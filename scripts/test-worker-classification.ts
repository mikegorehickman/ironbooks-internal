/** Tests for lib/worker-classification.ts.
 *  Run: npx tsx scripts/test-worker-classification.ts
 *
 *  Fixtures are RocketPainter Kingston's real shape, 2026-07-31: nine payroll
 *  employees; Jennifer Harvey on payroll AND in Subcontractors ($1,665) plus
 *  $1,813 of bare e-transfers inside Direct Field Labor; Paul Benia, Jim Blakely
 *  and Tigh Gallagher as genuine subcontractors who must NOT be flagged.
 */
import {
  detectWorkerOverlap,
  normalizePerson,
  samePerson,
  type WorkerScanRow,
} from "../lib/worker-classification";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const eq = (name: string, got: any, want: any) =>
  ok(`${name}${got === want ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

// ══ name normalisation ═════════════════════════════════════════════════════
eq("lowercases + trims", normalizePerson("  Jennifer Harvey "), "jennifer harvey");
eq("strips QBO dedup suffix", normalizePerson("Jennifer Harvey (2)"), "jennifer harvey");
eq("Last, First → first last", normalizePerson("Harvey, Jennifer"), "jennifer harvey");
eq("drops punctuation", normalizePerson("J. Blakely"), "j blakely");
eq("empty is safe", normalizePerson(null), "");

ok("exact match", samePerson("Jennifer Harvey", "jennifer harvey"));
ok("comma form matches", samePerson("Harvey, Jennifer", "Jennifer Harvey"));
ok("first initial matches", samePerson("J. Blakely", "Jim Blakely"));
ok("different surname does NOT match", !samePerson("Jim Blakely", "Jim Norris"));
ok("same surname different first does NOT match", !samePerson("Connor Norris", "Katie Norris"));
ok("single name does not match a full name", !samePerson("Jennifer", "Jennifer Harvey"));
ok("empty never matches", !samePerson("", "Jennifer Harvey"));

// ══ RocketPainter fixture ══════════════════════════════════════════════════
const ROCKET: WorkerScanRow[] = [
  // gross paycheques — the legitimate wage record, 9 employees
  ...["Jennifer Harvey", "Connor Norris", "Kaitlyn Baker", "Saverio Carfa", "Nadine Bauman",
      "Jenna Martin", "Katie Wilson", "Zion Palmer", "Ashton Weiber"].map((n) => ({
    account: "Direct Field Labor", txn_type: "Paycheque", name: n,
    memo: "Gross Pay - This is not a legal pay stub", amount: 1900, date: "2026-07-16",
  })),
  // Jennifer Harvey, also in a subcontractor account
  { account: "Subcontractors", txn_type: "Expense", name: "Jennifer Harvey", memo: null, amount: 1665, date: "2026-05-20" },
  { account: "Subcontractors – Painting", txn_type: "Expense", name: "Jennifer Harvey", memo: null, amount: 146, date: "2026-06-02" },
  // and bare e-transfers with the name ONLY in the bank memo
  { account: "Direct Field Labor", txn_type: "Expense", name: null, memo: "E-TRANSFERXXXXXXXX6926 Jennifer Harvey 4506*", amount: 360, date: "2026-06-04" },
  { account: "Direct Field Labor", txn_type: "Expense", name: null, memo: "E-TRANSFERXXXXXXXX9614 Jennifer Harvey 4506*", amount: 552, date: "2026-05-25" },
  // genuine subcontractors — NOT on payroll, must not be flagged
  { account: "Subcontractors – Painting", txn_type: "Expense", name: "Paul Benia", memo: null, amount: 10335, date: "2026-04-10" },
  { account: "Subcontractors – Painting", txn_type: "Expense", name: "Jim Blakely", memo: null, amount: 7552, date: "2026-04-18" },
  { account: "Subcontractors – Painting", txn_type: "Expense", name: "Tigh Gallagher", memo: null, amount: 4694, date: "2026-05-02" },
  // a real reimbursement to a payroll employee — must be excluded
  { account: "Fuel – Overhead", txn_type: "Expense", name: "Connor Norris", memo: "Reimbursement for vehicle fuel", amount: 220, date: "2026-06-11" },
];

{
  const r = detectWorkerOverlap(ROCKET);
  eq("roster learned from paycheques", r.employeeCount, 9);

  const people = r.findings.map((f) => f.person);
  eq("exactly one person flagged", r.findings.length, 1);
  eq("and it is Jennifer Harvey", people[0], "Jennifer Harvey");

  for (const clean of ["Paul Benia", "Jim Blakely", "Tigh Gallagher"])
    ok(`${clean} NOT flagged (genuine subcontractor)`, !people.includes(clean));
  ok("Connor Norris NOT flagged (real reimbursement)", !people.includes("Connor Norris"));

  const jh = r.findings[0];
  eq("tier is both_paths (sub account involved)", jh.tier, "both_paths");
  // 1665 + 146 + 360 + 552 — the paycheques themselves are excluded
  eq("non-payroll total", jh.amount, 2723);
  ok("names the subcontractor account", jh.accounts.includes("Subcontractors"));
  ok("picked up the memo-only e-transfers", jh.postings.some((p) => p.memo.includes("E-TRANSFER")));
  ok("payee match outranks memo match", jh.matchedOn === "name");
  ok("question mentions the filing consequence", /slips|employee and a subcontractor/i.test(jh.question));
  ok("postings are date-sorted", jh.postings.every((p, i, a) => i === 0 || a[i - 1].date <= p.date));
  eq("exposure totals the findings", r.exposure, 2723);
}

// ══ tier 3 alone: name ONLY in the memo ════════════════════════════════════
{
  const rows: WorkerScanRow[] = [
    { account: "Direct Field Labor", txn_type: "Paycheque", name: "Jennifer Harvey", memo: "Gross Pay", amount: 1900, date: "2026-07-16" },
    { account: "Direct Field Labor", txn_type: "Expense", name: null, memo: "E-TRANSFER 6926 Jennifer Harvey", amount: 360, date: "2026-06-04" },
  ];
  const r = detectWorkerOverlap(rows);
  eq("memo-only match found", r.findings.length, 1);
  eq("matchedOn is memo", r.findings[0].matchedOn, "memo");
  eq("no sub account → other-pay tier", r.findings[0].tier, "payroll_employee_other_pay");
  ok("question asks reimbursement vs pay", /reimbursement|additional pay/i.test(r.findings[0].question));
}

// ══ tier 1: shared email beats spelling ═══════════════════════════════════
{
  const rows: WorkerScanRow[] = [
    { account: "Wages", txn_type: "Paycheque", name: "Robert Smith", memo: null, amount: 2000, date: "2026-06-01" },
    { account: "Subcontractors", txn_type: "Expense", name: "Bob Smith Painting", memo: null, amount: 5000, date: "2026-06-10" },
  ];
  const byName = detectWorkerOverlap(rows);
  eq("names alone miss it", byName.findings.length, 0);

  const byId = detectWorkerOverlap(rows, [
    { kind: "employee", name: "Robert Smith", email: "bob@smith.ca" },
    { kind: "vendor", name: "Bob Smith Painting", email: "BOB@SMITH.CA" },
  ]);
  eq("shared email catches it", byId.findings.length, 1);
  eq("matchedOn is email", byId.findings[0].matchedOn, "email");
}
{
  const rows: WorkerScanRow[] = [
    { account: "Wages", txn_type: "Paycheque", name: "Robert Smith", memo: null, amount: 2000, date: "2026-06-01" },
    { account: "Subcontractors", txn_type: "Expense", name: "Bob Smith Painting", memo: null, amount: 5000, date: "2026-06-10" },
  ];
  const r = detectWorkerOverlap(rows, [
    { kind: "employee", name: "Robert Smith", phone: "(613) 555-0142" },
    { kind: "vendor", name: "Bob Smith Painting", phone: "613-555-0142" },
  ]);
  eq("shared phone catches it, formatting-insensitive", r.findings.length, 1);
  eq("matchedOn is phone", r.findings[0].matchedOn, "phone");
}

// ══ guards ════════════════════════════════════════════════════════════════
{
  // No paycheques = no roster. Must say so, not report a clean pass.
  const r = detectWorkerOverlap([
    { account: "Subcontractors", txn_type: "Expense", name: "Paul Benia", memo: null, amount: 5000, date: "2026-06-01" },
  ]);
  eq("no roster → no findings", r.findings.length, 0);
  eq("employeeCount 0", r.employeeCount, 0);
  ok("says the check could not run", /no roster/i.test(r.summary));
}
{
  // Trivial amounts are noise.
  const r = detectWorkerOverlap([
    { account: "Wages", txn_type: "Paycheque", name: "Jenna Martin", memo: null, amount: 900, date: "2026-06-01" },
    { account: "Subcontractors", txn_type: "Expense", name: "Jenna Martin", memo: null, amount: 12, date: "2026-06-05" },
  ]);
  eq("$12 below the floor", r.findings.length, 0);
}
{
  const r = detectWorkerOverlap([]);
  eq("empty input is safe", r.findings.length, 0);
  eq("clean summary", r.employeeCount, 0);
}
{
  // Clean client: employees paid only through payroll.
  const r = detectWorkerOverlap([
    { account: "Wages", txn_type: "Paycheque", name: "Katie Wilson", memo: "Gross Pay", amount: 1355, date: "2026-07-30" },
    { account: "Paint & Materials", txn_type: "Expense", name: "Sherwin-Williams", memo: null, amount: 800, date: "2026-07-12" },
  ]);
  eq("no overlap on a clean client", r.findings.length, 0);
  ok("summary says none paid outside payroll", /none paid outside payroll/i.test(r.summary));
}

console.log(`\nworker classification: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
