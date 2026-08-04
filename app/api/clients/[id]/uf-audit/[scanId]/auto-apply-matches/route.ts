import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { fetchAllAccounts, getValidToken, qboErrorResponse } from "@/lib/qbo";
import { auditClient } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/clients/[id]/uf-audit/[scanId]/auto-apply-matches
 *   { min_confidence?: number (default 0.9), exact_only?: boolean (default true),
 *     dry_run?: boolean (default TRUE) }
 *
 * ONE CLICK for the payments SNAP has already matched to a real bank deposit.
 *
 * WHY. Every orphan group opened on an empty "— pick a resolution —" and, worse,
 * `finalize` refuses a create_deposit item that has no `deposit_bank_account_id`
 * ("No bank account selected for the deposit"). The scan stores the matched
 * deposit's bank as a NAME (`probable_deposit_bank`) and its date, but not the QBO
 * account id — so even a bookkeeper who agreed with the match still had to pick
 * the bank and the date by hand, per group. On RocketPainter that is 3 groups; on
 * Clean Cut it would be 61. That hand-work is the entire reason nobody clears UF.
 *
 * This resolves the bank NAME → QBO account id, stamps resolution=create_deposit
 * with the matched bank and the deposit's own date, and stops. It does NOT write
 * to QuickBooks. `finalize` remains the single write path — it already groups by
 * (bank, date) into one Deposit per bank line with LinkedTxn references, which is
 * the correct QBO shape and not something worth reimplementing here.
 *
 * SAFETY. dry_run defaults TRUE. Duplicates are never included: a suspected
 * duplicate can also tie to a deposit by amount, and depositing it would bank the
 * same money twice. Only `exact` matches qualify by default — a bundled or
 * tax-adjusted tie is a judgement call and stays manual. Items a human already
 * resolved are left alone.
 */

const DEFAULT_MIN_CONFIDENCE = 0.9;

/** Match a stored bank name to a QBO account. Exact first, then a normalised
 *  compare — QBO report names and account names differ by punctuation and case
 *  ("Business Chequing" vs "Business Chequing (1234)"). Ambiguity returns null
 *  rather than guessing, because the wrong bank is a real reconciliation problem. */
