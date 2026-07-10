import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * /api/clients/[id]/notes — internal per-client notes (the profile Notes
 * section). Table = client_notes (migration 23, RLS tightened in 112).
 *
 * GET    → list, newest first, with author names
 * POST   { body }        → add a note (author = caller)
 * DELETE ?note_id=…      → remove (author or admin only)
 *
 * Internal roles only. Portal clients never see these.
 */
async function gate() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role, full_name").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper", "viewer"].includes((actor as any)?.role || "")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, service, role: (actor as any).role as string };
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate();
  if ("error" in g) return g.error;
  const { data, error } = await (g.service as any)
    .from("client_notes")
    .select("id, body, created_at, author_id, users:author_id(full_name, email)")
    .eq("client_link_id", id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    notes: ((data as any[]) || []).map((n) => ({
      id: n.id,
      body: n.body,
      created_at: n.created_at,
      author_id: n.author_id,
      author: n.users?.full_name || n.users?.email || "—",
    })),
  });
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate();
  if ("error" in g) return g.error;
  if (g.role === "viewer") return NextResponse.json({ error: "Viewers are read-only" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const body = String(b.body || "").trim().slice(0, 4000);
  if (!body) return NextResponse.json({ error: "Note body required" }, { status: 400 });
  const { data, error } = await (g.service as any)
    .from("client_notes")
    .insert({ client_link_id: id, author_id: g.user.id, body })
    .select("id, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id, created_at: data.created_at });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate();
  if ("error" in g) return g.error;
  const noteId = new URL(req.url).searchParams.get("note_id");
  if (!noteId) return NextResponse.json({ error: "note_id required" }, { status: 400 });
  let q = (g.service as any).from("client_notes").delete().eq("id", noteId).eq("client_link_id", id);
  if (g.role !== "admin") q = q.eq("author_id", g.user.id); // authors delete their own; admins any
  const { error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
