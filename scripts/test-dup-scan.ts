// Tests for duplicate detection. Run: npx tsx scripts/test-dup-scan.ts
import { findDuplicates } from "@/lib/qbo-dup-scan";
import type { PLDetailRow } from "@/lib/qbo-reports";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

let id = 0;
function row(p: Partial<PLDetailRow> & { account: string; amount: number; date: string }): PLDetailRow {
  return {
    txn_id: p.txn_id ?? `t${++id}`,
    txn_type: p.txn_type ?? "Expense",
    date: p.date,
    doc_number: p.doc_number ?? null,
    name: p.name ?? "Vendor",
    memo: p.memo ?? "",
    amount: p.amount,
    running_balance: null,
    account: p.account,
    section: p.section ?? "Expenses",
  };
}
const kinds = (findings: { kind: string }[]) => findings.map((f) => f.kind);

// 1. Same amount SAME DAY → exact_same_day
let f = findDuplicates([
  row({ account: "Materials", name: "Rona", amount: 300, date: "2026-05-01" }),
  row({ account: "Materials", name: "Rona", amount: 300, date: "2026-05-01" }),
], 25);
ok(f.length === 1 && f[0].kind === "exact_same_day", `same-day pair → exact_same_day [${kinds(f)}]`);

// 2. Same amount 1 day apart → near_duplicate
f = findDuplicates([
  row({ account: "Materials", name: "Rona", amount: 300, date: "2026-05-01" }),
  row({ account: "Materials", name: "Rona", amount: 300, date: "2026-05-02" }),
], 25);
ok(f.length === 1 && f[0].kind === "near_duplicate", `1 day apart → near_duplicate [${kinds(f)}]`);

// 3. THE BUG: same amount 3+ weeks apart → NOT flagged
f = findDuplicates([
  row({ account: "Painting Revenue", name: "Zelle JAMES TURNER", amount: 2000, date: "2026-04-24" }),
  row({ account: "Painting Revenue", name: "Zelle JAMES TURNER", amount: 2000, date: "2026-05-04" }),
], 25);
ok(f.length === 0, `same amount 10 days apart → NOT a duplicate [${kinds(f)}]`);

// 4. THE BIG BUG: recurring payroll, same "DD" doc + same amount every pay period → NOT flagged
f = findDuplicates([
  row({ account: "Direct Field Labor", name: "Samuel Johnson", amount: 769.23, date: "2026-05-11", doc_number: "DD", txn_type: "Expense" }),
  row({ account: "Direct Field Labor", name: "Samuel Johnson", amount: 769.23, date: "2026-05-18", doc_number: "DD", txn_type: "Expense" }),
  row({ account: "Direct Field Labor", name: "Samuel Johnson", amount: 769.23, date: "2026-05-26", doc_number: "DD", txn_type: "Expense" }),
  row({ account: "Direct Field Labor", name: "Samuel Johnson", amount: 769.23, date: "2026-06-08", doc_number: "DD", txn_type: "Expense" }),
], 25);
ok(f.length === 0, `recurring weekly payroll (DD placeholder) → NOT flagged [${kinds(f)}]`);

// 5. "Gusto" / numeric placeholder docs also ignored
f = findDuplicates([
  row({ account: "Cleaning Team", name: "Yaneth", amount: 304.24, date: "2026-04-15", doc_number: "Gusto" }),
  row({ account: "Cleaning Team", name: "Yaneth", amount: 304.24, date: "2026-05-13", doc_number: "Gusto" }),
], 25);
ok(f.length === 0, `Gusto placeholder doc, month apart → NOT flagged [${kinds(f)}]`);

// 6. REAL doc number posted twice same day → duplicate_doc
f = findDuplicates([
  row({ account: "Materials", name: "SW", amount: 812.55, date: "2026-05-10", doc_number: "INV-4021", txn_type: "Bill" }),
  row({ account: "Materials", name: "SW", amount: 812.55, date: "2026-05-10", doc_number: "INV-4021", txn_type: "Bill" }),
], 25);
ok(kinds(f).includes("duplicate_doc") || kinds(f).includes("exact_same_day"), `real dup doc same day → flagged [${kinds(f)}]`);

// 7. REAL doc number reused weeks apart → NOT flagged (window applies)
f = findDuplicates([
  row({ account: "Materials", name: "SW", amount: 812.55, date: "2026-05-10", doc_number: "INV-4021", txn_type: "Bill" }),
  row({ account: "Materials", name: "SW", amount: 812.55, date: "2026-06-20", doc_number: "INV-4021", txn_type: "Bill" }),
], 25);
ok(f.length === 0, `real doc reused 6 weeks apart → NOT flagged [${kinds(f)}]`);

// 8. Same-day cluster + far-apart third row: only the same-day pair, span reported = 0
f = findDuplicates([
  row({ account: "Bank Charges", name: "FEE", amount: 38, date: "2026-04-09" }),
  row({ account: "Bank Charges", name: "FEE", amount: 38, date: "2026-04-09" }),
  row({ account: "Bank Charges", name: "FEE", amount: 38, date: "2026-04-28" }),
], 25);
ok(f.length === 1 && f[0].kind === "exact_same_day" && f[0].dates.length === 1,
  `far-apart third row excluded; only same-day pair flagged [${kinds(f)}, dates=${f[0]?.dates}]`);

// 9. Reversal pair (purchase + refund) still surfaced, informational
f = findDuplicates([
  row({ account: "Materials", name: "Lowes", amount: 500, date: "2026-05-01" }),
  row({ account: "Materials", name: "Lowes", amount: -500, date: "2026-05-10" }),
], 25);
ok(kinds(f).includes("reversal_pair"), `refund pair → reversal_pair [${kinds(f)}]`);

// 10. Sub-$25 noise ignored
f = findDuplicates([
  row({ account: "Materials", name: "X", amount: 10, date: "2026-05-01" }),
  row({ account: "Materials", name: "X", amount: 10, date: "2026-05-01" }),
], 25);
ok(f.length === 0, `sub-$25 ignored [${kinds(f)}]`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
