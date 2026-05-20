/**
 * Adjusting journal entry suggester for Balance Sheet reconciliation.
 *
 * Given an account category + the QBO ledger balance + the bookkeeper-
 * supplied statement balance, produce:
 *   - a one-line summary of the gap
 *   - plain-English reasoning about likely causes
 *   - a suggested JE (DR/CR rows + amount) if applicable
 *
 * The output is informational — the bookkeeper still has to enter the
 * JE in QBO. Eventually we could auto-post via the QBO API but the
 * preview-only stage builds confidence in the logic first.
 */

export type AccountCategory =
  | "personal"
  | "business_checking"
  | "business_savings"
  | "loan_cc";

export interface JESuggestion {
  /** Headline status: 'matched' (gap < $0.50), 'gap', or 'no_balance' (no statement entered). */
  status: "matched" | "gap" | "no_balance";
  /** statement - qbo. Positive = QBO is missing money; negative = QBO has extra. */
  gap: number;
  /** Short headline for the row. */
  summary: string;
  /** Plain-English reasoning, 1-3 sentences. */
  reasoning: string;
  /** Suggested JE lines. Empty if no JE needed (matched or unclear). */
  je_lines: JELine[];
}

export interface JELine {
  side: "debit" | "credit";
  account_hint: string; // e.g. "Owner's Equity" or "Interest Expense" — bookkeeper picks the actual QBO account
  amount: number;
  description: string;
}

const TOLERANCE = 0.5;

