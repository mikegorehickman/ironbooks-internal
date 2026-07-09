/**
 * Loan P&I analyzer — finds a client's loan accounts and the payments posted
 * to them, then works out the principal/interest split for each payment.
 *
 * The classic mess this fixes: every loan payment posted 100% against the
 * loan liability (interest never expensed) — or the inverse, month-end AJEs
 * dumping whole payments into Interest Expense. Both make the P&L and the
 * balance sheet wrong.
 *
 * Split strategy, strongest evidence first:
 *   1. statement_interest — a lender statement import carries the actual
 *      interest per payment (imported_records.fee_amount, see csv-adapters
 *      loan_statement). Exact, per the lender.
 *   2. stated_rate — the loan account's name/description carries a rate
 *      ("Ford Credit 7.9%") → declining-balance split at that rate.
 *   3. unsolvable — no statement, no rate. We DON'T invent a ratio (the old
 *      scaffold hardcoded 80/20); we surface a flagged summary instead so the
 *      bookkeeper uploads a statement or posts the split manually.
 *
 * Pure computation + QBO reads. Posting stays in the cleanup module
 * (propose → bookkeeper approves → execute).
 */

import { fetchAllAccounts, fetchTransactionsForAccount, type QBOAccount } from "@/lib/qbo";

export interface LoanPayment {
  txnId: string;
  txnType: string; // Purchase (cheque/expense)
  date: string; // YYYY-MM-DD
  /** Portion of the transaction posted to the loan account (the "principal" as booked). */
  amount: number;
}

export interface PaymentSplit {
  date: string;
  payment: number;
  interest: number;
  principal: number;
  txnId?: string;
  source: "statement" | "computed";
}

export interface LoanAnalysis {
  accountId: string;
  accountName: string;
  accountType: string;
  currentBalance: number;
  statedAnnualRatePct: number | null;
  payments: LoanPayment[]; // newest first
  method: "statement_interest" | "stated_rate" | "unsolvable";
  splits: PaymentSplit[]; // oldest first (declining balance runs forward)
  totalInterest: number;
  note: string;
}

const LOAN_NAME_RE =
  /loan|note.?payable|line of credit|\bloc\b|financ|mortgage|vehicle|equipment|truck|van/i;
// Liability accounts that are NOT lender debt — never treat as loans.
const NOT_LOAN_RE =
  /gst|hst|pst|sales tax|payroll|source deduction|wcb|workers.?comp|credit card|visa|mastercard|amex|due to|shareholder|deferred/i;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pull a stated annual rate out of an account name/description ("7.9%"). */
