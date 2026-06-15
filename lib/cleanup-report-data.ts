/**
 * Build a CleanupReportData payload from all of the cleanup jobs a client
 * had in a given date range. Aggregates across COA cleanups, reclassifications,
 * and Stripe AR recon — whatever happened in that window.
 *
 * Used by /api/reports/cleanup/[client_link_id] to feed the PDF generator.
 */

import { createServiceSupabase } from "./supabase";
import fs from "fs";
import path from "path";
import type {
  CleanupReportData,
  CoaChangeRow,
  CategorySummaryRow,
  VendorSummaryRow,
  StripeReconSummary,
} from "./cleanup-report-pdf";

/**
 * Read the Ironbooks logo from the repo's public/ folder and return a base64
 * data URL. @react-pdf's Image component accepts these directly and avoids
 * the unreliable HTTP fetch from inside the serverless function. Cached at
 * module-level so we don't hit the disk on every request.
 */
let _logoDataUrlCache: string | null = null;
function loadLogoDataUrl(): string {
  if (_logoDataUrlCache) return _logoDataUrlCache;
  try {
    const logoPath = path.join(process.cwd(), "public", "logo.png");
    const buf = fs.readFileSync(logoPath);
    _logoDataUrlCache = `data:image/png;base64,${buf.toString("base64")}`;
    return _logoDataUrlCache;
  } catch (err: any) {
    console.warn("[cleanup-report] Could not load logo from disk:", err.message);
    // Falling back to the HTTPS URL — @react-pdf will try to fetch it.
    return "https://internal.ironbooks.com/logo.png";
  }
}

interface BuildParams {
  client_link_id: string;
  period_start: string; // ISO YYYY-MM-DD
  period_end: string;   // ISO YYYY-MM-DD (inclusive)
  bookkeeper_user_id: string;
  origin_url: string;   // e.g. https://internal.ironbooks.com — for logo
}

/**
 * Aggregate a client's cleanup activity for a date range. We use
 * execution_completed_at as the temporal anchor (when work actually landed
 * in QBO) rather than the job's creation time, so the report reflects what
 * was *applied* during the period.
 */
