/**
 * Portal P&L classifier — turns a flat ProfitLossData into the four buckets
 * a contractor actually thinks in:
 *
 *   1. Income          — money in from jobs
 *   2. Variable costs   — direct job costs (materials, subs, crew, etc.)
 *   3. Gross Profit     — Income − Variable costs
 *   4. Fixed expenses   — overhead that doesn't scale with jobs (rent,
 *                         insurance, software, admin)
 *
 * ...then Net Profit = Gross Profit − Fixed expenses (± Other income/expense).
 *
 * Source of truth for the variable/fixed split:
 *   - If the QBO file HAS a Cost of Goods Sold section, those lines ARE the
 *     variable costs and everything else is fixed. `costSplitEstimated=false`.
 *   - If it does NOT (everything dumped into "Expenses"), we estimate the
 *     split with a painting-trade direct-cost keyword list and flag it with
 *     `costSplitEstimated=true` so the UI can say "estimated — your
 *     bookkeeper can refine this." We never silently pretend an estimate is
 *     the real chart of accounts.
 *
 * Pure functions only — safe to import from server OR client components.
 */
import type { ProfitLossData } from "./qbo-reports";

export interface PlLine {
  label: string;
  /** Raw signed amount as it appears on the P&L. */
  amount: number;
  account_id: string | null;
  /** This line as a percent of total income (0 when income is 0). */
  pctOfIncome: number;
}

export type BucketKey = "income" | "variable" | "fixed" | "otherIncome" | "otherExpense";

export interface PlBucket {
  key: BucketKey;
  label: string;
  /** Sum of line magnitudes in the bucket (always >= 0 for cost buckets). */
  total: number;
  lines: PlLine[];
  pctOfIncome: number;
}

export interface PortalPl {
  income: PlBucket;
  variableCosts: PlBucket;
  fixedExpenses: PlBucket;
  otherIncome: PlBucket | null;
  otherExpense: PlBucket | null;

  totalIncome: number;
  totalVariable: number;
  totalFixed: number;

  grossProfit: number;
  grossMarginPct: number;
  netProfit: number;
  netMarginPct: number;

  /** True when the variable/fixed split came from the keyword heuristic. */
  costSplitEstimated: boolean;
  /** True when the QBO file has a real Cost of Goods Sold section. */
  hasCogsSection: boolean;
  /** True when there is essentially no activity (used by callers to no-op). */
  isEmpty: boolean;
}

// ─── Group classification ───────────────────────────────────────────────

function isIncomeGroup(group: string): boolean {
  const g = group.toLowerCase();
  if (/other\s*income/.test(g)) return false;
  return /income|revenue|sales/.test(g) && !/cost/.test(g);
}

function isCogsGroup(group: string): boolean {
  const g = group.toLowerCase();
  return /cogs|cost of goods|cost of sales|job cost|direct cost/.test(g);
}

function isOtherIncomeGroup(group: string): boolean {
  return /other\s*income/i.test(group);
}

function isOtherExpenseGroup(group: string): boolean {
  return /other\s*expense/i.test(group);
}

// ─── Direct-cost keyword heuristic (painting trade) ──────────────────────
// Used ONLY when the file has no COGS section. Conservative: a line is
// "variable" only if it clearly reads as a direct job cost. Everything else
// stays "fixed" (overhead).

const DIRECT_COST_KEYWORDS = [
  "cost of",
  "cogs",
  "material",
  "paint",
  "coating",
  "primer",
  "stain",
  "lacquer",
  "supplies",
  "sundries",
  "subcontract",
  "sub-contract",
  "subs ",
  "contract labor",
  "job labor",
  "field labor",
  "direct labor",
  "crew",
  "wages",
  "equipment rental",
  "equipment rentals",
  "tool",
  "sprayer",
  "sandpaper",
  "brush",
  "job ",
  "jobs",
  "dump fee",
  "disposal",
  "permit",
  "prep ",
  "drop cloth",
  "masking",
];

// Strong overhead hints that override a loose direct-cost match (e.g. "office
// supplies" should stay fixed even though "supplies" is a direct-cost word).
const OVERHEAD_OVERRIDE_KEYWORDS = [
  "office",
  "rent",
  "insurance",
  "software",
  "subscription",
  "advertis",
  "marketing",
  "accounting",
  "legal",
  "bank",
  "interest",
  "depreciat",
  "amortiz",
  "utilit",
  "phone",
  "internet",
  "admin",
  "officer",
  "owner",
  "dues",
  "license",
  "merchant",
  "payroll tax",
];

function looksVariableByLabel(label: string): boolean {
  const l = label.toLowerCase();
  if (OVERHEAD_OVERRIDE_KEYWORDS.some((kw) => l.includes(kw))) return false;
  return DIRECT_COST_KEYWORDS.some((kw) => l.includes(kw));
}

// ─── Main classifier ─────────────────────────────────────────────────────

