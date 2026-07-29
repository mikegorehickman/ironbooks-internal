/**
 * QBO Deposit line reclassification.
 * ----------------------------------
 * The main reclass engine (lib/qbo-reclass.ts) only moves expense-family lines
 * — Bill / Purchase / Expense / VendorCredit, all via AccountBasedExpenseLineDetail.
 * A bank *Deposit* carries a different line shape (DepositLineDetail.AccountRef),
 * so a deposit booked straight to an income account — Stripe / ACH credits and
 * mobile deposits categorized to "Painting Revenue" — is invisible to that
 * engine. In the client P&L drill those rows show up as `type: "Deposit"` and
 * bulk-reclass used to count them as `skipped_unsupported`: "Move" moved zero
 * and the drawer told the bookkeeper deposits "can't be moved from this tool".
 *
 * They can. This rewrites the matching deposit line's AccountRef and
 * sparse-updates the Deposit — the same write the hardcore-cleanup finalizer
 * already runs against live files (app/api/clients/[id]/hardcore-cleanup/
 * [runId]/finalize/route.ts). Moving an income line between two income accounts
 * (e.g. "Painting Revenue (deleted)" → "Service Revenue") is net-neutral on
 * total revenue — it just consolidates the presentation onto the live account.
 *
 * Only DIRECT deposit lines can move. A line that links a Payment / Sales
 * Receipt (LinkedTxn) takes its account from that linked txn, not from the
 * deposit — so it's reported as `linked` and left alone; the fix there is on
 * the linked transaction (apply-payment / invoice), never the deposit.
 */

import { qboRequest } from "./qbo";

export interface DepositReclassResult {
  /** Lines the QBO response confirmed are now at the target account. */
  applied: number;
  /** Lines that pointed at the source account (direct deposit lines). */
  matched: number;
  /** Source-account lines linked to a Payment/Sales Receipt — left untouched. */
  linked: number;
  /** Source-account lines a human moved since we scanned — left untouched. */
  stale: number;
  /** True when the whole deposit sits in a closed period (never written). */
  skipped_closed: boolean;
  txn_date: string | null;
  not_applied: Array<{ line_id: string; actual_account_id: string | null; reason: string }>;
}

/** Leaf-tolerant name compare (mirrors lib/qbo-reclass.ts stale guard). */
function accountsMatch(currentFull: string | null | undefined, expected: string): boolean {
  const norm = (s: string | null | undefined) =>
    (s || "").toLowerCase().replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim();
  const cur = norm(currentFull);
  const exp = norm(expected);
  if (!cur || !exp) return false;
  if (cur === exp) return true;
  return (cur.split(":").pop() || cur) === (exp.split(":").pop() || exp);
}

/** Refetch a Deposit for a fresh SyncToken + current Line[] shape. */
export async function refetchDeposit(
  realmId: string,
  accessToken: string,
  depositId: string
): Promise<any | null> {
  const data = await qboRequest<any>(realmId, accessToken, `/deposit/${depositId}?minorversion=70`);
  return data?.Deposit ?? null;
}

/**
 * Move every DIRECT deposit line currently posting to `sourceAccountId` onto
 * `newAccountId`. Skips linked / stale / closed-period lines (reported in the
 * result). Throws if QBO accepts the update but doesn't reflect every line we
 * changed — a partial apply must never read as success.
 */
