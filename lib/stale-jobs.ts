import { createServiceSupabase } from "./supabase";

/**
 * Stale-job watchdog. Auto-fails any background job that's been sitting in
 * `executing` past its watchdog window so the row doesn't rot forever and
 * block the client from starting a new run.
 *
 * Two failure modes we catch:
 *
 * 1. Never-started: status='executing', execution_started_at IS NULL,
 *    created_at older than NEVER_STARTED_MS. This is the "AI categorization
 *    or web_search hung silently" case — the worker accepted the job but
 *    crashed/timed-out before writing the first stage marker. (Interial
 *    Painting reclass, May 2026 — sat 3+ hours.)
 *
 * 2. Started-but-stalled: status='executing', execution_started_at older
 *    than STARTED_STALE_MS. The executor began the QBO write phase but
 *    crashed mid-loop without ever flipping status. Generous window so we
 *    don't kill a legitimately slow large-batch run.
 *
 * Cheap to run on every clients-page load — it's a handful of indexed
 * UPDATEs and almost always touches zero rows. Also safe to expose as a
 * cron endpoint.
 */

// 15 min: a coa/stripe-recon AI discovery phase that hasn't even
// written `execution_started_at` is hung. Typical successful discovery
// finishes well under 5 minutes.
const NEVER_STARTED_MS = 15 * 60 * 1000;

// 25 min for reclass specifically. Reclass discovery batches through
// Anthropic ~30 lines at a time AND can do web_search fallback per
// vendor, so legitimate runs on busy clients (hundreds of vendors)
// can push past 15 min. 25 is a safer ceiling that still catches
// genuine hangs.
const NEVER_STARTED_RECLASS_MS = 25 * 60 * 1000;

// Reclass discovery actively writes progress to error_message after every
// batch (`[ai_progress] X/Y`) and at each phase boundary. So updated_at is
// the real "is it doing anything" signal — created_at alone falsely kills
// 80-batch jobs that take 30+ minutes but are making steady progress.
// We require BOTH: job is at least 25 min old AND no progress in 15 min.
//
// 15 min (raised from 5) because the legitimately quiet windows can be long:
//   - QBO transaction fetch on a multi-year date range: 2-5 min silent
//   - Bulk insert of thousands of reclassifications rows: 2-5 min silent
//   - Anthropic 529 retry chain: ~14s backoff on top of 75s timeout per call
// 15 min still catches truly stuck jobs (the worker would emit at least one
// phase or progress marker within that window if it's actually doing work).
// (Lionetti Painting, May 2026: legitimately busy job killed at 5-min mark.)
const RECLASS_SILENT_MS = 15 * 60 * 1000;

// 45 min: QBO write phases run serially per action with rate-limit waits.
// Even a giant cleanup (hundreds of actions) finishes well inside this.
const STARTED_STALE_MS = 45 * 60 * 1000;

// 6 hours of bookkeeper inactivity in `web_search_paused` → unpark the job
// to `in_review` so the same-client concurrency guard doesn't permanently
// block new reclass runs. The AI work is already done; this just hands
// the row back to the bookkeeper as a normal review-ready job. Never
// fails it — the work is real.
const WEB_SEARCH_PAUSED_IDLE_MS = 6 * 60 * 60 * 1000;

type SweepResult = {
  coa_failed: number;
  reclass_failed: number;
  stripe_recon_failed: number;
};

