import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { requireStaff } from "@/lib/cleanup-system/auth";
import { fetchAllAccounts, getValidToken } from "@/lib/qbo";
import {
  enumerateAccounts, buildRequests,
  type FeedEvidence, type DeclaredAccount,
} from "@/lib/statement-enumeration";

/**
 * POST /api/clients/[id]/statement-requests/generate
 *
 * Auto-enumerates every bank / credit-card / loan account from THREE sources
 * (QBO chart of accounts, bank-feed evidence, onboarding declarations) and
 * creates one named statement request per account per period — replacing the
 * generic "credit card statements + open invoices" ask. Idempotent: re-runs
 * only add lines for accounts/periods that don't already have an open or
 * fulfilled request. Read-only against QBO.
 *
 * Returns the diff artifacts too: undeclared_asks (in books but client never
 * declared it — business-or-personal confirm) and missing_from_qbo (declared
 * but no QBO account — bookkeeper create-account card).
 */
export const maxDuration = 120;

// The structured declared-accounts table from the new onboarding form.
// Swap this constant when the table lands under a different name; the
// fallback below reads the legacy free-text ob_form_payload fields.
const DECLARED_ACCOUNTS_TABLE = "onboarding_declared_accounts";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // dry_run: enumerate + diff only — nothing inserted, nothing audited.
  // The cleanup wizard's "Need from client" panel uses this to DISPLAY the
  // complete per-account list without creating open requests as a side
  // effect of loading the page.
  const body = await request.json().catch(() => ({} as any));
  const dryRun = body?.dry_run === true;

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("*")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id) {
    return NextResponse.json({ error: "Client not found or no QBO connection" }, { status: 404 });
  }

  // ── Source 1: QBO chart of accounts (list API — includes zero-balance) ──
  const accessToken = await getValidToken(clientLinkId, service as any);
  const qboAccounts = await fetchAllAccounts(client.qbo_realm_id, accessToken);

  // ── Source 2: bank-feed evidence from our own reclass history ──
  // earliest is_bank_fed line per bank account ≈ feed-connection date.
  const feed: FeedEvidence = { firstSeenByAccount: new Map() };
  const { data: jobs } = await service
    .from("reclass_jobs").select("id").eq("client_link_id", clientLinkId);
  const jobIds = (jobs || []).map((j) => j.id);
  if (jobIds.length) {
    const { data: fedRows } = await service
      .from("reclassifications")
      .select("bank_account_name, transaction_date")
      .in("reclass_job_id", jobIds)
      .eq("is_bank_fed", true)
      .not("bank_account_name", "is", null)
      .not("transaction_date", "is", null);
    for (const r of (fedRows || []) as any[]) {
      const cur = feed.firstSeenByAccount.get(r.bank_account_name);
      if (!cur || r.transaction_date < cur) feed.firstSeenByAccount.set(r.bank_account_name, r.transaction_date);
    }
  }

  // ── Source 3: onboarding declarations ──
  const declared: DeclaredAccount[] = [];
  const { data: declRows, error: declErr } = await (service as any)
    .from(DECLARED_ACCOUNTS_TABLE)
    .select("*")
    .eq("client_link_id", clientLinkId);
  if (!declErr && declRows?.length) {
    for (const d of declRows) {
      const name = d.account_name || d.name || d.label || "";
      if (!name) continue;
      const rawKind = String(d.account_kind || d.kind || d.type || "").toLowerCase();
      declared.push({
        name,
        kind: /credit|card|visa|master|amex/.test(rawKind) ? "credit_card"
          : /loan|financ|lease/.test(rawKind) ? "loan"
          : /bank|chequing|checking|savings/.test(rawKind) ? "bank" : "unknown",
      });
    }
  } else {
    // Legacy fallback: free-text fields on the old onboarding form payload.
    const { data: lead } = await (service as any)
      .from("onboarding_leads")
      .select("ob_form_payload")
      .eq("client_link_id", clientLinkId)
      .not("ob_form_payload", "is", null)
      .limit(1)
      .maybeSingle();
    const p: any = (lead as any)?.ob_form_payload || {};
    const cc = String(p.CreditCards || "").trim();
    if (cc && !/^n\/?a$|^none$/i.test(cc)) declared.push({ name: cc, kind: "credit_card" });
  }

  // Does an onboarding FORM exist at all? (structured declared-accounts rows,
  // or a submitted legacy OB form). Drives the client-request wording: with no
  // form we can't compare to a declared baseline, so we drop the per-account
  // "business or personal?" asks and instead ask one catch-all question.
  let hasObForm = (declRows?.length || 0) > 0;
  if (!hasObForm) {
    const { data: obLead } = await (service as any)
      .from("onboarding_leads")
      .select("id")
      .eq("client_link_id", clientLinkId)
      .or("ob_form_submitted_at.not.is.null,ob_form_payload.not.is.null")
      .limit(1)
      .maybeSingle();
    hasObForm = !!obLead;
  }

  // ── Books start: last-filed year-end + 1 day; else 6 months back (Mike) ──
  const lastFiled = (client as any).last_filed_year_end || (client as any).last_filed_return_year || null;
  let booksStart: string;
  if (lastFiled && /^\d{4}/.test(String(lastFiled))) {
    booksStart = /^\d{4}$/.test(String(lastFiled))
      ? `${Number(lastFiled) + 1}-01-01`
      : new Date(new Date(String(lastFiled)).getTime() + 86400000).toISOString().slice(0, 10);
  } else {
    booksStart = new Date(Date.now() - 183 * 86400000).toISOString().slice(0, 10);
  }
  const today = new Date().toISOString().slice(0, 10);

  const accounts: any = enumerateAccounts(qboAccounts, feed, declared);
  const { requests, undeclared_asks } = buildRequests(accounts, {
    booksStart,
    today,
    // Only ask "business or personal?" when the client actually declared
    // accounts at onboarding — otherwise every account reads as undeclared
    // and floods the list with a redundant question per account.
    hasDeclarations: declared.length > 0,
  });

  // ── Idempotent insert: skip account+kind lines already requested ──
  const { data: existing } = await (service as any)
    .from("statement_requests")
    .select("qbo_account_id, account_kind, label, period_start")
    .eq("client_link_id", clientLinkId);
  const seen = new Set(
    (existing || []).map((e: any) => `${e.qbo_account_id ?? e.label}::${e.account_kind}::${e.period_start ?? ""}`)
  );
  const toInsert = requests
    .filter((r) => !seen.has(`${r.qbo_account_id ?? r.label}::${r.account_kind}::${r.period_start ?? ""}`))
    .map((r) => ({
      client_link_id: clientLinkId,
      label: r.label,
      account_name: r.account_name,
      account_kind: r.account_kind,
      qbo_account_id: r.qbo_account_id,
      period_start: r.period_start,
      period_end: r.period_end,
      source: r.source,
      status: "open",
      requested_by: auth.userId,
    }));
  if (dryRun) {
    return NextResponse.json({
      dry_run: true,
      has_ob_form: hasObForm,
      accounts: accounts.map((a: any) => ({
        label: a.label,
        kind: a.kind,
        sources: a.sources,
        qbo_account_id: a.qbo_account_id ?? null,
        last4: a.last4 ?? null,
        feed_first_date: a.feed_first_date,
      })),
      would_create: toInsert.length,
      already_requested: requests.length - toInsert.length,
      undeclared_asks,
      missing_from_qbo: accounts.missing ?? [],
      books_start: booksStart,
    });
  }

  if (toInsert.length) {
    const { error: insErr } = await (service as any).from("statement_requests").insert(toInsert);
    if (insErr) return NextResponse.json({ error: `insert failed: ${insErr.message}` }, { status: 500 });
  }

  await service.from("audit_log").insert({
    event_type: "statement_requests_generated",
    user_id: auth.userId,
    request_payload: {
      client_link_id: clientLinkId,
      accounts_enumerated: accounts.length,
      requests_created: toInsert.length,
      requests_already_open: requests.length - toInsert.length,
      undeclared_asks: undeclared_asks.length,
      missing_from_qbo: accounts.missing?.length ?? 0,
      declared_source: declErr ? "legacy_payload" : DECLARED_ACCOUNTS_TABLE,
      books_start: booksStart,
    } as any,
  } as any);

  return NextResponse.json({
    accounts: accounts.map((a: any) => ({ label: a.label, kind: a.kind, sources: a.sources, feed_first_date: a.feed_first_date })),
    created: toInsert.length,
    already_requested: requests.length - toInsert.length,
    undeclared_asks,
    missing_from_qbo: accounts.missing ?? [],
    books_start: booksStart,
  });
}
