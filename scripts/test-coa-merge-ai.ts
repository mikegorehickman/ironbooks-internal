// Unit tests for the deterministic guard over AI merge suggestions.
// This is the safety layer — it holds regardless of what the model returns.
// (Live AI semantic quality is verified against prod, where the key is set.)
// Run: npx tsx scripts/test-coa-merge-ai.ts
import { reconcileAiSuggestions, type AiMergeSource, type AiMergeTarget } from "@/lib/coa-merge-ai";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

const targets: AiMergeTarget[] = [
  { id: "MKT", name: "Marketing", type: "Expense" },
  { id: "INS", name: "Insurance", type: "Expense" },
  { id: "JSM", name: "Job Supplies & Materials", type: "Cost of Goods Sold" },
  { id: "DRAW", name: "Owner's Draw", type: "Equity" },
  { id: "INT", name: "Interest Income", type: "Other Income" },
  // The exact trap from Mike's screenshot: a real Expense target the old
  // heuristic dumped everything into.
  { id: "GIVE", name: "Charitable Giving", type: "Expense" },
];

const sources: AiMergeSource[] = [
  { id: "trailer", name: "16ft Trailer", type: "Fixed Asset" },
  { id: "truck", name: "2005 Chevrolet 5500 Lift Truck", type: "Fixed Asset" },
  { id: "bank", name: "First Dakota Savings", type: "Bank" },
  { id: "card", name: "Frontier Card", type: "Credit Card" },
  { id: "ap", name: "Accounts Payable", type: "Accounts Payable" },
  { id: "loan", name: "Marliyn Loan", type: "Long Term Liability" },
  { id: "ins", name: "General Liability Insurance", type: "Expense" },
  { id: "lowes", name: "Lowes", type: "Cost of Goods Sold" },
  { id: "adv", name: "Online Advertising", type: "Expense" },
  { id: "jobinc", name: "NX Job Income", type: "Income" },
];

// --- Adversarial AI response: the old failure mode, where the model tried to
// dump EVERYTHING into "Charitable Giving" (a real, type-Expense target). ---
const adversarial = sources.map((s) => ({ sourceId: s.id, action: "merge", targetName: "Charitable Giving", confidence: 0.9, reason: "x" }));
let r = reconcileAiSuggestions(adversarial, sources, targets);
const byId = (rs: typeof r) => new Map(rs.map((x) => [x.sourceId, x]));
let m = byId(r);

// Balance-sheet accounts are ALWAYS left, even if the model said merge.
for (const id of ["trailer", "truck", "bank", "card", "ap", "loan"]) {
  ok(m.get(id)!.action === "leave", `${id} (balance-sheet) forced to leave despite AI saying merge`);
}
// An INCOME source can never land on an Expense target (Charitable Giving).
ok(m.get("jobinc")!.action === "leave", `income "NX Job Income" rejected from Expense target`);
// Expense/COGS sources → Charitable Giving is type-compatible, so the guard
// PASSES it (semantic correctness is the AI's job, not the type guard's).
ok(m.get("ins")!.action === "merge" && m.get("ins")!.targetName === "Charitable Giving", `type-compatible merge passes the guard (AI owns semantics)`);

// --- Good AI response: correct, meaningful targets. ---
const good = [
  { sourceId: "trailer", action: "leave", targetName: null, confidence: 0, reason: "fixed asset" },
  { sourceId: "truck", action: "leave", targetName: null, confidence: 0, reason: "fixed asset" },
  { sourceId: "bank", action: "leave", targetName: null, confidence: 0, reason: "bank" },
  { sourceId: "card", action: "leave", targetName: null, confidence: 0, reason: "card" },
  { sourceId: "ap", action: "leave", targetName: null, confidence: 0, reason: "system" },
  { sourceId: "loan", action: "leave", targetName: null, confidence: 0, reason: "loan" },
  { sourceId: "ins", action: "merge", targetName: "Insurance", confidence: 0.95, reason: "liability insurance" },
  { sourceId: "lowes", action: "merge", targetName: "Job Supplies & Materials", confidence: 0.9, reason: "hardware vendor" },
  { sourceId: "adv", action: "merge", targetName: "Marketing", confidence: 0.92, reason: "advertising" },
  { sourceId: "jobinc", action: "leave", targetName: null, confidence: 0.4, reason: "no income target that fits" },
];
r = reconcileAiSuggestions(good, sources, targets);
m = byId(r);
ok(m.get("ins")!.action === "merge" && m.get("ins")!.targetId === "INS", `"General Liability Insurance" → Insurance`);
ok(m.get("lowes")!.action === "merge" && m.get("lowes")!.targetId === "JSM", `"Lowes" → Job Supplies & Materials`);
ok(m.get("adv")!.action === "merge" && m.get("adv")!.targetId === "MKT" && m.get("adv")!.confidence >= 0.85, `"Online Advertising" → Marketing (confident)`);
ok(m.get("jobinc")!.action === "leave", `income with no fitting target → leave`);

// --- Hallucinated target: model invents an account that doesn't exist. ---
const hallucinated = [{ sourceId: "ins", action: "merge", targetName: "Made Up Account", confidence: 0.99, reason: "x" }];
r = reconcileAiSuggestions(hallucinated, [sources.find((s) => s.id === "ins")!], targets);
ok(r[0].action === "leave", `hallucinated target "Made Up Account" rejected → leave`);

// --- Every source appears exactly once. ---
r = reconcileAiSuggestions([], sources, targets);
ok(r.length === sources.length && new Set(r.map((x) => x.sourceId)).size === sources.length, `empty AI response → every source leaves, once each`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
