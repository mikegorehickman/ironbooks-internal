import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function gate() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return { ok: false as const, res: NextResponse.json({ error: "Senior access required" }, { status: 403 }) };
  }
  return { ok: true as const, service, userId: user.id };
}

/** GET — list reusable templates. */
export async function GET() {
  const g = await gate();
  if (!g.ok) return g.res;
  const { data } = await g.service.from("email_templates").select("*").order("updated_at", { ascending: false });
  return NextResponse.json({ templates: data || [] });
}

/** POST — save a template. Body { name, subject, body_html, kind }. */
export async function POST(request: Request) {
  const g = await gate();
  if (!g.ok) return g.res;
  const b = await request.json().catch(() => ({} as any));
  if (!b.name || !b.subject || !b.body_html) {
    return NextResponse.json({ error: "name, subject, body_html required" }, { status: 400 });
  }
  const { data, error } = await g.service.from("email_templates").insert({
    name: b.name, subject: b.subject, body_html: b.body_html,
    kind: ["operational", "normal", "resubscribe"].includes(b.kind) ? b.kind : "normal",
    created_by: g.userId,
  } as any).select("id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: (data as any).id });
}

/** DELETE ?id= — remove a saved template. */
export async function DELETE(request: Request) {
  const g = await gate();
  if (!g.ok) return g.res;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await (g.service as any).from("email_templates").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
