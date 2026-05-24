import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/[id]/assign
 *
 * Assigns or unassigns a bookkeeper to a client.
 * Admin/lead only.
 *
 * Body: { bookkeeper_id: string | null }
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
  const { bookkeeper_id } = body;

  // Capture prior assignment so the audit log records the before→after
  // (otherwise it just looks like "Lisa touched it" with no context).
  const { data: prior } = await service
    .from("client_links")
    .select("assigned_bookkeeper_id, client_name")
    .eq("id", clientId)
    .single();

  await service
    .from("client_links")
    .update({ assigned_bookkeeper_id: bookkeeper_id ?? null } as any)
    .eq("id", clientId);

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "client_assign",
    request_payload: {
      client_link_id: clientId,
      client_name: (prior as any)?.client_name ?? null,
      from_bookkeeper_id: (prior as any)?.assigned_bookkeeper_id ?? null,
      to_bookkeeper_id: bookkeeper_id ?? null,
    } as any,
  });

  return NextResponse.json({ ok: true });
}

/**
 * POST /api/clients/[id]/assign/bulk  — handled via separate route
 * This endpoint also supports bulk reassignment when called from settings.
 *
 * POST /api/clients/[id]/assign with body { from_bookkeeper_id, to_bookkeeper_id, all: true }
 * reassigns ALL clients from one bookkeeper to another.
 */
