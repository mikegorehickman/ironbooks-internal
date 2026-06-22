import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** POST /api/me/profile — the signed-in user updates their own signature
 *  fields (title, phone, booking link, on/off). Internal users only. */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper", "viewer"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const b = await request.json().catch(() => ({} as any));
  const clean = (v: any) => (typeof v === "string" ? v.trim().slice(0, 200) || null : null);
  const { error } = await service.from("users").update({
    title: clean(b.title),
    phone: clean(b.phone),
    booking_url: clean(b.booking_url),
    signature_enabled: b.signature_enabled !== false,
    updated_at: new Date().toISOString(),
  } as any).eq("id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
