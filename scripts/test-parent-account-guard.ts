/** Unit tests for lib/parent-account-guard.ts — the "never post to a parent
 *  account" invariant.
 *  Run: npx tsx scripts/test-parent-account-guard.ts
 */
import {
  buildParentAccountIds,
  buildParentAccountNames,
  isParentAccountId,
  isParentAccountName,
  enforceNoParentPostings,
} from "../lib/parent-account-guard";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }

// A realistic painter chart: two parents with children, plus flat leaves.
const CHART = [
  { Id: "10", Name: "Vehicle Expenses" },
  { Id: "11", Name: "Vehicle Expenses:Admin Gas", ParentRef: { value: "10" } },
  { Id: "12", Name: "Vehicle Expenses:Field Gas", ParentRef: { value: "10" } },
  { Id: "20", Name: "Travel & Meals" },
  { Id: "21", Name: "Travel & Meals:Meals (50% deductible)", ParentRef: { value: "20" } },
  { Id: "30", Name: "Bank Charges" },                                  // flat leaf
  { Id: "40", Name: "Retired Sub", ParentRef: { value: "30" }, Active: false }, // inactive child
];

// ── Parent identification ──────────────────────────────────────────────────
const pIds = buildParentAccountIds(CHART);
const pNames = buildParentAccountNames(CHART);

ok("parents are identified by having children", pIds.has("10") && pIds.has("20"));
ok("leaves are not parents", !pIds.has("11") && !pIds.has("12") && !pIds.has("21"));
// An inactive child still leaves historical postings under the parent, so the
// parent is still a heading and still must not be posted to.
ok("an account with only an INACTIVE child is still a parent", pIds.has("30"));
ok("parent count is exactly 3", pIds.size === 3);

ok("isParentAccountId true for a parent", isParentAccountId("10", pIds));
ok("isParentAccountId false for a leaf", !isParentAccountId("11", pIds));
ok("isParentAccountId false for null/empty", !isParentAccountId(null, pIds) && !isParentAccountId("", pIds));

// ── Name matching, including QBO's "Parent:Child" fully-qualified form ──────
ok("parent name matches", isParentAccountName("Vehicle Expenses", pNames));
ok("parent name is case-insensitive", isParentAccountName("vehicle expenses", pNames));
ok("parent name tolerates whitespace", isParentAccountName("  Travel & Meals  ", pNames));
ok("a leaf name does NOT match", !isParentAccountName("Admin Gas", pNames));
ok("a fully-qualified leaf does NOT match", !isParentAccountName("Vehicle Expenses:Admin Gas", pNames));
ok("unknown name does not match", !isParentAccountName("Subcontractors", pNames));
ok("null name does not match", !isParentAccountName(null, pNames));

// ── The write-boundary guard ────────────────────────────────────────────────
{
  const rows: any[] = [
    // by id → must be blocked
    { to_account_id: "10", to_account_name: "Vehicle Expenses", decision: "auto_approve", status: "pending", ai_reasoning: "gas" },
    // by NAME only (bank rules / bookkeeper overrides carry no id) → blocked
    { to_account_id: "", to_account_name: "Travel & Meals", decision: "auto_approve", status: "pending", ai_reasoning: "lunch" },
    // legitimate leaf → untouched
    { to_account_id: "11", to_account_name: "Admin Gas", decision: "auto_approve", status: "pending", ai_reasoning: "fuel" },
  ];
  const blocked = enforceNoParentPostings(rows, pIds, pNames);
  ok("blocks both parent rows", blocked === 2);
  ok("parent-by-id demoted to needs_review", rows[0].decision === "needs_review" && rows[0].status === "pending");
  ok("parent-by-name demoted to needs_review", rows[1].decision === "needs_review");
  ok("block reason names the account", String(rows[1].ai_reasoning).includes("Travel & Meals"));
  ok("original reasoning is preserved", String(rows[1].ai_reasoning).includes("lunch"));
  ok("leaf row is completely untouched", rows[2].decision === "auto_approve" && rows[2].ai_reasoning === "fuel");
  // Nothing may be silently dropped or retargeted — the target is left intact
  // so a human can see what SNAP wanted to do.
  ok("blocked row keeps its target for the reviewer", rows[0].to_account_name === "Vehicle Expenses");
}
{
  // Rows already headed to a human need no relabelling.
  const rows: any[] = [
    { to_account_id: "10", to_account_name: "Vehicle Expenses", decision: "needs_review", status: "pending", ai_reasoning: "keep" },
    { to_account_id: "20", to_account_name: "Travel & Meals", decision: "ask_client", status: "pending", ai_reasoning: "keep" },
    { to_account_id: "10", to_account_name: "Vehicle Expenses", decision: "flagged", status: "pending", ai_reasoning: "keep" },
  ];
  ok("already-human rows are left alone", enforceNoParentPostings(rows, pIds, pNames) === 0);
  ok("their reasoning is not rewritten", rows.every((r) => r.ai_reasoning === "keep"));
}
{
  // A real skip (closed period, reconciled) must not be resurrected into review.
  const rows: any[] = [
    { to_account_id: "10", to_account_name: "Vehicle Expenses", decision: "skip", status: "skipped", skip_reason: "closed_period_qbo", ai_reasoning: "x" },
    { to_account_id: "10", to_account_name: "Vehicle Expenses", decision: "skip", status: "skipped", skip_reason: "reconciled", ai_reasoning: "x" },
  ];
  ok("genuinely-skipped rows stay skipped", enforceNoParentPostings(rows, pIds, pNames) === 0);
  ok("closed-period skip keeps its reason", rows[0].skip_reason === "closed_period_qbo");
}
{
  // A chart with no parents at all must be a no-op — and must not crash.
  const flat = [{ Id: "1", Name: "Bank Charges" }, { Id: "2", Name: "Supplies" }];
  const rows: any[] = [{ to_account_id: "1", to_account_name: "Bank Charges", decision: "auto_approve", ai_reasoning: "x" }];
  ok("flat chart blocks nothing",
    enforceNoParentPostings(rows, buildParentAccountIds(flat), buildParentAccountNames(flat)) === 0);
  ok("flat-chart row untouched", rows[0].decision === "auto_approve");
}
{
  // Empty inputs must be safe — this runs on every job.
  ok("empty rows are fine", enforceNoParentPostings([], pIds, pNames) === 0);
  ok("empty chart is fine", enforceNoParentPostings([{ to_account_id: "10" } as any], new Set(), new Set()) === 0);
}

console.log(`\nparent-account-guard: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
