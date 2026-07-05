import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/escalate-statements
 *
 * A bookkeeper reviewing financial statements (BS cleanup / P&L-only
 * promote) flags them as wrong and escalates to a manager with a written
 * explanation. Stored in audit_log (event_type=statements_escalated) so
 * it's append-only + traceable; surfaced on the senior /today queue.
 *
 * Body: { note: string, context?: string }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role, full_name, email")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { note?: string; context?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const note = (body.note || "").trim().slice(0, 2000);
  if (!note) {
    return NextResponse.json({ error: "Please describe what looks wrong." }, { status: 400 });
  }

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", id)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  await service.from("audit_log").insert({
    event_type: "statements_escalated",
    user_id: user.id,
    request_payload: {
      client_link_id: id,
      client_name: (client as any).client_name,
      note,
      context: body.context || "BS cleanup statement review",
      escalated_by_name: (actor as any).full_name || (actor as any).email,
    } as any,
  });

  // Also raise a first-class client escalation (kind=statement) — this IS
  // the queue (badges + strip + /approvals); the audit_log row above is the
  // append-only trail. A second flag while one is open appends its note to
  // the existing escalation rather than vanishing. Best-effort: environments
  // without migration 105 still keep the audit trail.
  try {
    const { data: existing } = await (service as any)
      .from("client_escalations")
      .select("id, note")
      .eq("client_link_id", id)
      .eq("kind", "statement")
      .eq("status", "open")
      .maybeSingle();
    if (existing) {
      const who = (actor as any).full_name || (actor as any).email;
      const merged = [existing.note, `${who}: ${note}`].filter(Boolean).join("\n").slice(0, 4000);
      await (service as any).from("client_escalations").update({ note: merged }).eq("id", existing.id);
    } else {
      await (service as any).from("client_escalations").insert({
        client_link_id: id,
        kind: "statement",
        reason: "Statements look wrong",
        note,
        raised_by: user.id,
      });
    }
  } catch {
    /* table missing — audit trail above still recorded */
  }

  return NextResponse.json({ ok: true });
}
