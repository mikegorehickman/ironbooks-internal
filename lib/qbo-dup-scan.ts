import type { PLDetailRow } from "./qbo-reports";

/**
 * Duplicate-transaction detection over a P&L detail pull. Extracted from
 * app/api/admin/dup-scan/route.ts so the books-verification engine can run it
 * per client at close time. Pure — no QBO or DB access.
 *
 * A duplicate is the SAME money booked twice CLOSE TOGETHER in time — same
 * account + payee + amount, posted on the same day or 1–2 days apart (Mike
 * 2026-07-17: "same amount, same day or max 1-2 days apart — NOT the same
 * amount in a different week/month"). Same amount recurring every pay period
 * or every month is a legitimate recurring charge, never a duplicate.
 *
 *   - exact_same_day : same account + payee + amount, 2+ rows same DAY (HIGH)
 *   - near_duplicate : same account + payee + amount within MAX_SPAN_DAYS (MED/HIGH)
 *   - duplicate_doc  : same REAL doc # + type + amount within the window (HIGH)
 *   - reversal_pair  : purchase + its refund (opposite signs) — informational
 *
 * Every same-amount group is sub-clustered by date proximity, so a recurring
 * weekly/monthly charge (each posting >MAX_SPAN_DAYS from the next) forms
 * singleton clusters and is never flagged.
 */
export type DupFinding = {
  kind: "exact_same_day" | "near_duplicate" | "duplicate_doc" | "reversal_pair";
  severity: "high" | "medium";
  section: string;
  account: string;
  name: string | null;
  amount: number;
  dates: string[];
  txn_types: string[];
  doc_numbers: (string | null)[];
  /** Distinct QBO transaction ids in the group — stable identity for the finding. */
  txn_ids: string[];
  count: number;
  note: string;
};

/** Same-originator ACH tell: "ORIG ID:XXXXXX2103" tokens in bank memos. */
function origIdOf(memo: string | null | undefined): string | null {
  const m = /ORIG\s*ID:\s*(\S+)/i.exec(memo || "");
  return m ? m[1].toUpperCase() : null;
}

/** Near-dups at/above this are HIGH severity (removable-track), not buried. */
export const NEAR_DUP_HIGH_FLOOR = 500;

/**
 * Two postings are only duplicates of each other if they land this close
 * together. Same day = 0; "1-2 days apart" covers weekend/settlement lag.
 * Anything further apart is a recurring charge, not a double entry.
 */
export const MAX_SPAN_DAYS = 2;

/**
 * QBO auto-fills a payment-method label into the doc-number field for payroll
 * and bank transactions ("DD", "Gusto", "ACH", "EFT", "1"…). These are NOT
 * unique document identifiers — recurring payroll reuses the same label + the
 * same amount every pay period, so matching on them flags every paycheque as a
 * "duplicate document". Only a REAL, distinctive doc number counts.
 */
const PLACEHOLDER_DOC = new Set([
  "dd", "gusto", "ach", "eft", "e-transfer", "etransfer", "e-tfr", "emt",
  "deposit", "debit", "credit", "transfer", "xfer", "payroll", "pay", "wire",
  "pos", "atm", "bill", "check", "cheque", "chk", "payment", "pmt", "online",
  "billpay", "epay", "auto", "recurring",
]);
function isRealDocNumber(doc: string | null | undefined): boolean {
  const d = (doc || "").trim();
  if (!d) return false;
  if (PLACEHOLDER_DOC.has(d.toLowerCase())) return false;
  // Pure short numbers (≤3 digits, e.g. "1", "42") are auto-increment/generic,
  // not distinctive enough to prove a duplicate on their own.
  if (/^\d{1,3}$/.test(d)) return false;
  return true;
}

const dayNum = (d: string) => Math.floor(new Date(d + "T00:00:00Z").getTime() / 86400000);

/**
 * Split a same-key group into clusters of rows that fall within MAX_SPAN_DAYS
 * of the cluster's first (earliest) date. Recurring charges spaced further
 * apart land in separate singleton clusters.
 */
function clusterByProximity<T extends { date: string }>(rows: T[]): T[][] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const clusters: T[][] = [];
  let current: T[] = [];
  let anchor = -Infinity;
  for (const r of sorted) {
    const d = dayNum(r.date);
    if (current.length === 0 || d - anchor <= MAX_SPAN_DAYS) {
      if (current.length === 0) anchor = d;
      current.push(r);
    } else {
      clusters.push(current);
      current = [r];
      anchor = d;
    }
  }
  if (current.length) clusters.push(current);
  return clusters;
}

