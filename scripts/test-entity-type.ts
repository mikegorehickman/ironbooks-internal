// Tests for entity-type resolution → filing form + owner-equity mapping.
// Run: npx tsx scripts/test-entity-type.ts

import { resolveEntityType, taxFormFor, isSolePropLike, entityOptionsFor, entityLabel } from "@/lib/entity-type";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

// resolveEntityType: stored value wins
ok(resolveEntityType("s_corp", "Corporation") === "s_corp", "stored s_corp wins over corporate_type");
ok(resolveEntityType("sole_prop", null) === "sole_prop", "stored sole_prop");
// fall back to legacy corporate_type free text
ok(resolveEntityType(null, "S-Corp") === "s_corp", "derive s_corp from 'S-Corp'");
ok(resolveEntityType(null, "Partnership") === "partnership", "derive partnership");
ok(resolveEntityType(null, "Sole Proprietor") === "sole_prop", "derive sole_prop");
ok(resolveEntityType(null, "Corporation") === "c_corp", "derive c_corp from 'Corporation'");
ok(resolveEntityType(null, "LLC") === "c_corp", "LLC → c_corp default (bookkeeper should confirm)");
ok(resolveEntityType(null, null) === "c_corp", "null → c_corp default (most of the fleet is incorporated)");
ok(resolveEntityType("garbage", "Sole Proprietor") === "sole_prop", "invalid stored value falls through to derivation");

// taxFormFor — US
ok(taxFormFor("c_corp", "US") === "Form 1120", "US c_corp → 1120");
ok(taxFormFor("s_corp", "US") === "Form 1120-S", "US s_corp → 1120-S");
ok(taxFormFor("partnership", "US") === "Form 1065", "US partnership → 1065");
ok(taxFormFor("sole_prop", "US") === "Schedule C", "US sole_prop → Schedule C");
// taxFormFor — Canada (no C/S split)
ok(taxFormFor("c_corp", "CA") === "T2", "CA corp → T2");
ok(taxFormFor("s_corp", "CA") === "T2", "CA s_corp still → T2");
ok(taxFormFor("sole_prop", "CA") === "T2125", "CA sole_prop → T2125");
ok(taxFormFor("partnership", "CA") === "T2125", "CA partnership → T2125");

// isSolePropLike (drives owner-equity overrides)
ok(isSolePropLike("sole_prop") && isSolePropLike("partnership"), "sole_prop + partnership are sole-prop-like");
ok(!isSolePropLike("c_corp") && !isSolePropLike("s_corp"), "corps are not sole-prop-like");

// options + labels differ by country
ok(entityOptionsFor("US").length === 4, "US offers all 4 entity options");
ok(entityOptionsFor("CA").length === 3 && !entityOptionsFor("CA").includes("s_corp"), "CA drops S-corp");
ok(entityLabel("c_corp", "CA") === "Corporation", "CA relabels c_corp as 'Corporation'");
ok(entityLabel("c_corp", "US") === "C-Corporation", "US keeps 'C-Corporation'");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
