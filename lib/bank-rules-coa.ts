/**
 * Bank-rules ↔ master-COA conformance (fleet, CA + US).
 *
 * Bank rules store their category as a NAME (target_account_name) because
 * QBO's rule-import wizard matches on name, not id. That makes them brittle
 * across a COA change: after the master-COA refresh + the fleet push, ~11% of
 * stored rule targets name accounts that no longer exist under that name.
 *
 * The failure is SILENT and that's the real problem: the export ensures/
 * resolves only names that exist in the master COA or the live chart, so an
 * off-COA target just writes its raw string into the .xls and QBO's wizard
 * shows a blank "Select category" for that row. The bookkeeper imports rules
 * that categorize nothing. (The export does compute an `unresolved` list —
 * but only into an HTTP header on a file download, which nobody reads.)
 *
 * Classification per rule target:
 *   on_master  — matches the client's jurisdiction master COA → fine
 *   live_only  — not master, but a real account in their live chart. USUALLY
 *                LEGITIMATE: transfer rules point at bank/credit-card
 *                accounts ("Chase"), which are balance-sheet, not master P&L.
 *                Never auto-retargeted.
 *   broken     — exists nowhere → exports blank. This is the fix list.
 *
 * Jurisdiction correctness matters: CA and US master charts both have 79
 * accounts but different ones (CRA/CPP/EI/WCB vs US equivalents), so every
 * lookup is scoped to the client's own jurisdiction.
 */

import { normalizeAccountName } from "./account-name";

export type TargetStatus = "on_master" | "live_only" | "broken";

export interface RuleTargetRow {
  rule_id: string;
  vendor_pattern: string;
  target_account_name: string;
  status: TargetStatus;
  /** For broken targets: best master-COA candidates, best first. */
  suggestions: { name: string; reason: string; score: number }[];
}

/**
 * Curated aliases for renames the master-COA refresh introduced. Keys are
 * normalized old names; values are the current master account. These are
 * bookkeeping judgements, not string similarity — kept explicit and small so
 * they're reviewable. Anything not here falls back to fuzzy scoring, and
 * every suggestion is human-approved before it's written.
 */
const ALIASES: Record<string, string> = {
  // Labor / subs. NB: keys must be pre-normalized — normalizeAccountName
  // puts spaces around hyphens, so "Sub-contractors" → "sub - contractors".
  "sub - contractors": "Subcontractors",
  "contractors": "Subcontractors",
  "direct payroll": "Direct Field Labor",
  "labor": "Direct Field Labor",
  "direct worker's compensation": "Workers Compensation – Field",
  "admin team salaries": "Admin Team Payroll",
  // Job costs
  "job supplies": "Job Supplies & Materials",
  "small tools / purchases": "Small Tools",
  "dump fees": "Job Disposal Fees",
  // Vehicle
  "gas/fuel": "Fuel – Overhead",
  "fuel - admin & sales vehicles": "Fuel – Overhead",
  "vehicle repairs - admin/sales": "Vehicle Repairs",
  "vehicle lease - admin/sales": "Vehicle Lease",
  "vehicle registration": "Registration",
  "van washing": "Vehicle Repairs",
  "travel transportation costs": "Travel – Airfare & Lodging",
  // Financial
  "bank service charges": "Bank Charges",
  "payment processing fees": "Bank Charges",
  // Marketing
  "online advertising - google ads / social media marketing": "Online Advertising - Ad Spend",
  // Owner equity
  "owner draw / salary": "Owner's Draw",
  "owner's pay & personal expenses": "Owner's Draw",
  "shareholder's distribution": "Owner's Draw",
  // Misc
  "employee meals": "Meals (50% deductible)",
  "coaching & development": "Continuing Education / Professional Development",
  "refunds/discounts": "Discounts",
};

/** Cheap token-overlap score in [0,1] — enough to rank candidates. */
function similarity(a: string, b: string): number {
  const ta = new Set(normalizeAccountName(a).split(/[^a-z0-9&]+/).filter(Boolean));
  const tb = new Set(normalizeAccountName(b).split(/[^a-z0-9&]+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  return hits / Math.max(ta.size, tb.size);
}

export function suggestMasterTargets(
  targetName: string,
  masterNames: string[]
): { name: string; reason: string; score: number }[] {
  const norm = normalizeAccountName(targetName);
  const leaf = normalizeAccountName(String(targetName).split(":").pop() || "");
  const out: { name: string; reason: string; score: number }[] = [];

  const alias = ALIASES[norm] || ALIASES[leaf];
  if (alias && masterNames.some((m) => normalizeAccountName(m) === normalizeAccountName(alias))) {
    out.push({ name: alias, reason: "known rename", score: 1 });
  }
  for (const m of masterNames) {
    if (out.some((o) => normalizeAccountName(o.name) === normalizeAccountName(m))) continue;
    const s = Math.max(similarity(targetName, m), similarity(leaf, m));
    if (s >= 0.34) out.push({ name: m, reason: "similar name", score: Math.round(s * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

/**
 * Classify one client's rule targets. `liveAccountNames` is optional — pass
 * the live QBO chart to separate legitimately-live targets (bank accounts on
 * transfer rules) from genuinely broken ones. Without it, anything off-master
 * is reported as broken, which over-reports.
 */
export function classifyRuleTargets(params: {
  rules: { id: string; vendor_pattern: string; target_account_name: string | null }[];
  /** Full master set — what counts as conformant. */
  masterNames: string[];
  /** Candidates offered as retarget destinations (postable accounts only —
   *  parents are excluded). Defaults to masterNames. */
  suggestFrom?: string[];
  liveAccountNames?: string[] | null;
}): RuleTargetRow[] {
  const master = new Set(params.masterNames.map(normalizeAccountName));
  const suggestFrom = params.suggestFrom || params.masterNames;
  const live = params.liveAccountNames
    ? new Set(params.liveAccountNames.map(normalizeAccountName))
    : null;

  const rows: RuleTargetRow[] = [];
  for (const r of params.rules) {
    const raw = String(r.target_account_name || "").trim();
    if (!raw) continue;
    const norm = normalizeAccountName(raw);
    const leaf = normalizeAccountName(raw.split(":").pop() || "");

    let status: TargetStatus;
    if (master.has(norm) || master.has(leaf)) status = "on_master";
    else if (live && (live.has(norm) || live.has(leaf))) status = "live_only";
    else status = "broken";

    rows.push({
      rule_id: r.id,
      vendor_pattern: r.vendor_pattern,
      target_account_name: raw,
      status,
      suggestions: status === "broken" ? suggestMasterTargets(raw, suggestFrom) : [],
    });
  }
  return rows;
}

export function summarize(rows: RuleTargetRow[]) {
  return {
    total: rows.length,
    on_master: rows.filter((r) => r.status === "on_master").length,
    live_only: rows.filter((r) => r.status === "live_only").length,
    broken: rows.filter((r) => r.status === "broken").length,
  };
}
