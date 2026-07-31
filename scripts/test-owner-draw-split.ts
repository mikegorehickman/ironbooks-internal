/** Unit tests for lib/owner-draw-split.ts — salary vs draw detection.
 *  Run: npx tsx scripts/test-owner-draw-split.ts
 */
import { scanOwnerDraw, assessOwnerRows, type OwnerDrawRow } from "../lib/owner-draw-split";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const eq = (name: string, got: any, want: any) =>
  ok(`${name}${got === want ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

const row = (o: Partial<OwnerDrawRow>): OwnerDrawRow => ({
  account: "Owner's Payroll", txn_type: "Purchase", date: "2026-07-05",
  name: null, memo: "", amount: 1000, txn_id: "t1", ...o,
});

// ── Account classification ──────────────────────────────────────────────────
console.log("account classification");
{
  // The pre-split combined account is unresolved BY DEFINITION — the name
  // refuses to say whether it's salary or a distribution.
  const s = scanOwnerDraw([
    row({ account: "Owner Draw / Salary", amount: 2500, txn_id: "a" }),
    row({ account: "Owner Draw / Salary", amount: 2500, txn_id: "b" }),
  ]);
  eq("combined account is found", s.findings.length, 1);
  eq("classified as combined", s.findings[0].kind, "combined");
  ok("combined always needs review", s.findings[0].needsReview);
  ok("scan demands senior review", s.needsSeniorReview);
  eq("total summed", s.findings[0].totalAmount, 5000);
}
{
  // An account already on the equity side has nothing to decide.
  const s = scanOwnerDraw([row({ account: "Owner's Draw", amount: 3000 })]);
  eq("draw account classified", s.findings[0].kind, "draw");
  ok("a draw account needs no review", !s.findings[0].needsReview);
  ok("nothing unresolved", !s.needsSeniorReview);
}
{
  const s = scanOwnerDraw([row({ account: "Shareholder Distributions", amount: 900 })]);
  eq("shareholder distributions counted as draw", s.findings[0].kind, "draw");
}
{
  // Unrelated accounts must not be dragged in.
  const s = scanOwnerDraw([
    row({ account: "Admin Team Salaries", amount: 4000 }),
    row({ account: "Subcontractors", amount: 8000 }),
  ]);
  eq("non-owner accounts ignored", s.findings.length, 0);
  ok("no review needed", !s.needsSeniorReview);
}

// ── Evidence: payroll vs draw ───────────────────────────────────────────────
console.log("evidence assessment");
{
  // A provider in the description is the strongest payroll signal.
  const a = assessOwnerRows([
    row({ memo: "WAGEPOINT PAYROLL", amount: 3214.87 }),
    row({ memo: "Wagepoint payroll", amount: 3214.87 }),
    row({ memo: "CRA source deduction remittance", amount: 1102.44 }),
  ]);
  eq("leans payroll", a.leaning, "payroll");
  ok("cites the provider", a.reasons.some((r) => /payroll provider/i.test(r)));
  ok("cites the remittance", a.reasons.some((r) => /remittance/i.test(r)));
}
{
  // Round amounts, no provider, no remittance → a draw.
  const a = assessOwnerRows([
    row({ name: "Dave Wilson", memo: "e-transfer", amount: 2000 }),
    row({ name: "Dave Wilson", memo: "e-transfer", amount: 5000 }),
    row({ name: "Dave Wilson", memo: "", amount: 1500 }),
  ]);
  eq("leans draw", a.leaning, "draw");
  ok("cites round amounts", a.reasons.some((r) => /round amounts/i.test(r)));
}
{
  const a = assessOwnerRows([]);
  eq("no rows is unclear", a.leaning, "unclear");
}

// ── The case that actually matters: profit is understated ───────────────────
console.log("profit impact");
{
  // Owner payroll that looks like a draw = every dollar is sitting above the
  // net-profit line when it belongs below it.
  const s = scanOwnerDraw([
    row({ account: "Owner's Payroll", name: "Dave Wilson", memo: "e-transfer", amount: 4000, txn_id: "x" }),
    row({ account: "Owner's Payroll", name: "Dave Wilson", memo: "e-transfer", amount: 6000, txn_id: "y" }),
  ]);
  eq("payroll account leaning draw needs review", s.findings[0].needsReview, true);
  eq("leaning is draw", s.findings[0].leaning, "draw");
  eq("profit impact is the full amount", s.profitImpactIfDraw, 10000);
  eq("unresolved amount matches", s.unresolvedAmount, 10000);
}
{
  // Genuine owner payroll → no review, and no phantom profit impact.
  const s = scanOwnerDraw([
    row({ account: "Owner's Payroll", memo: "GUSTO PAY", amount: 3111.19 }),
    row({ account: "Owner's Payroll", memo: "GUSTO PAY", amount: 3111.19 }),
    row({ account: "Owner's Payroll", memo: "941 payment", amount: 980.12 }),
  ]);
  ok("real payroll needs no review", !s.findings[0].needsReview);
  eq("no profit impact claimed", s.profitImpactIfDraw, 0);
}
{
  // Only draw-leaning money counts toward profit impact, even when other
  // unresolved rows exist — overstating the impact would be its own error.
  const s = scanOwnerDraw([
    row({ account: "Owner Draw / Salary", memo: "GUSTO PAY", amount: 5000, txn_id: "p" }),
    row({ account: "Owner Draw / Salary", memo: "GUSTO PAY", amount: 5000, txn_id: "q" }),
  ]);
  ok("combined + payroll evidence still needs review", s.needsSeniorReview);
  eq("but claims no profit impact (leans payroll)", s.profitImpactIfDraw, 0);
  eq("still counted as unresolved", s.unresolvedAmount, 10000);
}

// ── Reviewer aids ───────────────────────────────────────────────────────────
console.log("reviewer aids");
{
  const s = scanOwnerDraw([
    row({ account: "Owner Draw / Salary", name: "Dave Wilson", amount: 100, txn_id: "1" }),
    row({ account: "Owner Draw / Salary", name: "Dave Wilson", amount: 200, txn_id: "2" }),
    row({ account: "Owner Draw / Salary", name: "D. Wilson", amount: 300, txn_id: "3" }),
  ]);
  eq("payees de-duplicated", s.findings[0].payees.length, 2);
  eq("txn count", s.findings[0].txnCount, 3);
  ok("sample ids provided for drill-down", s.findings[0].sampleTxnIds.length === 3);
}
{
  // Biggest exposure first — that's the order a reviewer wants.
  const s = scanOwnerDraw([
    row({ account: "Owner Draw / Salary", amount: 500, txn_id: "s" }),
    row({ account: "Owner's Payroll", name: "Dave", amount: 9000, txn_id: "b" }),
  ]);
  eq("largest amount sorts first", s.findings[0].account, "Owner's Payroll");
}

console.log(`\nowner-draw-split: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
