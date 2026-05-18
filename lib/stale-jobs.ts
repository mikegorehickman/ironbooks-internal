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

// 15 min: a reclass AI discovery / web_search phase that hasn't even
// written `execution_started_at` is hung. Typical successful discovery
// finishes well under 5 minutes even with deep web search.
const NEVER_STARTED_MS = 15 * 60 * 1000;

// 45 min: QBO write phases run serially per action with rate-limit waits.
// Even a giant cleanup (hundreds of actions) finishes well inside this.
const STARTED_STALE_MS = 45 * 60 * 1000;

type SweepResult = {
  coa_failed: number;
  reclass_failed: number;
  stripe_recon_failed: number;
};

export async function sweepStaleJobs(): Promise<SweepResult> {
  const service = createServiceSupabase();
  const now = Date.now();
  const neverStartedCutoff = new Date(now - NEVER_STARTED_MS).toISOString();
  const startedStaleCutoff = new Date(now - STARTED_STALE_MS).toISOString();

  const errorMsgNeverStarted =
    "Auto-failed by watchdog: stuck in executing status with no execution_started_at for >15 min (likely AI discovery / web_search hang).";
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

  // reclass_jobs — same two modes
  const { data: reclassA } = await service
    .from("reclass_jobs")
    .update({
      status: "failed",
      error_message: errorMsgNeverStarted,
      execution_completed_at: new Date().toISOString(),
    } as any)
    .eq("status", "executing")
    .is("execution_started_at", null)
    .lt("created_at", neverStartedCutoff)
    .select("id");

  const { data: reclassB } = await service
    .from("reclass_jobs")
    .update({
      status: "failed",
      error_message: errorMsgStartedStale,
      execution_completed_at: new Date().toISOString(),
    } as any)
    .eq("status", "executing")
    .lt("execution_started_at", startedStaleCutoff)
    .select("id");

  // stripe_recon_jobs — defensive; column shape is leaner here, gate only
  // on created_at to keep it simple. If the table doesn't have these
  // columns the update silently affects 0 rows.
  let stripeFailed = 0;
  try {
    const { data: sr } = await service
      .from("stripe_recon_jobs" as any)
      .update({
        status: "failed",
        error_message: errorMsgNeverStarted,
      } as any)
      .eq("status", "executing")
      .lt("created_at", neverStartedCutoff)
      .select("id");
    stripeFailed = sr?.length || 0;
  } catch {
    // table or column may not exist in some envs — non-fatal
  }

  return {
    coa_failed: (coaA?.length || 0) + (coaB?.length || 0),
    reclass_failed: (reclassA?.length || 0) + (reclassB?.length || 0),
    stripe_recon_failed: stripeFailed,
  };
}
