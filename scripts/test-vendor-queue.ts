/** Unit tests for lib/vendor-queue.ts — the vendor work-queue core.
 *  Run: npx tsx scripts/test-vendor-queue.ts
 *
 *  The load-bearing test here is the UNGROUPABLE one. A naive normalizer once
 *  collapsed 375 RocketPainter rows into 5 cards, one of them $45,889 of
 *  unrelated "unknown vendor" transactions — a single Approve would have
 *  mass-miscategorized. If that assertion ever fails, do not "fix the test".
 */
export {}; // module scope — keeps pass/fail out of the global test namespace

import {
  isUngroupableSender,
  classifyTarget,
  needsClassification,
  vendorKeyFor,
  groupByVendorKey,
  unclassifiedGroups,
  sortGroups,
  splitRuleMatches,
  describeSplitRule,
  applySplit,
  suggestSplits,
  type QueueRow,
  type SplitRule,
} from "../lib/vendor-queue";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const eq = (name: string, got: any, want: any) =>
  ok(`${name}${got === want ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

let seq = 0;
const row = (o: Partial<QueueRow>): QueueRow => ({
  id: o.id ?? `r${++seq}`,
  sender: o.sender ?? "Home Depot",
  descriptor: o.descriptor ?? "",
  amount: o.amount ?? 100,
  target: o.target ?? null,
  confidence: o.confidence ?? null,
  reasoning: o.reasoning ?? null,
  flagged: o.flagged ?? false,
});

// ── 1. Ungroupable senders — the money test ─────────────────────────────────
console.log("ungroupable senders");
for (const s of ["unknown", "Unknown Vendor", "no vendor", "n/a", "N/A", "misc",
                 "Miscellaneous", "none", "null", "(no vendor)", "", "   ",
                 "payment", "Deposit", "TRANSFER"]) {
  ok(`"${s}" is ungroupable`, isUngroupableSender(s));
}
ok("a real vendor is groupable", !isUngroupableSender("Sherwin Williams"));
ok("null is ungroupable", isUngroupableSender(null));
{
  // Ten unrelated unknown-vendor rows must produce TEN cards, never one.
  const rows = Array.from({ length: 10 }, (_, i) =>
    row({ id: `u${i}`, sender: "unknown vendor", amount: 1000 + i, descriptor: `THING ${i}` })
  );
  const groups = groupByVendorKey(rows);
  eq("10 unknown-vendor rows → 10 cards", groups.length, 10);
  ok("every card holds exactly one txn", groups.every((g) => g.count === 1));
  ok("cards are marked ungroupable", groups.every((g) => !g.groupable));
  ok("no card carries a rule key", groups.every((g) => g.key === ""));
}
{
  // And they must not absorb identifiable rows either.
  const groups = groupByVendorKey([
    row({ sender: "unknown vendor", amount: 45889 }),
    row({ sender: "Home Depot", amount: 100 }),
    row({ sender: "Home Depot", amount: 200 }),
  ]);
  eq("unknown stays separate from a real vendor", groups.length, 2);
  const hd = groups.find((g) => g.groupable)!;
  eq("the real vendor grouped its 2 rows", hd.count, 2);
  eq("...and only its own dollars", hd.total, 300);
}

// ── 2. Target triage ────────────────────────────────────────────────────────
console.log("target triage");
eq("null → unmatched", classifyTarget(null), "unmatched");
eq("empty → unmatched", classifyTarget("   "), "unmatched");
eq("Uncategorized → holding", classifyTarget("Uncategorized"), "holding");
eq("Uncategorised (en-GB) → holding", classifyTarget("Uncategorised Expense"), "holding");
eq("Ask My Accountant → holding", classifyTarget("Ask My Accountant"), "holding");
eq("Suspense → holding", classifyTarget("Suspense"), "holding");
eq("TBD → holding", classifyTarget("TBD"), "holding");
eq("a real account → set", classifyTarget("Job Supplies & Materials"), "set");
eq("Misc Expense → holding", classifyTarget("Miscellaneous"), "holding");
// Real QBO accounts that merely START with a holding-ish word must stay "set",
// or correctly-classified vendors would live in the sweep forever.
eq("'Other Income' is NOT holding", classifyTarget("Other Income"), "set");
eq("'Other Expense' is NOT holding", classifyTarget("Other Expense"), "set");
eq("'Miscellaneous Income' is NOT holding", classifyTarget("Miscellaneous Income"), "set");
eq("bare 'Other' IS holding", classifyTarget("Other"), "holding");
eq("'Uncategorized Expense' is holding", classifyTarget("Uncategorized Expense"), "holding");
ok("unmatched needs classification", needsClassification(null));
ok("holding needs classification", needsClassification("Uncategorized"));
ok("set does not", !needsClassification("Fuel"));

// ── 3. Bank-rule-aligned keys ───────────────────────────────────────────────
console.log("vendor keys");
{
  // Descriptor spellings of one merchant must share a key, since that key
  // becomes the "contains" term of a bank rule.
  const a = vendorKeyFor({ sender: "PETRO-CANADA 30", descriptor: "PETRO-CANADA 30 REGINA SK" });
  const b = vendorKeyFor({ sender: "PETRO-CANADA 41", descriptor: "PETRO-CANADA 41 SASKATOON SK" });
  eq("store numbers don't split a merchant", a.key, b.key);
  ok("key is non-empty", a.key.length > 0);
  ok("groupable", a.groupable && b.groupable);
}
{
  const u = vendorKeyFor({ sender: "unknown vendor", descriptor: "SOMETHING" });
  ok("ungroupable sender yields no key", u.key === "" && !u.groupable);
}

// ── 4. Group aggregation ────────────────────────────────────────────────────
console.log("group aggregation");
{
  const g = groupByVendorKey([
    row({ sender: "Home Depot", amount: -120.5, target: "Job Supplies", confidence: 0.9 }),
    row({ sender: "Home Depot", amount: 80.25, target: "Job Supplies", confidence: 0.6 }),
  ])[0];
  eq("absolute dollars summed", g.total, 200.75);
  eq("agreed target", g.target, "Job Supplies");
  ok("not mixed", !g.mixedTargets);
  eq("group confidence = LOWEST row", g.confidence, 0.6);
  eq("fully-targeted group is set", g.targetState, "set");
}
{
  const g = groupByVendorKey([
    row({ sender: "Amazon", amount: 50, target: "Job Supplies" }),
    row({ sender: "Amazon", amount: 50, target: "Software" }),
  ])[0];
  ok("disagreeing rows flagged as mixed", g.mixedTargets);
}
{
  // A half-classified vendor must NOT hide from the sweep.
  const g = groupByVendorKey([
    row({ sender: "Amazon", amount: 50, target: "Job Supplies" }),
    row({ sender: "Amazon", amount: 50, target: null }),
  ])[0];
  eq("one undecided row keeps the group unmatched", g.targetState, "unmatched");
  eq("...and it appears in the sweep", unclassifiedGroups([g]).length, 1);
}
{
  const g = groupByVendorKey([
    row({ sender: "Amazon", amount: 50, target: "Job Supplies" }),
    row({ sender: "Amazon", amount: 50, target: "Ask My Accountant" }),
  ])[0];
  eq("parked row keeps the group in holding", g.targetState, "holding");
}
{
  const g = groupByVendorKey([row({ sender: "Rona", flagged: false }), row({ sender: "Rona", flagged: true })])[0];
  ok("flagged is sticky across the group", g.flagged);
}

// ── 5. Sorting ──────────────────────────────────────────────────────────────
console.log("sorting");
{
  const groups = groupByVendorKey([
    row({ sender: "Big Co", amount: 5000, target: "Fuel", confidence: 0.95 }),
    row({ sender: "Small Co", amount: 40, target: null, confidence: null }),
    row({ sender: "Mid Co", amount: 900, target: "Uncategorized", confidence: 0.4 }),
  ]);
  eq("impact = biggest dollars first", sortGroups(groups, "impact")[0].display, "Big Co");
  const sweep = sortGroups(groups, "unclassified_first");
  ok("undecided float to the top", sweep[0].targetState !== "set" && sweep[1].targetState !== "set");
  eq("...biggest undecided first", sweep[0].display, "Mid Co");
  eq("...decided sinks to the bottom", sweep[2].display, "Big Co");
  eq("least_confident puts no-opinion first", sortGroups(groups, "least_confident")[0].display, "Small Co");
  eq("sort does not mutate the input", groups[0].display, "Big Co");
}

// ── 6. Split rules ──────────────────────────────────────────────────────────
console.log("split rules");
{
  const under25: SplitRule = { kind: "amount_below", value: 25, target: "Owner's Draw" };
  ok("$18 is under $25", splitRuleMatches(under25, row({ amount: 18 })));
  ok("negative $18 counts by magnitude", splitRuleMatches(under25, row({ amount: -18 })));
  ok("$25 exactly is NOT under", !splitRuleMatches(under25, row({ amount: 25 })));
  const atLeast: SplitRule = { kind: "amount_atleast", value: 25, target: "Fuel" };
  ok("$25 exactly IS at-least (no gap between the two)", splitRuleMatches(atLeast, row({ amount: 25 })));
  const prime: SplitRule = { kind: "text_contains", value: "prime", target: "Software" };
  ok("matches case-insensitively in sender", splitRuleMatches(prime, row({ sender: "Amazon Prime" })));
  ok("matches in the descriptor too", splitRuleMatches(prime, row({ sender: "Amazon", descriptor: "AMZN PRIME MEMBER" })));
  ok("plain Amazon does not match", !splitRuleMatches(prime, row({ sender: "Amazon", descriptor: "AMZN MKTP" })));
  ok("empty needle never matches", !splitRuleMatches({ kind: "text_contains", value: "  ", target: null }, row({})));
  eq("amount_below reads plainly", describeSplitRule(under25), "under $25");
  eq("text_contains reads plainly", describeSplitRule(prime), 'contains "prime"');
}
{
  // Fuel: the real case. Small fills vs job fills.
  const rows = [
    row({ sender: "Petro-Canada", amount: 18 }),
    row({ sender: "Petro-Canada", amount: 22 }),
    row({ sender: "Petro-Canada", amount: 95 }),
    row({ sender: "Petro-Canada", amount: 140 }),
  ];
  const buckets = applySplit(rows, [{ kind: "amount_below", value: 25, target: "Owner's Draw" }]);
  eq("two buckets", buckets.length, 2);
  eq("small bucket caught 2", buckets[0].rows.length, 2);
  eq("small bucket dollars", buckets[0].total, 40);
  eq("leftover is last and labelled", buckets[1].label, "Everything else");
  eq("leftover caught the rest", buckets[1].rows.length, 2);
  eq("every row lands exactly once",
    buckets.reduce((n, b) => n + b.rows.length, 0), rows.length);
}
{
  // Overlapping rules: first match wins, no double-counting.
  const rows = [row({ sender: "Amazon Prime", amount: 12 }), row({ sender: "Amazon", amount: 12 })];
  const buckets = applySplit(rows, [
    { kind: "text_contains", value: "PRIME", target: "Software" },
    { kind: "amount_below", value: 25, target: "Office" },
  ]);
  eq("the Prime row is claimed once", buckets[0].rows.length, 1);
  eq("...by the FIRST matching rule", buckets[0].rows[0].sender, "Amazon Prime");
  eq("the other row falls to rule 2", buckets[1].rows.length, 1);
  eq("no leftover bucket when rules cover everything",
    buckets.filter((b) => b.rule === null).length, 0);
}
{
  const buckets = applySplit([row({ amount: 500 })], [{ kind: "amount_below", value: 25, target: "X" }]);
  eq("a rule that catches nothing is dropped", buckets.length, 1);
  eq("...leaving just the leftover", buckets[0].rule, null);
}
eq("splitting no rows yields no buckets", applySplit([], [{ kind: "amount_below", value: 25, target: "X" }]).length, 0);

// ── 7. Split suggestions ────────────────────────────────────────────────────
console.log("split suggestions");
{
  const g = groupByVendorKey([row({ sender: "Home Depot", amount: 100 }), row({ sender: "Home Depot", amount: 200 })])[0];
  eq("too few rows → no suggestions", suggestSplits(g).length, 0);
}
{
  const g = groupByVendorKey(Array.from({ length: 6 }, (_, i) =>
    row({ id: `x${i}`, sender: "unknown vendor", amount: 100 * (i + 1) })
  ))[0];
  eq("ungroupable card is never split", suggestSplits(g).length, 0);
}
{
  // Amazon / Prime: 3 say PRIME, 3 don't.
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => row({ id: `p${i}`, sender: "Amazon", descriptor: "AMAZON PRIME MEMBERSHIP", amount: 12 })),
    ...Array.from({ length: 3 }, (_, i) => row({ id: `m${i}`, sender: "Amazon", descriptor: "AMAZON MKTPLACE", amount: 60 })),
  ];
  const g = groupByVendorKey(rows)[0];
  const s = suggestSplits(g);
  const prime = s.find((x) => x.rule.kind === "text_contains" && /PRIME/i.test(String(x.rule.value)));
  ok("suggests splitting out PRIME", !!prime);
  eq("...with the right count", prime?.matches, 3);
  ok("explains itself in plain terms", /transactions say/.test(prime?.why || ""));
  ok("never pre-fills a target — the human picks", s.every((x) => x.rule.target === null));
}
{
  // A token in EVERY row is not a split (it's the vendor itself).
  const rows = Array.from({ length: 5 }, (_, i) =>
    row({ id: `a${i}`, sender: "Sherwin Williams", descriptor: "SHERWIN WILLIAMS PAINT STORE", amount: 100 })
  );
  const s = suggestSplits(groupByVendorKey(rows)[0]);
  ok("a universal token is not offered", !s.some((x) => x.rule.kind === "text_contains" && /PAINT/i.test(String(x.rule.value))));
}
{
  // Fuel spread → threshold suggestion, most balanced one chosen.
  const rows = [
    row({ id: "f1", sender: "Petro-Canada", amount: 15 }),
    row({ id: "f2", sender: "Petro-Canada", amount: 20 }),
    row({ id: "f3", sender: "Petro-Canada", amount: 110 }),
    row({ id: "f4", sender: "Petro-Canada", amount: 130 }),
  ];
  const s = suggestSplits(groupByVendorKey(rows)[0]);
  const amt = s.find((x) => x.rule.kind === "amount_below");
  ok("suggests an amount threshold", !!amt);
  eq("...the balanced $25 one", (amt!.rule as any).value, 25);
  eq("...matching 2 rows", amt!.matches, 2);
}
{
  // All same size → nothing to threshold on.
  const rows = Array.from({ length: 5 }, (_, i) => row({ id: `s${i}`, sender: "Petro-Canada", amount: 100 }));
  const s = suggestSplits(groupByVendorKey(rows)[0]);
  ok("uniform amounts produce no threshold", !s.some((x) => x.rule.kind === "amount_below"));
}

console.log(`\nvendor-queue: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
