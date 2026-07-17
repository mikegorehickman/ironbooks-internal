// Verify the ≥$400 Intuit → payroll (not software) reclass guardrail.
// Run: npx tsx scripts/test-intuit-payroll-rule.ts
import { lookupVendor } from "@/lib/vendor-knowledge";
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

// Big Intuit payroll net-pay deposit → NOT software; flagged (low conf) as payroll.
let r = lookupVendor("QuickBooks Payments", "INTUIT 11169983 PAYROLL Payroll Deposit", 1316.39, "painters");
ok(r?.account === "Payroll Clearing", `$1,316 Intuit PAYROLL deposit → Payroll Clearing [got ${r?.account}]`);
ok((r?.confidence ?? 1) < 0.95, `flagged for review, not auto-posted [conf ${r?.confidence}]`);

// Bare big Intuit charge (no "payroll" word) still routed off software.
r = lookupVendor("Intuit", "INTUIT 8005 CA", 812.00, "painters");
ok(r?.account === "Payroll Clearing", `$812 bare Intuit → Payroll Clearing (not Software) [got ${r?.account}]`);

// Small QBO subscription stays software.
r = lookupVendor("Intuit", "INTUIT *QBooks Online TORONTO ON", 55.00, "painters");
ok(r?.account === "Software Subscriptions", `$55 QBO subscription → Software Subscriptions [got ${r?.account}]`);

// Small QBooks Payroll fee → Payroll Expenses (existing rule, under $400).
r = lookupVendor("QuickBooks Payments", "INTUIT *QBooks Payroll TORONTO ON", 50.00, "painters");
ok(r?.account === "Payroll Expenses", `$50 QBooks Payroll fee → Payroll Expenses [got ${r?.account}]`);

// QB Payments processing fee (small) → Bank Charges.
r = lookupVendor("QuickBooks Payments", "System-recorded fee for QuickBooks Payments", 27.16, "painters");
ok(r?.account === "Bank Charges", `$27 QB Payments fee → Bank Charges [got ${r?.account}]`);

// Non-Intuit big charge unaffected.
r = lookupVendor("Sherwin Williams", "SHERWIN WILLIAMS 700", 900.00, "painters");
ok(r?.account !== "Payroll Clearing", `$900 Sherwin not swept to payroll [got ${r?.account}]`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
