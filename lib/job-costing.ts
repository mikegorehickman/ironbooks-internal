/**
 * Job costing computations — shared by the API and the portal UI so the math
 * is identical everywhere. Mirrors the client's "Job Cost Tracker" spreadsheet:
 *
 *   Gross Profit = Job Price − Materials − Labor      (sales tax is informational)
 *   Paint %      = Materials / Job Price
 *   Labor %      = Labor / Job Price
 *   GP %         = Gross Profit / Job Price
 *   Booked rate  = Job Price / Budgeted Hours
 *   Produced rate= Job Price / Actual Hours
 *   Hours +/-    = Budgeted − Actual              (positive = under budget)
 *   Labor        = Σ(wage × hours) × (1 + burden%)   (from the labor calculator)
 *
 * Pure functions only — no server imports, so the client component can use them.
 */

export interface JobLaborLine {
  painter: string;
  wage: number;
  hours: number;
}

export interface JobCostingSettings {
  goalPaintPct: number; // 0–1
  goalLaborPct: number; // 0–1
  burdenPct: number; // 0–1
}

export const DEFAULT_JC_SETTINGS: JobCostingSettings = {
  goalPaintPct: 0.15,
  goalLaborPct: 0.35,
  burdenPct: 0.13,
};

export interface JobInput {
  id: string;
  jobName: string;
  crew: string | null;
  jobDate: string; // YYYY-MM-DD
  jobPrice: number;
  salesTax: number;
  materialsCost: number;
  laborCost: number; // used only when laborLines is empty
  laborLines: JobLaborLine[];
  budgetedHours: number;
  actualHours: number;
  notes: string | null;
}

export interface ComputedJob extends JobInput {
  laborTotal: number; // effective labor (from lines+burden, or manual)
  paintPct: number;
  laborPct: number;
  grossProfit: number;
  gpPct: number;
  bookedChargeRate: number;
  producedChargeRate: number;
  hoursOverUnder: number;
  paintVariance: number; // actual − goal (positive = over budget %)
  laborVariance: number;
}

const r2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export function laborFromLines(lines: JobLaborLine[], burdenPct: number): number {
  const raw = (lines || []).reduce((s, l) => s + (Number(l.wage) || 0) * (Number(l.hours) || 0), 0);
  return raw * (1 + (burdenPct || 0));
}

export function computeJob(j: JobInput, settings: JobCostingSettings): ComputedJob {
  const price = Number(j.jobPrice) || 0;
  const materials = Number(j.materialsCost) || 0;
  const laborTotal =
    j.laborLines && j.laborLines.length > 0
      ? laborFromLines(j.laborLines, settings.burdenPct)
      : Number(j.laborCost) || 0;
  const grossProfit = price - materials - laborTotal;
  const paintPct = price > 0 ? materials / price : 0;
  const laborPct = price > 0 ? laborTotal / price : 0;
  return {
    ...j,
    laborTotal: r2(laborTotal),
    paintPct,
    laborPct,
    grossProfit: r2(grossProfit),
    gpPct: price > 0 ? grossProfit / price : 0,
    bookedChargeRate: j.budgetedHours > 0 ? r2(price / j.budgetedHours) : 0,
    producedChargeRate: j.actualHours > 0 ? r2(price / j.actualHours) : 0,
    hoursOverUnder: r2((Number(j.budgetedHours) || 0) - (Number(j.actualHours) || 0)),
    paintVariance: paintPct - settings.goalPaintPct,
    laborVariance: laborPct - settings.goalLaborPct,
  };
}

export interface JobCostingTotals {
  count: number;
  revenue: number;
  materials: number;
  labor: number;
  grossProfit: number;
  gpPct: number;
  paintPct: number;
  laborPct: number;
}

export function sumJobs(jobs: ComputedJob[]): JobCostingTotals {
  const t = jobs.reduce(
    (a, j) => ({
      revenue: a.revenue + (Number(j.jobPrice) || 0),
      materials: a.materials + (Number(j.materialsCost) || 0),
      labor: a.labor + j.laborTotal,
      grossProfit: a.grossProfit + j.grossProfit,
    }),
    { revenue: 0, materials: 0, labor: 0, grossProfit: 0 }
  );
  return {
    count: jobs.length,
    revenue: r2(t.revenue),
    materials: r2(t.materials),
    labor: r2(t.labor),
    grossProfit: r2(t.grossProfit),
    gpPct: t.revenue > 0 ? t.grossProfit / t.revenue : 0,
    paintPct: t.revenue > 0 ? t.materials / t.revenue : 0,
    laborPct: t.revenue > 0 ? t.labor / t.revenue : 0,
  };
}

export interface MonthGroup {
  key: string; // YYYY-MM
  label: string; // "January 2026"
  jobs: ComputedJob[];
  totals: JobCostingTotals;
}

export function groupByMonth(jobs: ComputedJob[]): MonthGroup[] {
  const map = new Map<string, ComputedJob[]>();
  for (const j of jobs) {
    const key = (j.jobDate || "").slice(0, 7) || "unknown";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(j);
  }
  const groups: MonthGroup[] = [];
  for (const [key, gjobs] of map) {
    const [y, m] = key.split("-").map(Number);
    const label =
      key === "unknown" || !y
        ? "Undated"
        : new Date(Date.UTC(y, (m || 1) - 1, 1)).toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          });
    groups.push({ key, label, jobs: gjobs, totals: sumJobs(gjobs) });
  }
  // newest month first
  return groups.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

export interface CrewGroup {
  crew: string;
  count: number;
  revenue: number;
  grossProfit: number;
  gpPct: number;
  hoursOverUnder: number;
}

export function groupByCrew(jobs: ComputedJob[]): CrewGroup[] {
  const map = new Map<string, CrewGroup>();
  for (const j of jobs) {
    const crew = (j.crew || "").trim() || "(no crew)";
    const g =
      map.get(crew) ||
      { crew, count: 0, revenue: 0, grossProfit: 0, gpPct: 0, hoursOverUnder: 0 };
    g.count += 1;
    g.revenue += Number(j.jobPrice) || 0;
    g.grossProfit += j.grossProfit;
    g.hoursOverUnder += j.hoursOverUnder;
    map.set(crew, g);
  }
  return [...map.values()]
    .map((g) => ({
      ...g,
      revenue: r2(g.revenue),
      grossProfit: r2(g.grossProfit),
      hoursOverUnder: r2(g.hoursOverUnder),
      gpPct: g.revenue > 0 ? g.grossProfit / g.revenue : 0,
    }))
    .sort((a, b) => b.grossProfit - a.grossProfit);
}
