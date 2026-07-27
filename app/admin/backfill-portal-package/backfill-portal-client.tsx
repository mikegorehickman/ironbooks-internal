"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Send, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";

type Candidate = { client_link_id: string; client_name: string; pl_only: boolean };
type Result = { client_link_id: string; client_name: string; ok: boolean; error?: string };

const PERIODS = [
  { key: "2026-06", label: "June 2026" },
  { key: "2026-05", label: "May 2026" },
  { key: "2026-07", label: "July 2026" },
];

export function BackfillPortalClient() {
  const [period, setPeriod] = useState("2026-06");
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null); // client_link_id | "all"
  const [results, setResults] = useState<Record<string, Result>>({});

  const loadCandidates = useCallback(async (p: string) => {
    setLoading(true); setError(null); setResults({});
    try {
      const res = await fetch("/api/admin/backfill-portal-package", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: p, dry_run: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't load");
      setCandidates(json.candidates || []);
    } catch (e: any) {
      setError(e?.message || "Couldn't load candidates");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadCandidates(period); }, [period, loadCandidates]);

  async function publish(ids: string[], tag: string) {
    if (running) return;
    const label = ids.length === 1 ? "this client" : `${ids.length} clients`;
    if (!confirm(`Publish the ${PERIODS.find((x) => x.key === period)?.label} package to ${label} and email them now? This is client-facing.`)) return;
    setRunning(tag);
    try {
      const res = await fetch("/api/admin/backfill-portal-package", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, dry_run: false, client_ids: ids }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Send failed");
      const next: Record<string, Result> = { ...results };
      for (const r of (json.results || []) as Result[]) next[r.client_link_id] = r;
      setResults(next);
    } catch (e: any) {
      setError(e?.message || "Send failed");
    } finally { setRunning(null); }
  }

  const pending = candidates.filter((c) => !results[c.client_link_id]?.ok);

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800 flex gap-2">
        <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
        <div>
          These clients were closed but their statements were only emailed as a plain summary — the P&L
          was never published to their portal. Publishing sends the branded <strong>“your statements
          are ready”</strong> email again and puts the P&L (and Balance Sheet, if they have one) in their
          portal. Clients who already got the plain email will receive one more. Nothing sends until you click.
        </div>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-sm font-semibold text-navy">Month:</label>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm">
          {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <button onClick={() => loadCandidates(period)} disabled={loading} className="inline-flex items-center gap-1.5 text-xs font-semibold border border-gray-200 rounded-lg px-2.5 py-1.5 hover:border-gray-300 disabled:opacity-50">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
        <span className="ml-auto text-xs text-ink-light">{candidates.length} email-only client{candidates.length === 1 ? "" : "s"}</span>
      </div>

      {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {loading ? (
        <div className="py-10 text-center text-sm text-ink-slate"><Loader2 size={16} className="animate-spin inline text-teal" /> Loading…</div>
      ) : candidates.length === 0 ? (
        <div className="py-10 text-center text-sm text-ink-light italic">No email-only closes for this month — everyone got their full portal package. ✅</div>
      ) : (
        <>
          <button
            onClick={() => publish(pending.map((c) => c.client_link_id), "all")}
            disabled={running !== null || pending.length === 0}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2 rounded-lg disabled:opacity-50"
          >
            {running === "all" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Publish + email all ({pending.length})
          </button>

          <ul className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden">
            {candidates.map((c) => {
              const r = results[c.client_link_id];
              return (
                <li key={c.client_link_id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-navy truncate">
                      {c.client_name}
                      {c.pl_only && <span className="ml-2 text-[10px] font-bold uppercase text-ink-light bg-slate-100 rounded px-1.5 py-0.5">P&L only</span>}
                    </div>
                    {r && !r.ok && <div className="text-[11px] text-red-600">{r.error}</div>}
                  </div>
                  {r?.ok ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700"><CheckCircle2 size={14} /> Published</span>
                  ) : (
                    <button
                      onClick={() => publish([c.client_link_id], c.client_link_id)}
                      disabled={running !== null}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold border border-gray-200 rounded-lg px-2.5 py-1.5 hover:border-gray-300 disabled:opacity-50"
                    >
                      {running === c.client_link_id ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                      Publish + email
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
