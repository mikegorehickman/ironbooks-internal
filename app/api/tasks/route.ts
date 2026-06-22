import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Team task board API. Internal staff only (clients are never tasked here).
 *   GET  → all tasks (flat; the page joins names client-side from its maps)
 *   POST → create a task { title, notes?, assignee_id?, client_link_id?,
 *          due_date?, priority? }
 */
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

export async function GET() {
  const a = await requireInternal();
  if ("error" in a) return a.error;
  const { data, error } = await (a.service as any)
    .from("team_tasks")
    .select("*")
    .order("status", { ascending: true })
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tasks: data || [] });
}

const PRIORITIES = new Set(["low", "normal", "high"]);

export async function POST(request: Request) {
  const a = await requireInternal();
  if ("error" in a) return a.error;
  const body = await request.json().catch(() => ({} as any));
  const title = (body.title || "").trim();
  if (!title) return NextResponse.json({ error: "Title is required" }, { status: 400 });

  const row: Record<string, any> = {
    title: title.slice(0, 300),
    notes: body.notes ? String(body.notes).slice(0, 4000) : null,
    assignee_id: body.assignee_id || null,
    client_link_id: body.client_link_id || null,
    due_date: body.due_date || null,
    priority: PRIORITIES.has(body.priority) ? body.priority : "normal",
    created_by: a.user.id,
    status: "todo",
  };
  const { data, error } = await (a.service as any)
    .from("team_tasks")
    .insert(row)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ task: data });
}
