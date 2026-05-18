import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/stripe-recon/[id]/acknowledge
 *
 * "Acknowledged and finished" terminal state for a recon job. Used when AR
 * matching is impossible (typical case: client takes payment via Stripe
 * Payment Links / subscriptions / direct charges and never creates QBO
 * Invoice or Payment objects, so the matcher correctly flags 100% of
 * deposits with zero candidates).
 *
 * Marks the job complete with a clear audit reason. Does NOT execute any
 * matches — there's nothing to execute. The bookkeeper can come back later
 * if the client connects Stripe and rerun.
 *
 * Body (optional): { note?: string }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const note: string | undefined = body?.note;

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("stripe_recon_jobs")
    .select("id, status, client_link_id, stripe_deposits_found, total_matched_amount, warnings, reclass_job_id")
    .eq("id", jobId)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  if (job.status === "complete") {
    return NextResponse.json({ ok: true, already: "complete" });
  }
  if (job.status === "executing") {
    return NextResponse.json(
      { error: "Job is currently executing — wait for it to finish or cancel it first." },
      { status: 409 }
    );
  }

  const ackWarning =
    `Acknowledged by bookkeeper without AR matching — no QBO invoices/payments existed within ±30 days of any deposit. ` +
    `Client likely takes payment via Stripe directly (Payment Links / subscriptions / Stripe Invoicing). ` +
    `Re-run after they connect Stripe via the sidebar.` +
    (note ? ` Note: ${note}` : "");

  const existingWarnings: string[] = Array.isArray((job as any).warnings)
    ? ((job as any).warnings as any[]).filter((w) => typeof w === "string")
    : [];

  await service
    .from("stripe_recon_jobs")
    .update({
      status: "complete",
      execution_completed_at: new Date().toISOString(),
      warnings: [...existingWarnings, ackWarning] as any,
    } as any)
    .eq("id", jobId);

  // Audit trail so we can see who acknowledged what later.
  try {
    await service.from("audit_log").insert({
      job_id: jobId,
      user_id: user.id,
      event_type: "stripe_recon_acknowledged",
      request_payload: {
        message:
          "Stripe recon acknowledged & finished without matches (AR matching impossible — client doesn't invoice through QBO).",
        note: note || null,
        deposits_count: (job as any).stripe_deposits_found ?? null,
      } as any,
    });
  } catch {
    // audit_log shape may vary across envs; non-fatal
  }

  return NextResponse.json({
    ok: true,
    acknowledged: true,
    next: job.reclass_job_id ? `/reclass/${job.reclass_job_id}/execute` : "/clients",
  });
}
