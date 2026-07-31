/**
 * Owner compensation: salary vs draw.
 * ------------------------------------
 * Owner money out has two treatments that must never be conflated:
 *
 *   • Owner's Payroll → operating EXPENSE, above the net-profit line. Real if
 *     the owner is genuinely on payroll (T4/W-2, source deductions remitted).
 *   • Owner's Draw    → EQUITY, below the net-profit line. A distribution of
 *     profit, NOT a cost of doing business.
 *
 * Migration 79 split the master COA into those two accounts. What it could not
 * do is fix the TRANSACTIONS: clients still have owner money sitting in the old
 * combined "Owner Draw / Salary" account, or expensed to owner payroll when it
 * was really a draw. Every dollar in the wrong one moves net profit by that
 * dollar — which is why this is the single most margin-distorting
 * misclassification in the fleet, and why the fix is a SENIOR decision rather
 * than something a rule should guess.
 *
 * This module only DETECTS and PROPOSES. It reads P&L detail rows and answers:
 * which owner-compensation postings exist, how much is at stake, and does the
 * evidence look like payroll or a draw. A lead decides; nothing here writes.
 *
 * Why the evidence test is what it is: real owner payroll leaves a trail —
 * a payroll provider in the description (Wagepoint, Gusto, ADP, QuickBooks
 * Payroll), consistent amounts on a regular cycle, and withholding remittances
 * alongside. A draw looks like round numbers at irregular intervals, often
 * straight to the owner's name or an e-transfer. Neither is proof, so the
 * output is a leaning plus the reasons, never a silent reclass.
 */

/** A P&L detail row, as returned by fetchPLDetailAll (lib/qbo-reports.ts). */
export interface OwnerDrawRow {
  account: string;
  txn_type: string;
  date: string;
  name?: string | null;
  memo?: string;
  amount: number;
  txn_id: string;
}

