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

  // Rich select (with assignee, migration 141). Falls back to the base select
  // if the columns aren't there yet so notes never break pre-migration.
  let data: any[] | null = null;
  let hasAssignee = true;
  {
    const rich = await (g.service as any)
      .from("client_notes")
      .select("id, body, created_at, author_id, assignee_id, assignee_done_at, author:author_id(full_name, email), assignee:assignee_id(full_name, email)")
      .eq("client_link_id", id)
      .order("created_at", { ascending: false })
      .limit(200);
    if (rich.error) {
      hasAssignee = false;
      const base = await (g.service as any)
        .from("client_notes")
        .select("id, body, created_at, author_id, author:author_id(full_name, email)")
        .eq("client_link_id", id)
        .order("created_at", { ascending: false })
        .limit(200);
      if (base.error) return NextResponse.json({ error: base.error.message }, { status: 500 });
      data = base.data;
    } else {
      data = rich.data;
    }
  }

  // Assignable teammates (internal, active) for the assign dropdown.
  const { data: team } = await (g.service as any)
    .from("users")
    .select("id, full_name, email, role")
    .in("role", ["admin", "lead", "bookkeeper"])
    .order("full_name", { ascending: true });

  return NextResponse.json({
    hasAssignee,
    team: ((team as any[]) || []).map((u) => ({ id: u.id, name: u.full_name || u.email })),
    notes: ((data as any[]) || []).map((n) => ({
      id: n.id,
      body: n.body,
      created_at: n.created_at,
      author_id: n.author_id,
      author: n.author?.full_name || n.author?.email || "—",
      assignee_id: n.assignee_id ?? null,
      assignee: n.assignee?.full_name || n.assignee?.email || null,
      assignee_done_at: n.assignee_done_at ?? null,
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
  const assigneeId = typeof b.assignee_id === "string" && b.assignee_id ? b.assignee_id : null;

  const row: any = { client_link_id: id, author_id: g.user.id, body };
  if (assigneeId) row.assignee_id = assigneeId;
  let ins = await (g.service as any).from("client_notes").insert(row).select("id, created_at").single();
  // Pre-migration fallback: if assignee_id doesn't exist yet, save the note
  // without it rather than failing the whole save.
  if (ins.error && assigneeId) {
    ins = await (g.service as any)
      .from("client_notes")
      .insert({ client_link_id: id, author_id: g.user.id, body })
      .select("id, created_at")
      .single();
  }
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: ins.data.id, created_at: ins.data.created_at });
}

/** PATCH { note_id, done } — the assignee clears an assigned note from their
 *  Home (sets assignee_done_at). Only the assignee may clear it. */
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate();
  if ("error" in g) return g.error;
  const b = await req.json().catch(() => ({}));
  const noteId = String(b.note_id || "");
  if (!noteId) return NextResponse.json({ error: "note_id required" }, { status: 400 });
  const done = b.done !== false;
  const { error } = await (g.service as any)
    .from("client_notes")
    .update({ assignee_done_at: done ? new Date().toISOString() : null })
    .eq("id", noteId)
    .eq("client_link_id", id)
    .eq("assignee_id", g.user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
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
