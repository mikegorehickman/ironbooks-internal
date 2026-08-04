"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, ExternalLink,
  Loader2, RefreshCw, ShieldCheck,
} from "lucide-react";

/**
 * The book-health board. Deliberately shows CLEAN clients as well as dirty
 * ones — a screen listing only problems can't tell you how many books you can
 * trust, which is the whole point of the ledger.
 */

interface Defect {
  id: string;
  defect_type: string;
  status: string;
  severity: string;
  exposure_cents: number | null;
  item_count: number | null;
  detail: Record<string, any>;
  detected_at: string;
  last_seen_at: string;
  note: string | null;
}
interface Row {
  clientLinkId: string;
  clientName: string;
  inProduction: boolean;
  cleanupDone: boolean;
  defects: Defect[];
  acceptedCount: number;
  exposureCents: number;
  worstSeverity: string | null;
}
interface TypeInfo {
  key: string; label: string; description: string; fleetHref?: string; derivable: boolean;
  lastScan: { ran_at: string; clients_scanned: number; defects_found: number } | null;
  affected: number; exposureCents: number;
}
interface Board {
  types: TypeInfo[];
  rows: Row[];
  totals: { clients: number; clean: number; dirty: number; exposureCents: number } | null;
  setup_pending?: boolean;
}

const money = (cents: number | null | undefined) =>
  cents == null ? "—" : `$${Math.round(cents / 100).toLocaleString()}`;

const SEV_STYLE: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-300",
  high: "bg-orange-100 text-orange-800 border-orange-300",
  medium: "bg-amber-100 text-amber-800 border-amber-300",
  low: "bg-slate-100 text-slate-700 border-slate-300",
};

function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  return `${d}d ago`;
}

