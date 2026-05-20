import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/reclass/[id]/cancel
 *
 * Marks an active job as failed so a new one can be started for the same
 * client. Only the owning bookkeeper or an admin/lead can cancel.
 * Accepts executing, in_review, and web_search_paused — any "live" status
 * that would block a new same-client reclass via the concurrency guard.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, status, bookkeeper_id")
    .eq("id", id)
    .single();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  const isSenior = ["admin", "lead"].includes(actor?.role ?? "");
  const isOwner = job.bookkeeper_id === user.id;

  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!["executing", "in_review", "web_search_paused"].includes(job.status)) {
    return NextResponse.json(
      { error: `Job is in '${job.status}' status — only active jobs (executing / in_review / web_search_paused) can be cancelled` },
      { status: 400 }
    );
  }

  await service
    .from("reclass_jobs")
    .update({
      status: "failed",
      error_message: `Cancelled by bookkeeper (was in '${job.status}')`,
      ai_completed_at: new Date().toISOString(),
    } as any)
    .eq("id", id);

  return NextResponse.json({ ok: true });
}
