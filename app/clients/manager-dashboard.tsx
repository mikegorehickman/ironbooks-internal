"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  LayoutGrid, ChevronDown, ChevronRight, ExternalLink, Loader2, Search, SkipForward, CalendarCheck,
  CheckCircle2, Circle, AlertTriangle, PlayCircle,
} from "lucide-react";
import { LIFECYCLE_META, type LifecycleStatus } from "@/lib/client-lifecycle";
import { ClientBadges } from "@/components/ClientBadges";
import { EscalateMenu } from "@/components/escalations-ui";
import type { AttentionState } from "@/lib/client-attention-state";

export interface ManagerRow {
  id: string;
  client_name: string;
  jurisdiction: string | null;
  state_province: string | null;
  assigned_bookkeeper_id: string | null;
  assigned_bookkeeper_name: string | null;
  status: LifecycleStatus;
  /** true when BS cleanup is deferred (bs_enabled=false) but still owed → amber badge. */
  bs_owed: boolean;
  /** true while the client is still in cleanup (Defer BS only meaningful here) */
  in_cleanup_phase: boolean;
  /** true once promoted to production — gets a Month-end deep link */
  is_production: boolean;
  /** status of the current close period; null when not in production */
  current_month_end: "done" | "in_review" | "waiting" | "in_progress" | "not_started" | null;
  /** the period being closed, "YYYY-MM"; null when not in production */
  current_month_end_period: string | null;
  /** latest fully-closed period, "YYYY-MM", or null if none closed yet */
  last_month_end_closed: string | null;
  /** id of a reclass job paused on a human Continue gate, or null */
  paused_job_id: string | null;
  /** lifecycle checklist for the row-expand drawer */
  steps: {
    qbo: boolean; coa: boolean; reclass: boolean; rules: boolean;
    bs: boolean; bs_deferred: boolean; signoff: boolean;
    production: boolean; month_sent: boolean;
  };
}
interface Bk { id: string; full_name: string }

const STATUS_ORDER = (Object.keys(LIFECYCLE_META) as LifecycleStatus[]).sort(
  (a, b) => LIFECYCLE_META[a].order - LIFECYCLE_META[b].order
);

/** Month-end close status → badge label + tone. */
const ME_META: Record<NonNullable<ManagerRow["current_month_end"]>, { label: string; tone: string }> = {
  done:        { label: "Done",            tone: "bg-emerald-50 text-emerald-700" },
  in_review:   { label: "In review",      tone: "bg-teal-light text-teal-dark" },
  waiting:     { label: "Waiting on client", tone: "bg-amber-50 text-amber-700" },
  in_progress: { label: "In progress",    tone: "bg-blue-50 text-blue-700" },
  not_started: { label: "Not started",    tone: "bg-slate-100 text-slate-600" },
};

