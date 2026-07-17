// Tests for cross-account labor duplication detector.
// Run: npx tsx scripts/test-labor-duplication.ts
import { detectLaborDuplication, type LaborScanRow } from "@/lib/payroll-double-entry";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

// The BMD shape: gross paycheques on one COGS labor account, net-pay
// e-Transfers/Intuit deposits miscategorized to "Workers Compensation".
const bmd: LaborScanRow[] = [
  // gross paycheques (legit)
  { account: "Direct Field Labor – Painting", txn_type: "Paycheque", name: "Mollie Markin (1)", amount: 2647.35 },
  { account: "Direct Field Labor – Painting", txn_type: "Paycheque", name: "Wolfrando Perez Prieto (1)", amount: 1128.24 },
  { account: "Direct Field Labor – Painting", txn_type: "Paycheque", name: "Bethany Blais", amount: 1310.40 },
  // source deductions ride the paycheque too — same legit account family
  { account: "Direct Labour Taxes", txn_type: "Paycheque", name: "Mollie Markin (1)", amount: 210.00 },
  // net pay miscategorized to WCB via bank feed (the phantom line)
  { account: "Workers Compensation – Field", txn_type: "Expense", name: "Wolfrando Perez Prieto", amount: 2079.25, memo: "e-Transfer sent" },
  { account: "Workers Compensation – Field", txn_type: "Expense", name: "Mollie Markin", amount: 1980.35, memo: "Mollie Markin e-Transfer sent" },
  { account: "Workers Compensation – Field", txn_type: "Expense", name: "Bethany Blais", amount: 1132.03, memo: "INTUIT PAYROLL Payroll Deposit" },
];

let r = detectLaborDuplication(bmd);
ok(r.flagged, "BMD flagged");
ok(r.employee_count === 3, `3 employees learned [got ${r.employee_count}]`);
ok(r.suspects.length === 1, `1 suspect account [got ${r.suspects.length}]`);
ok(r.suspects[0]?.account === "Workers Compensation – Field", `suspect is WCB [got ${r.suspects[0]?.account}]`);
ok(Math.abs(r.suspects[0]?.total - 5191.63) < 0.01, `suspect total 5191.63 [got ${r.suspects[0]?.total}]`);
ok(r.suspects[0]?.employees === 3, `3 employees on suspect [got ${r.suspects[0]?.employees}]`);
ok(!r.paycheque_accounts.includes("Workers Compensation – Field"), "WCB not treated as a paycheque account");
ok(r.paycheque_accounts.includes("Direct Labour Taxes"), "Direct Labour Taxes IS a paycheque account (excluded from suspects)");

// Clean client: paycheques only, nothing miscategorized.
const clean: LaborScanRow[] = [
  { account: "Wages", txn_type: "Paycheque", name: "Sam Lee", amount: 3000 },
  { account: "Wages", txn_type: "Paycheque", name: "Dana Fox", amount: 2500 },
  { account: "Materials", txn_type: "Expense", name: "Home Depot", amount: 900 },
];
r = detectLaborDuplication(clean);
ok(!r.flagged, "clean client not flagged");
ok(r.suspects.length === 0, `clean has 0 suspects [got ${r.suspects.length}]`);

// Below threshold: a single stray coincidence shouldn't flag.
const stray: LaborScanRow[] = [
  { account: "Wages", txn_type: "Paycheque", name: "Sam Lee", amount: 3000 },
  { account: "Office Supplies", txn_type: "Expense", name: "Sam Lee", amount: 42.00, memo: "reimburse pens" },
];
r = detectLaborDuplication(stray);
ok(!r.flagged, `stray $42 below threshold, not flagged [overstated ${r.overstated}]`);
r = detectLaborDuplication(stray, { minSuspectTotal: 10 });
ok(r.flagged, "stray flagged when threshold lowered");

// No payroll at all → nothing to learn, nothing flagged.
r = detectLaborDuplication([{ account: "Materials", txn_type: "Expense", name: "Rona", amount: 500 }]);
ok(!r.flagged && r.employee_count === 0, "no payroll → not flagged");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
