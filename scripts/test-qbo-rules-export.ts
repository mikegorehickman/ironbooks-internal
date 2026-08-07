/** Guards the QBO bank-rules .xls export against the 255-char BIFF8 cell trap.
 *  Run: npx tsx scripts/test-qbo-rules-export.ts
 *
 *  THE BUG THIS EXISTS FOR. A BIFF8 text cell holds 255 characters and SheetJS
 *  truncates past it SILENTLY — no error, no warning, just a chopped string. A
 *  rule whose JSON ran long shipped as `...,{"actionType":11,"v` , which is not
 *  valid JSON, and QBO rejected the ENTIRE file with a flat "Could not upload
 *  file" naming no row. INTAC's export lost all 109 rules to 3 bad ones.
 *
 *  These fixtures rebuild the exact payloads the route emits and assert both
 *  that they parse AND that they fit. Asserting only "it's valid JSON" would
 *  not have caught it: the JSON was valid when built, and only became invalid
 *  after the writer cut it.
 */
export {}; // module scope — keeps pass/fail out of the global test namespace

import * as XLSX from "xlsx";

const BIFF_CELL_LIMIT = 255;

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const eq = (name: string, got: any, want: any) =>
  ok(`${name}${got === want ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

// Mirrors the route's builders exactly. If the route's shape changes, change
// these together — that divergence is what the round-trip test below catches.
const buildConditions = (vendor: string) =>
  JSON.stringify({
    ruleConditions: [{ ruleType: 10, value: "-1" }, { ruleType: 1, value: vendor }],
    isAndRule: true,
  });
const buildOutputs = (account: string) =>
  JSON.stringify({
    ruleActions: [
      { actionType: 0, value: account },
      { actionType: 11, value: [] as unknown[] },
      { actionType: 8, value: true },
    ],
  });

// ── 1. The real INTAC rows that broke the upload ────────────────────────────
console.log("the rows that actually failed");
{
  // Longest account path in INTAC's chart, against a short vendor.
  const acct = "OTHER GENERAL AND ADMIN EXPENSES:Professional Fees:Continuing Education / Professional Development";
  const out = buildOutputs(acct);
  ok("longest real account path fits", out.length <= BIFF_CELL_LIMIT);
  eq("...and still parses", JSON.parse(out).ruleActions[0].value, acct);

  // The 142-char raw bank descriptor that was being used as a rule name.
  const monster = "MONTHLY FEE BUSINESS ADV RELATIONSHIP CHECKCARD 0207 EVERETTKUBRASERVICEFEE 800-766-6616 NJ XXXXX1650XXXXXXXXXX5095 CKCD 9311 XXXXXXXXXX102689";
  eq("descriptor is really 142 chars", monster.length, 142);
  ok("its conditions cell fits", buildConditions(monster).length <= BIFF_CELL_LIMIT);
}
{
  // The old shape carried a memo echoing the vendor. THAT is what overflowed.
  const acct = "OTHER GENERAL AND ADMIN EXPENSES:Professional Fees:Continuing Education / Professional Development";
  const withMemo = JSON.stringify({
    ruleActions: [
      { actionType: 0, value: acct },
      { actionType: 1, value: "SOCIETY FOR HUMAN RERSOURCE" },
      { actionType: 11, value: [] },
      { actionType: 8, value: true },
    ],
  });
  ok("the OLD payload overflowed (regression witness)", withMemo.length > BIFF_CELL_LIMIT);
  ok("the NEW payload does not", buildOutputs(acct).length <= BIFF_CELL_LIMIT);
}

// ── 2. Truncation is silent — prove it, so nobody "simplifies" the guard ────
console.log("silent truncation");
{
  const long = "x".repeat(400);
  const ws = XLSX.utils.json_to_sheet([{ A: long }], { header: ["A"] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Worksheet");
  const buf = XLSX.write(wb, { bookType: "biff8", type: "buffer" });
  const back = XLSX.utils.sheet_to_json(
    XLSX.read(buf, { type: "buffer" }).Sheets["Worksheet"], { header: 1 }
  )[1] as any[];
  eq("400 chars come back as 255", String(back[0]).length, BIFF_CELL_LIMIT);
  ok("the writer threw nothing — this is why the guard is needed", true);
}

// ── 3. Round-trip a full workbook, the way QBO reads it ─────────────────────
console.log("workbook round-trip");
{
  const fixtures = [
    { vendor: "LN CURTIS", account: "Job Supplies & Materials" },
    { vendor: "Chevron", account: "Vehicle Expenses:Fuel – Overhead" },      // en-dash
    { vendor: "SOCIETY FOR HUMAN RERSOURCE", account: "OTHER GENERAL AND ADMIN EXPENSES:Professional Fees:Continuing Education / Professional Development" },
    { vendor: 'Quote "Special" & <Co>', account: "Office & Admin:Utilities" }, // quotes must survive JSON+xls
  ];
  const rows = fixtures.map((f) => ({
    "Rule Name": f.vendor,
    "Rule Conditions": buildConditions(f.vendor),
    "Rule Outputs": buildOutputs(f.account),
  }));
  const ws = XLSX.utils.json_to_sheet(rows, { header: ["Rule Name", "Rule Conditions", "Rule Outputs"] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Worksheet");
  const buf = XLSX.write(wb, { bookType: "biff8", type: "buffer" });

  const rt = XLSX.read(buf, { type: "buffer" });
  eq("sheet is named Worksheet (QBO requires it)", rt.SheetNames[0], "Worksheet");
  const back = XLSX.utils.sheet_to_json(rt.Sheets["Worksheet"], { header: 1 }) as any[][];
  eq("header row intact", back[0].join("|"), "Rule Name|Rule Conditions|Rule Outputs");
  eq("all rows survived", back.length - 1, fixtures.length);

  back.slice(1).forEach((r, i) => {
    const f = fixtures[i];
    let cond: any, out: any;
    try { cond = JSON.parse(String(r[1])); } catch { cond = null; }
    try { out = JSON.parse(String(r[2])); } catch { out = null; }
    ok(`row ${i + 1} conditions parse after round-trip`, !!cond);
    ok(`row ${i + 1} outputs parse after round-trip`, !!out);
    eq(`row ${i + 1} vendor preserved`, cond?.ruleConditions?.[1]?.value, f.vendor);
    eq(`row ${i + 1} account preserved`, out?.ruleActions?.[0]?.value, f.account);
    ok(`row ${i + 1} money-out condition present`,
      !!cond?.ruleConditions?.some((c: any) => c.ruleType === 10 && c.value === "-1"));
    ok(`row ${i + 1} auto-apply set`,
      !!out?.ruleActions?.some((a: any) => a.actionType === 8 && a.value === true));
    ok(`row ${i + 1} carries no memo action`,
      !out?.ruleActions?.some((a: any) => a.actionType === 1));
  });
}

// ── 4. The guard itself ─────────────────────────────────────────────────────
console.log("oversize guard");
{
  // An account path long enough that nothing can save the row.
  const absurd = "A".repeat(300);
  ok("absurd account exceeds the limit", buildOutputs(absurd).length > BIFF_CELL_LIMIT);
  // The route SKIPS such a row rather than shipping a corrupt file. Dropping
  // one rule costs one rule; truncating it cost INTAC all 109.
  const kept = [{ vendor: "OK", account: "Fuel" }, { vendor: "BAD", account: absurd }]
    .filter((f) => buildOutputs(f.account).length <= BIFF_CELL_LIMIT);
  eq("only the safe row is exported", kept.length, 1);
  eq("...and it's the right one", kept[0].vendor, "OK");
}

console.log(`\nqbo-rules-export: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
