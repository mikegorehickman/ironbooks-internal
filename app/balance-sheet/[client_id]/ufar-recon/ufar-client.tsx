"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Play, RefreshCw, Scale } from "lucide-react";

/**
 * UF/AR Reconciler run + report. Poll while running (QBO pulls + the Opus
 * reconciliation take 30-90s), then render: four balance tiles, the two
 * explanations, and the checkable clearing plan. Step checkboxes persist
 * on the run row so the plan survives tab closes and hand-offs.
 */

const money = (n: number | null | undefined) =>
  n == null ? "—" : `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TOOL_LINK: Record<string, (id: string) => string | null> = {
  uf_audit: (id) => `/balance-sheet/${id}/uf-audit`,
  ar_recovery: (id) => `/balance-sheet/${id}/ar-recovery`,
  je: () => null,
  qbo: () => null,
  none: () => null,
};

export function UfArReconClient({ clientLinkId, clientName }: { clientLinkId: string; clientName: string }) {
  const [run, setRun] = useState<any | null | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/ufar-recon`);
      const j = await res.json();
      if (res.ok) setRun(j.run);
    } catch {}
  }
  useEffect(() => {
    load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (run?.status === "running" && !pollRef.current) {
      pollRef.current = setInterval(load, 5000);
    }
    if (run?.status !== "running" && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status]);

  async function start() {
    if (
      run?.status === "complete" &&
      !confirm(`Re-run the reconciliation for ${clientName}? The current report will be replaced by a fresh pull.`)
    )
      return;
    setStarting(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/ufar-recon`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      setError(e?.message || "Couldn't start");
    } finally {
      setStarting(false);
    }
  }

  async function toggleStep(step: number, done: boolean) {
    setRun((p: any) => ({
      ...p,
      steps_done: done ? [...(p.steps_done || []), step] : (p.steps_done || []).filter((s: number) => s !== step),
    }));
    await fetch(`/api/clients/${clientLinkId}/ufar-recon`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: run.id, step, done }),
    }).catch(() => {});
  }

  const s = run?.summary;
  const r = run?.report;
  const doneSet = new Set<number>(run?.steps_done || []);

  return (
    <>
      <div className="bg-white rounded-2xl border border-gray-100 p-5 flex items-center gap-4 flex-wrap">
        <div className="p-2.5 rounded-lg bg-teal-light"><Scale size={20} className="text-teal" /></div>
        <div className="flex-1 min-w-[260px]">
          <h2 className="font-bold text-navy">One-button reconciliation</h2>
          <p className="text-xs text-ink-slate">
            Pulls UF, open A/R, bank deposits, and revenue straight from QuickBooks, matches
            deposits→revenue deterministically, then AI reconciles the rest and writes the clearing plan.
          </p>
        </div>
        <button
          onClick={start}
          disabled={starting || run?.status === "running"}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2.5 rounded-lg disabled:opacity-50"
        >
          {starting || run?.status === "running" ? <Loader2 size={15} className="animate-spin" /> : run ? <RefreshCw size={15} /> : <Play size={15} />}
          {run?.status === "running" ? "Reconciling… (~1 min)" : run ? "Re-run" : "Run reconciliation"}
        </button>
      </div>
      {error && <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2.5 text-sm text-red-800">{error}</div>}
      {run === undefined ? (
        <div className="text-sm text-ink-slate flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> loading…</div>
      ) : run === null ? (
        <div className="bg-white rounded-2xl border border-gray-100 px-6 py-10 text-center text-sm text-ink-slate">
          No runs yet — hit <strong>Run reconciliation</strong> to replace the CSV-export-into-Claude workflow.
        </div>
      ) : run.status === "failed" ? (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          Run failed: {run.error_message || "unknown error"} — re-run, or check the client's QBO connection.
        </div>
      ) : run.status === "complete" && s ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="UF balance" value={money(s.uf_balance)} sub={`${s.uf_orphans} orphans · ${s.uf_duplicates} suspected dupes`} tone={s.uf_balance > 1 ? "amber" : "green"} />
            <Tile label="Booked A/R" value={money(s.booked_ar)} sub={`${s.open_invoices} open invoices`} tone="navy" />
            <Tile label="TRUE A/R (AI)" value={money(s.true_ar)} sub={s.true_ar != null && s.booked_ar != null ? `${money(s.booked_ar - s.true_ar)} not really owed` : ""} tone="teal" />
            <Tile label="Deposits matched" value={`${s.deposits_matched}/${s.deposits_pulled}`} sub={`${s.deposits_pulled - s.deposits_matched} need review`} tone={s.deposits_pulled - s.deposits_matched > 0 ? "amber" : "green"} />
          </div>
          {(r?.ar_explained || r?.uf_explained) && (
            <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-3 text-sm text-navy">
              {r.ar_explained && <p><strong>A/R:</strong> {r.ar_explained}</p>}
              {r.uf_explained && <p><strong>UF:</strong> {r.uf_explained}</p>}
            </div>
          )}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
              <h3 className="text-sm font-bold text-navy uppercase tracking-wider">Clearing plan</h3>
              <span className="text-xs text-ink-light">{doneSet.size}/{r?.steps?.length || 0} done</span>
            </div>
            {(r?.steps || []).length === 0 ? (
              <div className="px-5 py-6 text-sm text-ink-slate">Nothing to clear — UF and A/R reconcile clean. ✓</div>
            ) : (
              <ol className="divide-y divide-gray-50">
                {(r.steps as any[]).map((st) => {
                  const link = TOOL_LINK[st.tool]?.(clientLinkId) || null;
                  const done = doneSet.has(st.n);
                  return (
                    <li key={st.n} className={`px-5 py-3 flex items-start gap-3 ${done ? "opacity-50" : ""}`}>
                      <input
                        type="checkbox"
                        checked={done}
                        onChange={(e) => toggleStep(st.n, e.target.checked)}
                        className="mt-1 w-4 h-4 rounded border-gray-300 text-teal focus:ring-teal"
                      />
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-semibold text-navy ${done ? "line-through" : ""}`}>
                          {st.n}. {st.title}
                          {st.amount != null && <span className="text-ink-slate font-normal"> · {money(st.amount)}</span>}
                        </div>
                        <div className="text-xs text-ink-slate mt-0.5 whitespace-pre-line">{st.detail}</div>
                      </div>
                      {link && (
                        <a href={link} className="text-xs font-bold text-teal hover:text-teal-dark border border-teal/30 rounded-lg px-2.5 py-1.5 flex-shrink-0">
                          Open tool →
                        </a>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          <p className="text-[11px] text-ink-light">
            Run {new Date(run.created_at).toLocaleString()} · pulled {s.revenue_rows} revenue rows · read-only against QBO — steps execute through the linked tools.
          </p>
        </>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 px-6 py-10 text-center text-sm text-ink-slate">
          <Loader2 size={18} className="animate-spin mx-auto mb-2 text-teal" />
          Pulling UF, A/R, deposits, and revenue from QuickBooks, then reconciling… this page refreshes itself.
        </div>
      )}
    </>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: string }) {
  const cls: Record<string, string> = {
    green: "border-emerald-200 bg-emerald-50/50",
    amber: "border-amber-200 bg-amber-50/50",
    teal: "border-teal/30 bg-teal-lighter",
    navy: "border-gray-200 bg-white",
  };
  return (
    <div className={`rounded-xl border p-3.5 ${cls[tone] || cls.navy}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-slate">{label}</div>
      <div className="text-xl font-black text-navy tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-ink-slate mt-0.5">{sub}</div>}
    </div>
  );
}
