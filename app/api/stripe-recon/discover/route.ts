import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse, after } from "next/server";
import { getValidToken } from "@/lib/qbo";
import {
  fetchStripeDeposits,
  fetchInvoicesForRange,
  fetchCustomerPaymentsForRange,
} from "@/lib/qbo-stripe-recon";
import { matchStripeDeposits } from "@/lib/claude-stripe-match";

/**
 * POST /api/stripe-recon/discover
 *
 * Body:
 *  {
 *    client_link_id: string,
 *    date_range_start: string,  // YYYY-MM-DD
 *    date_range_end: string,
 *    jurisdiction: "US" | "CA",
 *    state_province?: string,
 *    reclass_job_id?: string,
 *    auto_approve_confidence?: number   // 0-1, default 0.90
 *  }
 *
 * Creates a stripe_recon_jobs row + kicks off background discovery.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const required = ["client_link_id", "date_range_start", "date_range_end", "jurisdiction"];
  for (const f of required) {
    if (!body[f]) {
      return NextResponse.json({ error: `Missing required field: ${f}` }, { status: 400 });
    }
  }

  const service = createServiceSupabase();
  const { data: job, error } = await service
    .from("stripe_recon_jobs")
    .insert({
      client_link_id: body.client_link_id,
      bookkeeper_id: user.id,
      reclass_job_id: body.reclass_job_id || null,
      date_range_start: body.date_range_start,
      date_range_end: body.date_range_end,
      jurisdiction: body.jurisdiction,
      state_province: body.state_province || null,
      status: "discovering",
    } as any)
    .select()
    .single();

  if (error || !job) {
    return NextResponse.json({ error: error?.message || "Job creation failed" }, { status: 500 });
  }

  after(async () => {
    try {
      await runDiscovery(job.id, body.auto_approve_confidence ?? 0.90);
    } catch (err: any) {
      console.error(`Stripe recon discovery failed for job ${job.id}:`, err);
      const svc = createServiceSupabase();
      await svc
        .from("stripe_recon_jobs")
        .update({
          status: "failed",
          error_message: err.message,
          ai_completed_at: new Date().toISOString(),
        } as any)
        .eq("id", job.id);
    }
  });

  return NextResponse.json({ job_id: job.id, started: true });
}

async function runDiscovery(jobId: string, autoApproveConfidence: number) {
  const service = createServiceSupabase();

  const { data: job } = await service
    .from("stripe_recon_jobs")
    .select("*, client_links(*)")
    .eq("id", jobId)
    .single();
  if (!job) throw new Error("Job not found");
  const clientLink = (job as any).client_links;

  const accessToken = await getValidToken(clientLink.id, service as any);

  // 1. Fetch Stripe deposits
  const deposits = await fetchStripeDeposits(
    clientLink.qbo_realm_id, accessToken, job.date_range_start, job.date_range_end
  );

  if (deposits.length === 0) {
    await service
      .from("stripe_recon_jobs")
      .update({
        status: "in_review",
        stripe_deposits_found: 0,
        ai_completed_at: new Date().toISOString(),
        warnings: ["No Stripe-origin deposits found in the selected date range."] as any,
      } as any)
      .eq("id", jobId);
    return;
  }

  // 2. Fetch supporting AR data
  const invoices = await fetchInvoicesForRange(
    clientLink.qbo_realm_id, accessToken, job.date_range_start, job.date_range_end
  );
  const payments = await fetchCustomerPaymentsForRange(
    clientLink.qbo_realm_id, accessToken, job.date_range_start, job.date_range_end
  );

  // 3. AI matching
  const result = await matchStripeDeposits({
    clientName: clientLink.client_name,
    jurisdiction: clientLink.jurisdiction,
    stateProvince: clientLink.state_province || "",
    deposits,
    invoices,
    payments,
    autoApproveThreshold: autoApproveConfidence,
  });

  // 4. Insert match rows
  const rows = result.matches.map((m) => ({
    job_id: jobId,
    qbo_deposit_id: m.qbo_deposit_id,
    qbo_deposit_txn_type: "Deposit",
    deposit_amount: m.deposit_amount,
    deposit_date: m.deposit_date,
    deposit_memo: m.deposit_memo,
    matched_invoices: m.matched_invoices as any,
    matched_customer_names: m.matched_customer_names,
    total_invoice_amount: m.total_invoice_amount,
    pre_tax_revenue: m.pre_tax_revenue,
    total_sales_tax_collected: m.total_sales_tax_collected,
    computed_fee: m.computed_fee,
    computed_tax: m.computed_tax,
    tax_code: m.tax_code,
    ai_confidence: m.ai_confidence,
    ai_reasoning: m.ai_reasoning,
    decision: m.decision,
  }));

  if (rows.length > 0) {
    const { error: insertErr } = await service.from("stripe_recon_matches").insert(rows);
    if (insertErr) throw new Error(`Failed to insert matches: ${insertErr.message}`);
  }

  // 5. Update job stats
  const totals = result.matches.reduce(
    (acc, m) => {
      acc.matched += m.total_invoice_amount;
      acc.fees += m.computed_fee;
      acc.tax += m.computed_tax;
      return acc;
    },
    { matched: 0, fees: 0, tax: 0 }
  );

  await service
    .from("stripe_recon_jobs")
    .update({
      status: "in_review",
      stripe_deposits_found: deposits.length,
      total_matched_amount: Number(totals.matched.toFixed(2)),
      total_fees: Number(totals.fees.toFixed(2)),
      total_tax: Number(totals.tax.toFixed(2)),
      ai_completed_at: new Date().toISOString(),
      warnings: result.warnings.length > 0 ? (result.warnings as any) : null,
    } as any)
    .eq("id", jobId);
}

export const maxDuration = 300;
