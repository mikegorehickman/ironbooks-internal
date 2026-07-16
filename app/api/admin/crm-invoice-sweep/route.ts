import { NextResponse } from "next/server";
import { after } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { fetchPLDetailAll, fetchProfitAndLoss } from "@/lib/qbo-reports";
import { analyzeCrmInvoiceRevenue, incomeAccountNamesFromSummary } from "@/lib/crm-invoice-revenue";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/crm-invoice-sweep — fleet scan for the CRM invoice/deposit
 * revenue double-count (the Dominion Painters pattern, mirror image of the
 * deposits-into-revenue sweep): CRM-pushed INVOICES recognizing income on the
 * cash-basis P&L while the bank DEPOSITS that pay them are also categorized
 * to revenue accounts.
 *
 * Read-only against QBO (one cash P&L-detail pull per client). Findings land
 * in audit_log as crm_invoice_revenue_finding rows (one per client with an
 * invoice leg), newest-wins, and render on /admin/crm-invoice-revenue where
 * Mike + Lisa walk the flagged list and set revenue_recognition_mode per
 * client. Clients with no invoices at all are recorded scanned but produce no
 * finding (deposits are their correct revenue entry).
 *
 * Chunked + self-chaining like revenue-integrity-sweep: CHUNK clients per
 * invocation; next chunk fired at ?offset=N with the CRON_SECRET bearer when
 * available, and the response always carries next_offset so the admin screen
 * can drive the chain from the browser session when CRON_SECRET isn't set.
 *
 * Auth: admin session OR self-chain/cron (Bearer CRON_SECRET).
 */
const CHUNK = 8;

export async function POST(request: Request) {
  const service = createServiceSupabase();

  const cronOk =
    !!process.env.CRON_SECRET &&
    request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  let userId: string | null = null;
  if (!cronOk) {
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
    if (!["admin", "lead"].includes((actor as any)?.role || "")) {
      return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
    }
    userId = user.id;
  }

  const url = new URL(request.url);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
  const year = new Date().getFullYear();
  const start = url.searchParams.get("start") || `${year}-01-01`;
  const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, cleanup_completed_at, daily_recon_enabled, revenue_recognition_mode" as any)
    .eq("is_active", true)
    .not("qbo_realm_id", "is", null)
    .order("id");

  // Scan EVERY active client with a real QBO connection — NOT just
  // production/graduated ones. The CRM invoice/deposit double-count exists
  // from the first cleanup (Dominion was found mid-cleanup), so gating on
  // cleanup_completed_at/daily_recon_enabled — the revenue-integrity sweep's
  // filter — wrongly skipped every in-cleanup client, including the one we
  // already confirmed. Only demo/test are excluded.
  const targets = ((clients as any[]) || []).filter(
    (c) => c.qbo_realm_id !== "DEMO" && !/\btest\b/i.test(c.client_name || "")
  );
  const chunk = targets.slice(offset, offset + CHUNK);

  const totals = { offset, scanned: 0, with_invoices: 0, flagged: 0, paired_deposit_total: 0 };
  const errors: string[] = [];

  for (const c of chunk) {
    try {
      const token = await getValidToken(c.id, service as any);
      const [plDetail, plSummary] = await Promise.all([
        fetchPLDetailAll(c.qbo_realm_id, token, start, end, "Cash"),
        fetchProfitAndLoss(c.qbo_realm_id, token, start, end, "Cash"),
      ]);
      // Restrict the deposit leg to real income accounts so UF-clearing +
      // processing-fee deposits (Housecall Pro) don't false-flag an
      // invoice-driven book (Clean Your Carpets).
      const report = analyzeCrmInvoiceRevenue(plDetail, incomeAccountNamesFromSummary(plSummary));
      totals.scanned++;

      // Only clients with an invoice leg produce a finding row — a no-invoice
      // book is definitionally clean for this pattern (nothing to review).
      if (report.invoiceTxnCount > 0) {
        totals.with_invoices++;
        if (report.flagged) totals.flagged++;
        totals.paired_deposit_total += report.pairedDepositTotal;
        await service.from("audit_log").insert({
          event_type: "crm_invoice_revenue_finding",
          user_id: userId,
          request_payload: {
            client_link_id: c.id,
            client_name: c.client_name,
            revenue_recognition_mode: c.revenue_recognition_mode || "standard",
            window: { start, end },
            flagged: report.flagged,
            reason: report.reason,
            invoice_txn_count: report.invoiceTxnCount,
            invoice_income_total: report.invoiceIncomeTotal,
            invoice_by_account: report.invoiceByAccount,
            deposit_count: report.depositCount,
            deposit_income_total: report.depositIncomeTotal,
            pair_count: report.pairs.length,
            paired_invoice_total: report.pairedInvoiceTotal,
            paired_deposit_total: report.pairedDepositTotal,
            customers_both_legs: report.customersBothLegs.slice(0, 25),
            // Cap stored pairs — the biggest 40 carry the story; the screen's
            // on-demand preview re-computes the full set live.
            pairs: report.pairs.slice(0, 40).map((p) => ({
              invoice_txn_id: p.invoice.txn_id,
              invoice_doc: p.invoice.doc_number,
              invoice_customer: p.invoice.customer,
              invoice_date: p.invoice.date,
              invoice_total: p.invoice.total,
              invoice_accounts: p.invoice.accounts,
              deposit_txn_id: p.deposit.txn_id,
              deposit_date: p.deposit.date,
              deposit_account: p.deposit.account,
              deposit_amount: p.deposit.amount,
              factor: p.factor,
              tax_label: p.taxLabel,
              same_customer: p.sameCustomer,
              confidence: p.confidence,
            })),
          } as any,
        });
      }
    } catch (e: any) {
      errors.push(`${c.client_name}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  totals.paired_deposit_total = Math.round(totals.paired_deposit_total * 100) / 100;
  const nextOffset = offset + CHUNK;
  const done = nextOffset >= targets.length;
  try {
    await service.from("audit_log").insert({
      event_type: done ? "crm_invoice_sweep_completed" : "crm_invoice_sweep_chunk",
      user_id: userId,
      request_payload: { ...totals, window: { start, end }, errors, remaining: Math.max(0, targets.length - nextOffset) } as any,
    });
  } catch {}

  // Self-chain ONLY for cron-triggered runs (the caller carries the CRON_SECRET
  // bearer). A browser/admin-initiated sweep must NOT hand off to a background
  // self-fetch — that `after()` chain isn't reliably completing on Vercel, so
  // the sweep silently stalled after the first 8-client chunk (Macatawa and
  // everything past offset 8 never got scanned). Browser runs drive every
  // chunk themselves via next_offset; cron runs self-chain here.
  if (!done && cronOk) {
    const next = `${url.origin}${url.pathname}?offset=${nextOffset}&start=${start}&end=${end}`;
    after(async () => {
      try {
        await fetch(next, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
        });
      } catch (e) {
        console.error("[crm-invoice-sweep] chain failed:", e);
      }
    });
  }

  return NextResponse.json({
    started: true,
    targets: targets.length,
    window: { start, end },
    chunk: { offset, scanned: totals.scanned, with_invoices: totals.with_invoices, flagged: totals.flagged, errors: errors.length, error_samples: errors.slice(0, 8) },
    next_offset: done ? null : nextOffset,
    // Only true when THIS run self-chains (cron). Browser runs keep paginating.
    server_chained: !done && cronOk,
    done,
  });
}
