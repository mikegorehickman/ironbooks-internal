import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function requireAdmin() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const service = createServiceSupabase();
  const { data: profile } = await service.from("users").select("role").eq("id", user.id).single();
  if (!profile || !["admin", "lead"].includes((profile as any).role)) {
    return { error: "Admin/lead only", status: 403 as const };
  }
  return { service };
}

/** PATCH /api/admin/coaching-calls — update one coach's calendar settings. */
export async function PATCH(request: Request) {
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { service } = auth;

  const body = await request.json().catch(() => ({} as any));
  const coachKey = String(body.coach_key || "").trim();
  if (!coachKey) return NextResponse.json({ error: "coach_key required" }, { status: 400 });

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (typeof body.coach_name === "string") patch.coach_name = body.coach_name.trim();
  if ("ghl_embed_url" in body) patch.ghl_embed_url = body.ghl_embed_url ? String(body.ghl_embed_url).trim() : null;
  if ("ghl_calendar_id" in body) patch.ghl_calendar_id = body.ghl_calendar_id ? String(body.ghl_calendar_id).trim() : null;
  if (typeof body.active === "boolean") patch.active = body.active;

  const { error } = await service
    .from("coaching_call_settings")
    .update(patch as any)
    .eq("coach_key", coachKey);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
