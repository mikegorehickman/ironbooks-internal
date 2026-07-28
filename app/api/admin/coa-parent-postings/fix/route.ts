import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, qboErrorResponse } from "@/lib/qbo";
import { fetchAllTransactionLines, reclassifyTransactionLines, getCompanyClosingDate, type SupportedTxType } from "@/lib/qbo-reclass";

/**
 * POST /api/admin/coa-parent-postings/fix   (WRITES TO QBO)
 *
 * Two shapes, both moving DIRECT postings off a parent account onto sub-accounts:
 *
 *   1. Sweep-all (original):
 *      { client_link_id, parent_account_id, child_account_id, dry_run? }
 *      Every posting on the parent goes to that one child.
 *
 *   2. Granular (preferred):
 *      { client_link_id, parent_account_id,
 *        assignments: [{ txn_key, child_account_id }, ...], dry_run? }
 *      Each transaction goes where IT belongs. A parent like "Payroll" with
 *      $261K of stray postings almost never belongs in one sub-account — it
 *      splits across Owner's Payroll / Admin Team / Sales Team / etc. Sweep-all
 *      would book all of it wrong, so the drawer at /coa-audit lists the parent's
 *      transactions (see ../transactions) and posts explicit per-txn targets.
 *      `txn_key` is "<TxType>::<TxId>", the same key that endpoint returns.
 *
 * Reuses the reclass engine: pull YTD lines, keep only those whose AccountRef is
 * the PARENT id (id-based — reliable), and re-point them to the chosen child.
 * The parent stays (it's still a heading); only its stray postings move.
 * Closed-period lines are skipped. dry_run defaults TRUE. Admin / lead.
 *
 * Covers expense-family postings (Bill/Purchase/Expense/VendorCredit — what the
 * reclass engine fetches); JE/Deposit postings on a parent are out of scope and
 * reported as untouched via the summary counts.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const BUDGET_MS = 240_000;
const MAX_TXNS_PER_PASS = 80;

export async function POST(request: Request) {
  const startTime = Date.now();
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role, full_name").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "").trim();
  const parentId = String(body.parent_account_id || "").trim();
  const childId = String(body.child_account_id || "").trim();
  const dryRun = body.dry_run !== false; // default TRUE — must opt in to write

  // Granular mode: explicit per-transaction targets. txn_key = "<TxType>::<TxId>".
  const rawAssignments: any[] = Array.isArray(body.assignments) ? body.assignments : [];
  const assignments = new Map<string, string>();
  for (const a of rawAssignments) {
    const k = String(a?.txn_key || "").trim();
    const c = String(a?.child_account_id || "").trim();
    if (k && c) assignments.set(k, c);
  }
  const granular = assignments.size > 0;

  if (!clientLinkId || !parentId) {
    return NextResponse.json({ error: "client_link_id and parent_account_id required" }, { status: 400 });
  }
  if (!granular && !childId) {
    return NextResponse.json({ error: "child_account_id (or assignments) required" }, { status: 400 });
  }
  if ([...assignments.values(), childId].some((c) => c && c === parentId)) {
    return NextResponse.json({ error: "child must differ from the parent" }, { status: 400 });
  }

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!(client as any)?.qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json({ error: "Client inactive or no QBO connection" }, { status: 400 });
  }

  try {
    const realm = (client as any).qbo_realm_id as string;
    const token = await getValidToken(clientLinkId, service as any);

    const accounts = await fetchAllAccounts(realm, token);
    const parent = accounts.find((a) => a.Id === parentId);
    if (!parent) return NextResponse.json({ error: "Parent account not found" }, { status: 404 });

    // Validate EVERY target the same way, whichever mode we're in: it must exist,
    // be active, and be a sub-account of this parent — the whole point is moving a
    // parent's stray postings onto its own children.
    const targetIds = granular ? [...new Set(assignments.values())] : [childId];
    const targets = new Map<string, { id: string; name: string }>();
    for (const id of targetIds) {
      const acct = accounts.find((a) => a.Id === id);
      if (!acct || acct.Active === false) {
        return NextResponse.json({ error: `Target account ${id} not found or inactive` }, { status: 400 });
      }
      if (String(acct.ParentRef?.value || "") !== parentId) {
        return NextResponse.json({ error: `"${acct.Name}" is not a sub-account of "${parent.Name}"` }, { status: 400 });
      }
      targets.set(id, { id, name: acct.Name });
    }
    const child = granular ? null : targets.get(childId)!;

    const year = new Date().getFullYear();
    // The drawer passes its own window so preview and write see the same set.
    const ytdStart = String(body.start || `${year}-01-01`).slice(0, 10);
    const ytdEnd = String(body.end || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const closingDate = await getCompanyClosingDate(realm, token).catch(() => null);

    const { lines } = await fetchAllTransactionLines(realm, token, ytdStart, ytdEnd);
    // Id-based filter — the parent's OWN postings (sub-account lines carry the
    // child's id, not the parent's).
    const parentLines = lines.filter((l) => String(l.current_account_id) === parentId);

    // Group the parent's lines by transaction.
    type TxnGroup = { key: string; txType: SupportedTxType; txId: string; lineIds: string[]; amount: number; date: string };
    const byTxn = new Map<string, TxnGroup>();
    for (const l of parentLines) {
      const key = `${l.transaction_type}::${l.transaction_id}`;
      const g = byTxn.get(key) || { key, txType: l.transaction_type as SupportedTxType, txId: l.transaction_id, lineIds: [], amount: 0, date: l.transaction_date };
      if (l.line_id) g.lineIds.push(l.line_id);
      g.amount = Math.round((g.amount + (Number(l.transaction_amount) || 0)) * 100) / 100;
      byTxn.set(key, g);
    }

    // Work list = every posting on the parent (sweep-all) or just the assigned
    // ones (granular), each paired with the sub-account IT should land on.
    let notFound = 0;
    const work: { t: TxnGroup; target: { id: string; name: string } }[] = [];
    if (granular) {
      for (const [key, targetId] of assignments) {
        const t = byTxn.get(key);
        // Not in the parent's current lines = already moved (or out of window).
        // Skip rather than fail: two bookkeepers on the same parent is normal.
        if (!t) { notFound++; continue; }
        work.push({ t, target: targets.get(targetId)! });
      }
    } else {
      for (const t of byTxn.values()) work.push({ t, target: child! });
    }
    const totalAmount = Math.round(work.reduce((s, w) => s + Math.abs(w.t.amount), 0) * 100) / 100;

    const summary = {
      dry_run: dryRun,
      granular,
      parent: parent.Name,
      child: granular ? `${targets.size} sub-account(s)` : child!.name,
      txns_found: work.length,
      lines_found: granular ? work.reduce((s, w) => s + w.t.lineIds.length, 0) : parentLines.length,
      amount_found: totalAmount,
      already_moved: notFound,
      moved_txns: 0,
      moved_lines: 0,
      skipped_closed: 0,
      failed: 0,
      remaining: 0,
    };

    if (dryRun) {
      return NextResponse.json(summary);
    }

    for (let i = 0; i < work.length; i++) {
      if (Date.now() - startTime > BUDGET_MS || i >= MAX_TXNS_PER_PASS) {
        summary.remaining = work.length - i;
        break;
      }
      const { t, target } = work[i];
      if (closingDate && t.date && t.date <= closingDate) { summary.skipped_closed++; continue; }
      // Memo names the actual destination, so the audit trail (and the revert
      // tooling that reads it) stays accurate when one parent fans out to many.
      const memo = `Ironbooks: moved off parent "${parent.Name}" → "${target.name}" (by ${(actor as any)?.full_name || "staff"})`;
      try {
        const r = await reclassifyTransactionLines(realm, token, {
          txType: t.txType,
          txId: t.txId,
          lineUpdates: t.lineIds.map((line_id) => ({
            line_id,
            new_account_id: target.id,
            new_account_name: target.name,
            expected_current_account_name: parent.Name, // stale guard
          })),
          auditMemo: memo,
        });
        if (r.lines_applied > 0) { summary.moved_txns++; summary.moved_lines += r.lines_applied; }
      } catch (e: any) {
        summary.failed++;
      }
    }

    await service.from("audit_log").insert({
      event_type: "coa_parent_posting_fix",
      user_id: user.id,
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
        parent_id: parentId,
        child_id: childId || null,
        // Granular runs fan out to several children — record the actual mapping
        // so the run is reconstructable from the log alone.
        assignments: granular ? Object.fromEntries(assignments) : null,
        ...summary,
      } as any,
    } as any);

    return NextResponse.json(summary);
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
