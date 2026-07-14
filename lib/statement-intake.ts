/**
 * Statement intake — when a client (or bookkeeper) uploads a bank/CC/loan
 * statement, read it with Claude, identify the account + period, match it to a
 * QBO account, rename it "<Account> – Mon YYYY", and file a client_statements
 * row so it shows in the client's Statements section (and, later, the BS
 * cleanup view).
 *
 * Reuses the existing extraction (lib/cleanup-system/statement-analysis) so the
 * AI logic stays in one place — this just runs it for a single uploaded file
 * and persists the result instead of writing recon-job gaps.
 */
import { fetchAllAccounts, getValidToken } from "@/lib/qbo";
import { fetchBalancesAsOf } from "@/lib/qbo-balance-sheet";
import { CLIENT_UPLOADS_BUCKET } from "@/lib/client-comms";
import { extractStatements, reconCandidates } from "@/lib/cleanup-system/statement-analysis";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Parse "YYYY-MM-DD" → {month 1-12, year}. Tolerant of nulls/garbage. */
function parsePeriod(endDate: string | null): { month: number | null; year: number | null } {
  if (!endDate) return { month: null, year: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate.trim());
  if (!m) return { month: null, year: null };
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return { month: null, year };
  return { month, year };
}

/** "<Account> – Mon YYYY" — falls back gracefully when pieces are missing. */
function buildDisplayName(
  account: string | null,
  month: number | null,
  year: number | null,
  fallback: string
): string {
  const acct = (account || "").trim();
  const period = month && year ? `${MONTHS[month - 1]} ${year}` : year ? String(year) : "";
  if (acct && period) return `${acct} – ${period}`;
  if (acct) return acct;
  if (period) return `Statement – ${period}`;
  return fallback || "Statement";
}

export interface IntakeResult {
  ok: boolean;
  id?: string;
  display_name?: string;
  matched_account_name?: string | null;
  match_confidence?: string | null;
  period_month?: number | null;
  period_year?: number | null;
  error?: string;
}

/**
 * Process ONE uploaded statement already sitting at `storagePath` in the
 * client-uploads bucket. Inserts a client_statements row and returns it.
 *
 * QBO matching is best-effort: if the client has no QBO connection (or it
 * fails), the statement is still filed with whatever Claude read off the page
 * (account label + period), just without a QBO-account match.
 */
