import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/messages/read
 *
 * Marks every unread client→bookkeeper communication for this client as
 * read. Fired when a bookkeeper opens /clients/[id]/messages — clears
 * the client's rows from the /today "Inbound from clients" widget.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { error } = await (service as any)
    .from("client_communications")
    .update({ read_at: new Date().toISOString(), read_by: user.id })
    .eq("client_link_id", id)
    .eq("direction", "from_client")
    .is("read_at", null);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
