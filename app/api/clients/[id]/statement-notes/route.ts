import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Internal reviewer notes on a client's statements (migration 140).
 * Staff-only (admin/lead/bookkeeper) — the real client never sees these; the
 * portal only renders the notes panel while a staff member is impersonating.
 *
 * GET   ?kind=pl&period=2026-05 → { notes } (period optional)
 * POST  { statement_kind, period?, anchor?, body }  → add
 * PATCH { noteId, resolved: boolean }               → resolve/unresolve
 * DELETE ?noteId=…                                   → remove
 */
const KINDS = new Set(["pl", "bs", "cash_flow", "package"]);

async function staff() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role, full_name").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, actor, service };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const auth = await staff();
  if ("error" in auth) return auth.error;
  const { searchParams } = new URL(request.url);
  const kind = (searchParams.get("kind") || "").trim();
  const period = (searchParams.get("period") || "").trim();

  let q = (auth.service as any)
    .from("statement_review_notes")
    .select("id, statement_kind, period, anchor, body, resolved_at, created_by_name, created_at")
    .eq("client_link_id", id)
    .order("created_at", { ascending: false });
  if (kind) q = q.eq("statement_kind", kind);
  if (period) q = q.eq("period", period);
  const { data, error } = await q;
  if (error) {
    // Table missing (migration 140 not applied) → empty, don't break the page.
    return NextResponse.json({ notes: [], persisted: false });
  }
  return NextResponse.json({ notes: data || [], persisted: true });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const auth = await staff();
  if ("error" in auth) return auth.error;
  let body: { statement_kind?: string; period?: string; anchor?: string; body?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!KINDS.has(body.statement_kind || "")) return NextResponse.json({ error: "Unknown statement kind" }, { status: 400 });
  const text = (body.body || "").trim();
  if (!text) return NextResponse.json({ error: "Note can't be empty" }, { status: 400 });

  const { data, error } = await (auth.service as any)
    .from("statement_review_notes")
    .insert({
      client_link_id: id,
      statement_kind: body.statement_kind,
      period: body.period?.trim() || null,
      anchor: body.anchor?.trim() || null,
      body: text.slice(0, 2000),
      created_by: auth.user.id,
      created_by_name: (auth.actor as any)?.full_name || null,
    })
    .select("id, statement_kind, period, anchor, body, resolved_at, created_by_name, created_at")
    .single();
  if (error) {
    return NextResponse.json(
      { error: "Couldn't save — run migration 140 (statement_review_notes).", reason: "not_migrated" },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true, note: data });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const auth = await staff();
  if ("error" in auth) return auth.error;
  let body: { noteId?: string; resolved?: boolean };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.noteId) return NextResponse.json({ error: "noteId required" }, { status: 400 });
  const { error } = await (auth.service as any)
    .from("statement_review_notes")
    .update({
      resolved_at: body.resolved ? new Date().toISOString() : null,
      resolved_by: body.resolved ? auth.user.id : null,
    })
    .eq("id", body.noteId)
    .eq("client_link_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const auth = await staff();
  if ("error" in auth) return auth.error;
  const { searchParams } = new URL(request.url);
  const noteId = searchParams.get("noteId");
  if (!noteId) return NextResponse.json({ error: "noteId required" }, { status: 400 });
  const { error } = await (auth.service as any)
    .from("statement_review_notes")
    .delete()
    .eq("id", noteId)
    .eq("client_link_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
