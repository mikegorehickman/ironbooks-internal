import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/reclass/[id]/status
 *
 * Live polling endpoint. Returns job state + recent audit events.
 * Query param: since (ISO timestamp) returns only events after.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;
  const { searchParams } = new URL(request.url);
  const since = searchParams.get("since");

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: job } = await supabase
    .from("reclass_jobs")
    .select("*")
    .eq("id", jobId)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  let logsQuery = supabase
    .from("audit_log")
    .select("event_type, request_payload, response_payload, occurred_at")
    .in("event_type", [
      "reclass_job_start",
      "reclass_progress",
      "reclass_job_complete",
      "reclass_job_failed",
    ])
    .order("occurred_at", { ascending: true })
    .limit(200);

  // Filter by this job's ID using JSONB containment
  logsQuery = logsQuery.filter(
    "request_payload->>reclass_job_id",
    "eq",
    jobId
  );

  if (since) logsQuery = logsQuery.gt("occurred_at", since);

  const { data: events } = await logsQuery;

  // Count executed rows
  const { count: executed } = await supabase
    .from("reclassifications")
    .select("*", { count: "exact", head: true })
    .eq("reclass_job_id", jobId)
    .eq("status", "executed");

  // Total approved (target denominator for progress)
  const { count: totalApproved } = await supabase
    .from("reclassifications")
    .select("*", { count: "exact", head: true })
    .eq("reclass_job_id", jobId)
    .in("decision", ["auto_approve", "approved"]);

  const total = totalApproved || 0;
  const completed = executed || 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Parse web search progress from error_message when paused/running a chunk.
  // Format: "[web_search_progress] done/total"
  let webSearchProgress: { done: number; total: number } | null = null;
  const wsMatch = (job.error_message || "").match(/\[web_search_progress\]\s*(\d+)\/(\d+)/);
  if (wsMatch) {
    webSearchProgress = { done: parseInt(wsMatch[1], 10), total: parseInt(wsMatch[2], 10) };
  }
  // While a chunk is actively running (status=executing, ai_completed_at set),
  // derive progress from live row counts so the spinner shows meaningful numbers.
  if (!webSearchProgress && job.ai_completed_at && job.status === "executing") {
    const [searchedRes, remainingRes] = await Promise.all([
      supabase
        .from("reclassifications")
        .select("vendor_name")
        .eq("reclass_job_id", jobId)
        .ilike("ai_reasoning", "(web search%")
        .not("vendor_name", "is", null),
      supabase
        .from("reclassifications")
        .select("vendor_name")
        .eq("reclass_job_id", jobId)
        .in("decision", ["flagged", "needs_review"])
        .lt("ai_confidence", 0.7)
        .not("ai_reasoning", "ilike", "(web search%")
        .not("vendor_name", "is", null),
    ]);
    const done = new Set(searchedRes.data?.map((r: any) => r.vendor_name)).size;
    const remaining = new Set(remainingRes.data?.map((r: any) => r.vendor_name)).size;
    if (done + remaining > 0) {
      webSearchProgress = { done, total: done + remaining };
    }
  }

  // Pass the raw error_message to the UI only for [web_search] progress lines.
  // Suppress [web_search_progress] bookkeeping lines (those are internal state).
  const uiErrorMessage = (job.error_message || "").startsWith("[web_search_progress]")
    ? null
    : job.error_message;

  return NextResponse.json({
    status: job.status,
    workflow: job.workflow,
    execution_started_at: job.execution_started_at,
    execution_completed_at: job.execution_completed_at,
    duration_seconds: job.execution_duration_seconds,
    error_message: uiErrorMessage,
    web_search_progress: webSearchProgress,
    progress: {
      total,
      completed,
      percentage: pct,
    },
    stats: {
      pulled: job.transactions_pulled,
      in_scope: job.transactions_in_scope,
      auto_approve: job.transactions_auto_approve,
      needs_review: job.transactions_needs_review,
      flagged: job.transactions_flagged,
      skipped_reconciled: job.transactions_skipped_reconciled,
      skipped_closed: job.transactions_skipped_closed,
      moved: job.transactions_moved,
      failed: job.transactions_failed,
    },
    events: events || [],
  });
}
