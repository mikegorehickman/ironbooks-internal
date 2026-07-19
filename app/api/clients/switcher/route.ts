import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/switcher — a lightweight {id, client_name} list of active
 * clients for the top-bar client switcher (QuickBooks-style company picker on
 * the client profile). Uses the RLS-scoped view, staff-only.
 */
export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper", "viewer"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("client_list_view")
    .select("id, client_name, is_active")
    .order("client_name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const clients = ((data as any[]) || [])
    .filter((c) => c.is_active !== false && c.id)
    .map((c) => ({ id: c.id as string, client_name: (c.client_name as string) || "Unnamed client" }));
  return NextResponse.json({ clients });
}
