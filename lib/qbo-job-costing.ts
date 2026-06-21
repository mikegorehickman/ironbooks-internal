/**
 * Job costing — profitability per JOB for painting contractors.
 *
 * QBO doesn't have a first-class "job profitability" report on the v3 API, but
 * the ProfitAndLoss report can be segmented into one column per dimension:
 *   - summarize_column_by=Classes   → a column per class (jobs, when the
 *     contractor tags transactions with a class per job)
 *   - summarize_column_by=Customers → a column per customer / sub-customer
 *     (the classic Customer:Job structure)
 *
 * We prefer Classes when class tracking is ON (cleanest job costing), and fall
 * back to Customers otherwise. Per job we read the report's section summaries
 * — Total Income (revenue), Total Cost of Goods Sold (direct costs), Gross
 * Profit — for the job's column. Self-contained (own report fetch) so it
 * doesn't depend on internals of other qbo libs.
 */
import { qboRequest } from "./qbo";

export type JobCostingMode = "classes" | "customers";

export interface JobProfit {
  name: string;
  revenue: number;
  directCosts: number; // Cost of Goods Sold for the job
  grossProfit: number;
  grossMarginPct: number;
}

export interface JobCostingResult {
  mode: JobCostingMode;
  classTrackingEnabled: boolean;
  period: { start: string; end: string };
  jobs: JobProfit[]; // sorted by grossProfit desc (most profitable first)
  totals: { revenue: number; directCosts: number; grossProfit: number; grossMarginPct: number };
}

function num(v: any): number {
  const n = parseFloat(
    String(v ?? "")
      .replace(/[,$\s]/g, "")
      .replace(/^\((.+)\)$/, "-$1")
  );
  return isNaN(n) ? 0 : n;
}

/** Is per-transaction class tracking turned on for this company? */
export async function detectClassTracking(realmId: string, accessToken: string): Promise<boolean> {
  try {
    const data: any = await qboRequest(
      realmId,
      accessToken,
      `/query?query=${encodeURIComponent("SELECT * FROM Preferences")}`
    );
    const prefs = data?.QueryResponse?.Preferences?.[0];
    const acc = prefs?.AccountingInfoPrefs || {};
    return acc.ClassTrackingPerTxn === true || acc.ClassTrackingPerTxnLine === true;
  } catch {
    return false;
  }
}

export async function getJobCosting(
  realmId: string,
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<JobCostingResult> {
  const classTrackingEnabled = await detectClassTracking(realmId, accessToken);
  const mode: JobCostingMode = classTrackingEnabled ? "classes" : "customers";
  const dimension = classTrackingEnabled ? "Classes" : "Customers";

  let report: any = null;
  try {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      accounting_method: "Accrual",
      summarize_column_by: dimension,
    });
    report = await qboRequest(realmId, accessToken, `/reports/ProfitAndLoss?${params.toString()}`);
  } catch {
    report = null;
  }

  const jobs: JobProfit[] = [];
  if (report) {
    const cols: any[] = report?.Columns?.Column || [];
    // Column 0 is the account label; the rest are job columns + a Total column.
    const jobCols = cols.slice(1).map((c: any, i: number) => ({
      idx: i + 1,
      title: String(c?.ColTitle || "").trim(),
      isTotal: String(c?.ColTitle || "").trim().toLowerCase() === "total",
    }));

    // Collect every row's summary line keyed by its label, so we can pull
    // Total Income / Total COGS / Gross Profit per column.
    const summaries = new Map<string, any[]>();
    const collect = (rows: any[]) => {
      for (const r of rows || []) {
        if (r?.Summary?.ColData) {
          const label = String(r.Summary.ColData[0]?.value || "").trim().toLowerCase();
          if (label && !summaries.has(label)) summaries.set(label, r.Summary.ColData);
        }
        if (r?.ColData && !r?.Rows?.Row) {
          const label = String(r.ColData[0]?.value || "").trim().toLowerCase();
          if (label && !summaries.has(label)) summaries.set(label, r.ColData);
        }
        if (r?.Rows?.Row) collect(r.Rows.Row);
      }
    };
    collect(report?.Rows?.Row || []);

    const incomeRow = summaries.get("total income") || summaries.get("total revenue");
    const cogsRow =
      summaries.get("total cost of goods sold") ||
      summaries.get("total cogs") ||
      summaries.get("total cost of sales");
    const gpRow = summaries.get("gross profit");

    for (const jc of jobCols) {
      if (jc.isTotal) continue;
      const revenue = incomeRow ? num(incomeRow[jc.idx]?.value) : 0;
      const directCosts = cogsRow ? num(cogsRow[jc.idx]?.value) : 0;
      const grossProfit = gpRow ? num(gpRow[jc.idx]?.value) : revenue - directCosts;
      if (revenue === 0 && directCosts === 0 && grossProfit === 0) continue; // empty column
      const rawName = jc.title || "(unspecified)";
      jobs.push({
        name: /not specified|unspecified|^$/i.test(rawName) ? "Unassigned (no job)" : rawName,
        revenue: Math.round(revenue),
        directCosts: Math.round(directCosts),
        grossProfit: Math.round(grossProfit),
        grossMarginPct: revenue > 0 ? Math.round((grossProfit / revenue) * 100) : 0,
      });
    }
  }

  jobs.sort((a, b) => b.grossProfit - a.grossProfit);
  const t = jobs.reduce(
    (acc, j) => ({
      revenue: acc.revenue + j.revenue,
      directCosts: acc.directCosts + j.directCosts,
      grossProfit: acc.grossProfit + j.grossProfit,
    }),
    { revenue: 0, directCosts: 0, grossProfit: 0 }
  );

  return {
    mode,
    classTrackingEnabled,
    period: { start: startDate, end: endDate },
    jobs,
    totals: {
      ...t,
      grossMarginPct: t.revenue > 0 ? Math.round((t.grossProfit / t.revenue) * 100) : 0,
    },
  };
}
