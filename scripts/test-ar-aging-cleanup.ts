// Unit tests for the AR Aging Cleanup pure core.
// Run: npx tsx scripts/test-ar-aging-cleanup.ts
import {
  parseDepositCsv,
  splitByScope,
  matchDepositsToInvoices,
  type ArAgingInvoice,
} from "@/lib/cleanup-system/ar-aging-cleanup";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

const inv = (p: Partial<ArAgingInvoice>): ArAgingInvoice => ({
  id: p.id || "1", doc: p.doc ?? null, date: p.date || "2024-06-15",
  customerId: p.customerId ?? "c1", customerName: p.customerName ?? "Customer",
  balance: p.balance ?? 500, total: p.total ?? p.balance ?? 500,
});

// ── parseDepositCsv ──
{
  const csv = `Date,Description,Amount\n2024-03-05,DEPOSIT MOBILE,1250.00\n03/12/2024,"E-DEPOSIT, BRANCH","$2,300.50"\n2024-04-01,REVERSAL,(500.00)\n2024-04-02,FEE,0\nnot-a-date,junk,abc`;
  const rows = parseDepositCsv(csv);
  ok(rows.length === 2, `header CSV: 2 valid deposit rows (got ${rows.length})`);
  ok(rows[0].date === "2024-03-05" && rows[0].amount === 1250, "ISO date + plain amount");
  ok(rows[1].date === "2024-03-12" && rows[1].amount === 2300.5, "MM/DD/YYYY + $ + comma + quoted");
}
{
  const rows = parseDepositCsv(`2023-01-05,900.25\n2023-02-01,100`);
  ok(rows.length === 2 && rows[0].amount === 900.25, "headerless positional CSV parses");
}
{
  ok(parseDepositCsv("").length === 0, "empty text → no rows");
}

// ── splitByScope ──
{
  const invoices = [
    inv({ id: "a", date: "2021-05-01", balance: 100 }),
    inv({ id: "b", date: "2023-12-31", balance: 200 }),
    inv({ id: "c", date: "2024-01-01", balance: 300 }), // exactly on cutoff = in-scope
    inv({ id: "d", date: "2025-06-01", balance: 400 }),
  ];
  const s = splitByScope(invoices, "2024-01-01");
  ok(s.inScope.map((i) => i.id).join(",") === "c,d", "on/after cutoff in-scope (cutoff-day edge included)");
  ok(s.outOfScopeByYear.length === 2 && s.outOfScopeByYear[0].year === 2021 && s.outOfScopeByYear[1].year === 2023, "out-of-scope grouped by year ascending");
  ok(s.outOfScopeByYear[1].total === 200, "year totals");
  ok(s.yearTotals.find((y) => y.year === 2024)?.inScope === true, "yearTotals marks scope");
}
{
  const s = splitByScope([inv({ id: "a", date: "2019-01-01" })], null);
  ok(s.inScope.length === 1 && s.outOfScopeByYear.length === 0, "no cutoff → everything in-scope");
}

// ── matchDepositsToInvoices ──
{
  const invoices = [
    inv({ id: "a", date: "2024-03-01", balance: 1250 }),
    inv({ id: "b", date: "2024-03-02", balance: 1250 }), // same amount — only one deposit available
    inv({ id: "c", date: "2024-05-01", balance: 999 }),
  ];
  const deposits = [
    { date: "2024-03-05", amount: 1250 },
    { date: "2024-09-01", amount: 999 }, // 123 days from invoice c → outside window
  ];
  const v = matchDepositsToInvoices(invoices, deposits, 60);
  ok(v.has("a") && !v.has("b"), "greedy: one deposit verifies exactly one of two identical invoices");
  ok(!v.has("c"), "deposit outside the window doesn't verify");
}
{
  const v = matchDepositsToInvoices(
    [inv({ id: "x", date: "2024-01-10", balance: 500.004 })],
    [{ date: "2024-01-12", amount: 500 }],
    60
  );
  ok(v.has("x"), "±1 cent amount tolerance");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
