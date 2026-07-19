// Tests for the CA entity-type → GIFI owner-equity mapping.
// Run: npx tsx scripts/test-entity-type.ts
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

(async () => {
  const { entityTypeOf } = await import("@/lib/tax-export");

  // profile dropdown values
  ok(entityTypeOf("Corporation") === "corp", "Corporation → corp");
  ok(entityTypeOf("LLC") === "corp", "LLC → corp");
  ok(entityTypeOf("S-Corp") === "corp", "S-Corp → corp");
  ok(entityTypeOf("Sole Proprietor") === "sole_prop", "Sole Proprietor → sole_prop");
  ok(entityTypeOf("Partnership") === "sole_prop", "Partnership → sole_prop");
  // free-text variants that came in from onboarding forms
  ok(entityTypeOf("sole prop") === "sole_prop", "'sole prop' free text → sole_prop");
  ok(entityTypeOf("SP - registered") === "corp", "ambiguous 'SP' alone does NOT match (needs sole/proprietor/partner)");
  // unset → corp default (most of the fleet is incorporated)
  ok(entityTypeOf(null) === "corp", "null → corp default");
  ok(entityTypeOf("") === "corp", "empty → corp default");
  ok(entityTypeOf("Nonprofit") === "corp", "Nonprofit → corp (files T2)");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