export async function buildCleanupReportData(
  params: BuildParams
): Promise<CleanupReportData> {
  const service = createServiceSupabase();

  // Inclusive end-of-day for the period end
  const periodEndExclusive = new Date(params.period_end);
  periodEndExclusive.setUTCDate(periodEndExclusive.getUTCDate() + 1);
  const endIso = periodEndExclusive.toISOString();
  const startIso = new Date(params.period_start).toISOString();

  // ─── Client + bookkeeper ───
  const [clientRes, userRes] = await Promise.all([
    service
      .from("client_links")
      .select("client_name, jurisdiction")
      .eq("id", params.client_link_id)
      .single(),
    service.from("users").select("full_name").eq("id", params.bookkeeper_user_id).single(),
  ]);

  const client = clientRes.data;
  if (!client) throw new Error(`Client ${params.client_link_id} not found`);
  const bookkeeperName = userRes.data?.full_name || "Your Ironbooks bookkeeper";

  // ─── COA jobs completed in the range → coa_actions executed=true ───
  const { data: coaJobs } = await service
    .from("coa_jobs")
    .select("id, status, execution_completed_at")
    .eq("client_link_id", params.client_link_id)
    .eq("status", "complete")
    .not("execution_completed_at", "is", null)
    .gte("execution_completed_at", startIso)
    .lt("execution_completed_at", endIso);

  const coaJobIds = (coaJobs || []).map((j) => j.id);
  let coaActionsRaw: any[] = [];
  if (coaJobIds.length > 0) {
    const { data } = await service
      .from("coa_actions")
      .select("action, current_name, new_name, ai_reasoning, transaction_count, executed")
      .in("job_id", coaJobIds)
      .eq("executed", true)
      .order("sort_order");
    coaActionsRaw = data || [];
  }

  // Group merges: identify when multiple renames share the same new_name
  // and surface them as a single "merge" row.
  const renameTargets = new Map<string, any[]>();
  for (const a of coaActionsRaw) {
    if (a.action === "rename" && a.new_name) {
      const key = a.new_name.toLowerCase().trim();
      const list = renameTargets.get(key) || [];
      list.push(a);
      renameTargets.set(key, list);
    }
  }
  const mergedKeys = new Set<string>();
  const coa_actions: CoaChangeRow[] = [];
  for (const a of coaActionsRaw) {
    if (a.action === "rename" && a.new_name) {
      const key = a.new_name.toLowerCase().trim();
      const group = renameTargets.get(key) || [];
      if (group.length > 1) {
        if (mergedKeys.has(key)) continue;
        mergedKeys.add(key);
        const sources = group.map((g) => g.current_name).filter(Boolean).join(", ");
        const totalTx = group.reduce((s, g) => s + (g.transaction_count || 0), 0);
        coa_actions.push({
          action: "merge",
          current_name: sources,
          new_name: a.new_name,
          transaction_count: totalTx,
          reasoning: group[0]?.ai_reasoning || null,
        });
        continue;
      }
    }
    coa_actions.push({
      action: (a.action === "delete" ? "delete" : a.action) as CoaChangeRow["action"],
      current_name: a.current_name,
      new_name: a.new_name,
      transaction_count: a.transaction_count || 0,
      reasoning: a.ai_reasoning,
    });
  }

  const coa_summary = {
    renamed: coa_actions.filter((a) => a.action === "rename").length,
    merged: coa_actions.filter((a) => a.action === "merge").length,
    created: coa_actions.filter((a) => a.action === "create").length,
    inactivated: coa_actions.filter((a) => a.action === "delete").length,
    flagged: coa_actions.filter((a) => a.action === "flag").length,
  };

  // ─── Reclassifications for transactions whose date falls in the report
  //     period ───
  //
  // Previously filtered reclass_jobs by execution_completed_at within the
  // period — which misses every reclass job that was finalized OUTSIDE the
  // period window (e.g. bookkeeper cleans a Jan–Dec 2025 book in June
  // 2026; the report for 2025 would show 0 transactions categorized). The
  // right semantic for a cleanup deliverable is "we re-categorized X
  // transactions whose date falls in this period", regardless of when the
  // bookkeeper actually clicked finalize.
  //
  // Strategy: pull all completed reclass_jobs for this client (no
  // execution-date filter), then filter the reclassifications themselves
  // by transaction_date within the period.
  const { data: reclassJobs } = await service
    .from("reclass_jobs")
    .select("id, status")
    .eq("client_link_id", params.client_link_id)
    .eq("status", "complete");

  const reclassJobIds = (reclassJobs || []).map((j) => j.id);
  const periodStartDate = params.period_start; // YYYY-MM-DD
  const periodEndDate = params.period_end;     // YYYY-MM-DD inclusive
  let reclassRows: any[] = [];
  if (reclassJobIds.length > 0) {
    const { data } = await service
      .from("reclassifications")
      .select(
        "vendor_name, from_account_name, to_account_name, bookkeeper_override_target_name, transaction_amount, transaction_date, status"
      )
      .in("reclass_job_id", reclassJobIds)
      .eq("status", "executed")
      .gte("transaction_date", periodStartDate)
      .lte("transaction_date", periodEndDate);
    reclassRows = data || [];
  }

  // Aggregate categories by target account
  const categoryAgg = new Map<string, { total: number; count: number }>();
  const vendorAgg = new Map<
    string,
    { total: number; count: number; categoryCounts: Map<string, number> }
  >();
  for (const r of reclassRows) {
    const target =
      r.bookkeeper_override_target_name || r.to_account_name || "Uncategorized";
    const amount = Math.abs(Number(r.transaction_amount || 0));
    const catEntry = categoryAgg.get(target) || { total: 0, count: 0 };
    catEntry.total += amount;
    catEntry.count += 1;
    categoryAgg.set(target, catEntry);

    const vendor = r.vendor_name || "Unknown vendor";
    const vEntry =
      vendorAgg.get(vendor) ||
      { total: 0, count: 0, categoryCounts: new Map<string, number>() };
    vEntry.total += amount;
    vEntry.count += 1;
    vEntry.categoryCounts.set(target, (vEntry.categoryCounts.get(target) || 0) + 1);
    vendorAgg.set(vendor, vEntry);
  }

  const top_categories: CategorySummaryRow[] = Array.from(categoryAgg.entries())
    .map(([account_name, v]) => ({
      account_name,
      total_amount: Number(v.total.toFixed(2)),
      transaction_count: v.count,
    }))
    .sort((a, b) => b.total_amount - a.total_amount);

  const top_vendors: VendorSummaryRow[] = Array.from(vendorAgg.entries())
    .map(([vendor_name, v]) => {
      // Most-frequent category for this vendor
      let bestCat = "—";
      let bestCount = 0;
      for (const [cat, c] of v.categoryCounts) {
        if (c > bestCount) {
          bestCount = c;
          bestCat = cat;
        }
      }
      return {
        vendor_name,
        total_amount: Number(v.total.toFixed(2)),
        transaction_count: v.count,
        primary_category: bestCat,
      };
    })
    .sort((a, b) => b.total_amount - a.total_amount);

  const reclass_total_count = reclassRows.length;
  const reclass_total_volume = top_categories.reduce((s, c) => s + c.total_amount, 0);

  // ─── Stripe recon (optional) ───
  const { data: stripeJobs } = await service
    .from("stripe_recon_jobs")
    .select("id, status, execution_completed_at")
    .eq("client_link_id", params.client_link_id)
    .eq("status", "complete")
    .not("execution_completed_at", "is", null)
    .gte("execution_completed_at", startIso)
    .lt("execution_completed_at", endIso);

  const stripeJobIds = (stripeJobs || []).map((j) => j.id);
  let stripe: StripeReconSummary | null = null;
  if (stripeJobIds.length > 0) {
    const { data: matches } = await service
      .from("stripe_recon_matches")
      .select(
        "deposit_amount, total_invoice_amount, pre_tax_revenue, computed_fee, computed_tax, matched_customer_names, executed"
      )
      .in("job_id", stripeJobIds)
      .eq("executed", true);

    const list = matches || [];
    if (list.length > 0) {
      const allCustomers = new Set<string>();
      for (const m of list) {
        for (const c of m.matched_customer_names || []) allCustomers.add(c);
      }
      stripe = {
        deposits_count: list.length,
        total_deposit_amount: Number(
          list.reduce((s, m) => s + Number(m.deposit_amount || 0), 0).toFixed(2)
        ),
        total_revenue_allocated: Number(
          list.reduce((s, m) => s + Number(m.pre_tax_revenue || 0), 0).toFixed(2)
        ),
        total_fees: Number(
          list.reduce((s, m) => s + Number(m.computed_fee || 0), 0).toFixed(2)
        ),
        total_tax_on_fees: Number(
          list.reduce((s, m) => s + Number(m.computed_tax || 0), 0).toFixed(2)
        ),
        unique_customers: allCustomers.size,
      };
    }
  }

  // ─── Bank rules created for this client during the cleanup ───
  // Counts every bank_rule we created from this client's reclass work.
  // No period filter — bank rules are stand-alone artifacts of the
  // cleanup ("we created X auto-categorization rules") and aren't
  // bound to transaction dates. We DO surface active-vs-total separately
  // so the report can say "12 rules created, 10 active on future imports".
  const { data: bankRules } = await service
    .from("bank_rules")
    .select("status, pushed_to_qbo")
    .eq("client_link_id", params.client_link_id);
  const allRules = (bankRules as Array<{ status: string | null; pushed_to_qbo: boolean | null }> | null) || [];
  const bank_rules_count = allRules.length;
  // "Active" here = the rule will fire on future bank-feed imports:
  // either the daily-recon engine matched it (status='active') or it was
  // pushed to QBO via the .xls export.
  const bank_rules_active = allRules.filter(
    (r) => r.status === "active" || r.pushed_to_qbo === true
  ).length;

  const generatedAt = new Date().toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return {
    client_name: client.client_name,
    jurisdiction: (client.jurisdiction as "US" | "CA") || "US",
    period_start: params.period_start,
    period_end: params.period_end,
    bookkeeper_name: bookkeeperName,
    generated_at: generatedAt,
    logo_url: loadLogoDataUrl(),
    coa_actions,
    coa_summary,
    reclass_total_count,
    reclass_total_volume,
    top_categories,
    top_vendors,
    bank_rules_count,
    bank_rules_active,
    stripe,
  };
}