export function BookHealthClient() {
  const [data, setData] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/book-defects", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e: any) {
      setErr(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sync = async () => {
    setSyncing(true);
    setErr(null);
    setSkipped([]);
    try {
      const r = await fetch("/api/book-defects/sync", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      // A source that failed to read is NOT "clean" — say so out loud, or the
      // board quietly overstates how much of the fleet has been checked.
      setSkipped(
        Object.entries(d.results || {})
          .filter(([, v]: any) => v && typeof v === "object" && "skipped" in v)
          .map(([k, v]: any) => `${k}: ${v.skipped}`)
      );
      await load();
    } catch (e: any) {
      setErr(e?.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const setStatus = async (defectId: string, status: string) => {
    let note: string | null = null;
    if (status === "accepted" || status === "resolved") {
      note = window.prompt(
        status === "accepted"
          ? "Why is this acceptable? (immaterial, client's call, …)"
          : "What was done to fix it?"
      );
      if (!note) return;
    }
    const r = await fetch(`/api/book-defects/${defectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, note }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(d.error || "Failed");
      return;
    }
    void load();
  };

  if (loading && !data) {
    return <div className="text-sm text-ink-slate"><Loader2 size={15} className="animate-spin inline mr-2" />Loading the ledger…</div>;
  }
  if (data?.setup_pending) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        The ledger isn&apos;t set up yet — migration 156 is pending.
      </div>
    );
  }

  const t = data?.totals;
  const pct = t && t.clients > 0 ? Math.round((t.clean / t.clients) * 100) : 0;

  return (
    <div className="space-y-5">
      {err && <div className="text-sm text-red-600">{err}</div>}

      {skipped.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="text-sm font-bold text-amber-900 flex items-center gap-2">
            <AlertTriangle size={14} /> {skipped.length} source{skipped.length === 1 ? "" : "s"} couldn&apos;t be read
          </div>
          <p className="text-[11px] text-amber-800 mt-0.5">
            Those defect classes were NOT refreshed — the clean count below is optimistic by however
            much they would have found.
          </p>
          <ul className="mt-1 space-y-0.5">
            {skipped.map((s) => (
              <li key={s} className="text-[11px] text-amber-900 font-mono">{s}</li>
            ))}
          </ul>
        </div>
      )}

      {/* The number to watch week over week. */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-cardline bg-white px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-light">Books we can stand behind</div>
          <div className="text-2xl font-bold text-navy mt-0.5">
            {t?.clean ?? 0}<span className="text-base text-ink-light"> / {t?.clients ?? 0}</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full mt-2 overflow-hidden">
            <div className={`h-full rounded-full ${pct >= 80 ? "bg-teal" : pct >= 50 ? "bg-amber-400" : "bg-red-400"}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="rounded-xl border border-cardline bg-white px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-light">Clients with defects</div>
          <div className="text-2xl font-bold text-navy mt-0.5">{t?.dirty ?? 0}</div>
        </div>
        <div className="rounded-xl border border-cardline bg-white px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-light">Total exposure</div>
          <div className="text-2xl font-bold text-navy mt-0.5">{money(t?.exposureCents ?? 0)}</div>
        </div>
        <div className="rounded-xl border border-cardline bg-white px-4 py-3 flex flex-col justify-between">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-light">Refresh from scanners</div>
          <button
            onClick={() => void sync()}
            disabled={syncing}
            className="mt-1 inline-flex items-center justify-center gap-2 bg-navy hover:bg-navy/90 text-white text-xs font-semibold px-3 py-2 rounded-lg disabled:opacity-50"
          >
            {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {syncing ? "Syncing…" : "Sync ledger"}
          </button>
        </div>
      </div>

      {/* Per defect class — including when it was last actually swept. */}
      <div className="rounded-xl border border-cardline bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-100">
          <h2 className="text-sm font-bold text-navy">Defect classes</h2>
          <p className="text-[11px] text-ink-light mt-0.5">
            &ldquo;Never swept&rdquo; is not the same as clean — nobody has looked.
          </p>
        </div>
        <div className="divide-y divide-gray-50">
          {(data?.types || []).map((ty) => (
            <div key={ty.key} className="px-4 py-2.5 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-navy">{ty.label}</span>
                  {!ty.lastScan && (
                    <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800 bg-amber-100 border border-amber-300 rounded-full px-1.5 py-0.5">
                      never swept
                    </span>
                  )}
                  {!ty.derivable && (
                    <span
                      className="text-[10px] text-ink-light"
                      title="This scanner keeps no records — results only reach the ledger when someone runs it and reports in."
                    >
                      manual scan
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-ink-slate mt-0.5 line-clamp-1">{ty.description}</p>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm font-bold text-navy">{ty.affected}</div>
                <div className="text-[10px] text-ink-light">clients</div>
              </div>
              <div className="text-right shrink-0 w-24">
                <div className="text-sm font-mono text-navy">{money(ty.exposureCents)}</div>
                <div className="text-[10px] text-ink-light">swept {ago(ty.lastScan?.ran_at)}</div>
              </div>
              {ty.fleetHref && (
                <Link href={ty.fleetHref} className="text-ink-light hover:text-teal shrink-0" title="Open the scanner">
                  <ExternalLink size={13} />
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Per client. */}
      <div className="rounded-xl border border-cardline bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
          <h2 className="text-sm font-bold text-navy">By client</h2>
          <span className="text-[11px] text-ink-light">worst first</span>
        </div>
        <ul className="divide-y divide-gray-50">
          {(data?.rows || []).map((r) => {
            const isOpen = open.has(r.clientLinkId);
            return (
              <li key={r.clientLinkId}>
                <button
                  onClick={() =>
                    setOpen((prev) => {
                      const n = new Set(prev);
                      n.has(r.clientLinkId) ? n.delete(r.clientLinkId) : n.add(r.clientLinkId);
                      return n;
                    })
                  }
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50/60"
                >
                  {r.defects.length > 0
                    ? (isOpen ? <ChevronDown size={14} className="text-ink-slate shrink-0" /> : <ChevronRight size={14} className="text-ink-slate shrink-0" />)
                    : <span className="w-[14px] shrink-0" />}
                  {r.defects.length === 0
                    ? <ShieldCheck size={15} className="text-teal shrink-0" />
                    : <AlertTriangle size={15} className={r.worstSeverity === "critical" ? "text-red-600 shrink-0" : "text-amber-600 shrink-0"} />}
                  <span className="text-sm font-semibold text-navy flex-1 truncate">{r.clientName}</span>
                  {r.acceptedCount > 0 && (
                    <span className="text-[10px] text-ink-light shrink-0" title="Known and deliberately not being fixed">
                      {r.acceptedCount} accepted
                    </span>
                  )}
                  {r.defects.length === 0 ? (
                    <span className="text-xs text-teal-dark font-semibold shrink-0">clean</span>
                  ) : (
                    <>
                      <span className="text-xs text-ink-slate shrink-0">
                        {r.defects.length} defect{r.defects.length === 1 ? "" : "s"}
                      </span>
                      <span className="text-xs font-mono text-navy w-20 text-right shrink-0">{money(r.exposureCents)}</span>
                    </>
                  )}
                </button>

                {isOpen && r.defects.length > 0 && (
                  <div className="px-4 pb-3 pl-11 space-y-1.5">
                    {r.defects.map((d) => {
                      const ty = data?.types.find((x) => x.key === d.defect_type);
                      return (
                        <div key={d.id} className="flex items-center gap-2 flex-wrap text-xs">
                          <span className={`text-[10px] font-bold uppercase tracking-wider rounded-full border px-1.5 py-0.5 ${SEV_STYLE[d.severity] || SEV_STYLE.low}`}>
                            {d.severity}
                          </span>
                          <span className="font-semibold text-navy">{ty?.label || d.defect_type}</span>
                          {d.item_count != null && <span className="text-ink-light">{d.item_count} item{d.item_count === 1 ? "" : "s"}</span>}
                          {d.exposure_cents != null && <span className="font-mono text-navy">{money(d.exposure_cents)}</span>}
                          {d.status === "remediating" && (
                            <span className="text-[10px] font-bold uppercase text-teal-dark bg-teal-lighter rounded-full px-1.5 py-0.5">fixing</span>
                          )}
                          <span className="text-ink-light">seen {ago(d.last_seen_at)}</span>
                          <span className="flex-1" />
                          {d.status !== "remediating" && (
                            <button onClick={() => void setStatus(d.id, "remediating")} className="text-teal-dark hover:underline font-semibold">
                              Start fixing
                            </button>
                          )}
                          <button onClick={() => void setStatus(d.id, "resolved")} className="text-teal-dark hover:underline font-semibold inline-flex items-center gap-1">
                            <Check size={11} /> Fixed
                          </button>
                          <button
                            onClick={() => void setStatus(d.id, "accepted")}
                            title="Real, understood, deliberately not fixing"
                            className="text-ink-slate hover:underline"
                          >
                            Accept
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <p className="text-[11px] text-ink-light leading-relaxed">
        Marking something <strong>Fixed</strong> doesn&apos;t make it true — the next sweep reopens it if the
        defect is still detectable. <strong>Accept</strong> is for defects that are real but not worth
        fixing; those stay out of the clean count&apos;s way and are never reopened automatically. Both
        require a note, and both are written to the audit log.
      </p>
    </div>
  );
}
