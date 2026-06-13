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

  return NextResponse.json({ ok: true });
}
