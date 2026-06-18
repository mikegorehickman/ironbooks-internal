import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/grain/todo  — internal (admin/lead/bookkeeper).
 *
 * Toggle a single Grain action item's completion. Persists inline in
 * grain_recordings.action_items[index].completed so the same state shows
 * crossed-off in the call card AND drives the aggregated Overview to-do list.
 *
 * Body: { recording_id, index, completed }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  await context.params; // [id] is for routing scope; the recording id carries the link
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!(actor as any)?.role || (actor as any).role === "client") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const recordingId = body.recording_id as string;
  const index = Number(body.index);
  const completed = body.completed === true;
  if (!recordingId || Number.isNaN(index)) {
    return NextResponse.json({ error: "recording_id and index required" }, { status: 400 });
  }

  const { data: rec } = await service
    .from("grain_recordings")
    .select("action_items")
    .eq("id", recordingId)
    .single();
  if (!rec) return NextResponse.json({ error: "Recording not found" }, { status: 404 });

  const items = ((rec as any).action_items || []) as any[];
  if (index < 0 || index >= items.length) {
    return NextResponse.json({ error: "index out of range" }, { status: 400 });
  }
  items[index] = {
    ...items[index],
    completed,
    status: completed ? "completed" : "pending",
    completed_at: completed ? new Date().toISOString() : null,
    completed_by: completed ? user.id : null,
  };

  const { error } = await service
    .from("grain_recordings")
    .update({ action_items: items, updated_at: new Date().toISOString() } as any)
    .eq("id", recordingId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, completed });
}
