import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function requireInternal() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role;
  if (!role || role === "client") {
    return { error: NextResponse.json({ error: "Forbidden — internal staff only" }, { status: 403 }) };
  }
  return { user, service };
}

const STATUSES = new Set(["todo", "in_progress", "done"]);
const PRIORITIES = new Set(["low", "normal", "high"]);

/**
 * PATCH /api/tasks/[id] — update status / assignee / fields. Moving status to
 * 'done' stamps completed_at; moving it back clears it.
 * DELETE /api/tasks/[id] — remove a task.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await requireInternal();
  if ("error" in a) return a.error;
  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({} as any));

  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (typeof body.title === "string") updates.title = body.title.trim().slice(0, 300);
  if ("notes" in body) updates.notes = body.notes ? String(body.notes).slice(0, 4000) : null;
  if ("assignee_id" in body) updates.assignee_id = body.assignee_id || null;
  if ("client_link_id" in body) updates.client_link_id = body.client_link_id || null;
  if ("due_date" in body) updates.due_date = body.due_date || null;
  if (PRIORITIES.has(body.priority)) updates.priority = body.priority;
  if (STATUSES.has(body.status)) {
    updates.status = body.status;
    updates.completed_at = body.status === "done" ? new Date().toISOString() : null;
  }

  const { data, error } = await (a.service as any)
    .from("team_tasks")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ task: data });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await requireInternal();
  if ("error" in a) return a.error;
  const { id } = await ctx.params;
  const { error } = await (a.service as any).from("team_tasks").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
