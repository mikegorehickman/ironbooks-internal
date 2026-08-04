/** Unit tests for lib/pl-hierarchy.ts. Run: npx tsx scripts/test-pl-hierarchy.ts */
import { buildPLHierarchy, formatPctOfIncome, type PLLineItem, type PLAccountLite } from "../lib/pl-hierarchy";

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

// ── % of income on every line (Mike, 2026-08-04) ─────────────────────────────
// Income here is 10000, so the fixture amounts make the maths readable:
//   Painting 3000 → 30%, Taxes 440.53 → 4.4%, Rent 1200 → 12%,
//   Direct Labor rollup 3440.53 → 34.4%
{
  const inc = h.sections.find((s) => s.key === "income")!;
  const sales = inc.rows.find((r) => r.name === "Sales")!;
  ok("income line is 100% of income", Math.abs((sales.pctOfIncome ?? 0) - 100) < 0.01);

  const painting2 = cogs!.rows.find((r) => r.name === "Painting")!;
  ok("SUB-ACCOUNT carries its own % (3000/10000)", Math.abs((painting2.pctOfIncome ?? 0) - 30) < 0.01);

  const taxes2 = cogs!.rows.find((r) => r.name === "Taxes")!;
  ok("second sub-account % (440.53/10000)", Math.abs((taxes2.pctOfIncome ?? 0) - 4.4053) < 0.01);

  const dl2 = cogs!.rows.find((r) => r.name === "Direct Labor" && !r.isTotalRow)!;
  ok("parent header % uses the ROLLUP, not its own 0", Math.abs((dl2.pctOfIncome ?? 0) - 34.4053) < 0.01);

  const dlTotal = cogs!.rows.find((r) => r.isTotalRow && r.name === "Total Direct Labor")!;
  ok("Total row % matches the parent rollup", Math.abs((dlTotal.pctOfIncome ?? 0) - 34.4053) < 0.01);

  const exp = h.sections.find((s) => s.key === "expenses")!;
  const rent = exp.rows.find((r) => r.name === "Rent")!;
  ok("operating expense line % (1200/10000)", Math.abs((rent.pctOfIncome ?? 0) - 12) < 0.01);

  ok("EVERY row has a percentage (none left null)", h.sections.every((sec) => sec.rows.every((r) => r.pctOfIncome !== null)));
}

// No income → the ratio is undefined, and must NOT read as 0%.
{
  const noIncome = buildPLHierarchy(
    [{ label: "Rent", amount: 1200, group: "Expenses", account_id: "20" }],
    accounts,
    { showZeros: false }
  );
  const rows = noIncome.sections.flatMap((sec) => sec.rows);
  ok("no income → pctOfIncome is null, not 0", rows.every((r) => r.pctOfIncome === null));
  ok("null renders as a dash", formatPctOfIncome(null) === "—");
}

// A contra line (discount/refund) keeps its sign rather than being abs()'d into
// looking like ordinary revenue.
{
  const withDiscount = buildPLHierarchy(
    [
      { label: "Sales", amount: 10000, group: "Income", account_id: "1" },
      { label: "Rent", amount: -500, group: "Expenses", account_id: "20" },
    ],
    accounts,
    { showZeros: false }
  );
  const rent = withDiscount.sections.flatMap((sec) => sec.rows).find((r) => r.name === "Rent")!;
  ok("negative amount yields a NEGATIVE percentage", (rent.pctOfIncome ?? 0) < 0);
  ok("negative percentage magnitude is right (-5%)", Math.abs((rent.pctOfIncome ?? 0) + 5) < 0.01);
}

// ── formatPctOfIncome ───────────────────────────────────────────────────────
ok("one decimal place", formatPctOfIncome(34.4053) === "34.4%");
ok("exact zero shows 0%", formatPctOfIncome(0) === "0%");
// A real-but-tiny share must not read as "0.0%" (nothing) or "—" (unknown).
ok("tiny positive shows <0.1%", formatPctOfIncome(0.02) === "<0.1%");
ok("tiny negative shows >-0.1%", formatPctOfIncome(-0.02) === ">-0.1%");
ok("0.05 rounds up rather than collapsing", formatPctOfIncome(0.05) === "0.1%");
ok("negative formats with sign", formatPctOfIncome(-5) === "-5.0%");
ok("non-finite is a dash", formatPctOfIncome(Infinity) === "—");
ok("100% formats plainly", formatPctOfIncome(100) === "100.0%");

console.log(`\npl-hierarchy: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
