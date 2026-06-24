import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { sendAskClientQuestions } from "@/lib/reclass-ask-client";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/reclass/[id]/resend-ask-client
 *
 * Re-sends the "we couldn't identify these transactions" message + email for a
 * reclass job, regenerating the body with the current (grouped) formatting.
 * Clears the one-batch idempotency marker first so the send isn't skipped.
 *
 * Adds a fresh portal message + email; it does NOT delete the prior one, so the
 * client may see both — use when the original was sent in a worse format.
 * Owner bookkeeper or senior only (it emails the client).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, bookkeeper_id")
    .eq("id", jobId)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role ?? "");
  const isOwner = (job as any).bookkeeper_id === user.id;
  if (!isOwner && !isSenior) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Clear the one-batch-per-job marker so the (idempotent) sender will re-run.
  const { data: markers } = await service
    .from("audit_log")
    .select("id")
    .eq("event_type", "reclass_ask_client_sent")
    .contains("request_payload", { reclass_job_id: jobId });
  if (markers && markers.length > 0) {
    await service.from("audit_log").delete().in("id", markers.map((m: any) => m.id));
  }

  const origin = new URL(request.url).origin;
  const result = await sendAskClientQuestions(service, { reclassJobId: jobId, portalOrigin: origin });

  if (!result.sent) {
    return NextResponse.json(
      { ok: false, reason: result.reason, count: result.count },
      { status: result.reason === "no_ask_client_rows" ? 400 : 500 }
    );
  }
  return NextResponse.json({ ok: true, count: result.count, email_delivery: result.emailDelivery });
}
