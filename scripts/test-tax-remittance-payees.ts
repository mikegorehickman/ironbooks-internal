/** Tests for lib/tax-remittance-payees.ts.
 *  Run: npx tsx scripts/test-tax-remittance-payees.ts
 *
 *  Fixtured on the real RocketPainter Kingston rows, 2026-08-04: seven bank lines
 *  whose entire memo is "GOVERNMENT CANADA", $4.09 to $16,862.06, five of which
 *  were auto-approved to Uncategorized Expense at 100% confidence.
 */
import {
  taxAuthorityFor,
  isTaxAuthorityPayee,
  remittanceKindFromMemo,
  taxRemittanceQuestion,
  taxRemittanceReasoning,
} from "../lib/tax-remittance-payees";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const eq = (name: string, got: any, want: any) =>
  ok(`${name}${got === want ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

// ── Canada ────────────────────────────────────────────────────────────────
eq("GOVERNMENT CANADA (the actual RocketPainter memo)", taxAuthorityFor("GOVERNMENT CANADA"), "CA");
eq("Government of Canada", taxAuthorityFor("Government of Canada"), "CA");
eq("RECEIVER GENERAL (Rock Bound has this rule)", taxAuthorityFor("RECEIVER GENERAL"), "CA");
eq("Canada Revenue Agency", taxAuthorityFor("Canada Revenue Agency"), "CA");
eq("Agence du revenu", taxAuthorityFor("AGENCE DU REVENU DU CANADA"), "CA");
eq("Revenu Québec", taxAuthorityFor("Revenu Quebec"), "CA");

// ── US ────────────────────────────────────────────────────────────────────
eq("IRS", taxAuthorityFor("IRS USATAXPYMT"), "US");
eq("EFTPS", taxAuthorityFor("EFTPS TAX PAYMENT"), "US");
eq("US Treasury", taxAuthorityFor("UNITED STATES TREASURY"), "US");
eq("Dept of Revenue", taxAuthorityFor("NC DEPT OF REVENUE"), "US");
eq("Franchise Tax Board", taxAuthorityFor("CA FRANCHISE TAX BOARD"), "US");

// ── Payee and memo are checked TOGETHER ──────────────────────────────────
eq("identifier in the memo only", taxAuthorityFor("PRE-AUTH DEBIT", "RECEIVER GENERAL"), "CA");
eq("identifier in the payee only", taxAuthorityFor("GOVERNMENT CANADA", "PAD"), "CA");

// ── Must NOT sweep in ordinary vendors ───────────────────────────────────
for (const n of [
  "Sherwin-Williams", "PETRO-CANADA", "Canada Post", "Home Depot",
  "Government Employees Insurance", "Revenue Sharing Partners LLC",
  "Bank of Canada Museum", "TREASURY WINE ESTATES",
]) ok(`not a tax authority: "${n}"`, !isTaxAuthorityPayee(n));

ok("empty is safe", !isTaxAuthorityPayee(null, null));
ok("whitespace is safe", !isTaxAuthorityPayee("   "));

// ── Remittance kind, when the bank actually says ─────────────────────────
eq("payroll wording", remittanceKindFromMemo("RECEIVER GENERAL SOURCE DEDUCTIONS"), "payroll");
eq("PD7A", remittanceKindFromMemo("CRA PD7A REMIT"), "payroll");
eq("941", remittanceKindFromMemo("EFTPS 941 PAYMENT"), "payroll");
eq("GST/HST", remittanceKindFromMemo("GOVERNMENT CANADA GST/HST"), "sales_tax");
eq("sales tax", remittanceKindFromMemo("NC DEPT REVENUE SALES TAX"), "sales_tax");
eq("instalment", remittanceKindFromMemo("CRA CORP TAX INSTALMENT"), "income_tax");
eq("estimated tax", remittanceKindFromMemo("IRS ESTIMATED TAX"), "income_tax");
// The RocketPainter case: nothing to go on.
eq("bare GOVERNMENT CANADA gives no kind", remittanceKindFromMemo("GOVERNMENT CANADA"), null);
eq("empty memo", remittanceKindFromMemo(null), null);

// ── The client question ──────────────────────────────────────────────────
{
  const q = taxRemittanceQuestion({
    authority: "CA", amount: 16862.06, date: "2026-06-01", payee: "GOVERNMENT CANADA",
  });
  ok("carries the amount", q.includes("$16,862.06"));
  ok("carries the date", q.includes("2026-06-01"));
  ok("names CRA", q.includes("CRA"));
  // Listing the options is the point — "what was this?" gets "a payment to CRA".
  ok("lists payroll", /payroll source deductions/i.test(q));
  ok("lists GST/HST", /GST\/HST/i.test(q));
  ok("lists the instalment", /instal?ment/i.test(q));
  ok("tells them where to look", /My Business Account/i.test(q));
  ok("quotes what we actually saw", q.includes("GOVERNMENT CANADA"));
}
{
  const q = taxRemittanceQuestion({ authority: "US", amount: 500, date: null, payee: null });
  ok("US wording differs", /941/.test(q));
  ok("no date is fine", !q.includes("on null"));
  ok("says we had no detail", /no detail/.test(q));
}

// ── The bookkeeper-facing reasoning ──────────────────────────────────────
{
  const r = taxRemittanceReasoning("CA", "GOVERNMENT CANADA");
  ok("explains why the name can't decide", /payee name cannot decide/i.test(r));
  ok("warns sales tax is never a P&L expense", /never a P&L expense/i.test(r));
  ok("mentions the refund possibility", /refund/i.test(r));
}
{
  const r = taxRemittanceReasoning("CA", "CRA SOURCE DEDUCTIONS");
  ok("uses the memo when it has one", /payroll source deductions/i.test(r));
  ok("still warns about the liability", /CLEAR A LIABILITY/i.test(r));
}

console.log(`\ntax remittance payees: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
