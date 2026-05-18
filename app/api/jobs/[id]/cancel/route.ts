import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/jobs/[id]/cancel
 *
 * Cooperative cancellation for a COA cleanup job. Flips the job's status
 * to 'cancelled' and flags every still-pending coa_action as 'flag'
 * (with an explanatory flagged_reason) so they're skipped going forward.
 *
 * The in-flight executor function (if one is running) reads the job's
 * status between actions and exits cleanly when it sees 'cancelled'.
 * That can take a few seconds to a minute depending on where it is in
 * its loop — typical case is sub-minute.
 *
 * Body (optional): { hard?: boolean }
 *   hard=true → also invalidate the client's QBO access token, which
 *   causes any in-flight QBO API call to fail and the function to
 *   exit within seconds. The client needs to reconnect QBO via OAuth
 *   afterward. Use only if you really need it stopped within seconds.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const hard = body?.hard === true;

  const service = createServiceSupabase();

  // Confirm the job exists + grab its client_link_id for the hard-stop path
  const { data: job } = await service
    .from("coa_jobs")
    .select("id, status, client_link_id")
    .eq("id", jobId)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // If it's already done/cancelled/failed, no-op.
  if (job.status === "complete" || job.status === "cancelled" || job.status === "failed") {
    return NextResponse.json({ ok: true, already: job.status });
  }

  // 1. Mark the job cancelled and clear execution markers. The executor's
  //    cooperative-cancel checks read this and exit at the next loop boundary.
  await service
    .from("coa_jobs")
    .update({
      status: "cancelled",
      execution_completed_at: new Date().toISOString(),
      error_message: hard
        ? `Cancelled by bookkeeper (hard stop — QBO token invalidated)`
        : `Cancelled by bookkeeper`,
    } as any)
    .eq("id", jobId);

  // 2. Flag every still-pending action so they're skipped permanently.
  await service
    .from("coa_actions")
    .update({
      action: "flag",
      flagged_reason: "Cleanup cancelled by bookkeeper before this action executed.",
    } as any)
    .eq("job_id", jobId)
    .eq("executed", false)
    .in("action", ["rename", "merge", "delete", "create"]);

  // 3. Audit log
  await service.from("audit_log").insert({
    job_id: jobId,
    user_id: user.id,
    event_type: "job_cancelled",
    request_payload: {
      message: hard
        ? "Job cancelled (hard stop — QBO token invalidated)"
        : "Job cancelled by bookkeeper",
      hard,
    } as any,
  });

  // 4. Hard stop path — invalidate the QBO token so the in-flight function
  //    crashes on its next QBO call. Only do this if explicitly asked.
  if (hard) {
    await service
      .from("client_links")
      .update({
        qbo_access_token: "CANCELLED_BY_BOOKKEEPER",
        qbo_refresh_token: null,
        qbo_token_expires_at: null,
      } as any)
      .eq("id", job.client_link_id);
  }

  return NextResponse.json({
    ok: true,
    cancelled: true,
    hard,
    message: hard
      ? "Job cancelled. QBO token invalidated — reconnect QuickBooks for this client before next cleanup."
      : "Job cancelled. The background function (if running) will exit within ~60s when it checks status next.",
  });
}
