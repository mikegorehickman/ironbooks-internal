/** Unit tests for lib/time-tracking.ts — the timer's pure core.
 *  Run: npx tsx scripts/test-time-tracking.ts
 */
import {
  DEFAULT_TIME_BUDGET_MINUTES,
  STALE_MS,
  elapsedSeconds,
  finalizeSegment,
  applyResume,
  monthRangeUtc,
  attributionMonth,
  currentMonth,
  isOverBudget,
  effectiveBudgetMinutes,
  resolvePathContext,
  isClientShapedPath,
  formatClock,
  formatDuration,
} from "../lib/time-tracking";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const eq = (name: string, got: any, want: any) =>
  ok(`${name}${got === want ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);
const deepEq = (name: string, got: any, want: any) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(`${name}${g === w ? "" : `  (got ${g}, want ${w})`}`, g === w);
};

const T0 = Date.parse("2026-07-15T18:00:00.000Z");
const iso = (msOffset: number) => new Date(T0 + msOffset).toISOString();
const MIN = 60_000;

// ── elapsedSeconds ──────────────────────────────────────────────────────────
console.log("elapsedSeconds");
eq("running mid-segment: 100 banked + 90s live", elapsedSeconds(
  { status: "running", accumulated_seconds: 100, last_resumed_at: iso(-90_000), last_heartbeat_at: iso(-30_000) },
  T0
), 190);
eq("paused: banked only", elapsedSeconds(
  { status: "paused", accumulated_seconds: 340, last_resumed_at: null, last_heartbeat_at: iso(-5 * MIN) },
  T0
), 340);
eq("completed: banked only", elapsedSeconds(
  { status: "completed", accumulated_seconds: 512, last_resumed_at: null, last_heartbeat_at: null },
  T0
), 512);
eq("skew: last_resumed_at in the future clamps to banked", elapsedSeconds(
  { status: "running", accumulated_seconds: 60, last_resumed_at: iso(+30_000), last_heartbeat_at: iso(0) },
  T0
), 60);

// ── finalizeSegment ─────────────────────────────────────────────────────────
console.log("finalizeSegment");
{
  // Fresh running entry: cap at now, no auto-pause.
  const f = finalizeSegment(
    { status: "running", accumulated_seconds: 100, last_resumed_at: iso(-10 * MIN), last_heartbeat_at: iso(-1 * MIN) },
    T0
  );
  eq("fresh: banks the full segment", f.accumulatedSeconds, 100 + 600);
  eq("fresh: not auto-paused", f.autoPaused, false);
  eq("fresh: ends now", f.effectiveEndMs, T0);
}
{
  // Stale: laptop died 2h ago — cap at the last heartbeat, not wall clock.
  const f = finalizeSegment(
    { status: "running", accumulated_seconds: 0, last_resumed_at: iso(-150 * MIN), last_heartbeat_at: iso(-120 * MIN) },
    T0
  );
  eq("stale: capped at last heartbeat (30 min credited, not 150)", f.accumulatedSeconds, 30 * 60);
  eq("stale: auto-paused", f.autoPaused, true);
  eq("stale: effective end = heartbeat", f.effectiveEndMs, T0 - 120 * MIN);
}
{
  // Negative-segment guard: heartbeat predates the resume (resume then instant death).
  const f = finalizeSegment(
    { status: "running", accumulated_seconds: 45, last_resumed_at: iso(-40 * MIN), last_heartbeat_at: iso(-60 * MIN) },
    T0
  );
  eq("heartbeat<resume: +0, never negative", f.accumulatedSeconds, 45);
  eq("heartbeat<resume: auto-paused", f.autoPaused, true);
  eq("heartbeat<resume: effective end clamped to resume", f.effectiveEndMs, T0 - 40 * MIN);
}
{
  // Paused entry: no-op.
  const f = finalizeSegment(
    { status: "paused", accumulated_seconds: 300, last_resumed_at: null, last_heartbeat_at: iso(-999 * MIN) },
    T0
  );
  eq("paused: accumulated unchanged", f.accumulatedSeconds, 300);
  eq("paused: not flagged", f.autoPaused, false);
}
{
  // Exactly at the staleness boundary is NOT stale (> not >=).
  const f = finalizeSegment(
    { status: "running", accumulated_seconds: 0, last_resumed_at: iso(-STALE_MS), last_heartbeat_at: iso(-STALE_MS) },
    T0
  );
  eq("boundary: exactly STALE_MS old is still fresh", f.autoPaused, false);
}

// ── applyResume ─────────────────────────────────────────────────────────────
console.log("applyResume");
{
  const r = applyResume(T0);
  eq("resume sets running", r.status, "running");
  eq("resume stamps segment start", r.last_resumed_at, iso(0));
  eq("resume bumps heartbeat (negative-segment guard)", r.last_heartbeat_at, iso(0));
  eq("resume clears auto_paused", r.auto_paused, false);
}

// ── month math ──────────────────────────────────────────────────────────────
console.log("monthRangeUtc / attributionMonth");
{
  // America/Regina is UTC-6 year-round (no DST).
  const r = monthRangeUtc("2026-07", "America/Regina");
  eq("Regina July start", r.startUtc, "2026-07-01T06:00:00.000Z");
  eq("Regina July end", r.endUtc, "2026-08-01T06:00:00.000Z");
}
{
  // Dec → Jan rollover.
  const r = monthRangeUtc("2026-12", "America/Regina");
  eq("Dec end rolls into next year", r.endUtc, "2027-01-01T06:00:00.000Z");
}
{
  // DST months in a DST zone: March (spring forward) and November (fall back).
  const mar = monthRangeUtc("2026-03", "America/New_York");
  eq("NY March start (EST, -5)", mar.startUtc, "2026-03-01T05:00:00.000Z");
  const apr = monthRangeUtc("2026-04", "America/New_York");
  eq("NY April start (EDT, -4)", apr.startUtc, "2026-04-01T04:00:00.000Z");
  eq("NY March end == April start (half-open, DST-consistent)", mar.endUtc, apr.startUtc);
  const nov = monthRangeUtc("2026-11", "America/New_York");
  eq("NY Nov start (EDT, -4)", nov.startUtc, "2026-11-01T04:00:00.000Z");
  const dec = monthRangeUtc("2026-12", "America/New_York");
  eq("NY Dec start (EST, -5)", dec.startUtc, "2026-12-01T05:00:00.000Z");
}
{
  let threw = false;
  try { monthRangeUtc("2026-7" as any); } catch { threw = true; }
  eq("malformed month rejected", threw, true);
  threw = false;
  try { monthRangeUtc("2026-13"); } catch { threw = true; }
  eq("month 13 rejected", threw, true);
}
// A UTC instant that is the PREVIOUS month in the business TZ:
eq("Aug 1 02:00Z is July in Regina", attributionMonth("2026-08-01T02:00:00.000Z", "America/Regina"), "2026-07");
eq("Aug 1 07:00Z is August in Regina", attributionMonth("2026-08-01T07:00:00.000Z", "America/Regina"), "2026-08");
eq("currentMonth agrees with attributionMonth", currentMonth(Date.parse("2026-08-01T02:00:00.000Z"), "America/Regina"), "2026-07");

// ── budget ──────────────────────────────────────────────────────────────────
console.log("isOverBudget");
eq("exactly at budget is NOT over", isOverBudget(90 * 60, 30 * 60, 120), false);
eq("one second past budget IS over", isOverBudget(90 * 60, 30 * 60 + 1, 120), true);
eq("NULL budget falls back to default", isOverBudget(DEFAULT_TIME_BUDGET_MINUTES * 60, 1, null), true);
eq("NULL budget under default is fine", isOverBudget(0, DEFAULT_TIME_BUDGET_MINUTES * 60, null), false);
eq("ZERO budget: any second is over (?? not ||)", isOverBudget(0, 1, 0), true);
eq("ZERO budget: zero seconds is not over", isOverBudget(0, 0, 0), false);
eq("effectiveBudgetMinutes(0) is 0", effectiveBudgetMinutes(0), 0);
eq("effectiveBudgetMinutes(null) is default", effectiveBudgetMinutes(null), DEFAULT_TIME_BUDGET_MINUTES);

// ── route resolution ────────────────────────────────────────────────────────
console.log("resolvePathContext");
const CID = "6f7f4b1a-3b65-435c-a22e-19863c7b4786";
const JID = "0b7c9e2d-1111-4222-8333-abcdefabcdef";
deepEq("/clients/[id]", resolvePathContext(`/clients/${CID}`), { kind: "client", clientLinkId: CID });
deepEq("/clients/[id]/cpa (subpage)", resolvePathContext(`/clients/${CID}/cpa`), { kind: "client", clientLinkId: CID });
deepEq("/today/[clientId]", resolvePathContext(`/today/${CID}`), { kind: "client", clientLinkId: CID });
deepEq("/balance-sheet/[client_id]/coa", resolvePathContext(`/balance-sheet/${CID}/coa`), { kind: "client", clientLinkId: CID });
deepEq("/revenue-check/[client_id]", resolvePathContext(`/revenue-check/${CID}`), { kind: "client", clientLinkId: CID });
deepEq("/tax-audit/[client_id]", resolvePathContext(`/tax-audit/${CID}`), { kind: "client", clientLinkId: CID });
deepEq("/reclass/[id]/review → reclass_jobs", resolvePathContext(`/reclass/${JID}/review`), { kind: "job", table: "reclass_jobs", jobId: JID });
deepEq("/jobs/[id]/execute → coa_jobs", resolvePathContext(`/jobs/${JID}/execute`), { kind: "job", table: "coa_jobs", jobId: JID });
deepEq("/rules/[id]/review → rule_discovery_jobs", resolvePathContext(`/rules/${JID}/review`), { kind: "job", table: "rule_discovery_jobs", jobId: JID });
deepEq("/stripe-recon/[id]/execute → stripe_recon_jobs", resolvePathContext(`/stripe-recon/${JID}/execute`), { kind: "job", table: "stripe_recon_jobs", jobId: JID });
deepEq("/balance-sheet/uf-ar/[id]/review → uf_ar_jobs", resolvePathContext(`/balance-sheet/uf-ar/${JID}/review`), { kind: "job", table: "uf_ar_jobs", jobId: JID });
deepEq("?client= on /reclass/new", resolvePathContext(`/reclass/new?client=${CID}&workflow=full_categorization`), { kind: "client", clientLinkId: CID });
deepEq("?client= on /jobs/new", resolvePathContext(`/jobs/new?client=${CID}&redo=1`), { kind: "client", clientLinkId: CID });
eq("'new' is not a uuid (/jobs/new bare)", resolvePathContext("/jobs/new"), null);
eq("fleet page /balance-sheet/cleanup is not client-scoped", resolvePathContext("/balance-sheet/cleanup"), null);
eq("/today (no id) is not client-scoped", resolvePathContext("/today"), null);
eq("/admin/billing is not client-scoped", resolvePathContext("/admin/billing"), null);
eq("/portal paths not client-scoped", resolvePathContext(`/portal/profit-loss`), null);
deepEq("trailing slash tolerated", resolvePathContext(`/clients/${CID}/`), { kind: "client", clientLinkId: CID });
deepEq("unrelated query string tolerated", resolvePathContext(`/clients/${CID}?tab=pl`), { kind: "client", clientLinkId: CID });
eq("prefilter agrees (positive)", isClientShapedPath(`/clients/${CID}`), true);
eq("prefilter agrees (negative)", isClientShapedPath("/inbox"), false);

// ── formatting ──────────────────────────────────────────────────────────────
console.log("formatClock / formatDuration");
eq("clock 0", formatClock(0), "0:00");
eq("clock 59s", formatClock(59), "0:59");
eq("clock 61m", formatClock(61 * 60), "1:01:00");
eq("clock 12m34s", formatClock(12 * 60 + 34), "12:34");
eq("duration 0", formatDuration(0), "0m");
eq("duration 59s rounds to 1m", formatDuration(59), "1m");
eq("duration 61m", formatDuration(61 * 60), "1h 1m");
eq("duration exact hours", formatDuration(3 * 3600), "3h");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
