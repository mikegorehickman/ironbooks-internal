"use client";

import { useState } from "react";
import {
  Briefcase,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  Loader2,
  CalendarRange,
  Settings2,
  Info,
} from "lucide-react";
import type { JobCostingResult } from "@/lib/qbo-job-costing";

const RANGE_PRESETS = [
  { key: "thisMonth", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "quarter", label: "This quarter" },
  { key: "ytd", label: "Year to date" },
  { key: "last12", label: "Last 12 months" },
] as const;

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function iso(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function computeRange(key: string): { start: string; end: string } {
  const now = new Date();
  const today = iso(now);
  switch (key) {
    case "thisMonth":
      return { start: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, end: today };
    case "lastMonth":
      return {
        start: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        end: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
    case "quarter":
      return { start: iso(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)), end: today };
    case "last12":
      return { start: iso(new Date(now.getFullYear(), now.getMonth() - 11, 1)), end: today };
    case "ytd":
    default:
      return { start: `${now.getFullYear()}-01-01`, end: today };
  }
}

function fmtMoney(n: number): string {
  const r = Math.round(n);
  const s = Math.abs(r).toLocaleString("en-US");
  return r < 0 ? `-$${s}` : `$${s}`;
}

export function JobCostingClient({
  initial,
  initialStart,
  initialEnd,
}: {
  initial: JobCostingResult | null;
  initialStart: string;
  initialEnd: string;
}) {
  const [data, setData] = useState<JobCostingResult | null>(initial);
  const [activeKey, setActiveKey] = useState<string>("ytd");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initial ? null : "Couldn't load job costing.");
  const [showCustom, setShowCustom] = useState(false);
  const [customStart, setCustomStart] = useState(initialStart);
  const [customEnd, setCustomEnd] = useState(initialEnd);

  async function load(start: string, end: string, key: string) {
    setLoading(true);
    setError(null);
    setActiveKey(key);
    try {
      const res = await fetch(`/api/portal/job-costing?start=${start}&end=${end}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body);
    } catch (e: any) {
      setError(e?.message || "Couldn't load job costing");
    } finally {
      setLoading(false);
    }
  }

  const jobs = data?.jobs || [];
  const maxAbs = Math.max(1, ...jobs.map((j) => Math.abs(j.grossProfit)));

  return (
    <div className="space-y-4">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy to-teal-dark px-6 py-5 text-white">
        <div className="absolute -right-10 -top-12 w-48 h-48 rounded-full bg-teal/25 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center flex-shrink-0">
            <Briefcase size={22} className="text-white" />
          </div>
          <div>
            <div className="text-xs text-white/60 uppercase tracking-wider font-semibold">Job Costing</div>
            <h1 className="text-2xl font-bold leading-tight">Profit by job, not just by month</h1>
            <div className="text-xs text-white/65 mt-0.5">
              Revenue, direct costs, and gross margin for every job — ranked most to least profitable.
            </div>
          </div>
        </div>
      </div>

      {/* Range picker */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-sm font-semibold bg-white">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => {
                setShowCustom(false);
                const r = computeRange(p.key);
                load(r.start, r.end, p.key);
              }}
              disabled={loading}
              className={`px-3 py-1.5 border-l border-slate-200 first:border-l-0 disabled:opacity-50 ${
                activeKey === p.key && !showCustom
                  ? "bg-teal text-white"
                  : "text-ink-slate hover:bg-slate-50"
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setShowCustom((v) => !v)}
            className={`px-3 py-1.5 border-l border-slate-200 ${
              showCustom ? "bg-teal text-white" : "text-ink-slate hover:bg-slate-50"
            }`}
          >
            Custom
          </button>
        </div>
        {data && (
          <span className="text-xs text-ink-light inline-flex items-center gap-1">
            <CalendarRange size={12} /> {data.period.start} → {data.period.end}
          </span>
        )}
        {loading && <Loader2 size={15} className="animate-spin text-teal-dark" />}
      </div>

      {showCustom && (
        <div className="flex items-center gap-2 flex-wrap bg-white border border-slate-200 rounded-xl p-3">
          <input
            type="date"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
            className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm text-navy"
          />
          <span className="text-ink-light text-sm">→</span>
          <input
            type="date"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
            className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm text-navy"
          />
          <button
            onClick={() => customStart && customEnd && customStart <= customEnd && load(customStart, customEnd, "custom")}
            disabled={loading || !customStart || !customEnd || customStart > customEnd}
            className="px-3 py-1.5 bg-teal text-white rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      )}

      {/* Class-tracking setup prompt — shown when class tracking is OFF. */}
      {data && !data.classTrackingEnabled && (
        <div className="bg-amber-50 border-2 border-amber-200 rounded-2xl p-4">
          <div className="flex items-start gap-3">
            <div className="p-1.5 rounded-lg bg-amber-100 flex-shrink-0">
              <Settings2 size={16} className="text-amber-700" />
            </div>
            <div className="flex-1 min-w-0 text-sm">
              <div className="font-bold text-amber-900">
                Turn on class tracking for true per-job costing
              </div>
              <p className="text-amber-800/90 mt-1">
                Class tracking isn't on yet, so this view is grouped <strong>by customer</strong> instead
                of by job. To get clean job-by-job numbers, enable class tracking in QuickBooks and tag
                one class per job:
              </p>
              <ol className="list-decimal ml-5 mt-2 space-y-0.5 text-amber-800/90">
                <li><strong>Settings (⚙)</strong> → <strong>Account and settings</strong> → <strong>Advanced</strong></li>
                <li>Under <strong>Categories</strong>, turn on <strong>Track classes</strong> (and "Warn me when not assigned")</li>
                <li>Create a class for each job, then pick that class on every invoice, bill, and expense for the job</li>
              </ol>
              <p className="text-amber-800/80 mt-2 text-xs">
                Your Ironbooks bookkeeper can set this up for you — just ask in Messages.
              </p>
            </div>
          </div>
        </div>
      )}

      {error ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle size={15} className="mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      ) : !data ? null : jobs.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
          <Briefcase size={28} className="mx-auto text-ink-light mb-2" />
          <div className="font-bold text-navy">No job-level data for this period</div>
          <p className="text-sm text-ink-slate mt-1 max-w-md mx-auto">
            {data.classTrackingEnabled
              ? "No transactions are tagged to a class (job) in this date range. Tag invoices and costs with a class to see them here."
              : "No customer-tagged income or costs in this date range yet."}
          </p>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryCard label="Total revenue" value={fmtMoney(data.totals.revenue)} tone="navy" />
            <SummaryCard label="Direct costs" value={fmtMoney(data.totals.directCosts)} tone="slate" />
            <SummaryCard label="Gross profit" value={fmtMoney(data.totals.grossProfit)} tone="green" />
            <SummaryCard label="Gross margin" value={`${data.totals.grossMarginPct}%`} tone="teal" />
          </div>

          {/* Ranked job list */}
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-sm font-bold text-navy">
                {jobs.length} {data.mode === "classes" ? "job" : "customer"}
                {jobs.length === 1 ? "" : "s"} · most profitable first
              </h2>
              <span className="text-xs text-ink-light inline-flex items-center gap-1">
                <Info size={12} /> Direct costs = Cost of Goods Sold
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-ink-slate">
                  <tr>
                    <th className="text-left px-4 py-2 font-semibold">#</th>
                    <th className="text-left px-4 py-2 font-semibold">{data.mode === "classes" ? "Job" : "Customer"}</th>
                    <th className="text-right px-4 py-2 font-semibold">Revenue</th>
                    <th className="text-right px-4 py-2 font-semibold">Direct costs</th>
                    <th className="text-right px-4 py-2 font-semibold">Gross profit</th>
                    <th className="text-right px-4 py-2 font-semibold w-28">Margin</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {jobs.map((j, i) => {
                    const positive = j.grossProfit >= 0;
                    const barPct = Math.round((Math.abs(j.grossProfit) / maxAbs) * 100);
                    return (
                      <tr key={`${j.name}-${i}`} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5 text-ink-light font-mono text-xs">{i + 1}</td>
                        <td className="px-4 py-2.5 text-navy font-medium max-w-[260px] truncate" title={j.name}>
                          {j.name}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-ink-slate">{fmtMoney(j.revenue)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-ink-slate">{fmtMoney(j.directCosts)}</td>
                        <td className={`px-4 py-2.5 text-right font-mono font-bold ${positive ? "text-emerald-700" : "text-red-600"}`}>
                          {fmtMoney(j.grossProfit)}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-2">
                            <div className="hidden sm:block w-16 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                              <div
                                className={positive ? "h-full bg-emerald-500" : "h-full bg-red-500"}
                                style={{ width: `${barPct}%` }}
                              />
                            </div>
                            <span className={`inline-flex items-center gap-0.5 font-semibold ${positive ? "text-emerald-700" : "text-red-600"}`}>
                              {positive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                              {j.grossMarginPct}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone: "navy" | "slate" | "green" | "teal" }) {
  const tones: Record<string, string> = {
    navy: "text-navy",
    slate: "text-ink-slate",
    green: "text-emerald-700",
    teal: "text-teal-dark",
  };
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-ink-light font-semibold">{label}</div>
      <div className={`text-xl font-bold mt-1 ${tones[tone]}`}>{value}</div>
    </div>
  );
}