export function statedRateFromText(text: string): number | null {
  const m = /(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(text || "");
  if (!m) return null;
  const pct = Number(m[1]);
  return pct > 0 && pct < 40 ? pct : null; // sanity band for lending rates
}

/** Identify the loan liability accounts in a chart. */
export function detectLoanAccounts(accounts: QBOAccount[]): QBOAccount[] {
  return accounts.filter((a) => {
    if (a.Active === false) return false;
    if (!["Long Term Liability", "Other Current Liability"].includes(a.AccountType)) return false;
    const label = `${a.Name} ${a.Description || ""}`;
    if (NOT_LOAN_RE.test(label)) return false;
    return LOAN_NAME_RE.test(label) || a.AccountSubType === "NotesPayable";
  });
}

/** Payments (Purchases/cheques) posted against a loan account. */
export async function fetchLoanPayments(
  realmId: string,
  accessToken: string,
  loanAccountId: string
): Promise<LoanPayment[]> {
  const byType = await fetchTransactionsForAccount(realmId, accessToken, loanAccountId, [
    "Purchase",
  ]);
  const out: LoanPayment[] = [];
  for (const { type, transactions } of byType) {
    for (const tx of transactions) {
      const hit = (tx.Line || [])
        .filter(
          (l: any) =>
            l?.AccountBasedExpenseLineDetail?.AccountRef?.value === loanAccountId &&
            Number(l.Amount) > 0
        )
        .reduce((s: number, l: any) => s + Number(l.Amount), 0);
      if (hit > 0.005 && tx.TxnDate) {
        out.push({ txnId: tx.Id, txnType: type, date: tx.TxnDate, amount: round2(hit) });
      }
    }
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  return out;
}

/**
 * Declining-balance split at a known annual rate. The payments were posted
 * 100% to the loan, so the balance BEFORE the window = current balance plus
 * everything posted in the window (books were presumed right up to then).
 * Walk forward: interest_i = balance × rate/12, principal_i = payment − interest.
 */
export function splitAtRate(
  payments: LoanPayment[], // any order
  currentBalance: number,
  annualRatePct: number
): PaymentSplit[] {
  const asc = [...payments].sort((a, b) => (a.date > b.date ? 1 : -1));
  const posted = asc.reduce((s, p) => s + p.amount, 0);
  // QBO reports liability balances as negative or positive depending on sign
  // convention upstream — work with magnitude.
  let balance = Math.abs(currentBalance) + posted;
  const monthlyRate = annualRatePct / 100 / 12;
  const splits: PaymentSplit[] = [];
  for (const p of asc) {
    const interest = Math.min(round2(balance * monthlyRate), p.amount);
    const principal = round2(p.amount - interest);
    splits.push({
      date: p.date,
      payment: p.amount,
      interest,
      principal,
      txnId: p.txnId,
      source: "computed",
    });
    balance = Math.max(0, round2(balance - principal));
  }
  return splits;
}

/**
 * Analyze one loan account. statementRows = imported lender records matched to
 * this loan (fee_amount = interest when the CSV had it).
 */
export function analyzeLoan(
  account: QBOAccount,
  payments: LoanPayment[],
  statementRows: Array<{ date: string | null; gross: number; interest: number }>
): LoanAnalysis {
  const statedRate = statedRateFromText(`${account.Name} ${account.Description || ""}`);
  const base = {
    accountId: account.Id,
    accountName: account.Name,
    accountType: account.AccountType,
    currentBalance: account.CurrentBalance,
    statedAnnualRatePct: statedRate,
    payments,
  };

  // 1. Lender statement with real interest → exact splits.
  const withInterest = statementRows.filter((r) => r.interest > 0.005 && r.gross > 0.005);
  if (withInterest.length > 0) {
    const splits: PaymentSplit[] = withInterest
      .map((r) => ({
        date: r.date || "",
        payment: round2(r.gross),
        interest: round2(r.interest),
        principal: round2(r.gross - r.interest),
        source: "statement" as const,
      }))
      .sort((a, b) => (a.date > b.date ? 1 : -1));
    return {
      ...base,
      method: "statement_interest",
      splits,
      totalInterest: round2(splits.reduce((s, x) => s + x.interest, 0)),
      note: `Interest per lender statement (${splits.length} payments).`,
    };
  }

  // 2. Stated rate on the account → declining-balance estimate.
  if (statedRate && payments.length > 0) {
    const splits = splitAtRate(payments, account.CurrentBalance, statedRate);
    return {
      ...base,
      method: "stated_rate",
      splits,
      totalInterest: round2(splits.reduce((s, x) => s + x.interest, 0)),
      note: `Estimated at the ${statedRate}% rate stated on the account (declining balance). Verify against the lender statement.`,
    };
  }

  // 3. Nothing to compute from — do NOT invent a ratio.
  return {
    ...base,
    method: "unsolvable",
    splits: [],
    totalInterest: 0,
    note:
      payments.length > 0
        ? `${payments.length} payment(s) posted 100% to the loan with no interest split, and no statement or stated rate to split from. Upload the lender statement (with an interest column) or add the rate to the account name (e.g. "– 7.9%") and re-run.`
        : "No loan payments found in QBO for this account.",
  };
}

/** Convenience: whole-chart detection + payment fetch. */
export async function analyzeClientLoans(
  realmId: string,
  accessToken: string,
  statementRowsByLender: Map<string, Array<{ date: string | null; gross: number; interest: number }>>
): Promise<LoanAnalysis[]> {
  const accounts = await fetchAllAccounts(realmId, accessToken);
  const loans = detectLoanAccounts(accounts);
  const out: LoanAnalysis[] = [];
  for (const acct of loans) {
    const payments = await fetchLoanPayments(realmId, accessToken, acct.Id);
    // Match statement rows to this loan by lender-name overlap with the account name.
    const acctNorm = acct.Name.toLowerCase();
    let rows: Array<{ date: string | null; gross: number; interest: number }> = [];
    for (const [lender, list] of statementRowsByLender) {
      const l = lender.toLowerCase();
      if (l && (acctNorm.includes(l) || l.includes(acctNorm.split(" ")[0]))) {
        rows = rows.concat(list);
      }
    }
    // A single imported statement with no lender match still applies when the
    // client has exactly ONE loan account — the common case.
    if (rows.length === 0 && loans.length === 1 && statementRowsByLender.size > 0) {
      for (const list of statementRowsByLender.values()) rows = rows.concat(list);
    }
    out.push(analyzeLoan(acct, payments, rows));
  }
  return out;
}
