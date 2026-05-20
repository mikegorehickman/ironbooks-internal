import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse, after } from "next/server";
import { getValidToken } from "@/lib/qbo";
import {
  findUndepositedFundsAccountId,
  fetchUndepositedFundsPayments,
  fetchOpenInvoices,
} from "@/lib/qbo-balance-sheet";
import { matchUFtoAR } from "@/lib/uf-ar-matcher";

/**
 * POST /api/balance-sheet/uf-ar-discover
 *
 * Body: { client_link_id: string }
 *
 * Creates a uf_ar_jobs row and kicks off background discovery:
 *   1. Find the Undeposited Funds account in QBO.
 *   2. Pull every unapplied UF Payment.
 *   3. Pull every open A/R Invoice.
 *   4. Run the matcher.
 *   5. Insert one row per UF Payment into uf_ar_matches.
 *   6. Update the job with counts + status='in_review'.
 *
 * Returns { job_id } immediately; the client polls /status for progress.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const clientLinkId = body?.client_link_id;
  if (!clientLinkId) {
    return NextResponse.json(
      { error: "client_link_id required" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();

  // Concurrency guard — one active UF→AR job per client at a time.
  // Cast .from() because migration-28 tables aren't in the regenerated
  // supabase types yet. Runtime works.
  const { data: rivals } = (await (service as any)
    .from("uf_ar_jobs")
    .select("id, status")
    .eq("client_link_id", clientLinkId)
    .in("status", ["discovering", "in_review"])
    .limit(1)) as any;
  if (rivals && rivals.length > 0) {
    return NextResponse.json(
      {
        error: `A UF→A/R match job is already in progress for this client (status=${rivals[0].status}).`,
        existing_job_id: rivals[0].id,
      },
      { status: 409 }
    );
  }

  const { data: job, error: jobErr } = (await (service as any)
    .from("uf_ar_jobs")
    .insert({
      client_link_id: clientLinkId,
      bookkeeper_id: user.id,
      status: "discovering",
    })
    .select()
    .single()) as any;
  if (jobErr || !job) {
    return NextResponse.json(
      { error: jobErr?.message || "Could not create job" },
      { status: 500 }
    );
  }

  after(async () => {
    const svc = createServiceSupabase();
    try {
      const { data: client } = await svc
        .from("client_links")
        .select("id, qbo_realm_id")
        .eq("id", clientLinkId)
        .single();
      if (!client) throw new Error("Client not found");

      const accessToken = await getValidToken(clientLinkId, svc as any);
      const realmId = (client as any).qbo_realm_id as string;

      // 1. Locate UF account
      const ufAccountId = await findUndepositedFundsAccountId(realmId, accessToken);
      if (!ufAccountId) {
        await (svc as any)
          .from("uf_ar_jobs")
          .update({
            status: "complete",
            ai_completed_at: new Date().toISOString(),
            warnings: [
              "This client has no Undeposited Funds account in QBO — nothing to match.",
            ] as any,
          } as any)
          .eq("id", (job as any).id);
        return;
      }

      // 2 + 3. Pull both data sets in parallel.
      const [ufPayments, openInvoices] = await Promise.all([
        fetchUndepositedFundsPayments(realmId, accessToken, ufAccountId),
        fetchOpenInvoices(realmId, accessToken),
      ]);

      // Filter out already-applied UF entries before matching.
      const unapplied = ufPayments.filter((p) => !p.already_applied);

      // 4. Run the matcher.
      const matches = matchUFtoAR(unapplied, openInvoices);

      // 5. Insert rows.
      const rows = matches.map((m) => ({
        job_id: (job as any).id,
        qbo_payment_id: m.payment.qbo_payment_id,
        uf_customer_id: m.payment.customer_id,
        uf_customer_name: m.payment.customer_name,
        uf_amount: m.payment.amount,
        uf_date: m.payment.date,
        uf_memo: m.payment.memo,
        uf_invoice_reference: m.payment.invoice_reference,
        match_kind: m.kind,
        confidence: m.confidence,
        proposed_invoices: m.proposed as any,
        candidate_invoices: m.candidates as any,
        decision:
          m.kind === "exact_invoice_number" || m.kind === "high_confidence"
            ? "auto_approve"
            : m.kind === "low_confidence"
            ? "needs_review"
            : "flagged",
        reasoning: m.reasoning,
      }));
      if (rows.length > 0) {
        const { error: insertErr } = (await (svc as any)
          .from("uf_ar_matches")
          .insert(rows)) as any;
        if (insertErr) throw new Error(`Insert matches failed: ${insertErr.message}`);
      }

      // 6. Update the job with counts.
      const counts = {
        exact: matches.filter((m) => m.kind === "exact_invoice_number").length,
        high: matches.filter((m) => m.kind === "high_confidence").length,
        low: matches.filter((m) => m.kind === "low_confidence").length,
        unmatched: matches.filter((m) => m.kind === "unmatched").length,
      };
      await (svc as any)
        .from("uf_ar_jobs")
        .update({
          status: "in_review",
          ai_completed_at: new Date().toISOString(),
          uf_transactions_scanned: unapplied.length,
          open_invoices_scanned: openInvoices.length,
          matches_exact: counts.exact,
          matches_high_confidence: counts.high,
          matches_low_confidence: counts.low,
          unmatched_count: counts.unmatched,
        } as any)
        .eq("id", (job as any).id);
    } catch (err: any) {
      console.error(`[uf-ar-discover] job ${(job as any).id} failed:`, err);
      await (svc as any)
        .from("uf_ar_jobs")
        .update({
          status: "failed",
          ai_completed_at: new Date().toISOString(),
          error_message: String(err?.message || err).slice(0, 1000),
        } as any)
        .eq("id", (job as any).id);
    }
  });

  return NextResponse.json({ ok: true, job_id: (job as any).id });
}