export async function reclassifyDepositLines(
  realmId: string,
  accessToken: string,
  params: {
    depositId: string;
    sourceAccountId: string;
    newAccountId: string;
    newAccountName: string;
    auditMemo: string;
    /** Stale guard: only move a line whose current account still matches this. */
    expectedCurrentAccountName?: string | null;
    /** Books-closing date — a deposit dated on/before this is left untouched. */
    closingDate?: string | null;
  }
): Promise<DepositReclassResult> {
  const dep = await refetchDeposit(realmId, accessToken, params.depositId);
  if (!dep) throw new Error(`Deposit ${params.depositId} not found (may have been deleted).`);

  const result: DepositReclassResult = {
    applied: 0, matched: 0, linked: 0, stale: 0,
    skipped_closed: false, txn_date: dep.TxnDate ?? null, not_applied: [],
  };

  // Never touch published books.
  if (params.closingDate && dep.TxnDate && dep.TxnDate <= params.closingDate) {
    result.skipped_closed = true;
    return result;
  }

  const lines: any[] = Array.isArray(dep.Line) ? dep.Line : [];
  const changedLineIds = new Set<string>();
  const srcId = String(params.sourceAccountId);

  const newLines = lines.map((ln) => {
    const detail = ln?.DepositLineDetail;
    const ref = detail?.AccountRef;
    if (!ref || String(ref.value) !== srcId) return ln; // not a line in the source account
    result.matched++;

    // Linked to a Payment / Sales Receipt — its account follows the linked txn.
    if (Array.isArray(ln.LinkedTxn) && ln.LinkedTxn.length > 0) {
      result.linked++;
      result.not_applied.push({
        line_id: String(ln.Id ?? ""),
        actual_account_id: srcId,
        reason: "linked to a Payment/Sales Receipt — recategorize the linked transaction, not the deposit",
      });
      return ln;
    }

    // Stale guard — a human moved this line since we scanned. The id match
    // above is authoritative; this only catches a later human change, so a line
    // with no name on its AccountRef is trusted (never force-skipped on absence).
    if (params.expectedCurrentAccountName && ref.name && !accountsMatch(ref.name, params.expectedCurrentAccountName)) {
      result.stale++;
      result.not_applied.push({
        line_id: String(ln.Id ?? ""),
        actual_account_id: srcId,
        reason: `stale: current account "${ref.name ?? "(none)"}" no longer matches expected "${params.expectedCurrentAccountName}"`,
      });
      return ln;
    }

    if (ln.Id != null) changedLineIds.add(String(ln.Id));
    return { ...ln, DepositLineDetail: { ...detail, AccountRef: { value: params.newAccountId, name: params.newAccountName } } };
  });

  // Nothing writable (no direct source lines, or all linked/stale) — no-op.
  if (changedLineIds.size === 0) return result;

  const existingMemo: string = dep.PrivateNote || "";
  const newMemo = existingMemo.includes(params.auditMemo)
    ? existingMemo
    : (existingMemo ? existingMemo + "\n" : "") + params.auditMemo;

  // Full update: a Deposit update REQUIRES the top-level DepositToAccountRef
  // (the bank account the money lands in) plus TxnDate etc. A minimal sparse
  // {Id,SyncToken,Line} body is rejected with QBO 2020 "Required parameter
  // DepositToAccountRef is missing". So carry the whole fetched entity, drop
  // only the read-only/computed fields, and override Line + memo — the same
  // approach as the expense-path writer (reclassifyTransactionLines).
  const { MetaData: _meta, domain: _domain, TotalAmt: _total, sparse: _sparse, ...depCore } = dep as any;
  const updated = await qboRequest<any>(realmId, accessToken, `/deposit?minorversion=70`, {
    method: "POST",
    body: JSON.stringify({ ...depCore, Line: newLines, PrivateNote: newMemo, sparse: false }),
  });

  // Verify each line we changed actually came back at the target account.
  const returned: any[] = Array.isArray(updated?.Deposit?.Line) ? updated.Deposit.Line : [];
  const byId = new Map<string, any>();
  for (const l of returned) if (l?.Id != null) byId.set(String(l.Id), l);
  const wantId = String(params.newAccountId);
  for (const id of changedLineIds) {
    const rl = byId.get(id);
    const actual = rl?.DepositLineDetail?.AccountRef?.value != null
      ? String(rl.DepositLineDetail.AccountRef.value)
      : null;
    if (actual === wantId) result.applied++;
    else result.not_applied.push({
      line_id: id,
      actual_account_id: actual,
      reason: actual
        ? `QBO returned line at account ${actual} instead of requested ${wantId}`
        : "line missing / no AccountRef in QBO response",
    });
  }

  if (result.applied < changedLineIds.size) {
    throw new Error(
      `Deposit ${params.depositId}: QBO accepted the update but applied only ` +
      `${result.applied}/${changedLineIds.size} lines. ${result.not_applied.map((n) => n.reason).join("; ")}`
    );
  }

  return result;
}
