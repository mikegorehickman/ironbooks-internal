/** Unit tests for lib/pl-hierarchy.ts. Run: npx tsx scripts/test-pl-hierarchy.ts */
import { buildPLHierarchy, type PLLineItem, type PLAccountLite } from "../lib/pl-hierarchy";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }

const accounts: PLAccountLite[] = [
  { Id: "1", Name: "Sales", FullyQualifiedName: "Sales", AccountType: "Income", Classification: "Revenue", Active: true },
  // Parent Labor with two subs
  { Id: "10", Name: "Direct Labor", FullyQualifiedName: "Direct Labor", AccountType: "Cost of Goods Sold", Classification: "Expense", Active: true },
  { Id: "11", Name: "Painting", FullyQualifiedName: "Direct Labor:Painting", AccountType: "Cost of Goods Sold", Classification: "Expense", Active: true, ParentRef: { value: "10" } },
  { Id: "12", Name: "Taxes", FullyQualifiedName: "Direct Labor:Taxes", AccountType: "Cost of Goods Sold", Classification: "Expense", Active: true, ParentRef: { value: "10" } },
  { Id: "20", Name: "Rent", FullyQualifiedName: "Rent", AccountType: "Expense", Classification: "Expense", Active: true },
  { Id: "30", Name: "Unused", FullyQualifiedName: "Unused", AccountType: "Expense", Classification: "Expense", Active: true },
];

const lineItems: PLLineItem[] = [
  { label: "Sales", amount: 10000, group: "Income", account_id: "1" },
  // Sub-account amounts only (pure rollup parent — parent has no own postings)
  { label: "Painting", amount: 3000, group: "COGS", account_id: "11" },
  { label: "Taxes", amount: 440.53, group: "COGS", account_id: "12" },
  { label: "Rent", amount: 1200, group: "Expenses", account_id: "20" },
  // Unused (id 30) has no line → zero
];

const h = buildPLHierarchy(lineItems, accounts, { showZeros: false });

// Sections present
const cogs = h.sections.find((s) => s.key === "cogs");
ok("cogs section exists", !!cogs);

// Parent "Direct Labor" appears even though it has NO own postings (pure rollup)
const dl = cogs!.rows.find((r) => r.name === "Direct Labor" && !r.isTotalRow);
ok("pure-rollup parent shown", !!dl);
ok("parent rollup total = 3000 + 440.53", !!dl && Math.abs(dl.total - 3440.53) < 0.01);
ok("parent own = 0", !!dl && Math.abs(dl.own) < 0.01);

// Sub-accounts nested at depth+1
const painting = cogs!.rows.find((r) => r.name === "Painting");
const taxes = cogs!.rows.find((r) => r.name === "Taxes");
ok("sub Painting present", !!painting && painting.depth === 1);
ok("sub Taxes present at depth 1", !!taxes && taxes.depth === 1);

// "Total Direct Labor" summary row present
ok("Total parent row", cogs!.rows.some((r) => r.isTotalRow && r.name === "Total Direct Labor" && Math.abs(r.total - 3440.53) < 0.01));

// Zero-balance account hidden by default, shown with showZeros
const exp = h.sections.find((s) => s.key === "expenses")!;
ok("zero-balance 'Unused' hidden by default", !exp.rows.some((r) => r.name === "Unused"));
const hZero = buildPLHierarchy(lineItems, accounts, { showZeros: true });
const expZ = hZero.sections.find((s) => s.key === "expenses")!;
ok("zero-balance 'Unused' shown with showZeros", expZ.rows.some((r) => r.name === "Unused"));

// Totals
ok("totalIncome 10000", Math.abs(h.totalIncome - 10000) < 0.01);
ok("grossProfit = 10000 - 3440.53", Math.abs(h.grossProfit - 6559.47) < 0.01);
ok("netProfit = gross - rent", Math.abs(h.netProfit - (6559.47 - 1200)) < 0.01);

// Deleted/unmatched report line still surfaces
const li2 = [...lineItems, { label: "Old Deleted Acct", amount: 99, group: "Expenses", account_id: "999" }];
const h2 = buildPLHierarchy(li2, accounts, {});
ok("unmatched report line surfaced", h2.sections.some((s) => s.rows.some((r) => r.name === "Old Deleted Acct")));

console.log(`\npl-hierarchy: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
