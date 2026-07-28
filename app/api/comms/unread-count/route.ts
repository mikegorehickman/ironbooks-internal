import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/comms/unread-count
 *
 * Count of unread from_client rows in client_communications, scoped like
 * /today: admins/leads see every client, bookkeepers only their assigned
 * ones. Powers the sidebar red-dot badge + new-message sound; polled, so
 * keep it one cheap head-count query.
 */
export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: profile } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (profile as any)?.role || "";
  if (!["admin", "lead", "bookkeeper", "viewer"].includes(role)) {
    return NextResponse.json({ count: 0 });
  }
  const isSenior = ["admin", "lead"].includes(role);

  // Scope to the same client set /inbox renders, or the badge counts messages
  // the user has no way to open. Deactivated clients (is_active = false) are
  // excluded everywhere else, so excluding them here too; is_active IS NULL is
  // legacy-active and must still count.
  let clientsQ = service.from("client_links").select("id, is_active");
  if (!isSenior) clientsQ = clientsQ.eq("assigned_bookkeeper_id", user.id);
  const { data: owned } = await clientsQ;
  const ids = ((owned as any[]) || [])
    .filter((c) => c.is_active !== false)
    .map((c) => c.id);
  if (ids.length === 0) return NextResponse.json({ count: 0 });

  const q = (service as any)
    .from("client_communications")
    .select("id", { count: "exact", head: true })
    .eq("direction", "from_client")
    // dismissed_at, not read_at — merely opening a thread used to clear this
    // badge even when nobody had answered the client (migration 144).
    .is("dismissed_at", null)
    .in("client_link_id", ids);

  const { count, error } = await q;
  if (error) return NextResponse.json({ count: 0 });
  return NextResponse.json({ count: count ?? 0 });
}
