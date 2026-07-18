// Tests for smart UF deposit matching. Run: npx tsx scripts/test-uf-deposit-match.ts
import { matchOrphansToDeposits, type OrphanRow, type DepositRow } from "@/lib/uf-deposit-match";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

// 1. Exact single match (deposit landed unlinked)
let m = matchOrphansToDeposits(
  [{ id: "p1", date: "2026-05-21", amount: 1695.0, customer: "Ian Low" }],
  [{ id: "d1", date: "2026-05-22", amount: 1695.0, bankAccount: "Main" }],
  { region: "US" },
);
ok(m.length === 1 && m[0].kind === "exact" && m[0].paymentIds[0] === "p1", `exact single [${JSON.stringify(m)}]`);

// 2. Combination: two payments bundled into one deposit
m = matchOrphansToDeposits(
  [
    { id: "a", date: "2026-06-03", amount: 2938.0, customer: "Ray" },
    { id: "b", date: "2026-06-03", amount: 2717.65, customer: "Ringia" },
  ],
  [{ id: "d", date: "2026-06-04", amount: 5655.65, bankAccount: "Main" }],
  { region: "US" },
);
ok(m.length === 1 && m[0].kind === "combination" && m[0].paymentIds.length === 2, `combination of 2 [${JSON.stringify(m[0]?.paymentIds)}]`);

// 3. CA tax-adjusted: deposit is the pre-tax amount (13% HST stripped)
m = matchOrphansToDeposits(
  [{ id: "p", date: "2026-04-01", amount: 1130.0, customer: "X" }], // $1000 + 13%
  [{ id: "d", date: "2026-04-03", amount: 1000.0, bankAccount: "Main" }],
  { region: "CA" },
);
ok(m.length === 1 && m[0].kind === "tax_adjusted", `CA tax-adjusted 13% [${JSON.stringify(m)}]`);

// 4. Same tax case but US → NOT matched (no tax stripping outside CA)
m = matchOrphansToDeposits(
  [{ id: "p", date: "2026-04-01", amount: 1130.0, customer: "X" }],
  [{ id: "d", date: "2026-04-03", amount: 1000.0, bankAccount: "Main" }],
  { region: "US" },
);
ok(m.length === 0, `US does not tax-strip [${JSON.stringify(m)}]`);

// 5. Out-of-window deposit → no match (money "matched" months later isn't it)
m = matchOrphansToDeposits(
  [{ id: "p", date: "2026-01-20", amount: 5268.27, customer: "Darryl" }],
  [{ id: "d", date: "2026-06-01", amount: 5268.27, bankAccount: "Main" }],
  { region: "US" },
);
ok(m.length === 0, `beyond 45-day window → no match [${JSON.stringify(m)}]`);

// 6. No coincidental match — unrelated amounts stay unmatched
m = matchOrphansToDeposits(
  [{ id: "p", date: "2026-03-05", amount: 679.99, customer: "Gough" }],
  [{ id: "d", date: "2026-03-06", amount: 4200.0, bankAccount: "Main" }],
  { region: "CA" },
);
ok(m.length === 0, `no coincidental match [${JSON.stringify(m)}]`);

// 7. A deposit consumes payments once — a second identical deposit needs its own payments
m = matchOrphansToDeposits(
  [
    { id: "x1", date: "2026-07-15", amount: 700.0, customer: "Ruth" },
    { id: "x2", date: "2026-07-16", amount: 700.0, customer: "Ruth" },
  ],
  [
    { id: "dep1", date: "2026-07-16", amount: 700.0, bankAccount: "Main" },
    { id: "dep2", date: "2026-07-17", amount: 700.0, bankAccount: "Main" },
  ],
  { region: "US" },
);
ok(m.length === 2 && new Set(m.flatMap((x) => x.paymentIds)).size === 2, `each deposit consumes a distinct payment [${JSON.stringify(m.map((x) => x.paymentIds))}]`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
