import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { PortalErrorState } from "../error-state";
import { JobCostingClient } from "./job-costing-client";
import { DEFAULT_JC_SETTINGS, type JobInput } from "@/lib/job-costing";

/**
 * Job Costing — SNAP-native tracker (writable). Contractors enter produced
 * jobs and SNAP computes profit by job, independent of QuickBooks. Modeled on
 * the client's "Job Cost Tracker" spreadsheet. Degrades to an empty tracker if
 * migration 84 (jc_jobs / jc_settings) hasn't been applied yet.
 */
export const dynamic = "force-dynamic";

function rowToJob(row: any): JobInput {
  return {
    id: row.id,
    jobName: row.job_name,
    crew: row.crew ?? null,
    jobDate: String(row.job_date || "").slice(0, 10),
    jobPrice: Number(row.job_price) || 0,
    salesTax: Number(row.sales_tax) || 0,
    materialsCost: Number(row.materials_cost) || 0,
    laborCost: Number(row.labor_cost) || 0,
    laborLines: Array.isArray(row.labor_lines) ? row.labor_lines : [],
    budgetedHours: Number(row.budgeted_hours) || 0,
    actualHours: Number(row.actual_hours) || 0,
    notes: row.notes ?? null,
  };
}

export default async function JobCostingPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const service = createServiceSupabase();
  const [jobsRes, settingsRes] = await Promise.all([
    (service as any)
      .from("jc_jobs")
      .select("*")
      .eq("client_link_id", ctx.clientLinkId)
      .order("job_date", { ascending: false }),
    (service as any).from("jc_settings").select("*").eq("client_link_id", ctx.clientLinkId).maybeSingle(),
  ]);

  const sRow = settingsRes?.data;
  const settings = sRow
    ? {
        goalPaintPct: Number(sRow.goal_paint_pct) || 0,
        goalLaborPct: Number(sRow.goal_labor_pct) || 0,
        burdenPct: Number(sRow.burden_pct) || 0,
      }
    : DEFAULT_JC_SETTINGS;

  const jobs: JobInput[] = ((jobsRes?.data as any[]) || []).map(rowToJob);

  return <JobCostingClient initialJobs={jobs} initialSettings={settings} />;
}
