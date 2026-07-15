/**
 * Re-apply "skipped — already in target account" reclassifications to QBO.
 *
 * Why this exists (Mike, 2026-07-15): when reclass discovery finds a
 * transaction already sitting in its target account it marks the row
 * `decision="skip", status="skipped", skip_reason="already_correct"` and
 * writes NOTHING to QBO — the assumption being "it's already right, leave
 * it." But that assumption is a snapshot taken at discovery time and is
 * sometimes wrong: the categorization never actually landed in QBO and the
 * transaction still shows uncategorized. The bookkeeper's fix: don't trust
 * the skip — re-push the target to QBO for every "already_correct" row to
 * be sure it's actually applied.
 *
 * The re-push is idempotent-safe: if the line genuinely IS already in the
 * target account, QBO gets a harmless no-op update; if it ISN'T, the target
 * finally lands. Critically we push WITHOUT `expected_current_account_name`
 * (the stale guard) — that guard would silently skip exactly the drifted
 * rows we're trying to fix. Closed periods are still never touched.
 *
 * This module holds the pure, testable candidacy + grouping logic. The
 * QBO writes + guards live in the route (mirrors vendor-remediation/apply).
 */
import { SUPPORTED_TX_TYPES, type SupportedTxType } from "@/lib/qbo-reclass";

export interface ReapplyRow {
  id: string;
  qbo_transaction_id: string | null;
  qbo_transaction_type: string | null;
  line_id: string | null;
  to_account_id: string | null;
  to_account_name: string | null;
  from_account_name: string | null;
  transaction_date: string | null;
  status: string | null;
  skip_reason: string | null;
  decision: string | null;
}

export interface ReapplyGroup {
  txType: SupportedTxType;
  txId: string;
  rows: ReapplyRow[];
}

/**
 * A row qualifies for re-apply iff it is a "skipped — already_correct" row
 * that carries everything needed to re-push: a known target account, a real
 * transaction id/line, and a SUPPORTED transaction type. Rows skipped for
 * ANY other reason (account missing, closed period, human-changed) are NOT
 * candidates — we only re-confirm what SNAP itself believed was correct.
 */
export function qualifiesForReapply(row: ReapplyRow): boolean {
  if (row.status !== "skipped") return false;
  if (row.skip_reason !== "already_correct") return false;
  if (!row.qbo_transaction_id) return false;
  if (!row.line_id) return false;
  if (!row.to_account_id && !row.to_account_name) return false;
  if (!SUPPORTED_TX_TYPES.includes(row.qbo_transaction_type as SupportedTxType)) return false;
  return true;
}

/**
 * Group qualifying rows by (transaction type, transaction id) so we issue
 * exactly one QBO write per transaction even when several of its lines are
 * being re-applied.
 */
export function groupReapplyRows(rows: ReapplyRow[]): ReapplyGroup[] {
  const byTxn = new Map<string, ReapplyGroup>();
  for (const row of rows) {
    if (!qualifiesForReapply(row)) continue;
    const txType = row.qbo_transaction_type as SupportedTxType;
    const txId = row.qbo_transaction_id as string;
    const key = `${txType}::${txId}`;
    let group = byTxn.get(key);
    if (!group) {
      group = { txType, txId, rows: [] };
      byTxn.set(key, group);
    }
    group.rows.push(row);
  }
  return [...byTxn.values()];
}
