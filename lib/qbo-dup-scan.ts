import type { PLDetailRow } from "./qbo-reports";

/**
 * Duplicate-transaction detection over a P&L detail pull. Extracted from
 * app/api/admin/dup-scan/route.ts so the books-verification engine can run it
 * per client at close time. Pure — no QBO or DB access.
 *
 *   - exact_same_day : same account + payee + amount + date, 2+ rows (HIGH)
 *   - near_duplicate : same account + payee + amount within 3 days (MEDIUM)
 *   - duplicate_doc  : same doc # + type + amount posted 2+ times (HIGH)
 *
 * Recurring patterns (same key 4+ times in the month — weekly payroll, fuel)
 * are treated as legit and skipped.
 */
export type DupFinding = {
  kind: "exact_same_day" | "near_duplicate" | "duplicate_doc";
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

export function findDuplicates(rows: PLDetailRow[], minAmount: number): DupFinding[] {
  const findings: DupFinding[] = [];
  const sig = (r: PLDetailRow) =>
    `${r.account}|${(r.name || r.memo.slice(0, 24)).toLowerCase().trim()}|${Math.abs(r.amount).toFixed(2)}`;
  const eligible = rows.filter((r) => Math.abs(r.amount) >= minAmount && r.date);

  // Group by account+payee+amount.
  const groups = new Map<string, PLDetailRow[]>();
  for (const r of eligible) {
    const k = sig(r);
    (groups.get(k) || groups.set(k, []).get(k)!).push(r);
  }

  for (const [, g] of groups) {
    if (g.length < 2) continue;
    // 4+ hits of the same key in one month = recurring (weekly payroll/fuel) — legit.
    if (g.length >= 4) continue;
    const dates = [...new Set(g.map((r) => r.date))].sort();
    const sample = g[0];
    const spanDays =
      (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / 86400000;
    // Distinct txn ids required — the same transaction split across rows is not a dupe.
    const distinctIds = new Set(g.map((r) => r.txn_id || Math.random()));
    if (distinctIds.size < 2) continue;

    if (dates.length < g.length || spanDays === 0) {
      findings.push(mkFinding("exact_same_day", "high", sample, g,
        `${g.length}× identical posting on the same day — classic double entry (bank feed + manual, or double import)`));
    } else if (spanDays <= 3) {
      findings.push(mkFinding("near_duplicate", "medium", sample, g,
        `same payee & amount ${Math.round(spanDays)} day(s) apart — possible duplicate posting`));
    }
  }

  // Duplicate document numbers (same doc # + type + amount, 2+ distinct txns).
  const byDoc = new Map<string, PLDetailRow[]>();
  for (const r of eligible) {
    if (!r.doc_number) continue;
    const k = `${r.txn_type}|${r.doc_number}|${Math.abs(r.amount).toFixed(2)}`;
    (byDoc.get(k) || byDoc.set(k, []).get(k)!).push(r);
  }
  for (const [, g] of byDoc) {
    const distinctIds = new Set(g.map((r) => r.txn_id));
    if (distinctIds.size < 2) continue;
    findings.push(mkFinding("duplicate_doc", "high", g[0], g,
      `doc #${g[0].doc_number} (${g[0].txn_type}) posted ${distinctIds.size}× — duplicate document`));
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
