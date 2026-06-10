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

  let q = (service as any)
    .from("client_communications")
    .select("id", { count: "exact", head: true })
    .eq("direction", "from_client")
    .is("read_at", null);

  if (!isSenior) {
    const { data: owned } = await service
      .from("client_links")
      .select("id")
      .eq("assigned_bookkeeper_id", user.id);
    const ids = ((owned as any[]) || []).map((c) => c.id);
    if (ids.length === 0) return NextResponse.json({ count: 0 });
    q = q.in("client_link_id", ids);
  }

  const { count, error } = await q;
  if (error) return NextResponse.json({ count: 0 });
  return NextResponse.json({ count: count ?? 0 });
}
