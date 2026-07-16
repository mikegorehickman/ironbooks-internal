// Tests for the read-only COA drift classifier.
// Run: npx tsx scripts/test-coa-drift.ts
import { computeCoaDrift, type DriftAccount, type DriftMasterRow } from "@/lib/coa-drift";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

const master: DriftMasterRow[] = [
  { account_name: "Service Revenue", qbo_account_type: "Income", qbo_account_subtype: "ServiceFeeIncome", parent_account_name: null, is_parent: false, is_required: true },
  { account_name: "Job Supplies & Materials", qbo_account_type: "Cost of Goods Sold", qbo_account_subtype: "SuppliesMaterialsCogs", parent_account_name: null, is_parent: false, is_required: true },
  { account_name: "Marketing", qbo_account_type: "Expense", qbo_account_subtype: "AdvertisingPromotional", parent_account_name: null, is_parent: true, is_required: false },
  { account_name: "Bank Charges", qbo_account_type: "Expense", qbo_account_subtype: "BankCharges", parent_account_name: "Office & Admin", is_parent: false, is_required: true },
];

const accounts: DriftAccount[] = [
  // matched (name + type align)
  { Id: "1", Name: "Service Revenue", AccountType: "Income", AccountSubType: "ServiceFeeIncome", Active: true },
  { Id: "2", Name: "Bank Charges", AccountType: "Expense", AccountSubType: "BankCharges", Active: true },
  // wrong type: name matches master but typed Other Expense
  { Id: "3", Name: "Job Supplies & Materials", AccountType: "Other Expense", AccountSubType: "OtherMiscellaneousExpense", Active: true },
  // non-master sprawl
  { Id: "4", Name: "Marketing Tools", AccountType: "Expense", Active: true },
  { Id: "5", Name: "Paint & Materials", AccountType: "Cost of Goods Sold", Active: true },
  // system account → skipped entirely
  { Id: "6", Name: "Uncategorized Expense", AccountType: "Expense", Active: true },
  { Id: "7", Name: "Opening Balance Equity", AccountType: "Equity", Active: true },
  // inactive → skipped
  { Id: "8", Name: "Old Thing", AccountType: "Expense", Active: false },
];

const d = computeCoaDrift(accounts, master);

ok(d.totalActive === 5, `5 active non-system accounts counted (got ${d.totalActive})`);
ok(d.matched === 2, `2 matched (Service Revenue, Bank Charges) (got ${d.matched})`);
ok(d.wrongType.length === 1 && d.wrongType[0].name === "Job Supplies & Materials", "Job Supplies flagged wrong-type (Other Expense vs COGS)");
ok(d.wrongType[0]?.masterType === "Cost of Goods Sold", "wrong-type reports the master type");
ok(d.nonMaster.length === 2, `2 non-master (Marketing Tools, Paint & Materials) (got ${d.nonMaster.length})`);
ok(d.nonMaster.some((n) => n.name === "Paint & Materials"), "Paint & Materials is non-master sprawl");
ok(!d.nonMaster.some((n) => /uncategorized|opening balance/i.test(n.name)), "system accounts never counted as drift");
ok(d.missingRequired.length === 0, `all required master leaves present or accounted (got missing: ${d.missingRequired.join(", ")})`);

// conformance = matched / (matched + wrongType + nonMaster) = 2 / 5 = 40%
ok(d.conformancePct === 40, `conformance 40% (got ${d.conformancePct})`);

// A perfectly-clean chart → 100%
const clean = computeCoaDrift(
  [
    { Id: "1", Name: "Service Revenue", AccountType: "Income", AccountSubType: "ServiceFeeIncome", Active: true },
    { Id: "2", Name: "Bank Charges", AccountType: "Expense", AccountSubType: "BankCharges", Active: true },
    { Id: "3", Name: "Job Supplies & Materials", AccountType: "Cost of Goods Sold", AccountSubType: "SuppliesMaterialsCogs", Active: true },
  ],
  master
);
ok(clean.conformancePct === 100, `clean chart → 100% (got ${clean.conformancePct})`);
ok(clean.missingRequired.length === 0, "clean chart missing nothing required");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