/** Accounts whose contents are owner compensation and need a decision. */
const OWNER_ACCOUNT_PATTERNS: { re: RegExp; kind: "combined" | "payroll" | "draw" }[] = [
  // The pre-migration-79 combined account — anything here is unresolved by
  // definition, because the account itself refuses to say which it is.
  { re: /owner'?s?\s*(draw|drawing)s?\s*\/\s*salary|owner\s+draw\s*\/\s*salary/i, kind: "combined" },
  { re: /owner'?s?\s*(payroll|salary|salaries|wages)/i, kind: "payroll" },
  { re: /owner'?s?\s*(draw|drawing|distribution)s?/i, kind: "draw" },
  { re: /shareholder\s*(draw|distribution|loan)s?/i, kind: "draw" },
];

/** Payroll providers — their presence is the strongest signal of real payroll. */
const PAYROLL_PROVIDER =
  /wagepoint|gusto|\badp\b|paychex|payworks|ceridian|rise\s*people|humi|quickbooks\s*payroll|payroll\s*intuit|intuit\s*payroll|\bqbp\b/i;

/** Withholding remittances travelling with payroll (CRA source deductions / IRS 941). */
const REMITTANCE = /source\s*deduction|payroll\s*(tax|remit)|receiver\s*general|\bcra\b.*payroll|\beftps\b|941/i;

export type OwnerLeaning = "payroll" | "draw" | "unclear";

export interface OwnerAccountFinding {
  account: string;
  /** How the account itself is labelled — "combined" is always unresolved. */
  kind: "combined" | "payroll" | "draw";
  txnCount: number;
  totalAmount: number;
  /** Distinct payees seen, for the reviewer to eyeball. */
  payees: string[];
  leaning: OwnerLeaning;
  reasons: string[];
  /** True when this needs a lead's decision before the month can be trusted. */
  needsReview: boolean;
  sampleTxnIds: string[];
}

export interface OwnerDrawScan {
  findings: OwnerAccountFinding[];
  /** Dollars sitting in owner compensation that a lead hasn't ruled on. */
  unresolvedAmount: number;
  /** Dollars that would move OFF the P&L if the "draw" leaning is accepted —
   *  i.e. how much net profit is currently understated. */
  profitImpactIfDraw: number;
  needsSeniorReview: boolean;
}

/** Round to cents; float drift on sums of many rows shows up in reports. */
const money = (n: number) => Math.round(n * 100) / 100;

function classifyAccount(account: string): "combined" | "payroll" | "draw" | null {
  for (const p of OWNER_ACCOUNT_PATTERNS) if (p.re.test(account)) return p.kind;
  return null;
}

/**
 * Does this look like payroll, or a draw? Returns a leaning plus the evidence,
 * never a verdict — the reasons are the point, since a lead is going to read
 * them and decide.
 */
export function assessOwnerRows(rows: OwnerDrawRow[]): { leaning: OwnerLeaning; reasons: string[] } {
  const reasons: string[] = [];
  if (rows.length === 0) return { leaning: "unclear", reasons: ["no postings"] };

  const text = rows.map((r) => `${r.name ?? ""} ${r.memo ?? ""}`).join(" | ");
  const hasProvider = PAYROLL_PROVIDER.test(text);
  const hasRemittance = REMITTANCE.test(text);

  // Round amounts at irregular intervals read as draws; payroll is usually an
  // odd number (net of deductions) on a steady cycle.
  const amounts = rows.map((r) => Math.abs(r.amount));
  const roundCount = amounts.filter((a) => a > 0 && a % 100 === 0).length;
  const roundShare = amounts.length > 0 ? roundCount / amounts.length : 0;
  const distinct = new Set(amounts.map((a) => a.toFixed(2))).size;
  const consistent = amounts.length >= 3 && distinct <= Math.ceil(amounts.length / 2);

  let payrollScore = 0;
  let drawScore = 0;
  if (hasProvider) { payrollScore += 2; reasons.push("a payroll provider appears in the descriptions"); }
  if (hasRemittance) { payrollScore += 2; reasons.push("withholding remittances travel alongside"); }
  if (consistent) { payrollScore += 1; reasons.push("amounts repeat on a regular cycle"); }
  if (roundShare >= 0.6) { drawScore += 2; reasons.push(`${Math.round(roundShare * 100)}% of postings are round amounts`); }
  if (!hasProvider && !hasRemittance) { drawScore += 1; reasons.push("no payroll provider or remittance anywhere in the descriptions"); }

  const leaning: OwnerLeaning =
    payrollScore > drawScore ? "payroll" : drawScore > payrollScore ? "draw" : "unclear";
  if (leaning === "unclear") reasons.push("evidence points both ways — needs the owner's actual arrangement confirmed");
  return { leaning, reasons };
}

/**
 * Scan P&L detail for owner compensation needing a salary-vs-draw decision.
 *
 * Anything in the pre-split combined account ALWAYS needs review (the account
 * name itself refuses to answer the question). Owner payroll accounts need
 * review only when the evidence leans "draw" — that's the case where profit is
 * currently understated and real money is sitting on the wrong side of the
 * net-profit line.
 */
export function scanOwnerDraw(rows: OwnerDrawRow[]): OwnerDrawScan {
  const byAccount = new Map<string, { kind: "combined" | "payroll" | "draw"; rows: OwnerDrawRow[] }>();
  for (const r of rows) {
    const kind = classifyAccount(r.account || "");
    if (!kind) continue;
    const cur = byAccount.get(r.account) || { kind, rows: [] };
    cur.rows.push(r);
    byAccount.set(r.account, cur);
  }

  const findings: OwnerAccountFinding[] = [];
  for (const [account, { kind, rows: accountRows }] of byAccount) {
    const { leaning, reasons } = assessOwnerRows(accountRows);
    const totalAmount = money(accountRows.reduce((s, r) => s + (Number(r.amount) || 0), 0));
    // A draw account is already on the equity side — nothing to decide.
    const needsReview = kind === "combined" || (kind === "payroll" && leaning !== "payroll");
    findings.push({
      account,
      kind,
      txnCount: accountRows.length,
      totalAmount,
      payees: [...new Set(accountRows.map((r) => (r.name || "").trim()).filter(Boolean))].slice(0, 8),
      leaning,
      reasons,
      needsReview,
      sampleTxnIds: accountRows.slice(0, 5).map((r) => r.txn_id).filter(Boolean),
    });
  }

  findings.sort((a, b) => Math.abs(b.totalAmount) - Math.abs(a.totalAmount));
  const unresolved = findings.filter((f) => f.needsReview);
  return {
    findings,
    unresolvedAmount: money(unresolved.reduce((s, f) => s + f.totalAmount, 0)),
    // Only the ones actually leaning "draw" would move off the P&L.
    profitImpactIfDraw: money(
      unresolved.filter((f) => f.leaning === "draw").reduce((s, f) => s + f.totalAmount, 0)
    ),
    needsSeniorReview: unresolved.length > 0,
  };
}
