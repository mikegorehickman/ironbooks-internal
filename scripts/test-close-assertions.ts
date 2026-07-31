/** Tests for lib/close-assertions.ts — the two balance-sheet assertions that
 *  keep invoice-sourced revenue from quietly inflating UF and A/R.
 *  Run: npx tsx scripts/test-close-assertions.ts
 */
import {
  assertUndepositedFundsClear,
  classifyOpenInvoices,
  type OpenInvoiceLike,
  type IncomePostingLike,
} from "../lib/close-assertions";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const eq = (name: string, got: any, want: any) =>
  ok(`${name}${got === want ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

const inv = (o: Partial<OpenInvoiceLike>): OpenInvoiceLike => ({
  qbo_invoice_id: "1", doc_number: "1001", customer_id: "c1", customer_name: "Henderson",
  txn_date: "2026-05-01", due_date: "2026-05-31", total_amount: 1000, balance: 1000, ...o,
});
const dep = (o: Partial<IncomePostingLike>): IncomePostingLike => ({
  txn_type: "Deposit", date: "2026-05-15", amount: 1000, name: "Henderson", memo: null, ...o,
});

// ══ Undeposited Funds ═══════════════════════════════════════════════════════
{
  const a = assertUndepositedFundsClear(0, [], "2026-06-30");
  ok("zero balance is clear", a.clear);
  eq("clear summary", a.summary, "Undeposited Funds is clear");
}
{
  // The case the old $5,000 threshold let through every single month.
  const a = assertUndepositedFundsClear(4900, [{ payment_date: "2026-06-20", amount: 4900 }], "2026-06-30");
  ok("$4,900 is NOT clear (old rule passed this)", !a.clear);
  ok("names the amount", a.summary.includes("$4,900.00"));
  eq("counts the stuck payment", a.stuck.length, 1);
  eq("not yet stale", a.stale.length, 0);
}
{
  const a = assertUndepositedFundsClear(500, [{ payment_date: "2026-01-05", amount: 500 }], "2026-06-30");
  eq("payment >60d is stale", a.stale.length, 1);
  ok("stale is reported", a.summary.includes("older than 60 days"));
}
{
  // Sub-dollar rounding is not a stuck payment.
  ok("$0.40 is clear", assertUndepositedFundsClear(0.4, [], "2026-06-30").clear);
  ok("negative balance still flags", !assertUndepositedFundsClear(-2500, [], "2026-06-30").clear);
}
{
  // A payment dated after period end is in transit for the NEXT close.
  const a = assertUndepositedFundsClear(300, [{ payment_date: "2026-07-15", amount: 300 }], "2026-06-30");
  eq("future-dated payment not counted as stuck", a.stuck.length, 0);
}

// ══ A/R classification ══════════════════════════════════════════════════════
{
  // The headline case: a deposit landed for the invoice amount and was never
  // applied. This is the invoice that closes itself once the matcher runs.
  const r = classifyOpenInvoices([inv({})], [dep({})], "2026-06-30");
  eq("classified as unmatched_deposit", r.classified[0].reason, "unmatched_deposit");
  eq("recoverable = the balance", r.recoverable, 1000);
  eq("nothing unexplained", r.unexplained.length, 0);
  ok("evidence attached", !!r.classified[0].evidence);
}
{
  // An INVOICE posting must never count as evidence the invoice was paid.
  const r = classifyOpenInvoices([inv({ due_date: "2026-03-31" })], [dep({ txn_type: "Invoice" })], "2026-06-30");
  eq("invoice posting is not payment evidence", r.classified[0].reason, "unexplained");
}
{
  // Amount must actually match.
  const r = classifyOpenInvoices([inv({ balance: 1000, due_date: "2026-03-31" })], [dep({ amount: 900 })], "2026-06-30");
  eq("different amount is not a match", r.classified[0].reason, "unexplained");
}
{
  // A deposit far outside the window isn't this invoice's payment.
  const r = classifyOpenInvoices([inv({ txn_date: "2026-01-01", due_date: "2026-01-31" })], [dep({ date: "2026-06-25" })], "2026-06-30");
  eq("deposit outside 120d window", r.classified[0].reason, "unexplained");
}
{
  // One deposit cannot close two invoices.
  const r = classifyOpenInvoices([inv({ qbo_invoice_id: "1" }), inv({ qbo_invoice_id: "2" })], [dep({})], "2026-06-30");
  const matched = r.classified.filter((c) => c.reason === "unmatched_deposit");
  eq("deposit claimed once only", matched.length, 1);
  // The other is a same-customer same-amount pair → duplicate, not unexplained.
  eq("the sibling reads as a duplicate", r.counts.probable_duplicate, 1);
}
{
  // Duplicate pair with no deposit at all.
  const r = classifyOpenInvoices(
    [inv({ qbo_invoice_id: "1", doc_number: "A" }), inv({ qbo_invoice_id: "2", doc_number: "B" })],
    [],
    "2026-06-30"
  );
  eq("both flagged duplicate", r.counts.probable_duplicate, 2);
  ok("advises match, not void", r.classified[0].note.includes("do not void"));
}
{
  // Recent invoice = current, not a finding.
  const r = classifyOpenInvoices([inv({ due_date: "2026-06-20" })], [], "2026-06-30");
  eq("recent invoice is current", r.classified[0].reason, "current");
  eq("current does not block", r.unexplained.length, 0);
}
{
  // Not yet due.
  const r = classifyOpenInvoices([inv({ due_date: "2026-07-20" })], [], "2026-06-30");
  eq("future due date is current", r.classified[0].reason, "current");
  ok("negative daysOverdue", r.classified[0].daysOverdue < 0);
}
{
  // Old, nothing explains it — the only reason that blocks.
  const r = classifyOpenInvoices([inv({ due_date: "2026-01-15" })], [], "2026-06-30");
  eq("old + unexplained", r.classified[0].reason, "unexplained");
  eq("counted as unexplained", r.unexplained.length, 1);
  ok("summary names the total", r.summary.includes("unexplained"));
}
{
  // Customer mismatch blocks a same-amount coincidence, but a bare bank memo
  // with no payee must still be allowed to match.
  const named = classifyOpenInvoices([inv({ customer_name: "Henderson", due_date: "2026-03-31" })], [dep({ name: "Unrelated Co" })], "2026-06-30");
  eq("different named customer is not a match", named.classified[0].reason, "unexplained");
  const bare = classifyOpenInvoices([inv({ customer_name: "Henderson" })], [dep({ name: null })], "2026-06-30");
  eq("no-payee deposit can still match", bare.classified[0].reason, "unmatched_deposit");
}
{
  const r = classifyOpenInvoices([], [], "2026-06-30");
  eq("empty is safe", r.summary, "No open invoices");
  eq("no recoverable", r.recoverable, 0);
}

console.log(`\nclose assertions: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