export async function sweepStaleJobs(): Promise<SweepResult> {
  const service = createServiceSupabase();
  const now = Date.now();
  const neverStartedCutoff = new Date(now - NEVER_STARTED_MS).toISOString();
  const neverStartedReclassCutoff = new Date(now - NEVER_STARTED_RECLASS_MS).toISOString();
  const reclassSilentCutoff = new Date(now - RECLASS_SILENT_MS).toISOString();
  const startedStaleCutoff = new Date(now - STARTED_STALE_MS).toISOString();
  const webSearchIdleCutoff = new Date(now - WEB_SEARCH_PAUSED_IDLE_MS).toISOString();

  const errorMsgNeverStarted =
    "Auto-failed by watchdog: stuck in executing status with no execution_started_at for >15 min (likely AI discovery / web_search hang).";
  const errorMsgNeverStartedReclass =
    "Auto-failed by watchdog: reclass discovery has been silent for >15 min after >25 min total runtime (likely AI categorization or web-search hang).";
  const errorMsgStartedStale =
    "Auto-failed by watchdog: execution_started_at older than 45 min with no completion (likely crashed mid-loop).";

  // coa_jobs — both failure modes
  const { data: coaA } = await service
    .from("coa_jobs")
    .update({
      status: "failed",
      error_message: errorMsgNeverStarted,
      execution_completed_at: new Date().toISOString(),
    } as any)
    .eq("status", "executing")
    .is("execution_started_at", null)
    .lt("created_at", neverStartedCutoff)
    .select("id");

  const { data: coaB } = await service
    .from("coa_jobs")
    .update({
      status: "failed",
      error_message: errorMsgStartedStale,
      execution_completed_at: new Date().toISOString(),
    } as any)
    .eq("status", "executing")
    .lt("execution_started_at", startedStaleCutoff)
    .select("id");

  // reclass_jobs — never-started mode. Now requires BOTH conditions:
  //   - created_at older than 25 min (NEVER_STARTED_RECLASS_MS), AND
  //   - updated_at older than 5 min (RECLASS_SILENT_MS).
  // The discovery worker writes `[phase] ...` and `[ai_progress] X/Y`
  // markers after every batch, which bumps updated_at. So a job that's
  // mid-batch and still progressing stays alive even past 25 min —
  // only jobs that have gone silent for 5+ minutes get killed.
  // (Splash of Colour, May 2026: 80 batches × ~20-30s = ~30 min total
  // legitimate runtime; old watchdog killed it at 25.)
  const { data: reclassA } = await service
    .from("reclass_jobs")
    .update({
      status: "failed",
      error_message: errorMsgNeverStartedReclass,
      execution_completed_at: new Date().toISOString(),
    } as any)
    .eq("status", "executing")
    .is("execution_started_at", null)
    .lt("created_at", neverStartedReclassCutoff)
    .lt("updated_at", reclassSilentCutoff)
    .select("id");

  // Started-but-stale: status='executing', execution_started_at older than
  // 45 min AND updated_at older than 5 min. The progress guard matters:
  // a big web-search chunk or a 500-vendor full-categorization can blow
  // past 45 min wall time while still emitting `[ai_progress]` markers
  // every batch. Without the updated_at gate, the watchdog kills live work.
  const { data: reclassB } = await service
    .from("reclass_jobs")
    .update({
      status: "failed",
      error_message: errorMsgStartedStale,
      execution_completed_at: new Date().toISOString(),
    } as any)
    .eq("status", "executing")
    .lt("execution_started_at", startedStaleCutoff)
    .lt("updated_at", reclassSilentCutoff)
    .select("id");

  // reclass_jobs — web_search_paused idle rescue. The AI work is done;
  // the row is waiting for the bookkeeper to pick "Web search" or "Skip".
  // If they never return, the row sits in web_search_paused forever and
  // blocks the per-client concurrency guard from starting a new reclass.
  // Flip to `in_review` (NOT failed — the AI decisions are valid) so the
  // bookkeeper sees it as a normal review job and the next reclass can run.
  const errorMsgWebSearchIdle =
    "Auto-unparked by watchdog: web_search_paused for >6h with no bookkeeper response. Decisions are intact — finish review or skip web search manually.";
  const { data: reclassC } = await service
    .from("reclass_jobs")
    .update({
      status: "in_review",
      error_message: errorMsgWebSearchIdle,
    } as any)
    .eq("status", "web_search_paused" as any)
    .lt("updated_at", webSearchIdleCutoff)
    .select("id");

  // stripe_recon_jobs — uses status='discovering' during the QBO fetch
  // phase (different status name than coa/reclass). We sweep both
  // 'discovering' and 'executing' rows older than the never-started cutoff.
  // The fetchStripeDeposits → QBO API call is the typical hang point.
  let stripeFailed = 0;
  try {
    const { data: sr } = await service
      .from("stripe_recon_jobs" as any)
      .update({
        status: "failed",
        error_message: errorMsgNeverStarted,
      } as any)
      .in("status", ["discovering", "executing"])
      .lt("created_at", neverStartedCutoff)
      .select("id");
    stripeFailed = sr?.length || 0;
  } catch {
    // table or column may not exist in some envs — non-fatal
  }

  return {
    coa_failed: (coaA?.length || 0) + (coaB?.length || 0),
    reclass_failed: (reclassA?.length || 0) + (reclassB?.length || 0) + (reclassC?.length || 0),
    stripe_recon_failed: stripeFailed,
  };
}