export async function intakeStatement(
  service: any,
  opts: {
    clientLinkId: string;
    storagePath: string;
    originalName: string;
    uploadedBy?: string | null;
    uploadedVia?: "portal" | "bookkeeper";
  }
): Promise<IntakeResult> {
  const { clientLinkId, storagePath, originalName } = opts;

  // 1. Pull the file bytes back out of storage as base64 for Claude.
  const dl = await service.storage.from(CLIENT_UPLOADS_BUCKET).download(storagePath);
  if (dl.error || !dl.data) {
    return { ok: false, error: "Could not read the uploaded file" };
  }
  const base64 = Buffer.from(await dl.data.arrayBuffer()).toString("base64");

  // 2. Build the QBO candidate list (best-effort).
  let accounts: any[] = [];
  try {
    const { data: client } = await service
      .from("client_links")
      .select("qbo_realm_id, qbo_refresh_token")
      .eq("id", clientLinkId)
      .single();
    if (client?.qbo_realm_id && client?.qbo_refresh_token) {
      const token = await getValidToken(clientLinkId, service);
      accounts = await fetchAllAccounts(client.qbo_realm_id, token);
    }
  } catch (e) {
    // No QBO / token trouble — fall through with an empty candidate list.
    accounts = [];
  }
  const candidates = reconCandidates(accounts);

  // 3. Extract + match with the shared statement reader.
  let ex;
  try {
    [ex] = await extractStatements([{ filename: originalName, base64 }], candidates);
  } catch (e: any) {
    return { ok: false, error: e?.message || "Statement reading failed" };
  }
  if (!ex) return { ok: false, error: "Statement reading returned nothing" };

  const matchedName =
    accounts.find((a) => String(a.Id) === ex!.matched_qbo_account_id)?.Name ||
    null;
  const { month, year } = parsePeriod(ex.statement_end_date);
  const accountForName = matchedName || ex.account_label || ex.institution;
  const displayName = buildDisplayName(accountForName, month, year, originalName);
  const status = ex.matched_qbo_account_id ? "processed" : "unmatched";

  // 4. File it.
  const { data: row, error } = await service
    .from("client_statements")
    .insert({
      client_link_id: clientLinkId,
      storage_path: storagePath,
      original_name: originalName,
      display_name: displayName,
      institution: ex.institution,
      account_label: ex.account_label,
      last4: ex.last4,
      account_kind: ex.account_kind,
      matched_qbo_account_id: ex.matched_qbo_account_id,
      matched_account_name: matchedName,
      match_confidence: ex.match_confidence,
      period_month: month,
      period_year: year,
      statement_end_date: ex.statement_end_date,
      ending_balance: ex.ending_balance,
      status,
      notes: ex.notes,
      uploaded_by: opts.uploadedBy ?? null,
      uploaded_via: opts.uploadedVia ?? "portal",
    })
    .select("id, display_name, matched_account_name, match_confidence, period_month, period_year")
    .single();

  if (error || !row) {
    return { ok: false, error: error?.message || "Could not file the statement" };
  }

  // Auto-clear any open bookkeeper request this statement satisfies.
  if (ex.matched_qbo_account_id || matchedName) {
    await fulfillStatementRequests(service, clientLinkId, {
      id: row.id,
      matched_qbo_account_id: ex.matched_qbo_account_id,
      matched_account_name: matchedName,
      account_label: ex.account_label,
      last4: ex.last4,
      statement_end_date: ex.statement_end_date,
    }).catch(() => {});
  }

  // Auto-recon (JP gate, Mike 2026-07-13: |variance| < $5 passes silently;
  // anything larger needs a human explanation before the month can publish).
  // QBO balance is fetched AS OF the statement's closing date — you can't
  // reconcile a month-old statement against today's ledger.
  if (ex.matched_qbo_account_id && ex.ending_balance != null && ex.statement_end_date) {
    try {
      const { data: cl } = await service
        .from("client_links").select("qbo_realm_id").eq("id", clientLinkId).single();
      const token = await getValidToken(clientLinkId, service);
      const balances = await fetchBalancesAsOf(cl.qbo_realm_id, token, ex.statement_end_date);
      const qboBalance = balances.get(String(ex.matched_qbo_account_id)) ?? 0;
      // Credit-card statements usually report the amount OWED as positive
      // while QBO holds liabilities negative — compare on magnitude too.
      const variance = Math.min(
        Math.abs(qboBalance - ex.ending_balance),
        Math.abs(Math.abs(qboBalance) - Math.abs(ex.ending_balance))
      );
      const pass = variance < 5;
      await service.from("client_statements")
        .update({ recon_status: pass ? "reconciled" : "variance", recon_variance: Math.round(variance * 100) / 100, recon_qbo_balance: qboBalance } as any)
        .eq("id", row.id);
      await service.from("audit_log").insert({
        event_type: "statement_recon",
        client_link_id: clientLinkId,
        request_payload: {
          statement_id: row.id,
          account: matchedName || ex.account_label,
          as_of: ex.statement_end_date,
          statement_balance: ex.ending_balance,
          qbo_balance: qboBalance,
          variance: Math.round(variance * 100) / 100,
          result: pass ? "pass" : "VARIANCE — needs explanation",
        } as any,
      } as any);
    } catch (err: any) {
      console.warn(`[statement-intake] auto-recon failed (non-blocking): ${err?.message}`);
    }
  }

  return {
    ok: true,
    id: row.id,
    display_name: row.display_name,
    matched_account_name: row.matched_account_name,
    match_confidence: row.match_confidence,
    period_month: row.period_month,
    period_year: row.period_year,
  };
}

const norm = (s: string | null | undefined) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Mark open statement_requests fulfilled when a statement that satisfies them
 * is filed. Matches on QBO account id first, then on a normalized name/last4
 * overlap (requests created from the cleanup view may carry only an account
 * name, not a QBO id). Called from intake and from the portal manual-match.
 */
export async function fulfillStatementRequests(
  service: any,
  clientLinkId: string,
  stmt: {
    id: string;
    matched_qbo_account_id: string | null;
    matched_account_name: string | null;
    account_label: string | null;
    last4: string | null;
    /** statement closing date — used to pick the right per-period request */
    statement_end_date?: string | null;
  }
): Promise<number> {
  const { data: open } = await service
    .from("statement_requests")
    .select("id, account_name, qbo_account_id, period_start, period_end")
    .eq("client_link_id", clientLinkId)
    .eq("status", "open");
  if (!open || open.length === 0) return 0;

  const stmtNames = [stmt.matched_account_name, stmt.account_label].map(norm).filter(Boolean);
  const last4 = stmt.last4 || "";

  const toFulfill = (open as any[]).filter((r) => {
    // Per-period requests (statement overhaul): only fulfill the request
    // whose window contains the statement's closing date. Requests without
    // periods keep the legacy account-only matching.
    if (stmt.statement_end_date && r.period_start && r.period_end) {
      if (stmt.statement_end_date < r.period_start || stmt.statement_end_date > r.period_end) return false;
    }
    if (stmt.matched_qbo_account_id && r.qbo_account_id && r.qbo_account_id === stmt.matched_qbo_account_id) {
      return true;
    }
    const rn = norm(r.account_name);
    if (!rn) return false;
    if (stmtNames.some((sn) => sn === rn || sn.includes(rn) || rn.includes(sn))) return true;
    if (last4 && r.account_name && r.account_name.replace(/\D/g, "").includes(last4)) return true;
    return false;
  });
  if (toFulfill.length === 0) return 0;

  await service
    .from("statement_requests")
    .update({ status: "fulfilled", fulfilled_statement_id: stmt.id, fulfilled_at: new Date().toISOString() })
    .in("id", toFulfill.map((r) => r.id));
  return toFulfill.length;
}