function resolveBankAccount(
  bankName: string | null,
  accounts: Array<{ Id: string; Name?: string; AccountType?: string; Active?: boolean }>
): { id: string; name: string } | null {
  if (!bankName) return null;
  const banks = accounts.filter(
    (a) => a.Active !== false && /bank|other current asset/i.test(String(a.AccountType || ""))
  );
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const target = norm(bankName);

  const exact = banks.filter((a) => norm(String(a.Name || "")) === target);
  if (exact.length === 1) return { id: String(exact[0].Id), name: String(exact[0].Name) };

  const partial = banks.filter((a) => {
    const n = norm(String(a.Name || ""));
    return n.includes(target) || target.includes(n);
  });
  if (partial.length === 1) return { id: String(partial[0].Id), name: String(partial[0].Name) };

  return null; // none, or ambiguous — the bookkeeper picks
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; scanId: string }> }
) {
  const { id: clientLinkId, scanId } = await context.params;
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await (service as any)
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead", "bookkeeper"].includes(String((actor as any)?.role || ""))) {
    return NextResponse.json({ error: "Staff only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const dryRun = body.dry_run !== false;
  const minConfidence =
    typeof body.min_confidence === "number" ? body.min_confidence : DEFAULT_MIN_CONFIDENCE;
  const exactOnly = body.exact_only !== false;

  const { data: scan } = await (service as any)
    .from("uf_audit_scans")
    .select("id, client_link_id, status, finalized_at")
    .eq("id", scanId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!scan) return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  if ((scan as any).finalized_at) {
    return NextResponse.json(
      { error: "This scan is already finalized — re-scan to work on it again." },
      { status: 400 }
    );
  }

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json({ error: "Client not connected to QuickBooks" }, { status: 400 });
  }

  const { data: items } = await (service as any)
    .from("uf_audit_items")
    .select(
      "id, qbo_payment_id, payment_date, payment_amount, customer_name, classification, " +
        "suspected_duplicate, probable_deposit_id, probable_deposit_date, probable_deposit_bank, " +
        "probable_match_kind, probable_match_confidence, resolution, deposit_bank_account_id"
    )
    .eq("scan_id", scanId);

  const all = ((items as any[]) || []).filter((i) => i.classification !== "matched");

  // The gate. Each exclusion is a decision, so they are counted and reported
  // rather than silently dropped.
  const skipped = { duplicate: 0, no_match: 0, low_confidence: 0, not_exact: 0, already_resolved: 0 };
  const candidates: any[] = [];
  for (const i of all) {
    if (i.resolution && i.resolution !== "pending") {
      skipped.already_resolved++;
      continue;
    }
    if (i.suspected_duplicate) {
      skipped.duplicate++;
      continue;
    }
    if (!i.probable_deposit_id) {
      skipped.no_match++;
      continue;
    }
    if (exactOnly && i.probable_match_kind !== "exact") {
      skipped.not_exact++;
      continue;
    }
    if ((Number(i.probable_match_confidence) || 0) < minConfidence) {
      skipped.low_confidence++;
      continue;
    }
    candidates.push(i);
  }

  let accounts: Awaited<ReturnType<typeof fetchAllAccounts>>;
  try {
    const token = await getValidToken(
      clientLinkId,
      service as any,
      "ironbooks/api/uf-audit/auto-apply-matches"
    );
    accounts = await fetchAllAccounts(String((client as any).qbo_realm_id), token);
  } catch (err: any) {
    return qboErrorResponse(err);
  }

  const willApply: any[] = [];
  const unresolvedBank: any[] = [];
  for (const i of candidates) {
    const bank = resolveBankAccount(i.probable_deposit_bank, accounts as any);
    if (!bank) {
      // finalize would reject this anyway; say so here instead of letting it fail
      // halfway through a batch.
      unresolvedBank.push({
        id: i.id,
        customer: i.customer_name,
        amount: Number(i.payment_amount) || 0,
        bank_name: i.probable_deposit_bank,
      });
      continue;
    }
    willApply.push({ item: i, bank });
  }

  const total = Math.round(willApply.reduce((s, w) => s + (Number(w.item.payment_amount) || 0), 0) * 100) / 100;

  const preview = {
    dry_run: dryRun,
    client: (client as any).client_name,
    scan_id: scanId,
    criteria: { min_confidence: minConfidence, exact_only: exactOnly },
    would_apply: willApply.length,
    would_apply_total: total,
    unresolved_bank: unresolvedBank,
    skipped,
    items: willApply.slice(0, 50).map((w) => ({
      customer: w.item.customer_name,
      payment_date: w.item.payment_date,
      amount: Number(w.item.payment_amount) || 0,
      deposit_date: w.item.probable_deposit_date,
      bank: w.bank.name,
      confidence: w.item.probable_match_confidence,
    })),
    note:
      "Staging only — this writes nothing to QuickBooks. It sets each payment's " +
      "resolution to create_deposit with the matched bank and deposit date, so " +
      "Finalize can post one Deposit per bank line.",
  };

  if (dryRun) return NextResponse.json({ ok: true, ...preview });

  let applied = 0;
  const errors: string[] = [];
  for (const { item, bank } of willApply) {
    const { error } = await (service as any)
      .from("uf_audit_items")
      .update({
        resolution: "create_deposit",
        deposit_bank_account_id: bank.id,
        deposit_bank_account_name: bank.name,
        // The deposit's OWN date, not today — so the QBO Deposit lands on the
        // bank statement line it reconciles against.
        deposit_date: item.probable_deposit_date || item.payment_date,
        resolution_notes:
          `Auto-applied from SNAP's match: deposit ${item.probable_deposit_date} into ${bank.name}` +
          (item.probable_match_confidence
            ? ` (${Math.round(Number(item.probable_match_confidence) * 100)}% confident, exact amount)`
            : ""),
      } as any)
      .eq("id", item.id)
      // Guard against a concurrent edit: only stamp rows still pending.
      .or("resolution.is.null,resolution.eq.pending");
    if (error) errors.push(`${item.customer_name || item.id}: ${error.message}`);
    else applied++;
  }

  await auditClient(service, {
    eventType: "uf_auto_apply_matches",
    clientLinkId,
    userId: user.id,
    payload: {
      scan_id: scanId,
      applied,
      total,
      criteria: { min_confidence: minConfidence, exact_only: exactOnly },
      skipped,
      unresolved_bank: unresolvedBank.length,
      errors: errors.slice(0, 10),
    },
  });

  return NextResponse.json({
    ok: true,
    ...preview,
    dry_run: false,
    applied,
    errors,
    next: "Press Finalize to post the Deposits to QuickBooks.",
  });
}
