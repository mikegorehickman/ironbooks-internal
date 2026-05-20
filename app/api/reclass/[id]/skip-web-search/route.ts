import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, status, bookkeeper_id")
    .eq("id", jobId)
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

  if (job.status === "web_search_paused") {
    // Job is between chunks — skip is instant, no in-flight requests to cancel.
    await service
      .from("reclass_jobs")
      .update({ status: "in_review", error_message: null } as any)
      .eq("id", jobId);
    return NextResponse.json({ ok: true, instant: true });
  }

  if (job.status === "executing") {
    // A chunk is actively running. Set the signal; the chunk's skip poller
    // detects it within 2s and aborts all in-flight web search requests.
    await service
      .from("reclass_jobs")
      .update({ error_message: "[skip_web_search]" } as any)
      .eq("id", jobId);
    return NextResponse.json({ ok: true, instant: false });
  }

  return NextResponse.json(
    { error: `Job is not in a skippable state (status: ${job.status})` },
    { status: 400 }
  );
}