export function classifyProfitLoss(pl: ProfitLossData): PortalPl {
  const incomeLines: PlLine[] = [];
  const variableLines: PlLine[] = [];
  const fixedLines: PlLine[] = [];
  const otherIncomeLines: PlLine[] = [];
  const otherExpenseLines: PlLine[] = [];

  // Pass 1: detect whether a COGS section exists at all.
  const hasCogsSection = pl.lineItems.some(
    (l) => isCogsGroup(l.group || "") && Math.abs(l.amount) >= 0.01
  );

  const totalIncomeForPct = Math.abs(pl.totalIncome) || 0;
  const pct = (amt: number) =>
    totalIncomeForPct > 0 ? (Math.abs(amt) / totalIncomeForPct) * 100 : 0;

  for (const item of pl.lineItems) {
    const group = item.group || "";
    if (Math.abs(item.amount) < 0.01) continue;
    const line: PlLine = {
      label: item.label,
      amount: item.amount,
      account_id: item.account_id,
      pctOfIncome: pct(item.amount),
    };

    if (isOtherIncomeGroup(group)) {
      otherIncomeLines.push(line);
      continue;
    }
    if (isOtherExpenseGroup(group)) {
      otherExpenseLines.push(line);
      continue;
    }
    if (isIncomeGroup(group)) {
      incomeLines.push(line);
      continue;
    }
    if (isCogsGroup(group)) {
      variableLines.push(line);
      continue;
    }
    // Remaining lines are operating expenses. Split variable vs fixed.
    if (hasCogsSection) {
      // The file already separates direct costs via COGS — so anything left
      // here is genuine overhead.
      fixedLines.push(line);
    } else if (looksVariableByLabel(item.label)) {
      variableLines.push(line);
    } else {
      fixedLines.push(line);
    }
  }

  const costSplitEstimated = !hasCogsSection && variableLines.length > 0;

  const sum = (lines: PlLine[]) => lines.reduce((s, l) => s + Math.abs(l.amount), 0);

  const totalIncome = totalIncomeForPct || sum(incomeLines);
  const totalVariable = sum(variableLines);
  const totalFixed = sum(fixedLines);
  const totalOtherIncome = sum(otherIncomeLines);
  const totalOtherExpense = sum(otherExpenseLines);

  const grossProfit = totalIncome - totalVariable;
  const grossMarginPct = totalIncome > 0 ? (grossProfit / totalIncome) * 100 : 0;

  // Prefer the report's authoritative netIncome when it's populated; fall back
  // to the bucket math (income − variable − fixed ± other).
  const computedNet =
    grossProfit - totalFixed + totalOtherIncome - totalOtherExpense;
  const netProfit = Number.isFinite(pl.netIncome) && pl.netIncome !== 0 ? pl.netIncome : computedNet;
  const netMarginPct = totalIncome > 0 ? (netProfit / totalIncome) * 100 : 0;

  const sortDesc = (lines: PlLine[]) =>
    [...lines].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const income: PlBucket = {
    key: "income",
    label: "Income",
    total: totalIncome,
    lines: sortDesc(incomeLines),
    pctOfIncome: 100,
  };
  const variableCosts: PlBucket = {
    key: "variable",
    label: costSplitEstimated ? "Variable costs (estimated)" : "Variable costs",
    total: totalVariable,
    lines: sortDesc(variableLines),
    pctOfIncome: pct(totalVariable),
  };
  const fixedExpenses: PlBucket = {
    key: "fixed",
    label: "Fixed expenses",
    total: totalFixed,
    lines: sortDesc(fixedLines),
    pctOfIncome: pct(totalFixed),
  };
  const otherIncome: PlBucket | null = otherIncomeLines.length
    ? {
        key: "otherIncome",
        label: "Other income",
        total: totalOtherIncome,
        lines: sortDesc(otherIncomeLines),
        pctOfIncome: pct(totalOtherIncome),
      }
    : null;
  const otherExpense: PlBucket | null = otherExpenseLines.length
    ? {
        key: "otherExpense",
        label: "Other expenses",
        total: totalOtherExpense,
        lines: sortDesc(otherExpenseLines),
        pctOfIncome: pct(totalOtherExpense),
      }
    : null;

  return {
    income,
    variableCosts,
    fixedExpenses,
    otherIncome,
    otherExpense,
    totalIncome,
    totalVariable,
    totalFixed,
    grossProfit,
    grossMarginPct,
    netProfit,
    netMarginPct,
    costSplitEstimated,
    hasCogsSection,
    isEmpty: totalIncome === 0 && totalVariable === 0 && totalFixed === 0,
  };
}

// ─── Plain-English margin commentary (shared by Overview + P&L) ───────────

export function marginVerdict(pct: number): { label: string; tone: "emerald" | "teal" | "amber" | "red" } {
  if (pct >= 25) return { label: "healthy", tone: "emerald" };
  if (pct >= 15) return { label: "solid", tone: "teal" };
  if (pct >= 5) return { label: "thin", tone: "amber" };
  if (pct >= 0) return { label: "very thin", tone: "amber" };
  return { label: "negative", tone: "red" };
}
