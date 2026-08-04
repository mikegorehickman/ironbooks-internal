import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

/**
 * PATCH /api/book-defects/[id] — a human's decision about one defect.
 *
 * Body: { status?: 'open'|'remediating'|'resolved'|'accepted', note?, assignedTo? }
 *
 * Three of these are judgement calls a scanner can't make:
 *   remediating  someone is actively fixing it (survives re-scans)
 *   accepted     real, understood, deliberately not being fixed — immaterial,
 *                or the client's own call. Never reopened by a sweep.
 *   resolved     fixed by hand. A later scan that still sees it WILL reopen it,
 *                which is the point: claiming a fix doesn't make the books right.
 *
 * 'accepted' and manual 'resolved' both demand a note. An unexplained
 * suppression is indistinguishable from a mistake six months later.
 */
export const dynamic = "force-dynamic";

const STATUSES = new Set(["open", "remediating", "resolved", "accepted"]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users").select("role, full_name").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const status = body.status ? String(body.status) : null;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : null;

  if (status && !STATUSES.has(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  if ((status === "accepted" || status === "resolved") && !note) {
    return NextResponse.json(
      { error: "A note is required when accepting or resolving — say why, for whoever reads this in six months." },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { updated_at: now };
  if (note !== null) patch.note = note;
  if (body.assignedTo !== undefined) patch.assigned_to = body.assignedTo || null;
  if (status) {
    patch.status = status;
    if (status === "resolved" || status === "accepted") {
      patch.resolved_at = now;
      patch.resolved_by = user.id;
      patch.resolution = status === "accepted" ? "accepted" : "fixed";
    } else {
      // Back into the live queue.
      patch.resolved_at = null;
      patch.resolved_by = null;
      patch.resolution = null;
    }
  }

  const { data, error } = await (service as any)
    .from("book_defects").update(patch).eq("id", id).select("*").single();
  if (error) {
    console.error("[book-defects PATCH]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // The audit log is the compliance record; a suppressed defect must be
  // traceable to a person. occurred_at, not created_at (see lib/audit.ts).
  try {
    await (service as any).from("audit_log").insert({
      event_type: "book_defect_status_changed",
      occurred_at: now,
      user_id: user.id,
      client_link_id: (data as any)?.client_link_id ?? null,
      request_payload: { defect_id: id, status, note },
    });
  } catch { /* never block the decision on the log */ }

  return NextResponse.json({ ok: true, defect: data });
}
