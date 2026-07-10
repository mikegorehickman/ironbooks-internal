import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/urgent  { urgent: boolean, note?: string }
 *
 * Flags a client as needing urgent support / books done ASAP (or clears it).
 * Boards badge flagged clients red and float them to the top of their column.
 * Internal roles (admin/lead/bookkeeper). Requires migration 112.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const b = await req.json().catch(() => ({}));
  const urgent = !!b.urgent;
  const note = String(b.note || "").trim().slice(0, 500) || null;

  const { error } = await (service as any)
    .from("client_links")
    .update(
      urgent
        ? { urgent_flag: true, urgent_flag_note: note, urgent_flag_set_at: new Date().toISOString(), urgent_flag_set_by: user.id }
        : { urgent_flag: false, urgent_flag_note: null, urgent_flag_set_at: null, urgent_flag_set_by: null }
    )
    .eq("id", id);
  if (error) {
    const missing = /column .*urgent_flag.* does not exist/i.test(error.message);
    return NextResponse.json(
      { error: missing ? "Run migration 112 first (urgent_flag columns)." : error.message },
      { status: missing ? 409 : 500 }
    );
  }

  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: urgent ? "client_flagged_urgent" : "client_urgent_cleared",
      request_payload: { client_link_id: id, note } as any,
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, urgent });
}
