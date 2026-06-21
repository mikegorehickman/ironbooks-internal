import { NextResponse } from "next/server";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { DEFAULT_JC_SETTINGS, type JobInput, type JobLaborLine } from "@/lib/job-costing";

export const dynamic = "force-dynamic";

export function rowToJob(row: any): JobInput {
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

/** Shared body → DB-row sanitizer for create + update. */
export function jobBodyToRow(body: any): Record<string, any> {
  const numn = (v: any) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const lines: JobLaborLine[] = Array.isArray(body.laborLines)
    ? body.laborLines
        .slice(0, 50)
        .map((l: any) => ({
          painter: String(l?.painter || "").slice(0, 120),
          wage: numn(l?.wage),
          hours: numn(l?.hours),
        }))
    : [];
  return {
    job_name: String(body.jobName || "").slice(0, 200),
    crew: body.crew ? String(body.crew).slice(0, 120) : null,
    job_date: /^\d{4}-\d{2}-\d{2}$/.test(body.jobDate) ? body.jobDate : new Date().toISOString().slice(0, 10),
    job_price: numn(body.jobPrice),
    sales_tax: numn(body.salesTax),
    materials_cost: numn(body.materialsCost),
    labor_cost: numn(body.laborCost),
    labor_lines: lines,
    budgeted_hours: numn(body.budgetedHours),
    actual_hours: numn(body.actualHours),
    notes: body.notes ? String(body.notes).slice(0, 2000) : null,
  };
}

export async function GET() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: ctxResult.message || "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;
  const service = createServiceSupabase();

  const [{ data: jobRows }, { data: settingsRow }] = await Promise.all([
    (service as any)
      .from("jc_jobs")
      .select("*")
      .eq("client_link_id", ctx.clientLinkId)
      .order("job_date", { ascending: false }),
    (service as any).from("jc_settings").select("*").eq("client_link_id", ctx.clientLinkId).maybeSingle(),
  ]);

  const settings = settingsRow
    ? {
        goalPaintPct: Number((settingsRow as any).goal_paint_pct) || 0,
        goalLaborPct: Number((settingsRow as any).goal_labor_pct) || 0,
        burdenPct: Number((settingsRow as any).burden_pct) || 0,
      }
    : DEFAULT_JC_SETTINGS;

  return NextResponse.json({
    jobs: ((jobRows as any[]) || []).map(rowToJob),
    settings,
  });
}

export async function POST(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: ctxResult.message || "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  const body = await request.json().catch(() => ({} as any));
  const row = jobBodyToRow(body);
  if (!row.job_name) {
    return NextResponse.json({ error: "Job name is required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { data, error } = await (service as any)
    .from("jc_jobs")
    .insert({ ...row, client_link_id: ctx.clientLinkId, created_by: ctx.userId })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ job: rowToJob(data) });
}
