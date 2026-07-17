/** Unit tests for computeRetypePlans — run with: npx tsx scripts/test-coa-retype.ts */
import { computeRetypePlans } from "../lib/coa-retype";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL: ${label}`); }
}

const master = [
  { account_name: "Salaries & Payroll", qbo_account_type: "Expense", qbo_account_subtype: "PayrollExpenses" },
  { account_name: "Fuel – Overhead", qbo_account_type: "Expense", qbo_account_subtype: "Auto" },
  { account_name: "Owner's Draw", qbo_account_type: "Equity", qbo_account_subtype: "OwnersEquity" },
  { account_name: "Job Supplies & Materials", qbo_account_type: "Cost of Goods Sold", qbo_account_subtype: "SuppliesMaterialsCogs" },
];

// 1. JP's hand-found case: Salaries & Payroll typed Other Expense
let plans = computeRetypePlans({
  masterRows: master,
  clientAccounts: [{ Id: "9", Name: "Salaries & Payroll", AccountType: "Other Expense", AccountSubType: "OtherMiscellaneousExpense" }],
});
ok(plans.length === 1, "wrong-typed Salaries & Payroll detected");
ok(plans[0]?.new_type === "Expense" && plans[0]?.new_subtype === "PayrollExpenses", "targets master type/subtype");

// 2. Dash variant still matches (client hyphen vs master en-dash)
plans = computeRetypePlans({
  masterRows: master,
  clientAccounts: [{ Id: "56", Name: "Fuel - Overhead", AccountType: "Other Expense", AccountSubType: "OtherMiscellaneousExpense" }],
});
ok(plans.length === 1, "hyphen variant of en-dash master name matches");

// 3. Correct type + subtype → no plan
plans = computeRetypePlans({
  masterRows: master,
  clientAccounts: [{ Id: "1", Name: "Owner's Draw", AccountType: "Equity", AccountSubType: "OwnersEquity" }],
});
ok(plans.length === 0, "correctly-typed account produces no plan");

// 4. Right type, wrong subtype → NO plan. Subtype-only differences leave the
//    account in the right statement section, read as a confusing "Expense →
//    Expense" no-op, and QBO usually rejects them (tax/parent/subaccount
//    locks). Detail-type tuning is out of scope for this deterministic tool.
plans = computeRetypePlans({
  masterRows: master,
  clientAccounts: [{ Id: "2", Name: "Fuel – Overhead", AccountType: "Expense", AccountSubType: "OtherMiscellaneousExpense" }],
});
ok(plans.length === 0, "subtype-only mismatch is NOT flagged (type already correct)");

// 5. Name not in master → ignored
plans = computeRetypePlans({
  masterRows: master,
  clientAccounts: [{ Id: "3", Name: "Some Random Account", AccountType: "Other Expense" }],
});
ok(plans.length === 0, "non-master account ignored");

// 6. Rename-target case: client "Wages" being renamed to "Salaries & Payroll", currently Other Expense
plans = computeRetypePlans({
  masterRows: master,
  clientAccounts: [{ Id: "4", Name: "Wages", AccountType: "Other Expense", AccountSubType: "OtherMiscellaneousExpense" }],
  renameTargets: new Map([["4", "Salaries & Payroll"]]),
});
ok(plans.length === 1 && plans[0].new_type === "Expense", "rename target drives the type comparison");

// 7. Master row with null subtype: only type compared
plans = computeRetypePlans({
  masterRows: [{ account_name: "Misc", qbo_account_type: "Expense", qbo_account_subtype: null }],
  clientAccounts: [{ Id: "5", Name: "Misc", AccountType: "Expense", AccountSubType: "Whatever" }],
});
ok(plans.length === 0, "null master subtype means subtype is not compared");

console.log(fail === 0 ? `\nALL PASS: ${pass} passed, 0 failed` : `\nFAILURES: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
