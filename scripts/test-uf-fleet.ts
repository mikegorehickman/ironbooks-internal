/** Tests for lib/uf-fleet.ts — the UF worklist: match + recommended action.
 *  Run: npx tsx scripts/test-uf-fleet.ts
 */
import { recommendForItem, buildUfWorklists, sumByAction, type UfItemRow } from "../lib/uf-fleet";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const eq = (name: string, got: any, want: any) =>
  ok(`${name}${got === want ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

const item = (o: Partial<UfItemRow> = {}): UfItemRow => ({
  id: "i1", scan_id: "s1", qbo_payment_id: "P1", qbo_payment_txn_type: "Payment",
  payment_date: "2026-02-03", payment_amount: 569, customer_name: "Heather Eysaman",
  payment_memo: null, payment_ref_num: "400003407", applied_invoice_ids: [],
  classification: "orphan", suspected_duplicate: false, duplicate_of_payment_id: null,
  duplicate_reason: null, probable_deposit_id: null, probable_deposit_date: null,
  probable_deposit_amount: null, probable_deposit_bank: null, probable_match_kind: null,
  probable_match_confidence: null, probable_match_note: null, probable_match_group: null,
  resolution: "pending", ...o,
});

// ── The money landed: recommend recording the Bank Deposit ─────────────────
{
  const w = recommendForItem(item({
    probable_deposit_id: "D9", probable_deposit_date: "2026-02-05",
    probable_deposit_amount: 569, probable_deposit_bank: "Checking (0898)",
    probable_match_kind: "exact", probable_match_confidence: 0.98,
  }));
  eq("exact tie → create_deposit", w.action, "create_deposit");
  eq("confidence carried", w.confidence, 0.98);
  ok("names the deposit date", w.recommendation.includes("2026-02-05"));
  ok("names the bank", w.recommendation.includes("Checking (0898)"));
  ok("says the money landed", /money landed/i.test(w.recommendation));
}

// ── Bundled deposit: several payments, one bank line ───────────────────────
{
  const w = recommendForItem(item({
    probable_deposit_id: "D9", probable_deposit_date: "2026-02-05", probable_deposit_amount: 2400,
    probable_match_kind: "combination", probable_match_group: ["P1", "P2", "P3"],
    probable_match_confidence: 0.8,
  }));
  eq("combination → create_deposit", w.action, "create_deposit");
  ok(`says bundled with 2 others (got "${w.recommendation}")`, /bundled with 2 other/.test(w.recommendation));
}

// ── CA sales-tax-adjusted tie ──────────────────────────────────────────────
{
  const w = recommendForItem(item({
    probable_deposit_id: "D7", probable_deposit_date: "2026-03-01",
    probable_deposit_amount: 643, probable_match_kind: "tax_adjusted", probable_match_confidence: 0.7,
  }));
  ok("explains the tax adjustment", /after sales tax/i.test(w.recommendation));
}

// ── Duplicate wins over a deposit tie — banking it twice is the danger ─────
{
  const w = recommendForItem(item({
    suspected_duplicate: true, duplicate_of_payment_id: "P0",
    duplicate_reason: "same customer, amount and date as P0",
    // A duplicate can ALSO tie to a deposit by amount; that must not win.
    probable_deposit_id: "D9", probable_deposit_amount: 569, probable_match_kind: "exact",
    probable_match_confidence: 0.99,
  }));
  eq("duplicate beats deposit match", w.action, "void_duplicate");
  ok("names the original", w.recommendation.includes("P0"));
  ok("warns about double-banking", /twice/i.test(w.recommendation));
}

// ── Applied to an invoice but never deposited ──────────────────────────────
{
  const w = recommendForItem(item({ applied_invoice_ids: ["INV-1"] }));
  eq("invoice-applied, no deposit → ask_client", w.action, "ask_client");
  ok("asks which account", /which account/i.test(w.recommendation));
}

// ── Nothing found at all ──────────────────────────────────────────────────
{
  const w = recommendForItem(item());
  eq("no match → ask_client", w.action, "ask_client");
  ok("offers the real possibilities", /deposited elsewhere|refunded|entered in error/i.test(w.recommendation));
  eq("not done", w.done, false);
}

// ── Resolution state ──────────────────────────────────────────────────────
eq("pending is open", recommendForItem(item({ resolution: "pending" })).done, false);
eq("null resolution is open", recommendForItem(item({ resolution: null })).done, false);
eq("void_duplicate is resolved", recommendForItem(item({ resolution: "void_duplicate" })).done, true);

// ── Grouping + totals ─────────────────────────────────────────────────────
{
  const scanToClient = new Map([["s1", "cA"], ["s2", "cB"]]);
  const rows: UfItemRow[] = [
    item({ id: "1", payment_amount: 1000, probable_deposit_id: "D1", probable_match_kind: "exact", probable_match_confidence: 0.9 }),
    item({ id: "2", payment_amount: 500, suspected_duplicate: true, duplicate_of_payment_id: "P9" }),
    item({ id: "3", payment_amount: 250 }),
    // Already resolved — visible, but must not be counted as open work.
    item({ id: "4", payment_amount: 9999, resolution: "void_duplicate", suspected_duplicate: true }),
    // A matched payment has a deposit behind it and is not work at all.
    item({ id: "5", payment_amount: 7777, classification: "matched" }),
    item({ id: "6", scan_id: "s2", payment_amount: 300 }),
    // Orphan from a scan we have no client for — must be dropped, not mis-assigned.
    item({ id: "7", scan_id: "s-unknown", payment_amount: 4444 }),
  ];
  const w = buildUfWorklists(rows, scanToClient);
  eq("two clients", w.size, 2);

  const a = w.get("cA")!;
  eq("matched excluded from the worklist", a.items.length, 4);
  eq("open count excludes the resolved one", a.openCount, 3);
  eq("open amount = 1000+500+250", a.openAmount, 1750);
  eq("biggest first", a.items[0].amount, 9999);   // resolved, still displayed
  eq("create_deposit total", a.byAction.create_deposit.amount, 1000);
  eq("void total excludes resolved", a.byAction.void_duplicate.amount, 500);
  eq("ask total", a.byAction.ask_client.amount, 250);

  ok("unknown scan dropped", ![...w.values()].some((x) => x.items.some((i) => i.amount === 4444)));

  const t = sumByAction(w.values());
  eq("fleet create_deposit", t.create_deposit.amount, 1000);
  eq("fleet ask_client", t.ask_client.amount, 550); // 250 + 300
  eq("fleet void", t.void_duplicate.count, 1);
}

{
  eq("empty input is safe", buildUfWorklists([], new Map()).size, 0);
  const t = sumByAction([]);
  eq("empty totals are zero", t.create_deposit.amount, 0);
}

console.log(`\nuf fleet worklist: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
