// Tests for re-apply candidacy + grouping.
// Run: npx tsx scripts/test-reapply-skipped.ts
import { qualifiesForReapply, groupReapplyRows, type ReapplyRow } from "@/lib/reapply-skipped";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

const row = (o: Partial<ReapplyRow>): ReapplyRow => ({
  id: "r1",
  qbo_transaction_id: "tx1",
  qbo_transaction_type: "Purchase",
  line_id: "1",
  to_account_id: "42",
  to_account_name: "Job Supplies & Materials",
  from_account_name: "Job Supplies & Materials",
  transaction_date: "2026-05-01",
  status: "skipped",
  skip_reason: "already_correct",
  decision: "skip",
  ...o,
});

// ── Qualifies: the canonical already-correct skip ──
ok(qualifiesForReapply(row({})), "already_correct skip with target + supported type qualifies");

// ── Disqualified for the right reasons ──
ok(!qualifiesForReapply(row({ status: "executed" })), "executed rows never re-apply");
ok(!qualifiesForReapply(row({ status: "pending" })), "pending rows never re-apply");
ok(!qualifiesForReapply(row({ skip_reason: "account_missing" })), "skips for other reasons never re-apply");
ok(!qualifiesForReapply(row({ skip_reason: null })), "skip with no reason never re-applies");
ok(!qualifiesForReapply(row({ to_account_id: null, to_account_name: null })), "no target → not a candidate");
ok(!qualifiesForReapply(row({ qbo_transaction_id: null })), "no tx id → not a candidate");
ok(!qualifiesForReapply(row({ line_id: null })), "no line id → not a candidate");
ok(!qualifiesForReapply(row({ qbo_transaction_type: "Deposit" })), "unsupported tx type → not a candidate");
ok(!qualifiesForReapply(row({ qbo_transaction_type: "JournalEntry" })), "JournalEntry unsupported → not a candidate");

// ── A target name alone (no id) still qualifies — execute resolves it live ──
ok(qualifiesForReapply(row({ to_account_id: null, to_account_name: "Parking" })), "target name w/o id still qualifies");

// ── Grouping: multiple lines of one txn collapse to one QBO write ──
const grouped = groupReapplyRows([
  row({ id: "a", qbo_transaction_id: "tx1", line_id: "1" }),
  row({ id: "b", qbo_transaction_id: "tx1", line_id: "2" }),
  row({ id: "c", qbo_transaction_id: "tx2", line_id: "1" }),
]);
ok(grouped.length === 2, `2 distinct txns → 2 groups (got ${grouped.length})`);
const tx1 = grouped.find((g) => g.txId === "tx1");
ok(tx1?.rows.length === 2, `tx1 has both its lines (got ${tx1?.rows.length})`);

// ── Grouping filters out non-candidates so they never reach QBO ──
const mixed = groupReapplyRows([
  row({ id: "good", qbo_transaction_id: "txA" }),
  row({ id: "bad", qbo_transaction_id: "txB", skip_reason: "account_missing" }),
  row({ id: "bad2", qbo_transaction_id: "txC", status: "executed" }),
]);
ok(mixed.length === 1, `only the qualifying row groups (got ${mixed.length})`);
ok(mixed[0]?.txId === "txA", "the surviving group is the qualifying txn");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
