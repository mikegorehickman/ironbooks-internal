import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

/**
 * GET /api/me — who am I? (READ-ONLY)
 *
 * The signed-in user's id, name and role, for client components that need to
 * gate on role without each one running its own Supabase query (the Sidebar
 * pattern costs two round-trips per navigation). Cached client-side for the
 * page's lifetime; the time-tracker provider uses it to decide whether to exist
 * at all. 401 when signed out — callers treat that as "stay dormant".
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: profile } = await service
    .from("users")
    .select("role, full_name, is_active")
    .eq("id", user.id)
    .single();

  return NextResponse.json(
    {
      id: user.id,
      email: user.email ?? null,
      full_name: (profile as any)?.full_name ?? null,
      role: (profile as any)?.role ?? null,
      is_active: (profile as any)?.is_active ?? true,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
