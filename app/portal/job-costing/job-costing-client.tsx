"use client";

import { useMemo, useState } from "react";
import {
  Briefcase, Plus, Settings2, X, Trash2, Pencil, Loader2, TrendingUp, TrendingDown,
  Calculator, AlertCircle, Users,
} from "lucide-react";
import {
  computeJob, sumJobs, groupByMonth, groupByCrew, laborFromLines,
  type JobInput, type JobCostingSettings, type JobLaborLine,
} from "@/lib/job-costing";

const money = (n: number) => {
  const r = Math.round(Number(n) || 0);
  return (r < 0 ? "-$" : "$") + Math.abs(r).toLocaleString("en-US");
};
const pct = (frac: number, dp = 1) => `${((Number(frac) || 0) * 100).toFixed(dp)}%`;

function blankJob(): JobInput {
  return {
    id: "",
    jobName: "",
    crew: "",
    jobDate: new Date().toISOString().slice(0, 10),
    jobPrice: 0,
    salesTax: 0,
    materialsCost: 0,
    laborCost: 0,
    laborLines: [],
    budgetedHours: 0,
    actualHours: 0,
    notes: "",
  };
}

export function JobCostingClient({
  initialJobs,
  initialSettings,
}: {
  initialJobs: JobInput[];
  initialSettings: JobCostingSettings;
}) {
  const [jobs, setJobs] = useState<JobInput[]>(initialJobs);
  const [settings, setSettings] = useState<JobCostingSettings>(initialSettings);
  const [view, setView] = useState<"month" | "ranked">("month");
  const [editing, setEditing] = useState<JobInput | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const computed = useMemo(() => jobs.map((j) => computeJob(j, settings)), [jobs, settings]);
  const totals = useMemo(() => sumJobs(computed), [computed]);
  const months = useMemo(() => groupByMonth(computed), [computed]);
  const crews = useMemo(() => groupByCrew(computed), [computed]);
  const ranked = useMemo(() => [...computed].sort((a, b) => b.grossProfit - a.grossProfit), [computed]);
  const best = ranked[0];
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  async function saveJob(job: JobInput) {
    const isNew = !job.id;
    const url = isNew ? "/api/portal/job-costing/jobs" : `/api/portal/job-costing/jobs/${job.id}`;
    const res = await fetch(url, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Couldn't save the job");
    const saved: JobInput = body.job;
    setJobs((prev) => (isNew ? [saved, ...prev] : prev.map((j) => (j.id === saved.id ? saved : j))));
  }

  async function deleteJob(id: string) {
    if (!confirm("Delete this job from your costing tracker?")) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/portal/job-costing/jobs/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || "Couldn't delete");
      }
      setJobs((prev) => prev.filter((j) => j.id !== id));
    } catch (e: any) {
      setError(e?.message || "Couldn't delete the job");
    } finally {
      setBusyId(null);
    }
  }

  async function saveSettings(next: JobCostingSettings) {
    const res = await fetch("/api/portal/job-costing/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Couldn't save settings");
    setSettings(body.settings || next);
    setSettingsOpen(false);
  }

  return (
    <div className="space-y-4">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy to-teal-dark px-6 py-5 text-white">
        <div className="absolute -right-10 -top-12 w-48 h-48 rounded-full bg-teal/25 blur-3xl" />
        <div className="relative flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center flex-shrink-0">
              <Briefcase size={22} className="text-white" />
            </div>
            <div>
              <div className="text-xs text-white/60 uppercase tracking-wider font-semibold">Job Costing</div>
              <h1 className="text-2xl font-bold leading-tight">Profit by job</h1>
              <div className="text-xs text-white/65 mt-0.5">
                Track each job's price, materials, and labor — see which jobs and crews actually make money.
              </div>
            </div>
          </div>
          <button
            onClick={() => { setError(null); setEditing(blankJob()); }}
            className="inline-flex items-center gap-1.5 bg-white text-navy font-bold text-sm px-4 py-2 rounded-lg hover:bg-white/90"
          >
            <Plus size={16} /> Add job
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-sm font-semibold bg-white">
          <button
            onClick={() => setView("month")}
            className={`px-3 py-1.5 ${view === "month" ? "bg-teal text-white" : "text-ink-slate hover:bg-slate-50"}`}
          >
            By month
          </button>
          <button
            onClick={() => setView("ranked")}
            className={`px-3 py-1.5 border-l border-slate-200 ${view === "ranked" ? "bg-teal text-white" : "text-ink-slate hover:bg-slate-50"}`}
          >
            Ranked
          </button>
        </div>
        <button
          onClick={() => setSettingsOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-slate hover:text-navy px-3 py-1.5 rounded-lg border border-slate-200 hover:border-teal/40 bg-white"
        >
          <Settings2 size={14} /> Goals &amp; burden
        </button>
        <span className="text-xs text-ink-light">
          Goal paint {pct(settings.goalPaintPct, 0)} · Goal labor {pct(settings.goalLaborPct, 0)} · Burden {pct(settings.burdenPct, 0)}
        </span>
      </div>

      {settingsOpen && <SettingsPanel settings={settings} onSave={saveSettings} onCancel={() => setSettingsOpen(false)} />}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle size={15} className="mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center">
          <Briefcase size={30} className="mx-auto text-ink-light mb-2" />
          <div className="font-bold text-navy text-lg">Start tracking jobs</div>
          <p className="text-sm text-ink-slate mt-1 max-w-md mx-auto">
            Add each produced job — its price, paint &amp; supplies, and labor. SNAP does the margins,
            charge rates, and crew profitability automatically. No QuickBooks setup required.
          </p>
          <button
            onClick={() => setEditing(blankJob())}
            className="mt-4 inline-flex items-center gap-1.5 bg-teal text-white font-bold text-sm px-4 py-2 rounded-lg hover:bg-teal-dark"
          >
            <Plus size={16} /> Add your first job
          </button>
        </div>
      ) : (
        <>
          {/* Totals */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="Revenue" value={money(totals.revenue)} />
            <Stat label="Materials" value={money(totals.materials)} sub={pct(totals.paintPct)} />
            <Stat label="Labor" value={money(totals.labor)} sub={pct(totals.laborPct)} />
            <Stat label="Gross profit" value={money(totals.grossProfit)} tone="green" />
            <Stat label="Gross margin" value={pct(totals.gpPct)} tone="teal" />
          </div>

          {/* Best / worst */}
          {best && worst && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Highlight kind="best" job={best} />
              <Highlight kind="worst" job={worst} />
            </div>
          )}

          {/* Jobs */}
          {view === "month" ? (
            <div className="space-y-4">
              {months.map((g) => (
                <div key={g.key} className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                  <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between flex-wrap gap-2">
                    <div className="text-sm font-bold text-navy">
                      {g.label} <span className="text-ink-light font-normal">· {g.totals.count} job{g.totals.count === 1 ? "" : "s"}</span>
                    </div>
                    <div className="text-xs text-ink-slate">
                      Rev <strong className="text-navy">{money(g.totals.revenue)}</strong> · GP{" "}
                      <strong className="text-emerald-700">{money(g.totals.grossProfit)}</strong> ({pct(g.totals.gpPct)})
                    </div>
                  </div>
                  <JobTable jobs={g.jobs} settings={settings} busyId={busyId} onEdit={setEditing} onDelete={deleteJob} />
                </div>
              ))}
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-200 text-sm font-bold text-navy">
                All jobs · most profitable first
              </div>
              <JobTable jobs={ranked} settings={settings} busyId={busyId} onEdit={setEditing} onDelete={deleteJob} ranked />
            </div>
          )}

          {/* Crew performance */}
          {crews.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-200 text-sm font-bold text-navy flex items-center gap-2">
                <Users size={14} className="text-teal-dark" /> Crew performance
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[10px] uppercase tracking-wider text-ink-slate">
                    <tr className="border-b border-slate-100">
                      <th className="text-left px-4 py-2 font-semibold">Crew</th>
                      <th className="text-right px-4 py-2 font-semibold">Jobs</th>
                      <th className="text-right px-4 py-2 font-semibold">Revenue</th>
                      <th className="text-right px-4 py-2 font-semibold">Gross profit</th>
                      <th className="text-right px-4 py-2 font-semibold">GP %</th>
                      <th className="text-right px-4 py-2 font-semibold">Hrs +/−</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {crews.map((c) => (
                      <tr key={c.crew} className="hover:bg-slate-50">
                        <td className="px-4 py-2 text-navy font-medium">{c.crew}</td>
                        <td className="px-4 py-2 text-right text-ink-slate">{c.count}</td>
                        <td className="px-4 py-2 text-right font-mono text-ink-slate">{money(c.revenue)}</td>
                        <td className={`px-4 py-2 text-right font-mono font-bold ${c.grossProfit >= 0 ? "text-emerald-700" : "text-red-600"}`}>{money(c.grossProfit)}</td>
                        <td className="px-4 py-2 text-right font-semibold text-navy">{pct(c.gpPct)}</td>
                        <td className={`px-4 py-2 text-right font-mono ${c.hoursOverUnder >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                          {c.hoursOverUnder >= 0 ? "+" : ""}{c.hoursOverUnder}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {editing && (
        <JobModal
          initial={editing}
          settings={settings}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
          save={saveJob}
        />
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "green" | "teal" }) {
  const c = tone === "green" ? "text-emerald-700" : tone === "teal" ? "text-teal-dark" : "text-navy";
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-ink-light font-semibold">{label}</div>
      <div className={`text-xl font-bold mt-1 ${c}`}>{value}</div>
      {sub && <div className="text-[11px] text-ink-light mt-0.5">{sub} of revenue</div>}
    </div>
  );
}

function Highlight({ kind, job }: { kind: "best" | "worst"; job: ReturnType<typeof computeJob> }) {
  const best = kind === "best";
  return (
    <div className={`rounded-2xl border-2 p-4 ${best ? "border-emerald-200 bg-emerald-50/60" : "border-red-200 bg-red-50/50"}`}>
      <div className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${best ? "text-emerald-700" : "text-red-700"}`}>
        {best ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
        {best ? "Most profitable" : "Least profitable"}
      </div>
      <div className="text-navy font-bold mt-1 truncate">{job.jobName}</div>
      <div className="text-sm text-ink-slate mt-0.5">
        GP <strong className={best ? "text-emerald-700" : "text-red-600"}>{money(job.grossProfit)}</strong> ({pct(job.gpPct)})
        {job.crew ? ` · ${job.crew}` : ""}
      </div>
    </div>
  );
}

function JobTable({
  jobs,
  settings,
  busyId,
  onEdit,
  onDelete,
  ranked,
}: {
  jobs: ReturnType<typeof computeJob>[];
  settings: JobCostingSettings;
  busyId: string | null;
  onEdit: (j: JobInput) => void;
  onDelete: (id: string) => void;
  ranked?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm whitespace-nowrap">
        <thead className="text-[10px] uppercase tracking-wider text-ink-slate">
          <tr className="border-b border-slate-100">
            {ranked && <th className="text-left px-3 py-2 font-semibold">#</th>}
            <th className="text-left px-4 py-2 font-semibold">Job</th>
            <th className="text-left px-3 py-2 font-semibold">Crew</th>
            <th className="text-right px-3 py-2 font-semibold">Price</th>
            <th className="text-right px-3 py-2 font-semibold">Materials</th>
            <th className="text-right px-3 py-2 font-semibold">Paint %</th>
            <th className="text-right px-3 py-2 font-semibold">Labor</th>
            <th className="text-right px-3 py-2 font-semibold">Labor %</th>
            <th className="text-right px-3 py-2 font-semibold">Gross profit</th>
            <th className="text-right px-3 py-2 font-semibold">GP %</th>
            <th className="text-right px-3 py-2 font-semibold">Hrs (b/a)</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {jobs.map((j, i) => {
            const paintOver = j.paintVariance > 0.0001;
            const laborOver = j.laborVariance > 0.0001;
            return (
              <tr key={j.id} className="hover:bg-slate-50">
                {ranked && <td className="px-3 py-2 text-ink-light font-mono text-xs">{i + 1}</td>}
                <td className="px-4 py-2 text-navy font-medium max-w-[200px] truncate" title={j.jobName}>{j.jobName}</td>
                <td className="px-3 py-2 text-ink-slate text-xs">{j.crew || "—"}</td>
                <td className="px-3 py-2 text-right font-mono text-navy">{money(j.jobPrice)}</td>
                <td className="px-3 py-2 text-right font-mono text-ink-slate">{money(j.materialsCost)}</td>
                <td className={`px-3 py-2 text-right font-semibold ${paintOver ? "text-red-600" : "text-emerald-700"}`} title={`Goal ${pct(settings.goalPaintPct, 0)}`}>{pct(j.paintPct)}</td>
                <td className="px-3 py-2 text-right font-mono text-ink-slate">{money(j.laborTotal)}</td>
                <td className={`px-3 py-2 text-right font-semibold ${laborOver ? "text-red-600" : "text-emerald-700"}`} title={`Goal ${pct(settings.goalLaborPct, 0)}`}>{pct(j.laborPct)}</td>
                <td className={`px-3 py-2 text-right font-mono font-bold ${j.grossProfit >= 0 ? "text-emerald-700" : "text-red-600"}`}>{money(j.grossProfit)}</td>
                <td className={`px-3 py-2 text-right font-bold ${j.gpPct >= 0.5 ? "text-emerald-700" : j.gpPct >= 0.35 ? "text-amber-600" : "text-red-600"}`}>{pct(j.gpPct)}</td>
                <td className="px-3 py-2 text-right font-mono text-xs text-ink-slate">
                  {j.budgetedHours || 0}/{j.actualHours || 0}{" "}
                  <span className={j.hoursOverUnder >= 0 ? "text-emerald-700" : "text-red-600"}>
                    ({j.hoursOverUnder >= 0 ? "+" : ""}{j.hoursOverUnder})
                  </span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => onEdit(jobs.find((x) => x.id === j.id) as any)} className="p-1 text-ink-light hover:text-teal-dark" title="Edit">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => onDelete(j.id)} disabled={busyId === j.id} className="p-1 text-ink-light hover:text-red-600 disabled:opacity-50" title="Delete">
                      {busyId === j.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SettingsPanel({
  settings,
  onSave,
  onCancel,
}: {
  settings: JobCostingSettings;
  onSave: (s: JobCostingSettings) => Promise<void>;
  onCancel: () => void;
}) {
  const [paint, setPaint] = useState(Math.round(settings.goalPaintPct * 100));
  const [labor, setLabor] = useState(Math.round(settings.goalLaborPct * 100));
  const [burden, setBurden] = useState(Math.round(settings.burdenPct * 100));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4">
      <div className="text-sm font-bold text-navy mb-3">Goals &amp; labor burden</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <NumField label="Goal Paint %" value={paint} onChange={setPaint} suffix="%" />
        <NumField label="Goal Labor %" value={labor} onChange={setLabor} suffix="%" />
        <NumField label="Labor burden %" value={burden} onChange={setBurden} suffix="%" />
      </div>
      {err && <div className="text-xs text-red-700 mt-2">{err}</div>}
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={async () => {
            setSaving(true); setErr(null);
            try {
              await onSave({ goalPaintPct: paint / 100, goalLaborPct: labor / 100, burdenPct: burden / 100 });
            } catch (e: any) { setErr(e?.message || "Couldn't save"); } finally { setSaving(false); }
          }}
          disabled={saving}
          className="inline-flex items-center gap-1.5 bg-teal text-white text-sm font-bold px-3.5 py-1.5 rounded-lg disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : null} Save
        </button>
        <button onClick={onCancel} className="text-sm font-semibold text-ink-slate hover:text-navy px-2 py-1.5">Cancel</button>
      </div>
    </div>
  );
}

function NumField({ label, value, onChange, suffix }: { label: string; value: number; onChange: (n: number) => void; suffix?: string }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-ink-light font-semibold">{label}</span>
      <div className="relative mt-1">
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm text-navy outline-none focus:border-teal"
        />
        {suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-light text-sm">{suffix}</span>}
      </div>
    </label>
  );
}

function JobModal({
  initial,
  settings,
  onClose,
  onSaved,
  save,
}: {
  initial: JobInput;
  settings: JobCostingSettings;
  onClose: () => void;
  onSaved: () => void;
  save: (j: JobInput) => Promise<void>;
}) {
  const [j, setJ] = useState<JobInput>({ ...initial, crew: initial.crew || "", notes: initial.notes || "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<JobInput>) => setJ((p) => ({ ...p, ...patch }));

  const lines = j.laborLines || [];
  const effectiveLabor = lines.length > 0 ? laborFromLines(lines, settings.burdenPct) : (Number(j.laborCost) || 0);
  const previewGp = (Number(j.jobPrice) || 0) - (Number(j.materialsCost) || 0) - effectiveLabor;

  function setLine(i: number, patch: Partial<JobLaborLine>) {
    set({ laborLines: lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white rounded-2xl shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white">
          <h3 className="font-bold text-navy">{j.id ? "Edit job" : "Add job"}</h3>
          <button onClick={onClose} className="text-ink-slate hover:text-navy"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Job name" required>
              <input value={j.jobName} onChange={(e) => set({ jobName: e.target.value })} className="jc-in" placeholder="e.g. Johnson — exterior repaint" />
            </Field>
            <Field label="Crew">
              <input value={j.crew || ""} onChange={(e) => set({ crew: e.target.value })} className="jc-in" placeholder="e.g. Ryan's Crew" />
            </Field>
            <Field label="Date">
              <input type="date" value={j.jobDate} onChange={(e) => set({ jobDate: e.target.value })} className="jc-in" />
            </Field>
            <Field label="Job price ($)">
              <input type="number" value={j.jobPrice || ""} onChange={(e) => set({ jobPrice: parseFloat(e.target.value) || 0 })} className="jc-in" />
            </Field>
            <Field label="Paint & supplies ($)">
              <input type="number" value={j.materialsCost || ""} onChange={(e) => set({ materialsCost: parseFloat(e.target.value) || 0 })} className="jc-in" />
            </Field>
            <Field label="Sales tax ($)">
              <input type="number" value={j.salesTax || ""} onChange={(e) => set({ salesTax: parseFloat(e.target.value) || 0 })} className="jc-in" />
            </Field>
            <Field label="Budgeted hours">
              <input type="number" value={j.budgetedHours || ""} onChange={(e) => set({ budgetedHours: parseFloat(e.target.value) || 0 })} className="jc-in" />
            </Field>
            <Field label="Actual hours">
              <input type="number" value={j.actualHours || ""} onChange={(e) => set({ actualHours: parseFloat(e.target.value) || 0 })} className="jc-in" />
            </Field>
          </div>

          {/* Labor calculator */}
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="flex items-center gap-1.5 text-sm font-bold text-navy mb-2">
              <Calculator size={14} className="text-teal-dark" /> Labor calculator
              <span className="text-[11px] font-normal text-ink-light">(incl. {pct(settings.burdenPct, 0)} burden)</span>
            </div>
            {lines.length > 0 ? (
              <div className="space-y-1.5">
                {lines.map((l, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input value={l.painter} onChange={(e) => setLine(i, { painter: e.target.value })} placeholder="Painter" className="jc-in flex-1" />
                    <input type="number" value={l.wage || ""} onChange={(e) => setLine(i, { wage: parseFloat(e.target.value) || 0 })} placeholder="Wage/hr" className="jc-in w-24" />
                    <input type="number" value={l.hours || ""} onChange={(e) => setLine(i, { hours: parseFloat(e.target.value) || 0 })} placeholder="Hours" className="jc-in w-20" />
                    <span className="font-mono text-xs text-ink-slate w-20 text-right">{money((l.wage || 0) * (l.hours || 0))}</span>
                    <button onClick={() => set({ laborLines: lines.filter((_, idx) => idx !== i) })} className="text-ink-light hover:text-red-600"><X size={14} /></button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-ink-slate">No painter breakdown — enter labor total directly:</span>
                <input type="number" value={j.laborCost || ""} onChange={(e) => set({ laborCost: parseFloat(e.target.value) || 0 })} placeholder="Labor $" className="jc-in w-28" />
              </div>
            )}
            <div className="flex items-center justify-between mt-2">
              <button
                onClick={() => set({ laborLines: [...lines, { painter: "", wage: 0, hours: 0 }] })}
                className="inline-flex items-center gap-1 text-xs font-semibold text-teal-dark hover:text-teal"
              >
                <Plus size={12} /> Add painter
              </button>
              <div className="text-sm">
                Labor (incl. burden): <strong className="text-navy font-mono">{money(effectiveLabor)}</strong>
              </div>
            </div>
          </div>

          <Field label="Notes">
            <textarea value={j.notes || ""} onChange={(e) => set({ notes: e.target.value })} rows={2} className="jc-in resize-none" />
          </Field>

          {/* Live preview */}
          <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-2.5 text-sm flex items-center justify-between flex-wrap gap-2">
            <span className="text-ink-slate">Gross profit preview:</span>
            <span className={`font-mono font-bold ${previewGp >= 0 ? "text-emerald-700" : "text-red-600"}`}>
              {money(previewGp)}{" "}
              <span className="text-ink-light font-normal">
                ({j.jobPrice > 0 ? pct(previewGp / j.jobPrice) : "—"} GP)
              </span>
            </span>
          </div>

          {err && <div className="text-xs text-red-700">{err}</div>}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-200 flex items-center justify-end gap-2 sticky bottom-0 bg-white">
          <button onClick={onClose} className="text-sm font-semibold text-ink-slate hover:text-navy px-3 py-2">Cancel</button>
          <button
            onClick={async () => {
              if (!j.jobName.trim()) { setErr("Job name is required"); return; }
              setSaving(true); setErr(null);
              try { await save(j); onSaved(); } catch (e: any) { setErr(e?.message || "Couldn't save"); setSaving(false); }
            }}
            disabled={saving}
            className="inline-flex items-center gap-1.5 bg-teal text-white text-sm font-bold px-4 py-2 rounded-lg disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} {j.id ? "Save changes" : "Add job"}
          </button>
        </div>
      </div>
      <style jsx global>{`
        .jc-in {
          width: 100%;
          padding: 0.4rem 0.6rem;
          border: 1px solid rgb(226 232 240);
          border-radius: 0.5rem;
          font-size: 0.875rem;
          color: #0f1f2e;
          outline: none;
        }
        .jc-in:focus { border-color: #1a9b8f; }
      `}</style>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-ink-light font-semibold">
        {label}{required && <span className="text-red-500"> *</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
