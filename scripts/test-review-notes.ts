/** Tests for splitReviewNote — the manager reject note → fix-list split.
 *  Run: npx tsx scripts/test-review-notes.ts
 *
 *  The three "real notes" cases below are verbatim from monthly_rec_runs
 *  (Kedma's rejects, 2026-08-04). Each was rendering as a SINGLE checkbox,
 *  which meant ticking it asserted every item in it was fixed.
 */
import { splitReviewNote } from "../lib/review-notes";

let pass = 0,
  fail = 0;

function eq(note: string | null | undefined, expected: string[], label: string) {
  const got = splitReviewNote(note);
  const ok = got.length === expected.length && got.every((g, i) => g === expected[i]);
  if (ok) pass++;
  else {
    fail++;
    console.error(`  ✗ ${label}\n     got:      ${JSON.stringify(got)}\n     expected: ${JSON.stringify(expected)}`);
  }
}

// ── The notes this change exists for ──────────────────────────────────────
eq(
  "Cash Income needs to be reviewed and reconciled. Concern that technician is not categorized in COGS. Please verify wages under expenses.",
  [
    "Cash Income needs to be reviewed and reconciled.",
    "Concern that technician is not categorized in COGS.",
    "Please verify wages under expenses.",
  ],
  "LT Woodworks — 3 asks in one paragraph"
);

// "$ 26k" must survive: the split requires whitespace AFTER the period.
eq(
  "$ 26k in deposits not reconciiled. WA state taxes sitting in expense account. Need verification.",
  [
    "$ 26k in deposits not reconciiled.",
    "WA state taxes sitting in expense account.",
    "Need verification.",
  ],
  "Taro — leading $ amount and a state abbreviation mid-note"
);

eq(
  "Please review under revenue the deposits that don't have an assigned customer. It just says mobile deposits, appears to be duplicate to rev.",
  [
    "Please review under revenue the deposits that don't have an assigned customer.",
    "It just says mobile deposits, appears to be duplicate to rev.",
  ],
  "James Painting — 2 asks"
);

// ── Explicit separators still work, and take precedence ───────────────────
eq("Fix A\nFix B\nFix C", ["Fix A", "Fix B", "Fix C"], "newlines");
eq("Fix A; Fix B; Fix C", ["Fix A", "Fix B", "Fix C"], "semicolons");
eq("- Fix A\n- Fix B", ["Fix A", "Fix B"], "dash bullets stripped");
eq("1. Fix A\n2. Fix B", ["Fix A", "Fix B"], "numbered list stripped");
eq("• Fix A\n• Fix B", ["Fix A", "Fix B"], "bullet chars stripped");
eq(
  "Reconcile the bank.\nAlso: UF is not zero. Check the deposits.",
  ["Reconcile the bank.", "Also: UF is not zero.", "Check the deposits."],
  "newlines AND sentences together"
);

// ── Must NOT split ────────────────────────────────────────────────────────
// No space after the period — decimals and versions stay whole.
eq("Margin is 1.5% not 15%.", ["Margin is 1.5% not 15%."], "decimal");
eq("Deposit of $2,847.60 is unmatched.", ["Deposit of $2,847.60 is unmatched."], "money with cents");
// Lowercase after the period is a continuation, not a new item.
eq("Check the COGS. then the wages.", ["Check the COGS. then the wages."], "lowercase after period");
// A single ask stays a single ask.
eq("Undeposited funds is not zero.", ["Undeposited funds is not zero."], "one sentence");

// ── Empty / junk ──────────────────────────────────────────────────────────
eq(null, [], "null");
eq(undefined, [], "undefined");
eq("", [], "empty string");
eq("   \n  ", [], "whitespace only");
eq("..", [], "punctuation debris dropped");
eq("OK", [], "two chars is below the floor");

console.log(`\nreview note split: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