/** "YYYY-MM" → "MMM YYYY" (e.g. 2026-05 → May 2026). */
function fmtPeriod(p: string): string {
  const [y, m] = p.split("-").map(Number);
  if (!y || !m) return p;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/**
 * Manager dashboard — the Double-style "every client, preparer, status" view
 * Lisa asked for. One flat table across all lifecycle stages, with inline
 * preparer reassignment and a BS-cleanup bypass. Collapsible; sits above the
 * existing kanban/list on /clients.
 */
export function ManagerDashboard({
  rows: initialRows,
  bookkeepers,
  canEdit,
}: {
  rows: ManagerRow[];
  bookkeepers: Bk[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState(initialRows);
  // Attention badge feed (escalated / billing / BS owed / disconnected).
  const [attention, setAttention] = useState<Record<string, AttentionState>>({});
  useEffect(() => {
    fetch("/api/attention")
      .then((r) => r.json())
      .then((j) => setAttention(j.clients || {}))
      .catch(() => {});
  }, []);
  const escalatedCount = useMemo(
    () => Object.values(attention).filter((a) => a.escalations.length > 0).length,
    [attention]
  );
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<LifecycleStatus | "all">("all");
  const [bsOnly, setBsOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fixMsg, setFixMsg] = useState<{ id: string; text: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleRow = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const filtered = useMemo(() => {
    let r = rows;
    if (statusFilter !== "all") r = r.filter((x) => x.status === statusFilter);
    if (bsOnly) r = r.filter((x) => x.bs_owed);
    if (q.trim()) {
      const s = q.toLowerCase();
      r = r.filter(
        (x) => x.client_name.toLowerCase().includes(s) || (x.assigned_bookkeeper_name || "").toLowerCase().includes(s)
      );
    }
    return [...r].sort(
      (a, b) => LIFECYCLE_META[a.status].order - LIFECYCLE_META[b.status].order || a.client_name.localeCompare(b.client_name)
    );
  }, [rows, q, statusFilter, bsOnly]);

  const counts = useMemo(() => {
    const m = new Map<LifecycleStatus, number>();
    for (const r of rows) m.set(r.status, (m.get(r.status) || 0) + 1);
    return m;
  }, [rows]);

  const bsOwedCount = useMemo(() => rows.filter((r) => r.bs_owed).length, [rows]);

  const groupTotals = useMemo(() => {
    const g: Record<string, number> = { Pipeline: 0, Review: 0, Live: 0 };
    for (const r of rows) g[LIFECYCLE_META[r.status].group]++;
    return g;
  }, [rows]);

  async function reassign(id: string, bkId: string) {
    setBusy(id); setError(null);
    try {
      const res = await fetch(`/api/clients/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigned_bookkeeper_id: bkId || null }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      setRows((prev) => prev.map((r) => r.id === id
        ? { ...r, assigned_bookkeeper_id: bkId || null, assigned_bookkeeper_name: bookkeepers.find((b) => b.id === bkId)?.full_name || null }
        : r));
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  }

  // Get-unstuck: ask the server to diagnose + recover a paused/stuck reclass
  // job. Instant fixes (skip web-search, reset a hung run) clear the flag and
  // refresh; cases that need the job page (resume chunks, retry) navigate there.
  async function selfFix(clientId: string, jobId: string) {
    setBusy(clientId); setError(null); setFixMsg(null);
    try {
      const res = await fetch(`/api/reclass/${jobId}/self-fix`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.navigate && data.href) {
        router.push(data.href);
        return;
      }
      setFixMsg({ id: clientId, text: data.message || "Done." });
      if (data.fixed) {
        // Flag is resolved — drop it locally and refresh the derived status.
        setRows((prev) => prev.map((r) => r.id === clientId ? { ...r, paused_job_id: null } : r));
        router.refresh();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  // Defer / un-defer BS cleanup reuses the existing production BS toggle
  // (bs_off = defer/P&L-only, bs_on = BS done/full service) so there's ONE
  // source of truth (bs_enabled), shared with the production board.
  async function bsAction(id: string, defer: boolean) {
    setBusy(id); setError(null);
    try {
      const res = await fetch(`/api/clients/${id}/production`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: defer ? "bs_off" : "bs_on" }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      setRows((prev) => prev.map((r) => r.id === id
        ? { ...r, bs_owed: defer, steps: { ...r.steps, bs_deferred: defer } }
        : r));
      router.refresh();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  }

  return (
    <section className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-5 py-3 border-b border-gray-100 hover:bg-gray-50"
      >
        {open ? <ChevronDown size={16} className="text-ink-slate" /> : <ChevronRight size={16} className="text-ink-slate" />}
        <LayoutGrid size={16} className="text-teal" />
        <h2 className="text-sm font-bold text-navy">Manager dashboard</h2>
        <span className="text-[11px] text-ink-light">every client · preparer · status</span>
        <span className="ml-auto text-xs font-bold text-ink-slate bg-slate-100 rounded-full px-2 py-0.5">{rows.length}</span>
      </button>

      {open && (
        <div className="p-4">
          {/* At-a-glance group totals */}
          <div className="flex items-center gap-3 mb-3">
            {([["Pipeline", "text-blue-700 bg-blue-50"], ["Review", "text-amber-700 bg-amber-50"], ["Live", "text-teal bg-teal/10"]] as const).map(([g, tone]) => (
              <div key={g} className={`flex items-baseline gap-1.5 px-3 py-1.5 rounded-lg ${tone}`}>
                <span className="text-lg font-black tabular-nums">{groupTotals[g]}</span>
                <span className="text-[11px] font-semibold uppercase tracking-wide">{g}</span>
              </div>
            ))}
            {escalatedCount > 0 && (
              <Link
                href="/approvals"
                className="flex items-baseline gap-1.5 px-3 py-1.5 rounded-lg text-red-700 bg-red-50 hover:bg-red-100"
                title="Open the escalation queue on Approvals"
              >
                <span className="text-lg font-black tabular-nums">{escalatedCount}</span>
                <span className="text-[11px] font-semibold uppercase tracking-wide">Escalated →</span>
              </Link>
            )}
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-light" />
              <input
                value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client or preparer…"
                className="text-sm rounded-lg border border-gray-200 pl-7 pr-3 py-1.5 w-56 focus:outline-none focus:border-teal"
              />
            </div>
            <button
              onClick={() => setStatusFilter("all")}
              className={`text-xs font-semibold px-2.5 py-1 rounded-full ${statusFilter === "all" ? "bg-navy text-white" : "bg-slate-100 text-ink-slate hover:bg-slate-200"}`}
            >
              All {rows.length}
            </button>
            {STATUS_ORDER.filter((s) => counts.get(s)).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(statusFilter === s ? "all" : s)}
                className={`text-xs font-semibold px-2.5 py-1 rounded-full ${statusFilter === s ? "bg-navy text-white" : LIFECYCLE_META[s].tone + " hover:opacity-80"}`}
              >
                {LIFECYCLE_META[s].label} {counts.get(s)}
              </button>
            ))}
            {bsOwedCount > 0 && (
              <button
                onClick={() => setBsOnly((v) => !v)}
                className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full ${bsOnly ? "bg-amber-600 text-white" : "bg-amber-100 text-amber-800 hover:bg-amber-200"}`}
                title="Clients in production/closed that still owe a balance-sheet cleanup"
              >
                <AlertTriangle size={11} /> BS outstanding {bsOwedCount}
              </button>
            )}
          </div>

          {error && <div className="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</div>}

          <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white z-10">
                <tr className="text-[10px] uppercase tracking-wider text-ink-light text-left border-b border-gray-100">
                  <th className="py-2 pr-3 font-bold">Client</th>
                  <th className="py-2 pr-3 font-bold">Preparer</th>
                  <th className="py-2 pr-3 font-bold">Status</th>
                  <th className="py-2 pr-3 font-bold">Month-end</th>
                  <th className="py-2 pr-3 font-bold">Last closed</th>
                  <th className="py-2 pr-3 font-bold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <Fragment key={r.id}>
                  <tr className="border-b border-gray-50 hover:bg-teal-lighter/40">
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => toggleRow(r.id)}
                          className="text-ink-light hover:text-navy flex-shrink-0"
                          title="Lifecycle checklist"
                        >
                          {expanded.has(r.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                        <Link href={`/clients/${r.id}`} className="font-semibold text-navy hover:underline inline-flex items-center gap-1 group">
                          {r.client_name}
                          <ExternalLink size={11} className="opacity-0 group-hover:opacity-50" />
                        </Link>
                        {(r.jurisdiction || r.state_province) && (
                          <span className="text-[11px] text-ink-light">{r.state_province || r.jurisdiction}</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      {canEdit ? (
                        <select
                          value={r.assigned_bookkeeper_id || ""}
                          onChange={(e) => reassign(r.id, e.target.value)}
                          disabled={busy === r.id}
                          className="text-xs rounded-md border border-gray-200 px-1.5 py-1 bg-white text-navy max-w-[160px]"
                        >
                          <option value="">Unassigned</option>
                          {bookkeepers.map((b) => <option key={b.id} value={b.id}>{b.full_name}</option>)}
                        </select>
                      ) : (
                        <span className="text-ink-slate">{r.assigned_bookkeeper_name || "—"}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full ${LIFECYCLE_META[r.status].tone}`}>
                        {LIFECYCLE_META[r.status].label}
                      </span>
                      {/* Unified attention badges (wide table → show all); the
                          stuck-job state keeps its richer Get-unstuck ACTION
                          below instead of a passive badge. */}
                      <span className="ml-1.5">
                        <ClientBadges
                          attention={
                            attention[r.id] ? { ...attention[r.id], stuck_job: false } : attention[r.id]
                          }
                          stage="dashboard"
                          max={5}
                        />
                      </span>
                      {r.paused_job_id && (
                        <button
                          onClick={() => selfFix(r.id, r.paused_job_id!)}
                          disabled={busy === r.id}
                          className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-teal-light text-teal-dark hover:bg-teal-light disabled:opacity-50"
                          title="This client has a stuck reclass job — click to auto-resume it"
                        >
                          {busy === r.id ? <Loader2 size={9} className="animate-spin" /> : <PlayCircle size={9} />} Get unstuck
                        </button>
                      )}
                      {fixMsg && fixMsg.id === r.id && (
                        <span className="ml-1.5 text-[10px] text-ink-slate italic">{fixMsg.text}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      {r.current_month_end ? (
                        <div className="flex flex-col gap-0.5">
                          {r.current_month_end_period && (
                            <span className="text-[10px] text-ink-light leading-none">{fmtPeriod(r.current_month_end_period)}</span>
                          )}
                          <span className={`inline-flex items-center w-fit text-[11px] font-semibold px-2 py-0.5 rounded-full ${ME_META[r.current_month_end].tone}`}>
                            {ME_META[r.current_month_end].label}
                          </span>
                        </div>
                      ) : (
                        <span className="text-ink-light text-xs">—</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      {r.last_month_end_closed ? (
                        <span className="text-xs text-ink-slate">{fmtPeriod(r.last_month_end_closed)}</span>
                      ) : (
                        <span className="text-ink-light text-xs">—</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-1 text-right whitespace-nowrap">
                      {busy === r.id && <Loader2 size={13} className="animate-spin text-teal inline mr-2" />}
                      {/* Defer BS — while in the cleanup phase and not already deferred */}
                      {canEdit && r.in_cleanup_phase && !r.bs_owed && (
                        <button
                          onClick={() => bsAction(r.id, true)}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-amber-200 text-amber-700 hover:bg-amber-50"
                          title="Defer the balance-sheet cleanup (P&L-only) — move to production now, BS stays flagged as owed"
                        >
                          <SkipForward size={11} /> Defer BS
                        </button>
                      )}
                      <span className="mr-1.5">
                        <EscalateMenu
                          clientLinkId={r.id}
                          clientName={r.client_name}
                          onRaised={() =>
                            fetch("/api/attention")
                              .then((res) => res.json())
                              .then((j) => setAttention(j.clients || {}))
                              .catch(() => {})
                          }
                          small
                        />
                      </span>
                      {/* Mark BS done — whenever it's owed (cleanup OR production) */}
                      {canEdit && r.bs_owed && (
                        <button
                          onClick={() => bsAction(r.id, false)}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                          title="Mark the deferred balance-sheet cleanup as done (restores full BS service)"
                        >
                          <CheckCircle2 size={11} /> BS done
                        </button>
                      )}
                      {r.is_production && (
                        <Link
                          href="/production"
                          className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg border ${
                            r.status === "done"
                              ? "border-gray-200 text-ink-slate hover:bg-gray-50"
                              : "border-teal/30 text-teal hover:bg-teal-lighter"
                          }`}
                          title={r.status === "done" ? "Month closed — open the production board" : "Open the month-end close: review, attest, send statements"}
                        >
                          <CalendarCheck size={11} /> {r.status === "done" ? "Month-end" : "Finish month-end"}
                        </Link>
                      )}
                    </td>
                  </tr>
                  {expanded.has(r.id) && (
                    <tr className="bg-slate-50/60">
                      <td colSpan={6} className="px-4 py-3">
                        <Checklist steps={r.steps} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={6} className="py-8 text-center text-ink-light text-sm italic">No clients match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/** Lifecycle checklist shown when a dashboard row is expanded. */
function Checklist({ steps }: { steps: ManagerRow["steps"] }) {
  const items: { label: string; done: boolean; note?: string }[] = [
    { label: "QuickBooks connected", done: steps.qbo },
    { label: "COA cleanup", done: steps.coa },
    { label: "Reclassification", done: steps.reclass },
    { label: "Bank rules created", done: steps.rules },
    { label: "Balance-sheet cleanup", done: steps.bs, note: steps.bs_deferred ? "deferred — owed" : undefined },
    { label: "Cleanup signed off", done: steps.signoff },
    { label: "In production (daily recon)", done: steps.production },
    { label: "This month sent to client", done: steps.month_sent },
  ];
  return (
    <ul className="grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-1.5">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5 text-xs">
          {it.done ? (
            <CheckCircle2 size={13} className="text-emerald-600 flex-shrink-0" />
          ) : (
            <Circle size={13} className="text-ink-light flex-shrink-0" />
          )}
          <span className={it.done ? "text-navy" : "text-ink-light"}>
            {it.label}
            {it.note && <span className="ml-1 text-[10px] italic text-amber-700">({it.note})</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
