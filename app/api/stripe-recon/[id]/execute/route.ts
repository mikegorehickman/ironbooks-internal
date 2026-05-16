import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse, after } from "next/server";
import { getValidToken } from "@/lib/qbo";
import {
  resolveExpenseAccounts,
  applyStripeReconToDeposit,
} from "@/lib/qbo-stripe-execute";

/**
 * POST /api/stripe-recon/[id]/execute
 *
 * Kicks off background execution. Only processes matches whose decision is
 * "auto_approve" (the bookkeeper's final review state).
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
    .from("stripe_recon_jobs")
    .select("*, client_links(*)")
    .eq("id", id)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  if (job.status === "executing") {
    return NextResponse.json({ error: "Execution already in progress" }, { status: 409 });
  }
  if (job.status === "complete") {
    return NextResponse.json({ error: "Job already complete" }, { status: 409 });
  }

  // Move to executing immediately so the UI shows the right state
  await service
    .from("stripe_recon_jobs")
    .update({
      status: "executing",
      // Reuse ai_completed_at column as start marker if execution_started_at not present
    } as any)
    .eq("id", id);

  after(async () => {
    const svc = createServiceSupabase();
    const startedAt = Date.now();
    try {
      await runExecution(id, svc);
    } catch (err: any) {
      console.error(`Stripe recon execute failed for ${id}:`, err);
      await svc
        .from("stripe_recon_jobs")
        .update({
          status: "failed",
          error_message: err.message,
          execution_completed_at: new Date().toISOString(),
          execution_duration_seconds: Math.floor((Date.now() - startedAt) / 1000),
        } as any)
        .eq("id", id);
    }
  });

  return NextResponse.json({ started: true, job_id: id });
}

async function runExecution(
  jobId: string,
  service: ReturnType<typeof createServiceSupabase>
) {
  const startedAt = Date.now();

  const { data: job } = await service
    .from("stripe_recon_jobs")
    .select("*, client_links(*)")
    .eq("id", jobId)
    .single();
  if (!job) throw new Error("Job not found");
  const clientLink = (job as any).client_links;

  // Only execute auto_approve, not-yet-executed matches
  const { data: matches } = await service
    .from("stripe_recon_matches")
    .select("*")
    .eq("job_id", jobId)
    .eq("decision", "auto_approve")
    .eq("executed", false);

  if (!matches || matches.length === 0) {
    await service
      .from("stripe_recon_jobs")
      .update({
        status: "complete",
        execution_completed_at: new Date().toISOString(),
        execution_duration_seconds: Math.floor((Date.now() - startedAt) / 1000),
        warnings: ["No approved matches to execute. Set deposits to 'auto_approve' first."] as any,
      } as any)
      .eq("id", jobId);
    return;
  }

  const accessToken = await getValidToken(clientLink.id, service as any);

  // Resolve fee + tax destination accounts once for the whole batch
  const targets = await resolveExpenseAccounts(
    clientLink.qbo_realm_id, accessToken, clientLink.jurisdiction
  );

  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  for (const m of matches) {
    try {
      const result = await applyStripeReconToDeposit(
        clientLink.qbo_realm_id,
        accessToken,
        {
          qbo_deposit_id: m.qbo_deposit_id,
          matched_customer_names: m.matched_customer_names || [],
          computed_fee: Number(m.computed_fee || 0),
          computed_tax: Number(m.computed_tax || 0),
          tax_code: m.tax_code,
        },
        targets,
        clientLink.jurisdiction as "US" | "CA"
      );

      await service
        .from("stripe_recon_matches")
        .update({
          executed: true,
          executed_at: new Date().toISOString(),
          error_message: null,
        } as any)
        .eq("id", m.id);

      successCount++;
      void result;
    } catch (err: any) {
      failCount++;
      errors.push(`${m.qbo_deposit_id}: ${err.message}`);
      await service
        .from("stripe_recon_matches")
        .update({
          executed: false,
          error_message: String(err.message).slice(0, 1000),
        } as any)
        .eq("id", m.id);
    }
  }

  await service
    .from("stripe_recon_jobs")
    .update({
      status: failCount > 0 && successCount === 0 ? "failed" : "complete",
      execution_completed_at: new Date().toISOString(),
      execution_duration_seconds: Math.floor((Date.now() - startedAt) / 1000),
      error_message: errors.length > 0 ? errors.slice(0, 5).join(" | ") : null,
    } as any)
    .eq("id", jobId);
}

export const maxDuration = 300;