export function suggestJE(opts: {
  category: AccountCategory | null;
  account_name: string;
  qbo_balance: number;
  statement_balance: number | null;
  statement_date: string | null;
}): JESuggestion {
  if (opts.statement_balance == null || opts.statement_balance === undefined) {
    return {
      status: "no_balance",
      gap: 0,
      summary: "No statement balance entered",
      reasoning: "Enter the statement ending balance + as-of date to compute the gap.",
      je_lines: [],
    };
  }

  const gap = Number(opts.statement_balance) - Number(opts.qbo_balance);
  const absGap = Math.abs(gap);

  if (absGap < TOLERANCE) {
    return {
      status: "matched",
      gap,
      summary: "Reconciled cleanly",
      reasoning: `Statement and QBO ledger agree (within $${TOLERANCE.toFixed(2)} tolerance). No adjusting entry needed for this account.`,
      je_lines: [],
    };
  }

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(Math.abs(n));

  const cat = opts.category;

  // ── PERSONAL ACCOUNT ──
  // Commingled personal funds shouldn't be on the books at all. The
  // entire gap is typically owner-money flowing in or out. We suggest
  // routing it through Owner's Equity (or Owner Draws if expense-flavor).
  if (cat === "personal") {
    if (gap > 0) {
      // QBO ledger LOWER than statement → personal funds added that we
      // never recorded. Money came IN to the account from the owner.
      return {
        status: "gap",
        gap,
        summary: `${fmt(gap)} owner contribution not yet booked`,
        reasoning: `${opts.account_name} is a personal account. Statement shows ${fmt(gap)} more than QBO — most likely owner-funded deposits that weren't recorded. Book as an Owner Contribution to Equity. If this account doesn't belong on the business books at all, talk to the client about removing it.`,
        je_lines: [
          {
            side: "debit",
            account_hint: opts.account_name,
            amount: gap,
            description: "Catch up to bank statement balance",
          },
          {
            side: "credit",
            account_hint: "Owner Contribution / Equity",
            amount: gap,
            description: "Personal funds added to business account",
          },
        ],
      };
    }
    // gap < 0 → QBO HIGHER than statement → money left the account that
    // was never recorded (owner draws / personal expenses paid out).
    return {
      status: "gap",
      gap,
      summary: `${fmt(gap)} owner draw not yet booked`,
      reasoning: `${opts.account_name} is a personal account. QBO shows ${fmt(gap)} more than the statement — typically owner draws or personal expenses paid out that weren't recorded. Book as an Owner Draw against Equity. Consider removing this account from QBO going forward if it's not meant to track business activity.`,
      je_lines: [
        {
          side: "debit",
          account_hint: "Owner Draw / Equity",
          amount: -gap,
          description: "Personal expenses paid from this account",
        },
        {
          side: "credit",
          account_hint: opts.account_name,
          amount: -gap,
          description: "Catch up to bank statement balance",
        },
      ],
    };
  }

  // ── LOAN / CREDIT CARD ──
  // QBO HIGHER than statement (i.e. statement shows a smaller balance
  // owed than QBO) → could be missing interest expense, or
  // over-recorded principal.
  // QBO LOWER → missing payments OR mis-split interest.
  if (cat === "loan_cc") {
    if (gap > 0) {
      // statement > QBO → liability is bigger than QBO shows. QBO is
      // missing interest accrual or new charges.
      return {
        status: "gap",
        gap,
        summary: `Liability under-recorded by ${fmt(gap)}`,
        reasoning: `${opts.account_name} statement shows ${fmt(gap)} more owed than QBO. Likely causes: (1) interest charges not yet booked, (2) new CC charges missing from the bank feed, (3) a payment was incorrectly applied to principal when it should have been interest expense.`,
        je_lines: [
          {
            side: "debit",
            account_hint: "Interest Expense (or relevant expense)",
            amount: gap,
            description: "Catch up missing interest / charges",
          },
          {
            side: "credit",
            account_hint: opts.account_name,
            amount: gap,
            description: "Match the statement balance",
          },
        ],
      };
    }
    // gap < 0 → statement < QBO → QBO has more debt than statement.
    // Usually means a payment was booked twice OR principal was
    // under-allocated.
    return {
      status: "gap",
      gap,
      summary: `Liability over-recorded by ${fmt(gap)}`,
      reasoning: `${opts.account_name} statement shows ${fmt(gap)} less owed than QBO. Possible causes: (1) a payment was double-booked, (2) the principal portion of recent payments was understated (interest over-allocated), (3) lender wrote off a portion. Audit recent payments first.`,
      je_lines: [
        {
          side: "debit",
          account_hint: opts.account_name,
          amount: -gap,
          description: "Reduce liability to match statement",
        },
        {
          side: "credit",
          account_hint: "Interest Expense (adjustment) or Loan reconciliation",
          amount: -gap,
          description: "Reverse over-recorded interest / fix split",
        },
      ],
    };
  }

  // ── BUSINESS CHECKING / SAVINGS ──
  // Generic cash gap. The fix is almost always "find the missing /
  // duplicate transactions" rather than a single JE.
  if (cat === "business_checking" || cat === "business_savings") {
    if (gap > 0) {
      return {
        status: "gap",
        gap,
        summary: `QBO missing ${fmt(gap)} of activity`,
        reasoning: `${opts.account_name} statement is ${fmt(gap)} higher than QBO. QBO is missing one or more deposits (or has duplicated outflows). Don't post a plug JE — find the missing transactions in the bank feed or statement and book them properly. If the gap is small and you've audited, a "Reconciliation Adjustment" to Other Income/Expense is acceptable.`,
        je_lines: [],
      };
    }
    return {
      status: "gap",
      gap,
      summary: `QBO has ${fmt(gap)} of extra activity`,
      reasoning: `${opts.account_name} QBO ledger is ${fmt(gap)} higher than the statement. QBO has one or more transactions the bank doesn't (duplicate deposits, missing outflows, or a forced "Opening Balance" entry that doesn't match reality). Find and correct the offending transactions before posting any JE.`,
      je_lines: [],
    };
  }

  // ── No category set ──
  return {
    status: "gap",
    gap,
    summary: `${fmt(gap)} gap (uncategorized account)`,
    reasoning: `Categorize the account (Personal / Business Checking / Business Savings / Loan-CC) to get a targeted JE suggestion.`,
    je_lines: [],
  };
}
