/**
 * Per-client revenue recognition mode.
 *
 * `deposits_only` — for cash-basis clients whose field CRM (Jobber / DripJobs /
 * Housecall) pushes INVOICES into QBO. On the cash-basis P&L those invoices get
 * recognized as income, and the bank deposit that pays them is ALSO categorized
 * to a revenue account, so the same job is counted twice (Dominion Painters:
 * $1,002.58 invoice in Billable Expense Income + $1,132.91 deposit in Service
 * Revenue = the invoice net × 1.13 HST). In this mode SNAP recognizes revenue
 * from ACTUAL CASH RECEIPTS only and excludes the invoice-recognized income.
 *
 * This is the INVERSE of lib/revenue-integrity.ts (which treats the invoice as
 * truth and the deposit as the duplicate — the Clean Your Carpets case). Which
 * leg is real is a per-client policy: `revenue_recognition_mode` on client_links.
 *
 * Pure + dependency-free — fixture-tested. Consumed by monthly production
 * (statement P&L) and the close-verification gate.
 */

import type { PLDetailRow } from "./qbo-reports";

export type RevenueRecognitionMode = "standard" | "deposits_only";

/** Read a client's mode defensively (unknown / null → standard). */
export function normalizeRevenueMode(v: unknown): RevenueRecognitionMode {
  return v === "deposits_only" ? "deposits_only" : "standard";
}

/** A P&L-detail row hitting an ordinary-income account. */
function isIncomeSection(section: string | null | undefined): boolean {
  const s = (section || "").toLowerCase();
  if (!s) return false;
  if (/cost of goods|cogs|expense/.test(s)) return false;
  return /income|revenue|sales/.test(s);
}

/**
 * An income posting that came from an INVOICE (the CRM duplicate under
 * deposits_only). Actual cash receipts — Deposit, Sales Receipt, Payment,
 * Journal Entry, Transfer — are kept. Matched on the report's txn_type.
 */
export function isInvoiceRecognizedIncome(txnType: string | null | undefined): boolean {
  return /invoice/i.test(txnType || "");
}

export interface ExcludedIncomeRow {
  txn_id: string;
  date: string;
  account: string;
  name: string | null;
  doc_number: string | null;
  amount: number;
}

export interface RevenueAdjustment {
  mode: RevenueRecognitionMode;
  /** Invoice-recognized income removed from revenue (0 when mode=standard). */
  excludedInvoiceRevenue: number;
  /** Per-income-account amount removed, keyed by account NAME (for line-item adjust). */
  excludedByAccount: Record<string, number>;
  /** The excluded rows themselves, largest first — for review / the remediation step. */
  excludedRows: ExcludedIncomeRow[];
  /** Income kept (actual cash receipts). */
  keptCashRevenue: number;
}

const r2 = (n: number) => Math.round((n || 0) * 100) / 100;

/**
 * Split a period's cash-basis P&L detail into kept cash revenue vs excluded
 * invoice-recognized revenue. In `standard` mode nothing is excluded (the
 * returned adjustment is a no-op) so callers can apply it unconditionally.
 */
export function computeRevenueAdjustment(
  plDetail: PLDetailRow[] | null | undefined,
  mode: RevenueRecognitionMode
): RevenueAdjustment {
  const base: RevenueAdjustment = {
    mode,
    excludedInvoiceRevenue: 0,
    excludedByAccount: {},
    excludedRows: [],
    keptCashRevenue: 0,
  };
  if (!plDetail || plDetail.length === 0) return base;

  const excludedByAccount: Record<string, number> = {};
  const excludedRows: ExcludedIncomeRow[] = [];
  let excluded = 0;
  let kept = 0;

  for (const row of plDetail) {
    if (!isIncomeSection(row.section)) continue;
    const amount = Number(row.amount) || 0;
    // Only exclude in deposits_only mode; standard keeps everything.
    if (mode === "deposits_only" && isInvoiceRecognizedIncome(row.txn_type)) {
      excluded += amount;
      const acct = row.account || "(no account)";
      excludedByAccount[acct] = r2((excludedByAccount[acct] || 0) + amount);
      excludedRows.push({
        txn_id: row.txn_id,
        date: row.date,
        account: row.account,
        name: row.name ?? null,
        doc_number: row.doc_number ?? null,
        amount: r2(amount),
      });
    } else {
      kept += amount;
    }
  }

  excludedRows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return {
    mode,
    excludedInvoiceRevenue: r2(excluded),
    excludedByAccount,
    excludedRows,
    keptCashRevenue: r2(kept),
  };
}

export interface AdjustedPLTotals {
  totalIncome: number;
  grossProfit: number;
  netIncome: number;
  lineItems: { label: string; amount: number; group: string }[];
}

/**
 * Apply a revenue adjustment to summary P&L totals + income line items.
 * Removing invoice income drops totalIncome, grossProfit, and netIncome each
 * by the excluded amount (no offsetting expense), and reduces the affected
 * income line items by account name (a line that nets to ~0 is dropped).
 */
export function applyRevenueAdjustment(
  pl: {
    totalIncome: number;
    cogs: number;
    netIncome: number;
    lineItems: { label: string; amount: number; group: string }[];
  },
  adj: RevenueAdjustment
): AdjustedPLTotals {
  if (adj.excludedInvoiceRevenue === 0) {
    return {
      totalIncome: r2(pl.totalIncome),
      grossProfit: r2(pl.totalIncome - pl.cogs),
      netIncome: r2(pl.netIncome),
      lineItems: pl.lineItems,
    };
  }

  const totalIncome = r2(pl.totalIncome - adj.excludedInvoiceRevenue);
  const netIncome = r2(pl.netIncome - adj.excludedInvoiceRevenue);
  const grossProfit = r2(totalIncome - pl.cogs);

  const lineItems = pl.lineItems
    .map((li) => {
      const cut = adj.excludedByAccount[li.label];
      if (!cut) return li;
      return { ...li, amount: r2(li.amount - cut) };
    })
    // Drop income lines that were entirely CRM invoices (now ~0).
    .filter((li) => !(adj.excludedByAccount[li.label] && Math.abs(li.amount) < 0.005));

  return { totalIncome, grossProfit, netIncome, lineItems };
}