export function findDuplicates(rows: PLDetailRow[], minAmount: number): DupFinding[] {
  const findings: DupFinding[] = [];
  // SIGN-AWARE key: a purchase and its refund share account+payee+|amount| but
  // are NOT duplicates of each other — grouping by abs() conflated them.
  // Same-sign rows group for dup detection; opposite-sign pairs are detected
  // separately as reversal_pair below.
  const payeeOf = (r: PLDetailRow) => (r.name || r.memo.slice(0, 24)).toLowerCase().trim();
  const sig = (r: PLDetailRow) =>
    `${r.account}|${payeeOf(r)}|${Math.abs(r.amount).toFixed(2)}|${r.amount < 0 ? "-" : "+"}`;
  const eligible = rows.filter((r) => Math.abs(r.amount) >= minAmount && r.date);

  // Group by account+payee+amount+sign, then sub-cluster by date proximity so
  // only postings CLOSE TOGETHER in time count as duplicates of each other.
  const groups = new Map<string, PLDetailRow[]>();
  for (const r of eligible) {
    const k = sig(r);
    (groups.get(k) || groups.set(k, []).get(k)!).push(r);
  }

  for (const [, g] of groups) {
    if (g.length < 2) continue;
    for (const cluster of clusterByProximity(g)) {
      if (cluster.length < 2) continue;               // lone recurring posting
      if (cluster.length >= 4) continue;              // 4+ identical in ≤2 days: treat as recurring/legit
      const distinctIds = new Set(cluster.map((r) => r.txn_id).filter(Boolean));
      if (distinctIds.size < 2) continue;             // same txn split across rows ≠ dupe
      const dates = [...new Set(cluster.map((r) => r.date))].sort();
      const sample = cluster[0];
      const spanDays = dayNum(dates[dates.length - 1]) - dayNum(dates[0]);

      if (spanDays === 0) {
        findings.push(mkFinding("exact_same_day", "high", sample, cluster,
          `${cluster.length}× identical posting on the same day — classic double entry (bank feed + manual, or double import)`));
      } else {
        // 1–2 days apart. Shared ACH originator or a large amount → HIGH.
        const origIds = cluster.map((r) => origIdOf(r.memo)).filter(Boolean);
        const sameOrig = origIds.length === cluster.length && new Set(origIds).size === 1;
        const big = Math.abs(sample.amount) >= NEAR_DUP_HIGH_FLOOR;
        findings.push(mkFinding(
          "near_duplicate",
          big || sameOrig ? "high" : "medium",
          sample,
          cluster,
          `same payee & amount ${spanDays} day(s) apart${sameOrig ? " with the SAME bank originator (ORIG ID)" : ""} — ${big || sameOrig ? "likely" : "possible"} duplicate posting`,
        ));
      }
    }
  }

  // REVERSAL PAIRS — refund/credit netting against a purchase: same account +
  // payee + |amount|, opposite signs, within 30 days. Not duplicates (never
  // auto-removable) but surfaced so the bookkeeper confirms the refund is
  // placed/netted intentionally (Mike's Sherwin-refund-in-Paint&Materials ask).
  const byAbs = new Map<string, PLDetailRow[]>();
  for (const r of eligible) {
    const k = `${r.account}|${payeeOf(r)}|${Math.abs(r.amount).toFixed(2)}`;
    (byAbs.get(k) || byAbs.set(k, []).get(k)!).push(r);
  }
  for (const [, g] of byAbs) {
    const pos = g.filter((r) => r.amount > 0);
    const neg = g.filter((r) => r.amount < 0);
    if (pos.length === 0 || neg.length === 0) continue;
    const pair = [pos[0], neg[0]];
    const spanDays = Math.abs(dayNum(pos[0].date) - dayNum(neg[0].date));
    if (spanDays > 30) continue;
    const distinctIds = new Set(pair.map((r) => r.txn_id).filter(Boolean));
    if (distinctIds.size < 2) continue;
    findings.push(mkFinding("reversal_pair", "medium", pos[0], pair,
      `refund/credit of ${Math.abs(neg[0].amount).toFixed(2)} nets against a matching charge ${spanDays} day(s) apart — verify the refund is intentional (not a duplicate order + refund, and placed in the right account)`));
  }

  // Duplicate document numbers — a REAL, distinctive doc # + type + amount
  // posted on 2+ transactions CLOSE TOGETHER. Placeholder doc labels ("DD",
  // "Gusto", "1") are excluded (recurring payroll reuses them every period),
  // and the same date-window applies so a genuinely reused invoice number
  // weeks apart isn't confused with an ordinary recurring charge.
  const byDoc = new Map<string, PLDetailRow[]>();
  for (const r of eligible) {
    if (!isRealDocNumber(r.doc_number)) continue;
    const k = `${r.txn_type}|${r.doc_number}|${Math.abs(r.amount).toFixed(2)}`;
    (byDoc.get(k) || byDoc.set(k, []).get(k)!).push(r);
  }
  for (const [, g] of byDoc) {
    for (const cluster of clusterByProximity(g)) {
      const distinctIds = new Set(cluster.map((r) => r.txn_id));
      if (distinctIds.size < 2) continue;
      findings.push(mkFinding("duplicate_doc", "high", cluster[0], cluster,
        `doc #${cluster[0].doc_number} (${cluster[0].txn_type}) posted ${distinctIds.size}× within ${MAX_SPAN_DAYS} day(s) — duplicate document`));
    }
  }

  // High severity first, then by amount.
  findings.sort((a, b) => (a.severity === b.severity ? Math.abs(b.amount) - Math.abs(a.amount) : a.severity === "high" ? -1 : 1));
  return findings.slice(0, 50);
}

function mkFinding(kind: DupFinding["kind"], severity: DupFinding["severity"], sample: PLDetailRow, g: PLDetailRow[], note: string): DupFinding {
  return {
    kind, severity, note,
    section: sample.section, account: sample.account,
    name: sample.name || sample.memo.slice(0, 40) || null,
    amount: sample.amount,
    dates: [...new Set(g.map((r) => r.date))].sort(),
    txn_types: [...new Set(g.map((r) => r.txn_type))],
    doc_numbers: [...new Set(g.map((r) => r.doc_number))],
    txn_ids: [...new Set(g.map((r) => r.txn_id).filter(Boolean))].sort() as string[],
    count: g.length,
  };
}
