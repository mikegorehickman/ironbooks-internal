/**
 * "Is this account a holding pen rather than a real category?"
 *
 * Shared by daily-recon and the reclass discovery pre-pass. It used to live
 * privately in lib/daily-recon.ts, which meant the reclass no-op check had no
 * concept of it — and that caused a real, measured production defect:
 *
 *   The no-op check skips a line as `already_correct` when the AI's target
 *   equals the account the line already sits in. When the AI cannot classify
 *   something it falls back to Uncategorized, so target == current ==
 *   "Uncategorized Expense" and the line was marked correct and abandoned.
 *   Fleet audit 2026-07-28: 920 lines, $568,385, across 33 clients.
 *
 * Match is lower-case substring so we catch "Uncategorized Expense",
 * "Uncategorised Expense" (UK spelling, used by QBO Global), "Uncategorized
 * Asset", and custom names like "Unassigned Expenses" without an exhaustive
 * enum.
 */
export const UNCATEGORIZED_ACCOUNT_PATTERNS = [
  "uncategorized",
  "uncategorised",   // UK spelling — QBO Global uses this
  "unassigned",
  "ask my accountant",
  "ask my client",   // SNAP convention for "client confirmation needed"
];

/**
 * Fails OPEN: a null/empty name counts as uncategorized. QBO's query API often
 * omits `AccountRef.name`, and treating an unknown account as "already fine" is
 * the failure mode that loses transactions.
 */
export function isUncategorizedAccount(accountName: string | null | undefined): boolean {
  if (!accountName) return true;
  const lower = accountName.toLowerCase();
  return UNCATEGORIZED_ACCOUNT_PATTERNS.some((p) => lower.includes(p));
}
