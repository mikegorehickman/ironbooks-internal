// Tests for the three-way statement enumeration.
// Run: npx tsx scripts/test-statement-enumeration.ts
import { enumerateAccounts, buildRequests, maskedLabel, declaredMatches, last4Of, type FeedEvidence } from "@/lib/statement-enumeration";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

const acct = (o: any) => ({ Id: "0", FullyQualifiedName: o.Name, AccountSubType: "", Classification: "", Active: true, SubAccount: false, CurrentBalance: 0, CurrentBalanceWithSubAccounts: 0, CurrencyRef: { value: "CAD" }, ...o });

// ── masking / matching primitives ──
ok(maskedLabel({ Name: "RBC Chequing", AcctNum: "00517053" }) === "RBC Chequing ****7053", "AcctNum → ****7053");
ok(maskedLabel({ Name: "BUS COMPLETE CHK (3362)" }) === "BUS COMPLETE CHK ****3362", "digits in name → masked");
ok(maskedLabel({ Name: "Petty Cash" }) === "Petty Cash", "no digits → unchanged");
// last-4 hunt: masked pattern in name/description, but NOT arbitrary digits
ok(last4Of({ Name: "Main Account" }) === null, "generic name → no last-4 (the noise case)");
ok(last4Of({ Name: "Chequing ****7053" }) === "7053", "**** mask in name");
ok(last4Of({ Name: "Operating", Description: "RBC business chequing ending 9983" }) === "9983", "'ending NNNN' in description");
ok(last4Of({ Name: "PC Financial Mastercard", Description: "Call 1-800-555-1234 for support" }) === null, "phone number in description is NOT taken as last-4");
ok(maskedLabel({ Name: "Operating", Description: "acct #4417" }) === "Operating ****4417", "masked pattern in description → masked label");
ok(declaredMatches("RBC chequing", "RBC Chequing ****7053"), "declared fuzzy-matches QBO name");
ok(declaredMatches("visa ending 7053", "TD Visa 7053"), "last-4 match wins");
ok(!declaredMatches("Scotiabank LOC", "RBC Chequing"), "different institutions don't match");

// ── three-way enumeration ──
const qbo = [
  acct({ Id: "1", Name: "RBC Chequing", AcctNum: "7053", AccountType: "Bank" }),
  acct({ Id: "2", Name: "TD Visa 4429", AccountType: "Credit Card" }),
  acct({ Id: "3", Name: "Zero Balance Savings", AccountType: "Bank" }),                 // zero-balance still enumerated
  acct({ Id: "4", Name: "F-150 Vehicle Loan", AccountType: "Long Term Liability" }),
  acct({ Id: "5", Name: "GST Payable", AccountType: "Other Current Liability" }),       // liability but NOT a loan
  acct({ Id: "6", Name: "Old Bank", AccountType: "Bank", Active: false }),              // inactive excluded
];
const feed: FeedEvidence = { firstSeenByAccount: new Map([["RBC Chequing", "2026-01-16"]]) };
const declared = [
  { name: "RBC chequing", kind: "bank" as const },
  { name: "Wealthsimple corporate card", kind: "credit_card" as const },                // NOT in QBO
];
const accounts: any = enumerateAccounts(qbo, feed, declared);
ok(accounts.filter((a: any) => a.kind === "bank").length === 2, "banks: RBC + zero-balance");
ok(accounts.some((a: any) => a.kind === "credit_card" && /wealthsimple/i.test(a.label)), "declared-missing keeps its declared kind");
ok(accounts.some((a: any) => a.qbo_account_id === "3"), "zero-balance account enumerated");
ok(!accounts.some((a: any) => a.qbo_account_name === "GST Payable"), "GST Payable not treated as loan");
ok(!accounts.some((a: any) => a.qbo_account_name === "Old Bank"), "inactive excluded");
ok(accounts.find((a: any) => a.qbo_account_id === "1")?.feed_first_date === "2026-01-16", "feed date attached");
ok(accounts.find((a: any) => a.qbo_account_id === "1")?.sources.includes("onboarding"), "declared matched to QBO account");
ok(accounts.missing.length === 1 && /wealthsimple/i.test(accounts.missing[0].name), "declared-but-missing surfaced");

// ── request building ── (this scenario HAS declared accounts)
const { requests, undeclared_asks } = buildRequests(accounts, { booksStart: "2025-01-01", today: "2026-07-13", hasDeclarations: true });
const rbc = requests.filter((r) => r.qbo_account_id === "1");
ok(rbc.length === 2, "RBC gets gap-CSV + monthly lines");
ok(/CSV/.test(rbc[0].label) && rbc[0].period_end === "2026-01-16", "gap CSV runs books-start → feed-connect");
ok(/monthly statements/i.test(rbc[1].label) && rbc[1].period_start === "2026-01-16", "statements resume at feed-connect");
ok(requests.some((r) => r.account_kind === "loan" && /principal & interest/.test(r.label)), "loan line asks for P&I split");
ok(requests.some((r) => r.account_kind === "crm_report"), "CRM report kept");
ok(requests.some((r) => r.account_kind === "open_invoices"), "open invoices kept");
ok(requests.some((r) => r.qbo_account_id === null && /wealthsimple/i.test(r.label)), "declared-missing still gets a request line");
// undeclared: TD Visa + Zero Balance are in QBO but weren't declared
ok(undeclared_asks.length === 2, `undeclared asks = TD Visa + zero-balance (got ${undeclared_asks.length})`);
ok(undeclared_asks.some((a) => /td visa/i.test(a.label)), "TD Visa flagged for business-or-personal confirm");

// ── no-declarations case: EVERY account reads as undeclared, so the
// business-or-personal ask must be SUPPRESSED (Dominion bug — statement
// line per account is fine, but not a redundant question per account). ──
const { requests: reqND, undeclared_asks: asksND } = buildRequests(accounts, {
  booksStart: "2025-01-01",
  today: "2026-07-13",
  hasDeclarations: false,
});
ok(asksND.length === 0, `no declarations → zero business-or-personal asks (got ${asksND.length})`);
ok(
  reqND.some((r) => r.qbo_account_id === "1"),
  "no declarations → statement request lines still generated per account"
);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
