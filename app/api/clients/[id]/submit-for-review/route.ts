import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/[id]/submit-for-review
 *
 * Bookkeeper-of-any-role action: flag a finished cleanup as "ready for
 * senior review." Sets cleanup_review_state='in_review' and records who
 * submitted + when. The client moves out of the active list on /clients
 * and into the In Review partition; seniors see a new dashboard widget
 * with all pending reviews.
 *
 * Body (optional): { range_start?, range_end? } — passed through so the
 * eventual PDF report uses the cleanup's window. Falls back to the most
 * recent coa_jobs date range when omitted (same pattern as the old
 * complete-cleanup endpoint).
 *
 * DELETE = un-submit (send back to Active). Used if the bookkeeper
 * realized they're not done yet.
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
  let rangeStart: string | null = body?.range_start || null;
  let rangeEnd: string | null = body?.range_end || null;

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, cleanup_review_state, cleanup_completed_at, pl_attested_at")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  if ((client as any).cleanup_completed_at) {
    return NextResponse.json(
      { error: "Client cleanup is already marked complete. Reopen first if you need to redo." },
      { status: 409 }
    );
  }

  // Authoritative gate: the P&L must be attested in the Balance Sheet stage
  // before a cleanup can be submitted for senior review. The UI also disables
  // the button, but this stops a direct/stale call from bypassing it.
  // (Tolerate the column not existing yet — migration 94 — by checking presence.)
  if ("pl_attested_at" in (client as any) && !(client as any).pl_attested_at) {
    return NextResponse.json(
      { error: "Attest the P&L in the Balance Sheet step before submitting for review." },
      { status: 422 }
    );
  }
  if ((client as any).cleanup_review_state === "in_review") {
    return NextResponse.json({ ok: true, already: "in_review" });
  }

  // Default range to most-recent completed COA job so the PDF report is
  // re-pullable later without the senior having to pick dates.
  if (!rangeStart || !rangeEnd) {
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

  const { error: updErr } = await service
    .from("client_links")
    .update({
      cleanup_review_state: "in_review",
      cleanup_review_submitted_at: new Date().toISOString(),
      cleanup_review_submitted_by: user.id,
      // Cache the range NOW so the PDF report works even if no further
      // jobs run before approval. We reuse the cleanup_range_* columns
      // added in migration 19.
      cleanup_range_start: rangeStart,
      cleanup_range_end: rangeEnd,
    } as any)
    .eq("id", clientLinkId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "client_cleanup_submitted_for_review",
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
        range_start: rangeStart,
        range_end: rangeEnd,
      } as any,
    });
  } catch {
    // non-fatal
  }

  return NextResponse.json({ ok: true, state: "in_review" });
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
  // Withdrawing also clears the P&L attestation so a re-submitted cleanup must
  // be re-attested (a stale attestation shouldn't carry over more work).
  const { error } = await service
    .from("client_links")
    .update({
      cleanup_review_state: null,
      cleanup_review_submitted_at: null,
      cleanup_review_submitted_by: null,
      pl_attested_at: null,
      pl_attested_by: null,
    } as any)
    .eq("id", clientLinkId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "client_cleanup_review_withdrawn",
      request_payload: { client_link_id: clientLinkId } as any,
    });
  } catch {
    // non-fatal
  }

  return NextResponse.json({ ok: true });
}
