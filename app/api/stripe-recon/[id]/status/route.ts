import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/stripe-recon/[id]/status
 *
 * Polled by the live execution page. Returns job state + per-match progress.
 */
export async function GET(
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
    .select("id, status, error_message, execution_completed_at, execution_duration_seconds, total_fees, total_tax, warnings")
    .eq("id", id)
    .single();
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Per-match progress
  const { data: matches } = await service
    .from("stripe_recon_matches")
    .select("id, decision, executed, executed_at, error_message, qbo_deposit_id, computed_fee, computed_tax, matched_customer_names, deposit_amount")
    .eq("job_id", id);

  const approved = (matches || []).filter((m) => m.decision === "auto_approve");
  const executed = approved.filter((m) => m.executed);
  const failed = approved.filter((m) => !m.executed && m.error_message);
  const pending = approved.filter((m) => !m.executed && !m.error_message);

  return NextResponse.json({
    job,
    progress: {
      total_approved: approved.length,
      executed: executed.length,
      failed: failed.length,
      pending: pending.length,
      percentage:
        approved.length === 0
          ? 0
          : Math.round((executed.length / approved.length) * 100),
    },
    recent_failures: failed.slice(0, 10).map((f) => ({
      qbo_deposit_id: f.qbo_deposit_id,
      error: f.error_message,
    })),
    matches: (matches || []).map((m) => ({
      id: m.id,
      qbo_deposit_id: m.qbo_deposit_id,
      decision: m.decision,
      executed: m.executed,
      executed_at: m.executed_at,
      error_message: m.error_message,
      computed_fee: m.computed_fee,
      computed_tax: m.computed_tax,
      matched_customer_names: m.matched_customer_names,
      deposit_amount: m.deposit_amount,
    })),
  });
}
