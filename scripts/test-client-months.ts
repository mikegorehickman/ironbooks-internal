/** Unit tests for lib/client-months.ts — the monthly close stage model.
 *  Run: npx tsx scripts/test-client-months.ts
 */
import {
  MONTH_STAGES,
  formatMonth,
  monthBounds,
  periodMonthOf,
  priorPeriodMonth,
  monthProgress,
  stageState,
  eligibleForMonthlyClose,
  effectiveStatus,
} from "../lib/client-months";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const eq = (name: string, got: any, want: any) =>
  ok(`${name}${got === want ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

// ── Month bounds — the range a reclass job gets scoped to ──────────────────
eq("June end is the 30th", monthBounds("2026-06-01").end, "2026-06-30");
eq("June start", monthBounds("2026-06-01").start, "2026-06-01");
eq("July end is the 31st", monthBounds("2026-07-01").end, "2026-07-31");
eq("February 2026 (non-leap) ends 28th", monthBounds("2026-02-01").end, "2026-02-28");
eq("February 2024 (leap) ends 29th", monthBounds("2024-02-01").end, "2024-02-29");
eq("December end", monthBounds("2026-12-01").end, "2026-12-31");
eq("single-digit month is zero-padded", monthBounds("2026-03-01").start, "2026-03-01");

// ── Formatting. A bare date string is UTC midnight, so a naive `new Date()`
//    renders the PREVIOUS month for anyone west of Greenwich. ───────────────
eq("June 2026 label", formatMonth("2026-06-01"), "June 2026");
eq("January label", formatMonth("2026-01-01"), "January 2026");
eq("December label", formatMonth("2025-12-01"), "December 2025");

// ── Which month the 1st-of-month cron should close ─────────────────────────
eq("running on 1 Jul closes June", priorPeriodMonth(new Date("2026-07-01T07:00:00Z")), "2026-06-01");
eq("running on 1 Jan closes last December", priorPeriodMonth(new Date("2026-01-01T07:00:00Z")), "2025-12-01");
eq("running mid-July still closes June", priorPeriodMonth(new Date("2026-07-28T07:00:00Z")), "2026-06-01");
eq("current month of a July date", periodMonthOf(new Date("2026-07-28T07:00:00Z")), "2026-07-01");

// ── Progress is DERIVED, and skipped is NOT done ──────────────────────────
{
  const p = monthProgress(null);
  ok("no row = zero progress", p.done === 0 && p.pct === 0 && !p.allResolved);
  eq("next stage on an empty month is COA", p.nextStage?.key, "coa_confirmed_at");
}
{
  const p = monthProgress({});
  eq("stage count is the agreed 7", p.total, 7);
  eq("empty row is 0%", p.pct, 0);
}
{
  const p = monthProgress({ coa_confirmed_at: "2026-07-01", reclass_completed_at: "2026-07-02" });
  eq("two stages done", p.done, 2);
  eq("next stage is bank rules", p.nextStage?.key, "bank_rules_completed_at");
  ok("not all resolved", !p.allResolved);
}
{
  // Out-of-order completion is normal — statements requested before bank rules
  // are finished. Progress must count completions, not position.
  const p = monthProgress({ coa_confirmed_at: "x", statements_requested_at: "x", duplicates_checked_at: "x" });
  eq("out-of-order completions still count", p.done, 3);
  eq("next stage is the first genuine gap", p.nextStage?.key, "reclass_completed_at");
}
{
  // A skip resolves a stage without claiming it was done.
  const p = monthProgress({ skipped_stages: ["coa_confirmed_at"], reclass_completed_at: "x" });
  eq("skipped counted separately", p.skipped, 1);
  eq("done excludes the skip", p.done, 1);
  eq("resolved includes both", p.resolved, 2);
  ok("a skipped stage is not the next action", p.nextStage?.key !== "coa_confirmed_at");
}
{
  const all: any = { skipped_stages: [] };
  for (const st of MONTH_STAGES) all[st.key] = "2026-07-01";
  const p = monthProgress(all);
  ok("every stage stamped = allResolved", p.allResolved && p.pct === 100);
  eq("no next stage when finished", p.nextStage, null);
  eq("nothing skipped", p.skipped, 0);
}
{
  // A month can close on a mix of done and skipped.
  const mixed: any = { skipped_stages: ["coa_confirmed_at", "bank_rules_completed_at", "ask_client_at", "statements_requested_at"] };
  for (const st of MONTH_STAGES) if (!mixed.skipped_stages.includes(st.key)) mixed[st.key] = "x";
  const p = monthProgress(mixed);
  ok("done + skipped can complete a month", p.allResolved && p.pct === 100);
  eq("skipped count is honest", p.skipped, 4);
  eq("done count is honest", p.done, 3);
}

// ── stageState: three states, never conflated ────────────────────────────
eq("done wins", stageState({ coa_confirmed_at: "x", skipped_stages: ["coa_confirmed_at"] } as any, "coa_confirmed_at"), "done");
eq("skipped when no timestamp", stageState({ skipped_stages: ["ask_client_at"] } as any, "ask_client_at"), "skipped");
eq("todo when neither", stageState({ skipped_stages: [] } as any, "ask_client_at"), "todo");
eq("null row is todo", stageState(null, "ask_client_at"), "todo");
eq("missing skipped_stages is safe", stageState({} as any, "ask_client_at"), "todo");

// ── Only the non-substantive stages may be skipped ───────────────────────
{
  const skippable = MONTH_STAGES.filter((s) => s.skippable).map((s) => s.key);
  const required = MONTH_STAGES.filter((s) => !s.skippable).map((s) => s.key);
  ok("COA confirm is skippable (per spec)", skippable.includes("coa_confirmed_at"));
  ok("reclass is NOT skippable", required.includes("reclass_completed_at"));
  ok("duplicates check is NOT skippable", required.includes("duplicates_checked_at"));
  ok("sending month-end is NOT skippable", required.includes("month_end_sent_at"));
}

// ── Eligibility: who gets a month opened ──────────────────────────────────
ok("cleanup-signed-off client is eligible",
  eligibleForMonthlyClose({ is_active: true, cleanup_completed_at: "2026-06-19", daily_recon_enabled: false }));
ok("daily-engine client is eligible",
  eligibleForMonthlyClose({ is_active: true, cleanup_completed_at: null, daily_recon_enabled: true }));
ok("onboarding client is NOT eligible (no month to close yet)",
  !eligibleForMonthlyClose({ is_active: true, cleanup_completed_at: null, daily_recon_enabled: false }));
ok("inactive client is NOT eligible",
  !eligibleForMonthlyClose({ is_active: false, cleanup_completed_at: "2026-06-19", daily_recon_enabled: true }));

// ── Status: a month can't declare victory before the work is stamped ──────
{
  const all: any = { status: "in_progress", skipped_stages: [] };
  for (const st of MONTH_STAGES) all[st.key] = "2026-07-01";
  eq("all stages stamped ⇒ complete", effectiveStatus(all), "complete");
}
eq("all stages SKIPPED-or-done also completes",
  effectiveStatus({
    status: "in_progress",
    skipped_stages: MONTH_STAGES.filter((s) => s.skippable).map((s) => s.key),
    reclass_completed_at: "x", duplicates_checked_at: "x", month_end_sent_at: "x",
  } as any), "complete");
eq("status=complete but nothing done ⇒ in_progress (cannot fake it)",
  effectiveStatus({ status: "complete" }), "in_progress");
eq("waiting_client is respected over derived state",
  effectiveStatus({ status: "waiting_client", coa_confirmed_at: "x" }), "waiting_client");
eq("failed_review is respected",
  effectiveStatus({ status: "failed_review", coa_confirmed_at: "x" }), "failed_review");
eq("some work done ⇒ in_progress",
  effectiveStatus({ status: "not_started", coa_confirmed_at: "x" }), "in_progress");
eq("nothing done ⇒ not_started", effectiveStatus({ status: "not_started", skipped_stages: [] } as any), "not_started");
eq("ready_for_review is kept while incomplete",
  effectiveStatus({ status: "ready_for_review", coa_confirmed_at: "x" }), "ready_for_review");

// ── Stage list integrity ─────────────────────────────────────────────────
ok("stage keys are unique", new Set(MONTH_STAGES.map((s) => s.key)).size === MONTH_STAGES.length);
ok("every stage has a label and a blurb", MONTH_STAGES.every((s) => !!s.label && !!s.blurb));
ok("every stage key ends in _at (it is a timestamp)", MONTH_STAGES.every((s) => s.key.endsWith("_at")));
ok("stage list matches the agreed 7", MONTH_STAGES.length === 7);

console.log(`\nclient-months: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
