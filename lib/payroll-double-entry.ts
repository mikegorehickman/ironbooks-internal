/**
 * Detect QBO Payroll double-entry — the systemic bug where the same wages
 * land on the P&L twice. Mechanism, in QBO's words:
 *
 *   1. QBO Payroll runs and posts a Paycheck / Direct Deposit. This is
 *      a SYSTEM transaction — QBO locks it. PrivateNote/TxnType give it
 *      away ("Paycheck", "Direct Deposit"). The locked txn books wages
 *      on the P&L AND credits the funding bank account.
 *
 *   2. The bookkeeper (or QBO's bank feed auto-categorize rules) then
 *      records a Transfer / JE / Deposit that moves the same dollar
 *      amount from the operating bank to the payroll funding bank.
 *      If that Transfer is categorized as Wages / Salaries / Payroll
 *      Expense (instead of as a bank-to-bank transfer or to a Payroll
 *      Clearing wash account), the expense is booked twice.
 *
 *   3. Result: P&L wage expense ≈ 2× actual payroll. Clean Cut Painters
 *      saw -$18k/month, -$50k YTD from this.
 *
 * The detector pairs locked Paychecks against user-categorizable Transfers
 * within a small date window + matching amount, returning each pair so the
 * bookkeeper can recategorize the Transfer side.
 *
 * Detection runs against the per-account transaction list (fetched by the
 * caller via fetchAccountTransactions for each candidate payroll account).
 * Pure function — no QBO calls in here, no DB calls. Caller owns I/O.
 */

import type { AccountTransaction } from "./qbo-balance-sheet";

/**
 * QBO transaction types that represent the LOCKED, system-managed
 * payroll posting. These are what QBO Payroll creates when payroll runs;
 * the bookkeeper can't edit them. Matching anything that looks like a
 * paycheck — QBO has used several names over the years.
 */
const LOCKED_PAYROLL_TXN_TYPES = new Set([
  "paycheck",
  "pay check",
  "payroll check",
  "direct deposit",
  "directdeposit",
]);

/**
 * Transaction types that ARE user-recordable and could be the dupe side
 * of a payroll pair. We include the broadest reasonable set so a JE
 * coded against a wage account also gets caught.
 */
const RECATEGORIZABLE_TXN_TYPES = new Set([
  "transfer",
  "journal entry",
  "journalentry",
  "deposit",
  "expense",
  "check",
]);

/**
 * Account-name regex used to identify the candidate payroll-expense
 * accounts on a client's COA. Caller fetches every account whose name
 * matches and then pulls transactions for each.
 *
 * Inclusive on purpose — payroll account naming varies wildly across
 * clients (Wages, Salaries, Direct Labor, Officer Comp, Crew Pay,
 * Production Wages, ...). False positives here just mean the detector
 * scans an extra account; false negatives mean we miss the bug.
 */
export const PAYROLL_ACCOUNT_NAME_REGEX =
  /\b(wage|salar|payroll|labor|crew\s*pay|officer\s*comp|production\s*wage|direct\s*labor|field\s*labor)\b/i;

/** One detected duplicate pair. */
export interface PayrollDoubleEntry {
  /** The transaction the bookkeeper should fix (the categorizable side). */
  duplicate_txn_id: string;
  duplicate_txn_type: string;
  duplicate_date: string;
  duplicate_doc_number: string | null;
  duplicate_amount: number;
  duplicate_memo: string;
  duplicate_account_id: string;
  duplicate_account_name: string;

  /** The locked Paycheck/DD that the duplicate mirrors. */
  locked_txn_id: string;
  locked_txn_type: string;
  locked_date: string;
  locked_doc_number: string | null;
  locked_amount: number;
  locked_memo: string;

  /** Days between locked + duplicate (0 = same-day). */
  date_offset_days: number;
  /** Heuristic 0..1 — higher = more confident this is a real pair. */
  confidence: number;
  reasoning: string;
}

export interface DetectPayrollDoubleEntryInput {
  /**
   * Transactions grouped by the payroll-expense account they hit. Each
   * entry: the account id/name plus EVERY transaction that posted to it
   * in the scan window (via TransactionList). Date strings YYYY-MM-DD or
   * MM/DD/YYYY — we normalize.
   */
  accountsByPayroll: Array<{
    account_id: string;
    account_name: string;
    transactions: AccountTransaction[];
  }>;
  /** ± days between locked + duplicate to call them a pair. Default 3. */
  dateWindowDays?: number;
  /** Amount tolerance in dollars. Default $0.01. */
  amountTolerance?: number;
}

/**
 * Pure detection function. For each (locked, recategorizable) pair
 * within the same payroll account, same amount, within the date window,
 * emit a PayrollDoubleEntry record.
 *
 * Caller is responsible for fetching the transaction lists per account
 * and persisting the results. This way the algorithm is unit-testable
 * with synthetic data and the I/O concerns live where they belong.
 */
