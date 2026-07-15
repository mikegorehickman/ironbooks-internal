// Tests for bank-rule grouping: brand consolidation + noise filtering.
// Run: npx tsx scripts/test-rules-eligibility.ts
import { buildRuleCandidates, ruleGroupKey, type RuleSourceRow } from "@/lib/rules-eligibility";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

const row = (o: Partial<RuleSourceRow>): RuleSourceRow => ({
  vendor_name: "Unknown vendor",
  vendor_pattern_normalized: null,
  description: null,
  decision: "approved",
  to_account_id: "1",
  to_account_name: "Fuel – Overhead",
  bookkeeper_override_target_id: null,
  bookkeeper_override_target_name: null,
  transaction_amount: 50,
  ...o,
});

// ── Mike's core ask: brand consolidation ──
// Multiple raw phrasings of the SAME brand must collapse into ONE candidate.
const petroRows = [
  row({ description: "PETRO-CANADA #1234 TORONTO ON" }),
  row({ description: "INTERAC PURCHASE - PETRO-CANADA" }),
  row({ description: "35 PETRO CANADA 8821" }),
  row({ description: "PETRO-CANADA #5678 OTTAWA" }),
];
const { candidates: petroCandidates } = buildRuleCandidates(petroRows);
ok(petroCandidates.length === 1, `4 phrasings of Petro-Canada → 1 rule (got ${petroCandidates.length})`);
ok(petroCandidates[0]?.vendorDisplay === "Petro-Canada", `canonical display name is "Petro-Canada" (got "${petroCandidates[0]?.vendorDisplay}")`);
ok(petroCandidates[0]?.txCount === 4, `rule covers all 4 transactions (got ${petroCandidates[0]?.txCount})`);

// ── Mike's exact junk example: pure noise must be ignored, not a rule ──
const noiseKey = ruleGroupKey({ vendor_name: "Unknown vendor", vendor_pattern_normalized: null, description: "35 INTERAC PURCHASE 3199 3235" });
ok(noiseKey === null, "'35 INTERAC PURCHASE 3199 3235' → no group (pure bank plumbing)");
const { candidates: noiseCandidates, excluded } = buildRuleCandidates([
  row({ description: "35 INTERAC PURCHASE 3199 3235" }),
  row({ description: "INTERAC E-TRANSFER 4471 8823" }),
  row({ description: "POS WITHDRAWAL 9912" }),
]);
ok(noiseCandidates.length === 0, "noise-only descriptions never become rule candidates");
ok(excluded.no_vendor === 3, `all 3 noise rows counted in excluded.no_vendor (got ${excluded.no_vendor})`);

// ── Real un-branded vendor must still survive (don't over-filter) ──
const localShopRows = [
  row({ description: "JOE'S HARDWARE STORE #22" }),
  row({ description: "JOE'S HARDWARE STORE #22" }),
];
const { candidates: localCandidates } = buildRuleCandidates(localShopRows);
ok(localCandidates.length === 1, "a real (non-brand-listed) vendor still becomes a candidate, not dropped");
ok(localCandidates[0]?.txCount === 2, "real vendor still counts both transactions");

// ── Known vendor path (vendor_name present) is untouched ──
const knownKey = ruleGroupKey({ vendor_name: "Sherwin Williams", vendor_pattern_normalized: "SHERWIN WILLIAMS", description: null });
ok(knownKey?.key === "SHERWIN WILLIAMS", "known-vendor path uses vendor_pattern_normalized, unaffected by brand extraction");

// ── Sample descriptions: real preview text, not the "Unknown vendor" sentinel ──
const { candidates: sampleCandidates } = buildRuleCandidates([
  row({ description: "PETRO-CANADA #1234 TORONTO ON" }),
  row({ description: "INTERAC PURCHASE - PETRO-CANADA" }),
]);
const samples = sampleCandidates[0]?.sampleDescriptions || [];
ok(samples.length === 2, `2 distinct real sample descriptions captured (got ${samples.length})`);
ok(!samples.includes("Unknown vendor"), "samples are real bank text, never the 'Unknown vendor' sentinel");
ok(samples.some((s) => /PETRO-CANADA #1234/i.test(s)), "sample includes the actual raw description");

// ── A known vendor's own sample uses vendor_name (unchanged behavior) ──
const { candidates: knownSampleCandidates } = buildRuleCandidates([
  row({ vendor_name: "Sherwin Williams", vendor_pattern_normalized: "SHERWIN WILLIAMS", description: "SHERWIN WILLIAMS #4521" }),
]);
ok(knownSampleCandidates[0]?.sampleDescriptions[0] === "Sherwin Williams", "known-vendor samples still use vendor_name");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
