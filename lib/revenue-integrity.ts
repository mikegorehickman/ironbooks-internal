/**
 * Revenue integrity — deposits posted straight into revenue accounts.
 *
 * The failure mode (found live on Clean Your Carpets, Jul 2026): the client
 * invoices every job through their field platform (Housecall Pro etc.), so
 * revenue is recognized when the invoice posts. When the batch payout lands
 * in the bank a few days later, the bank feed (or a QBO bank rule, or an
 * auto-categorizer) codes that deposit to a revenue account instead of
 * matching it against the invoices. The same money is now revenue twice:
 * once as the invoice, once as the deposit. CYC was overstated ~$35K in H1.
 *
 * The tell is structural, not fuzzy: a Deposit transaction posting to an
 * ordinary Income account, usually with no customer name and no doc number,
 * in a set of books where Invoices/Sales Receipts carry the revenue.
 *
 * Other Income (interest, gain on asset sales) is EXPECTED to receive
 * deposits — those are reported separately as informational, never flagged.
 *
 * Pure analysis over already-fetched data; no QBO calls here. Consumed by:
 *   - lib/books-verification.ts  (deposits_in_revenue close-gate check)
 *   - app/api/admin/revenue-integrity-sweep  (fleet scan)
 *   - lib/daily-recon.ts guards against creating NEW ones (deposit_to_income)
 */

import type { PLDetailRow } from "./qbo-reports";

export interface DepositIntoIncomeRow {
  txn_id: string;
  date: string;
  account: string;
  amount: number;
  /** Customer on the deposit line — usually null, which is the tell. */
  name: string | null;
  doc_number: string | null;
}

export interface RevenueIntegrityReport {
  /** Ordinary Income accounts (AccountType "Income") present in the COA. */
  incomeAccounts: string[];
  invoiceCount: number;
  invoiceTotal: number;
  /** Deposits posted into ordinary Income accounts — the suspect set. */
  depositRows: DepositIntoIncomeRow[];
  depositCount: number;
  depositTotal: number;
  /** Subset of depositTotal with no customer name (strongest signal). */
  depositNoNameTotal: number;
  /** Deposits into Other Income (interest, asset sales) — informational only. */
  otherIncomeDepositTotal: number;
  /**
   * True when this book looks invoice-driven AND deposits are also landing
   * in revenue — the double-count pattern. Small books with no invoicing
   * (pure cash businesses) are NOT flagged; a deposit is their only way to
   * record a sale.
   */
  flagged: boolean;
  reason: string;
}

/** Materiality floor: ignore books where suspect deposits total under this. */
export const DEPOSIT_TO_INCOME_FLOOR = 500;

/** Minimum invoice presence for "this book is invoice-driven". */
const INVOICE_DRIVEN_MIN_COUNT = 10;

const isDeposit = (t: string) => /^deposit$/i.test((t || "").trim());
const isInvoiceLike = (t: string) => /invoice|sales receipt/i.test(t || "");

export interface AccountTypeInfo {
  name: string;
  accountType: string; // QBO AccountType, e.g. "Income", "Other Income"
}

/**
 * Analyze one client's P&L detail for deposits posted into revenue.
 *
 * `accounts` is the live COA (name + AccountType) — detail rows carry only
 * the account NAME, so classification joins on name. Accounts missing from
 * the list (deleted accounts still showing history) are treated as ordinary
 * income only when the P&L already grouped them under income — the caller
 * passes `incomeSectionAccounts` for that (account names it saw under the
 * Income group on the summary P&L). Either signal marks an account income.
 */
export function analyzeDepositsToIncome(
  plDetail: PLDetailRow[],
  accounts: AccountTypeInfo[],
  incomeSectionAccounts: string[] = []
): RevenueIntegrityReport {
  const lc = (s: string) => s.trim().toLowerCase();

  const ordinaryIncome = new Set<string>();
  const otherIncome = new Set<string>();
  for (const a of accounts) {
    if (a.accountType === "Income") ordinaryIncome.add(lc(a.name));
    else if (a.accountType === "Other Income") otherIncome.add(lc(a.name));
  }
  for (const name of incomeSectionAccounts) {
    const k = lc(name);
    if (!otherIncome.has(k)) ordinaryIncome.add(k);
  }

  let invoiceCount = 0;
  let invoiceTotal = 0;
  const depositRows: DepositIntoIncomeRow[] = [];
  let depositNoNameTotal = 0;
  let otherIncomeDepositTotal = 0;

  for (const r of plDetail) {
    const acct = lc(r.account || "");
    const inOrdinary = ordinaryIncome.has(acct);
    const inOther = otherIncome.has(acct);
    if (!inOrdinary && !inOther) continue;

    if (isInvoiceLike(r.txn_type)) {
      invoiceCount++;
      invoiceTotal += r.amount;
      continue;
    }
    if (!isDeposit(r.txn_type)) continue;

    if (inOther) {
      otherIncomeDepositTotal += r.amount;
      continue;
    }
    depositRows.push({
      txn_id: r.txn_id,
      date: r.date,
      account: r.account,
      amount: r.amount,
      name: r.name ?? null,
      doc_number: r.doc_number ?? null,
    });
    if (!r.name) depositNoNameTotal += r.amount;
  }

  // Largest first so the review list leads with the money.
  depositRows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const depositTotal = depositRows.reduce((s, r) => s + r.amount, 0);
  const round = (n: number) => Math.round(n * 100) / 100;

  const invoiceDriven = invoiceCount >= INVOICE_DRIVEN_MIN_COUNT || invoiceTotal > depositTotal;
  const material = depositTotal >= DEPOSIT_TO_INCOME_FLOOR;
  const flagged = invoiceDriven && material;

  let reason: string;
  if (depositRows.length === 0) {
    reason = "No deposits posted to ordinary income accounts.";
  } else if (!material) {
    reason = `Deposits into income total ${fmtUsd(depositTotal)} — under the ${fmtUsd(DEPOSIT_TO_INCOME_FLOOR)} floor.`;
  } else if (!invoiceDriven) {
    reason =
      "Deposits land in income but the book has no meaningful invoicing — deposits may be how this business records sales. Review, don't assume double-count.";
  } else {
    reason = `Invoice-driven book (${invoiceCount} invoices, ${fmtUsd(invoiceTotal)}) also has ${depositRows.length} deposit${depositRows.length === 1 ? "" : "s"} posted to revenue (${fmtUsd(depositTotal)}) — likely double-counted income.`;
  }

  return {
    incomeAccounts: [...ordinaryIncome],
    invoiceCount,
    invoiceTotal: round(invoiceTotal),
    depositRows,
    depositCount: depositRows.length,
    depositTotal: round(depositTotal),
    depositNoNameTotal: round(depositNoNameTotal),
    otherIncomeDepositTotal: round(otherIncomeDepositTotal),
    flagged,
    reason,
  };
}

function fmtUsd(n: number): string {
  return (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString();
}
