/**
 * Payees whose NAME can never determine the account.
 *
 * WHY THIS EXISTS. RocketPainter Kingston has seven bank lines whose entire memo
 * is the string "GOVERNMENT CANADA" — $4.09 to $16,862.06, identical payee,
 * identical description, no reference number. Five were auto-approved to
 * Uncategorized Expense at 100% confidence; two went to Payroll Taxes. Nothing in
 * the feed distinguishes them, so no categorizer and no bookkeeper can tell them
 * apart from the data alone.
 *
 * The reason it matters more than ordinary miscategorization is that a tax
 * authority payment is not reliably an expense at all:
 *
 *   payroll source deductions  → clears the payroll liability the paycheque made
 *   GST/HST or sales-tax       → clears a LIABILITY; never touches the P&L
 *   corporate tax instalment   → income tax, not an operating expense
 *   a refund                   → a credit, not a debit
 *
 * Booking one to an expense account both overstates expenses AND leaves the
 * liability unrelieved — wrong on both sides of the entry.
 *
 * So these always go to the client with the question written out. That is not a
 * failure of the categorizer; it is the only correct answer from this input.
 *
 * Pure and dependency-free.
 */

/** Canada. "Receiver General" is the payee CRA cheques are made out to. */
const CA_PATTERNS = [
  /\bgovern?ment\s+(of\s+)?canada\b/i,
  /\breceiver\s+general\b/i,
  /\bcanada\s+revenue\b/i,
  /\bagence\s+du\s+revenu\b/i,
  /\brevenu\s+qu[eé]bec\b/i,
  /\bcra\s+(payment|remit|remittance)\b/i,
];

/** US federal + the common state-revenue wordings. */
const US_PATTERNS = [
  /\b(irs|internal\s+revenue)\b/i,
  /\beftps\b/i,
  /\bus\s+treasury\b/i,
  /\bunited\s+states\s+treasury\b/i,
  /\bdept?\.?\s+of\s+revenue\b/i,
  /\bdepartment\s+of\s+revenue\b/i,
  /\bfranchise\s+tax\s+board\b/i,
  /\bstate\s+of\s+\w+\s+tax\b/i,
];

export type TaxAuthority = "CA" | "US";

/**
 * Is this payee/memo a tax authority? Matched against the payee AND the memo
 * together, because the bank often puts the identifying word in only one of them.
 */
export function taxAuthorityFor(
  payee: string | null | undefined,
  memo?: string | null
): TaxAuthority | null {
  const blob = `${payee || ""} ${memo || ""}`;
  if (!blob.trim()) return null;
  if (CA_PATTERNS.some((r) => r.test(blob))) return "CA";
  if (US_PATTERNS.some((r) => r.test(blob))) return "US";
  return null;
}

export function isTaxAuthorityPayee(payee: string | null | undefined, memo?: string | null): boolean {
  return taxAuthorityFor(payee, memo) !== null;
}

/**
 * A payment to a tax authority CAN be safely categorized when the memo says which
 * kind it is — some banks do include it. Only then, and the caller still decides
 * what to do with the answer.
 */
export type RemittanceKind = "payroll" | "sales_tax" | "income_tax" | null;

export function remittanceKindFromMemo(memo: string | null | undefined): RemittanceKind {
  const m = (memo || "").toLowerCase();
  if (!m) return null;
  if (/\b(payroll\w*|source\s+ded\w*|p\.?d\.?7a|941|940)\b/.test(m)) return "payroll";
  if (/\b(gst|hst|qst|pst|sales\s+tax\w*|vat)\b/.test(m)) return "sales_tax";
  if (/\b(corp\w*\s+tax\w*|income\s+tax\w*|instal?ment\w*|t2\b|1120|estimated\s+tax\w*)\b/.test(m)) return "income_tax";
  return null;
}

/**
 * The question to put in front of the client, with the amount and date in it so
 * they can find it on their own statement without a follow-up email.
 *
 * Deliberately lists the possibilities rather than asking an open question — a
 * client asked "what was this?" replies "a payment to CRA", which we already knew.
 */
export function taxRemittanceQuestion(opts: {
  authority: TaxAuthority;
  amount: number;
  date: string | null;
  payee?: string | null;
}): string {
  const amount = `$${Math.abs(opts.amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  const when = opts.date ? ` on ${opts.date}` : "";
  const who = opts.authority === "CA" ? "CRA" : "the tax authority";
  const kinds =
    opts.authority === "CA"
      ? "payroll source deductions, a GST/HST remittance, or a corporate tax instalment"
      : "payroll taxes (941/940), a sales-tax remittance, or an income-tax estimate";
  return (
    `${amount}${when} to ${who} — which was it: ${kinds}? ` +
    `We can't tell from the bank description ("${(opts.payee || "").trim() || "no detail"}"), and each one posts ` +
    `to a different account. Your ${
      opts.authority === "CA" ? "CRA My Business Account" : "tax authority"
    } remittance history will show it.`
  );
}

/** Why this can't be auto-categorized — shown to the bookkeeper, not the client. */
export function taxRemittanceReasoning(authority: TaxAuthority, memo: string | null | undefined): string {
  const kind = remittanceKindFromMemo(memo);
  if (kind) {
    const label =
      kind === "payroll"
        ? "payroll source deductions"
        : kind === "sales_tax"
        ? "a sales-tax remittance"
        : "an income-tax payment";
    return (
      `Tax authority payment, and the memo indicates ${label}. Confirm before posting — ` +
      `payroll and sales-tax remittances CLEAR A LIABILITY rather than creating an expense.`
    );
  }
  return (
    `Payment to a tax authority with nothing in the description to say which kind. ` +
    `It could be payroll source deductions (clears a payroll liability), a sales-tax ` +
    `remittance (clears a liability — never a P&L expense), an income-tax instalment, or a ` +
    `refund. The payee name cannot decide this, so it goes to the client rather than to an ` +
    `expense account.`
  );
}
