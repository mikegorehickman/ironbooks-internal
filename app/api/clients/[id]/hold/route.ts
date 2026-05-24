import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/[id]/hold
 *
 * Toggles kanban_on_hold on a client. On-hold clients are hidden from all
 * kanban columns and exempt from future auto-triggers.
 *
 * Body: { on_hold: boolean }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!["admin", "lead"].includes(actor?.role ?? "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const on_hold: boolean = body.on_hold ?? true;

  const { data: prior } = await service
    .from("client_links")
    .select("kanban_on_hold, client_name")
    .eq("id", clientId)
    .single();

  await service
    .from("client_links")
    .update({ kanban_on_hold: on_hold } as any)
    .eq("id", clientId);

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: on_hold ? "client_hold" : "client_unhold",
    request_payload: {
      client_link_id: clientId,
      client_name: (prior as any)?.client_name ?? null,
      prior_on_hold: (prior as any)?.kanban_on_hold ?? false,
      on_hold,
    } as any,
  });

  return NextResponse.json({ ok: true, on_hold });
}
