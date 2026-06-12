import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { previousMonthPeriod } from "@/lib/monthly-rec";

/**
 * Cleanup completion endpoints for a client.
 *
 * POST  → Mark the client's cleanup as complete. Body:
 *           { range_start?: string;  // YYYY-MM-DD — saved so the PDF
 *             range_end?: string;    //   report can be re-pulled without
 *             note?: string;         //   re-picking dates.
 *           }
 *         If range is omitted, falls back to the most recent
 *         coa_jobs.date_range_* for this client.
 *
 * DELETE → Reopen a previously-completed cleanup. Clears the completion
 *          markers. The bookkeeper can start new jobs on the client
 *          again as normal.
 */

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const note: string | undefined = body?.note;
  let rangeStart: string | null = body?.range_start || null;
  let rangeEnd: string | null = body?.range_end || null;

  const service = createServiceSupabase();

  // Verify the client exists + load most-recent COA job for fallback dates.
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, cleanup_completed_at")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  if ((client as any).cleanup_completed_at) {
    return NextResponse.json(
      { ok: true, already_complete: true },
      { status: 200 }
    );
  }

  if (!rangeStart || !rangeEnd) {
    // Most-recent completed COA job is the canonical cleanup range. Falls
    // back to whatever the cleanup actually touched, not whatever the
    // bookkeeper happens to be looking at.
    const { data: lastJob } = await service
      .from("coa_jobs")
      .select("date_range_start, date_range_end")
      .eq("client_link_id", clientLinkId)
      .eq("status", "complete")
      .order("execution_completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastJob) {
      rangeStart = rangeStart || (lastJob as any).date_range_start;
      rangeEnd = rangeEnd || (lastJob as any).date_range_end;
    }
  }

  const now = new Date().toISOString();

  // Save the range + note immediately (the PDF re-pull depends on them),
  // but DON'T stamp cleanup_completed_at yet — completion now requires the
  // statement sign-off: bookkeeper reviews P&L/BS/CFS (+ AI spot check),
  // attests, and a senior approves & sends to the client. The send handler
  // (monthly-rec, kind='cleanup') stamps cleanup_completed_at.
  const { error: updErr } = await service
    .from("client_links")
    .update({
      cleanup_completion_note: note || null,
      cleanup_range_start: rangeStart,
      cleanup_range_end: rangeEnd,
    } as any)
    .eq("id", clientLinkId);

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  // Create (or refresh) the sign-off run. Period = the PREVIOUS calendar
  // month — the most recent complete month, which is what the statements
  // (P&L for the month, BS as of month end) should reflect. The current
  // month is still in flight and would show partial numbers.
  const prev = previousMonthPeriod(new Date(now));
  const period = prev.period;
  let signoffError: string | null = null;
  try {
    await (service as any).from("monthly_rec_runs").upsert(
      {
        client_link_id: clientLinkId,
        period,
        period_start: prev.periodStart,
        period_end: prev.periodEnd,
        kind: "cleanup",
        status: "open",
        created_by: user.id,
      },
      { onConflict: "client_link_id,period" }
    );
  } catch (e: any) {
    signoffError = e?.message || "sign-off run creation failed";
  }

  // Audit trail
  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "client_cleanup_signoff_started",
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
        range_start: rangeStart,
        range_end: rangeEnd,
        note: note || null,
      } as any,
    });
  } catch {
    // audit_log column shape varies across envs; non-fatal
  }

  return NextResponse.json({
    ok: true,
    requires_signoff: true,
    signoff_period: period,
    signoff_error: signoffError,
    message:
      "Cleanup work recorded. Final step: review the financial statements in Monthly Rec, attest, and get senior approval to send them to the client — that closes the cleanup.",
    cleanup_range_start: rangeStart,
    cleanup_range_end: rangeEnd,
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, cleanup_completed_at")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  if (!(client as any).cleanup_completed_at) {
    return NextResponse.json({ ok: true, already_open: true });
  }

  const { error: updErr } = await service
    .from("client_links")
    .update({
      cleanup_completed_at: null,
      cleanup_completed_by: null,
      cleanup_completion_note: null,
      // Keep range_* as historical breadcrumbs — useful if they reopen
      // and want to start from where they left off. Cleared on next
      // mark-complete anyway.
    } as any)
    .eq("id", clientLinkId);

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "client_cleanup_reopened",
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
      } as any,
    });
  } catch {
    // non-fatal
  }

  return NextResponse.json({ ok: true, reopened: true });
}
