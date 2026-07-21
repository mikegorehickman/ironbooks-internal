import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/[id]/reject-review
 *
 * Senior-only: Manager Reject for a cleanup that's In Review. Instead of
 * approving, the manager bounces it back to the assigned bookkeeper into the
 * new "Failed Review" stage (cleanup_review_state = 'failed_review') with a
 * required note explaining what to fix. The bookkeeper sees it on Today
 * ("Sent back — needs rework") and reworks, then re-submits (which flips the
 * state back to 'in_review'). No client email is sent.
 *
 * Body: { notes: string }  — the reason / what to fix (required).
 * Role gate: admin or lead only.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "lead"].includes((profile as any).role)) {
    return NextResponse.json(
      { error: "Only admin/lead bookkeepers can reject cleanup reviews." },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({} as any));
  const notes: string = (body?.notes || "").trim();
  if (!notes) {
    return NextResponse.json(
      { error: "Add a note telling the bookkeeper what to fix before rejecting." },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, cleanup_review_state, cleanup_completed_at, cleanup_review_submitted_by")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  if ((client as any).cleanup_completed_at) {
    return NextResponse.json(
      { error: "This cleanup is already complete — reopen it before rejecting." },
      { status: 409 }
    );
  }
  if ((client as any).cleanup_review_state !== "in_review") {
    return NextResponse.json(
      { error: "Cleanup isn't in the review queue, so there's nothing to reject." },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();
  const { error: updErr } = await (service as any)
    .from("client_links")
    .update({
      cleanup_review_state: "failed_review",
      cleanup_review_rejected_at: now,
      cleanup_review_rejected_by: user.id,
      cleanup_review_notes: notes,
    })
    .eq("id", clientLinkId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "client_cleanup_review_rejected",
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
        submitted_by: (client as any).cleanup_review_submitted_by,
        rejected_by_name: (profile as any).full_name,
        notes,
        rejected_at: now,
      } as any,
    });
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({ ok: true, rejected_at: now });
}