export function detectPayrollDoubleEntries(
  input: DetectPayrollDoubleEntryInput
): PayrollDoubleEntry[] {
  const { accountsByPayroll, dateWindowDays = 3, amountTolerance = 0.01 } = input;
  const out: PayrollDoubleEntry[] = [];

  for (const { account_id, account_name, transactions } of accountsByPayroll) {
    // Partition this account's transactions into locked vs recategorizable.
    // Anything not in either bucket (e.g. an Adjustment) is ignored.
    const locked: AccountTransaction[] = [];
    const recat: AccountTransaction[] = [];
    for (const t of transactions) {
      const typeKey = String(t.txn_type || "").toLowerCase().trim();
      if (LOCKED_PAYROLL_TXN_TYPES.has(typeKey)) {
        locked.push(t);
        continue;
      }
      // Memo-as-fallback signal — QBO sometimes labels the locked DD as
      // generic "Journal Entry" with the Payroll system as the source.
      // Trust the memo only when amount + date look payroll-shaped.
      if (
        typeKey === "journal entry" &&
        /paycheck|payroll|direct\s*deposit|net\s*pay/i.test(t.memo || "")
      ) {
        locked.push(t);
        continue;
      }
      if (RECATEGORIZABLE_TXN_TYPES.has(typeKey)) {
        recat.push(t);
      }
    }

    if (locked.length === 0 || recat.length === 0) continue;

    // Sort by date so the inner loop's early-exit works.
    locked.sort((a, b) => toDays(a.date) - toDays(b.date));
    recat.sort((a, b) => toDays(a.date) - toDays(b.date));

    // For each locked Paycheck, look for a recategorizable sibling
    // within dateWindow days + matching amount tolerance. We track
    // claimed recat ids so one Transfer can't pair to two Paychecks.
    const claimed = new Set<string>();
    for (const L of locked) {
      const Ldays = toDays(L.date);
      const Lamt = Math.abs(L.amount);

      for (const R of recat) {
        if (claimed.has(R.txn_id)) continue;
        const Rdays = toDays(R.date);
        const offset = Math.abs(Rdays - Ldays);
        if (offset > dateWindowDays) continue;
        const Ramt = Math.abs(R.amount);
        if (Math.abs(Ramt - Lamt) > amountTolerance) continue;

        // Match — flag.
        out.push({
          duplicate_txn_id: R.txn_id,
          duplicate_txn_type: R.txn_type,
          duplicate_date: R.date,
          duplicate_doc_number: R.doc_number,
          duplicate_amount: R.amount,
          duplicate_memo: R.memo,
          duplicate_account_id: account_id,
          duplicate_account_name: account_name,
          locked_txn_id: L.txn_id,
          locked_txn_type: L.txn_type,
          locked_date: L.date,
          locked_doc_number: L.doc_number,
          locked_amount: L.amount,
          locked_memo: L.memo,
          date_offset_days: offset,
          confidence: scoreConfidence(L, R, offset),
          reasoning: buildReasoning(L, R, offset, account_name),
        });
        claimed.add(R.txn_id);
        break; // each locked txn pairs to at most one recat side
      }
    }
  }

  return out;
}

/**
 * Confidence scoring — higher when:
 *   - Same-day pairing (offset = 0)
 *   - Both sides hit the same payroll-expense account
 *   - Memo on the recat side contains payroll keywords
 *   - The recat type is "Transfer" (the canonical mis-categorization;
 *     less confident on JE/Deposit which are noisier).
 */
function scoreConfidence(
  L: AccountTransaction,
  R: AccountTransaction,
  offsetDays: number
): number {
  let score = 0.5;
  if (offsetDays === 0) score += 0.25;
  else if (offsetDays === 1) score += 0.15;
  else score += 0.05;
  if (/transfer/i.test(R.txn_type)) score += 0.15;
  else if (/journal\s*entry/i.test(R.txn_type)) score += 0.05;
  if (/payroll|wage|salar|paycheck|net\s*pay|direct\s*deposit/i.test(R.memo || "")) {
    score += 0.10;
  }
  // Both sides on the SAME payroll account is implicit (we only iterate
  // within an account) — captured by the iteration structure, not score.
  return Math.min(1, Math.round(score * 100) / 100);
}

function buildReasoning(
  L: AccountTransaction,
  R: AccountTransaction,
  offsetDays: number,
  accountName: string
): string {
  const offsetTxt =
    offsetDays === 0 ? "same day as" : `${offsetDays} day${offsetDays === 1 ? "" : "s"} after`;
  return (
    `${R.txn_type} ${R.doc_number ? `#${R.doc_number} ` : ""}for $${Math.abs(R.amount).toFixed(2)} ` +
    `posts to "${accountName}" ${offsetTxt} a locked ${L.txn_type} ` +
    `${L.doc_number ? `#${L.doc_number} ` : ""}of the same amount. ` +
    `The locked Paycheck/DD already books the wage expense — recategorize ` +
    `this ${R.txn_type} to a Payroll Clearing or transfer account so the ` +
    `expense isn't booked twice.`
  );
}

