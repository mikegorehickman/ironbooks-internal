// Tests for merge-target suggestion.
// Run: npx tsx scripts/test-coa-merge-suggest.ts
import { suggestMergeTarget, type MergeTarget } from "@/lib/coa-merge-suggest";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

// The client's master-standard accounts (valid merge targets).
const cogsTargets: MergeTarget[] = [
  { id: "t1", name: "Job Supplies & Materials" },
  { id: "t2", name: "Subcontractors" },
  { id: "t3", name: "Small Tools" },
];
const opTargets: MergeTarget[] = [
  { id: "m1", name: "Marketing" },
  { id: "m2", name: "Office & Admin" },
  { id: "m3", name: "Insurance" },
];

// Obvious COGS merges
let s = suggestMergeTarget("Job Supplies", true, cogsTargets);
ok(s.target?.id === "t1" && s.confident, `"Job Supplies" → Job Supplies & Materials (confident) [score ${s.score}]`);

s = suggestMergeTarget("Paint & Materials", true, cogsTargets);
ok(s.target?.id === "t1", `"Paint & Materials" → Job Supplies & Materials [score ${s.score}]`);

s = suggestMergeTarget("Subcontractors – Painting", true, cogsTargets);
ok(s.target?.id === "t2" && s.confident, `"Subcontractors – Painting" → Subcontractors [score ${s.score}]`);

// Obvious operating merges
s = suggestMergeTarget("Marketing Tools", false, opTargets);
ok(s.target?.id === "m1" && s.confident, `"Marketing Tools" → Marketing (confident) [score ${s.score}]`);

s = suggestMergeTarget("Online Advertising – Google Ads / Social Media Marketing", false, opTargets);
ok(s.target?.id === "m1", `"Online Advertising…Marketing" → Marketing [score ${s.score}]`);

s = suggestMergeTarget("General Liability Insurance", false, opTargets);
ok(s.target?.id === "m3" && s.confident, `"General Liability Insurance" → Insurance (confident) [score ${s.score}]`);

s = suggestMergeTarget("Office Supplies", false, opTargets);
ok(s.target?.id === "m2", `"Office Supplies" → Office & Admin [score ${s.score}]`);

// Something with no good target still returns the best but NOT confident
s = suggestMergeTarget("Zamboni Rental", false, opTargets);
ok(!s.confident, `"Zamboni Rental" has no confident target [target ${s.target?.name}, score ${s.score}]`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