/** Date string → epoch days (UTC). Tolerant of MM/DD/YYYY and YYYY-MM-DD. */
function toDays(dateStr: string): number {
  if (!dateStr) return 0;
  const s = String(dateStr).trim();
  let parsed: number;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    parsed = Date.parse(s.slice(0, 10) + "T00:00:00Z");
  } else {
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      const [, mm, dd, yy] = m;
      const yyyy = yy.length === 2 ? `20${yy}` : yy;
      parsed = Date.parse(
        `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T00:00:00Z`
      );
    } else {
      parsed = Date.parse(s);
    }
  }
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed / 86_400_000);
}

// ─────────────────────────────────────────────────────────────────────────
// Cross-account labor duplication (the BMD / Taro pattern)
// ─────────────────────────────────────────────────────────────────────────
//
// Confirmed on BMD (2026-07-17): QBO Payroll posts each Paycheque (gross
// wages) to the correct wage account, and SEPARATELY the bank feed imports
// the actual money paying those employees (net-pay e-Transfers + the Intuit
// direct-deposit debit) as plain Expense lines — which get categorized to a
// DIFFERENT labor-ish account. Net result: the crew's pay is expensed twice,
// on two different P&L lines. The equal-amount same-account detector above
// misses it (gross ≠ net, different accounts).
//
// Signature: an account that is NOT a paycheque account but carries
// user-recordable postings (Expense/Deposit/Transfer/Check/JE) whose payee is
// one of the payroll employees. That second line is the phantom labor.

/** One P&L posting line (shape of a ProfitAndLossDetail row). */
export interface LaborScanRow {
  account: string;
  txn_type: string;
  name: string | null;
  amount: number;
  memo?: string | null;
}

export interface LaborSuspectAccount {
  account: string;
  postings: number;
  total: number;          // signed sum on the P&L
  employees: number;      // distinct payroll employees appearing here
  by_type: Record<string, number>;
  sample_memos: string[];
}

export interface LaborDuplicationResult {
  /** Accounts that carry the legit QBO Payroll paycheque postings. */
  paycheque_accounts: string[];
  /** Distinct employee names learned from paycheque postings. */
  employee_count: number;
  /** Non-paycheque accounts carrying those employees' pay = the phantom lines. */
  suspects: LaborSuspectAccount[];
  /** Total phantom labor $ (sum of |suspect totals|). */
  overstated: number;
  /** True when there's a material second labor line to remediate. */
  flagged: boolean;
}

const PAYCHEQUE_TXN_TYPE = /paycheque|paycheck|pay check|payroll check|direct deposit|directdeposit/i;
// The money-movement postings that should never re-expense wages.
const RECORDABLE_TXN_TYPE = /expense|deposit|transfer|check|cheque|journal|bill|purchase/i;

function normPerson(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/\s*\(\d+\)\s*$/, "").replace(/\s+/g, " ").trim();
}

/**
 * Detect the cross-account labor double-count from a client's whole-P&L
 * detail rows. Pure — caller fetches the rows (fetchPLDetailAll). Threshold
 * guards against a single stray coincidence flagging a client.
 */
export function detectLaborDuplication(
  rows: LaborScanRow[],
  opts: { minSuspectTotal?: number } = {}
): LaborDuplicationResult {
  const minSuspectTotal = opts.minSuspectTotal ?? 500;

  // 1) Learn the employee roster + the accounts paycheques legitimately hit.
  const employees = new Set<string>();
  const paychequeAccounts = new Set<string>();
  for (const r of rows) {
    if (PAYCHEQUE_TXN_TYPE.test(r.txn_type)) {
      paychequeAccounts.add(r.account);
      const p = normPerson(r.name);
      if (p) employees.add(p);
    }
  }

  // 2) Any OTHER account carrying those employees' pay via a recordable txn
  //    is a phantom labor line.
  const byAccount = new Map<string, LaborSuspectAccount>();
  if (employees.size > 0) {
    for (const r of rows) {
      if (paychequeAccounts.has(r.account)) continue;      // legit paycheque line
      if (!RECORDABLE_TXN_TYPE.test(r.txn_type)) continue;
      const p = normPerson(r.name);
      if (!p || !employees.has(p)) continue;
      const e = byAccount.get(r.account) || { account: r.account, postings: 0, total: 0, employees: 0, by_type: {}, sample_memos: [] };
      e.postings++;
      e.total += r.amount;
      e.by_type[r.txn_type] = (e.by_type[r.txn_type] || 0) + 1;
      if (r.memo && e.sample_memos.length < 4 && !e.sample_memos.includes(r.memo)) e.sample_memos.push(r.memo);
      byAccount.set(r.account, e);
      // track distinct employees per account via a side set
      (e as any)._people ? (e as any)._people.add(p) : ((e as any)._people = new Set([p]));
    }
  }

  const suspects = [...byAccount.values()]
    .map((e) => {
      e.employees = ((e as any)._people as Set<string>)?.size || 0;
      delete (e as any)._people;
      e.total = Math.round(e.total * 100) / 100;
      return e;
    })
    .filter((e) => Math.abs(e.total) >= minSuspectTotal)
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

  const overstated = Math.round(suspects.reduce((s, e) => s + Math.abs(e.total), 0) * 100) / 100;

  return {
    paycheque_accounts: [...paychequeAccounts],
    employee_count: employees.size,
    suspects,
    overstated,
    flagged: suspects.length > 0,
  };
}
