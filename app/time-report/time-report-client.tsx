"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ChevronDown, ChevronRight, Clock, Download, Layers, Loader2, MessageSquare, Pencil, Users,
} from "lucide-react";
import { formatDuration } from "@/lib/time-tracking";

/**
 * The time report's interactive half: month navigation, per-client actual vs
 * budget, inline budget editing, over-budget notes, per-bookkeeper split,
 * session drill-down and CSV export.
 *
 * Everything is computed server-side by /api/time-tracking/report (one source
 * of truth for month attribution and the budget rules); this only renders and
 * PATCHes budgets.
 */

interface ByUser { userId: string; userName: string; seconds: number; sessions: number }
interface NoteRow {
  entryId: string; userName: string; endedAt: string | null; seconds: number; note: string;
  budgetMinutesAtCompletion: number | null; mtdSecondsAtCompletion: number | null;
}
interface ClientRow {
  clientLinkId: string; clientName: string; isActive: boolean;
  budgetMinutes: number; budgetIsDefault: boolean;
  actualSeconds: number; openSeconds: number; sessions: number;
  overBudget: boolean; overBySeconds: number;
  byUser: ByUser[]; notes: NoteRow[];
}
interface StaffRow {
  userId: string; userName: string; role: string | null;
  seconds: number; overheadSeconds: number; sessions: number; clients: number;
}
interface Zombie {
  entryId: string; clientName: string; userName: string; status: string;
  autoPaused: boolean; seconds: number; startedAt: string; updatedAt: string;
}
interface EntryRow {
  id: string; clientLinkId: string | null; clientName: string; category: string | null;
  userId: string; userName: string;
  startedAt: string; endedAt: string | null; seconds: number; sourcePath: string | null; note: string | null;
}
interface OverheadRow { category: string; label: string; seconds: number; sessions: number }
interface Report {
  month: string;
  setup_pending?: boolean;
  defaultBudgetMinutes: number;
  totals: {
    trackedSeconds: number; overheadSeconds: number; clientSharePct: number | null;
    openSeconds: number; sessions: number; overheadSessions: number;
    clients: number; overBudgetClients: number;
  };
  clients: ClientRow[];
  overhead: OverheadRow[];
  staff: StaffRow[];
  zombies: Zombie[];
  entries: EntryRow[];
}

const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, (mo || 1) - 1, 1)).toLocaleDateString(undefined, {
    month: "long", year: "numeric", timeZone: "UTC",
  });
};
const shiftMonth = (m: string, delta: number) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, (mo || 1) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export function TimeReportClient({ initialMonth }: { initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [showStaff, setShowStaff] = useState(true);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/time-tracking/report?month=${m}`, { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || `Failed (${res.status})`);
      setData(d);
    } catch (e: any) {
      setError(e?.message || "Failed to load the report");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(month); }, [month, load]);

  const toggle = (id: string) =>
    setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function saveBudget(clientLinkId: string) {
    const raw = editValue.trim();
    const body = raw === "" ? { timeBudgetMinutes: null } : { timeBudgetMinutes: Number(raw) };
    if (raw !== "" && (!Number.isInteger(Number(raw)) || Number(raw) < 0)) {
      setError("Budget must be a whole number of minutes (or blank for the default).");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/time-tracking/budgets/${clientLinkId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || d?.error || "Failed to save");
      setEditing(null);
      await load(month);
    } catch (e: any) {
      setError(e?.message || "Failed to save the budget");
    } finally {
      setSaving(false);
    }
  }

  const csv = useMemo(() => {
    if (!data) return "";
    const esc = (v: any) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [
      ["Client / category", "Type", "Bookkeeper", "Started", "Completed", "Minutes", "Note"].join(","),
      ...data.entries.map((e) =>
        [
          e.clientName,
          e.category ? "Overhead" : "Client",
          e.userName, e.startedAt, e.endedAt ?? "", Math.round(e.seconds / 60), e.note ?? "",
        ].map(esc).join(",")
      ),
    ];
    return rows.join("\n");
  }, [data]);

  function downloadCsv() {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ironbooks-time-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      {/* Month + actions */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white overflow-hidden">
          <button onClick={() => setMonth(shiftMonth(month, -1))} className="px-2.5 py-1.5 text-xs font-semibold text-ink-slate hover:bg-gray-50">
            ←
          </button>
          <span className="px-3 py-1.5 text-xs font-bold text-navy min-w-[130px] text-center">{monthLabel(month)}</span>
          <button
            onClick={() => setMonth(shiftMonth(month, 1))}
            disabled={month >= initialMonth}
            className="px-2.5 py-1.5 text-xs font-semibold text-ink-slate hover:bg-gray-50 disabled:opacity-40"
          >
            →
          </button>
        </div>
        <div className="flex items-center gap-2">
          {month !== initialMonth && (
            <button onClick={() => setMonth(initialMonth)} className="text-xs font-semibold text-teal hover:underline">
              This month
            </button>
          )}
          <button
            onClick={downloadCsv}
            disabled={!data || data.entries.length === 0}
            className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border border-gray-200 text-navy hover:border-gray-300 disabled:opacity-50"
          >
            <Download size={13} /> CSV
          </button>
        </div>
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

      {data?.setup_pending && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <span className="font-bold">Time tracking isn&apos;t set up yet.</span> Apply{" "}
          <code className="font-mono">scripts/migration_146_time_tracking.sql</code> in the Supabase SQL editor and this
          page fills in.
        </div>
      )}

      {loading && !data ? (
        <div className="py-16 text-center text-sm text-ink-slate">
          <Loader2 size={16} className="animate-spin inline mr-2" /> Loading…
        </div>
      ) : !data ? null : (
        <>
          {/* Totals */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="Client time" value={formatDuration(data.totals.trackedSeconds)} sub={`${data.totals.sessions} session${data.totals.sessions === 1 ? "" : "s"} · ${data.totals.clients} client${data.totals.clients === 1 ? "" : "s"}`} />
            <Kpi
              label="Overhead"
              value={formatDuration(data.totals.overheadSeconds)}
              sub={data.totals.clientSharePct !== null ? `${data.totals.clientSharePct}% of time is client work` : "no time tracked yet"}
            />
            <Kpi label="Over budget" value={String(data.totals.overBudgetClients)} sub="clients past their month" tone={data.totals.overBudgetClients > 0 ? "warn" : undefined} />
            <Kpi label="Still open" value={formatDuration(data.totals.openSeconds)} sub="running or paused now" />
          </div>

          {/* Forgotten timers */}
          {data.zombies.length > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={15} className="text-amber-600 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-bold text-amber-900">
                    {data.zombies.length} timer{data.zombies.length === 1 ? "" : "s"} left open
                  </div>
                  <p className="text-[11px] text-amber-800 mt-0.5">
                    Auto-paused after inactivity, or paused for over a week. The time isn&apos;t counted until someone
                    completes the session.
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {data.zombies.map((z) => (
                      <li key={z.entryId} className="text-[11px] text-amber-900 flex items-center gap-2">
                        <span className="font-semibold truncate">{z.clientName}</span>
                        <span className="text-amber-700">· {z.userName}</span>
                        <span className="font-mono">{formatDuration(z.seconds)}</span>
                        {z.autoPaused && <span className="text-[9px] font-bold uppercase bg-amber-200 px-1 rounded">auto</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Per-client */}
          <div className="rounded-xl border border-cardline bg-white overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
              <Clock size={14} className="text-teal" />
              <span className="text-sm font-bold text-navy">By client</span>
              <span className="text-[11px] text-ink-light">· actual vs monthly budget · click a row for detail</span>
            </div>
            {data.clients.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-ink-slate">
                No time tracked in {monthLabel(month)}.
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {data.clients.map((c) => {
                  const budgetSeconds = c.budgetMinutes * 60;
                  const pct = budgetSeconds > 0 ? Math.min(100, Math.round((c.actualSeconds / budgetSeconds) * 100)) : 100;
                  const open = expanded.has(c.clientLinkId);
                  return (
                    <div key={c.clientLinkId}>
                      <div className="px-4 py-2.5 flex items-center gap-3 hover:bg-gray-50/60">
                        <button onClick={() => toggle(c.clientLinkId)} className="shrink-0 text-ink-light hover:text-navy">
                          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        <button onClick={() => toggle(c.clientLinkId)} className="min-w-0 flex-1 text-left">
                          <div className="text-xs font-bold text-navy truncate">
                            {c.clientName}
                            {!c.isActive && <span className="ml-1.5 text-[10px] font-semibold text-ink-light">(inactive)</span>}
                          </div>
                          <div className="mt-1 h-1.5 rounded-full bg-gray-100 overflow-hidden max-w-[280px]">
                            <div className={`h-full rounded-full ${c.overBudget ? "bg-rust" : "bg-teal"}`} style={{ width: `${pct}%` }} />
                          </div>
                        </button>
                        <div className="shrink-0 text-right">
                          <div className={`font-mono text-xs font-bold ${c.overBudget ? "text-rust" : "text-navy"}`}>
                            {formatDuration(c.actualSeconds)}
                          </div>
                          <div className="text-[10px] text-ink-light">
                            {c.sessions} session{c.sessions === 1 ? "" : "s"}
                            {c.openSeconds > 0 && <> · {formatDuration(c.openSeconds)} open</>}
                          </div>
                        </div>
                        {/* Budget cell — inline editable */}
                        <div className="shrink-0 w-[124px] text-right">
                          {editing === c.clientLinkId ? (
                            <div className="flex items-center gap-1 justify-end">
                              <input
                                autoFocus
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") void saveBudget(c.clientLinkId);
                                  if (e.key === "Escape") setEditing(null);
                                }}
                                placeholder="min"
                                className="w-14 text-[11px] border border-gray-300 rounded px-1.5 py-1 text-right"
                              />
                              <button
                                onClick={() => void saveBudget(c.clientLinkId)}
                                disabled={saving}
                                className="text-[11px] font-bold text-teal hover:underline disabled:opacity-50"
                              >
                                {saving ? "…" : "Save"}
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setEditing(c.clientLinkId); setEditValue(c.budgetIsDefault ? "" : String(c.budgetMinutes)); }}
                              className="group inline-flex items-center gap-1 text-[11px] text-ink-slate hover:text-navy"
                              title="Set this client's monthly budget"
                            >
                              <span>
                                {formatDuration(c.budgetMinutes * 60)}
                                {c.budgetIsDefault && <span className="text-ink-light"> (default)</span>}
                              </span>
                              <Pencil size={10} className="opacity-0 group-hover:opacity-100" />
                            </button>
                          )}
                          {c.overBudget && (
                            <div className="text-[10px] font-bold text-rust">+{formatDuration(c.overBySeconds)}</div>
                          )}
                        </div>
                      </div>

                      {open && (
                        <div className="px-4 pb-3 pl-11 space-y-2 bg-gray-50/40">
                          {c.byUser.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-2">
                              {c.byUser.map((u) => (
                                <span key={u.userId} className="text-[10px] font-semibold bg-white border border-gray-200 rounded-full px-2 py-0.5 text-ink-slate">
                                  {u.userName} · {formatDuration(u.seconds)}
                                </span>
                              ))}
                            </div>
                          )}
                          {c.notes.length > 0 && (
                            <div className="space-y-1.5">
                              {c.notes.map((n) => (
                                <div key={n.entryId} className="rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-2">
                                  <div className="flex items-start gap-1.5">
                                    <MessageSquare size={11} className="text-amber-600 mt-0.5 shrink-0" />
                                    <div className="min-w-0">
                                      <div className="text-[11px] text-amber-900">{n.note}</div>
                                      <div className="text-[10px] text-amber-700 mt-0.5">
                                        {n.userName} · {formatDuration(n.seconds)} session
                                        {n.budgetMinutesAtCompletion !== null && (
                                          <> · was {formatDuration((n.mtdSecondsAtCompletion ?? 0) + n.seconds)} of a{" "}
                                          {formatDuration(n.budgetMinutesAtCompletion * 60)} budget</>
                                        )}
                                        {n.endedAt && <> · {new Date(n.endedAt).toLocaleDateString()}</>}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="space-y-0.5">
                            {data.entries
                              .filter((e) => e.clientLinkId === c.clientLinkId)
                              .map((e) => (
                                <div key={e.id} className="flex items-center gap-2 text-[11px] text-ink-slate">
                                  <span className="w-[86px] shrink-0">
                                    {e.endedAt ? new Date(e.endedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"}
                                  </span>
                                  <span className="flex-1 truncate">{e.userName}</span>
                                  <span className="font-mono shrink-0">{formatDuration(e.seconds)}</span>
                                </div>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Overhead — real work that belongs to no single client */}
          {data.overhead.length > 0 && (
            <div className="rounded-xl border border-cardline bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
                <Layers size={14} className="text-teal" />
                <span className="text-sm font-bold text-navy">Not for one client</span>
                <span className="text-[11px] text-ink-light">· never counted against a client&apos;s budget</span>
              </div>
              <div className="divide-y divide-gray-100">
                {data.overhead.map((o) => {
                  const share = data.totals.overheadSeconds > 0
                    ? Math.round((o.seconds / data.totals.overheadSeconds) * 100)
                    : 0;
                  return (
                    <div key={o.category} className="px-4 py-2.5 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-navy">{o.label}</div>
                        <div className="mt-1 h-1.5 rounded-full bg-gray-100 overflow-hidden max-w-[280px]">
                          <div className="h-full rounded-full bg-navy/40" style={{ width: `${share}%` }} />
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="font-mono text-xs font-bold text-navy">{formatDuration(o.seconds)}</div>
                        <div className="text-[10px] text-ink-light">
                          {o.sessions} session{o.sessions === 1 ? "" : "s"} · {share}%
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Per bookkeeper */}
          <div className="rounded-xl border border-cardline bg-white overflow-hidden">
            <button onClick={() => setShowStaff((s) => !s)} className="w-full px-4 py-2.5 border-b border-gray-100 flex items-center gap-2 text-left">
              {showStaff ? <ChevronDown size={14} className="text-ink-light" /> : <ChevronRight size={14} className="text-ink-light" />}
              <Users size={14} className="text-teal" />
              <span className="text-sm font-bold text-navy">By bookkeeper</span>
            </button>
            {showStaff && (
              data.staff.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-ink-slate">Nothing tracked this month.</div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {data.staff.map((s) => (
                    <div key={s.userId} className="px-4 py-2 flex items-center gap-3 text-xs">
                      <span className="flex-1 min-w-0 truncate font-semibold text-navy">
                        {s.userName}
                        {s.role && <span className="ml-1.5 text-[10px] font-normal text-ink-light">{s.role}</span>}
                      </span>
                      <span className="text-[11px] text-ink-slate shrink-0">
                        {s.clients} client{s.clients === 1 ? "" : "s"} · {s.sessions} session{s.sessions === 1 ? "" : "s"}
                      </span>
                      {s.overheadSeconds > 0 && (
                        <span className="text-[10px] text-ink-light shrink-0 w-[76px] text-right">
                          +{formatDuration(s.overheadSeconds)} other
                        </span>
                      )}
                      <span className="font-mono font-bold text-navy shrink-0 w-[70px] text-right">{formatDuration(s.seconds)}</span>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" }) {
  return (
    <div className={`rounded-xl border bg-white px-4 py-3 ${tone === "warn" ? "border-amber-300" : "border-cardline"}`}>
      <div className="text-[10px] font-bold uppercase tracking-wide text-ink-light">{label}</div>
      <div className={`text-xl font-bold mt-0.5 ${tone === "warn" ? "text-rust" : "text-navy"}`}>{value}</div>
      {sub && <div className="text-[10px] text-ink-slate mt-0.5">{sub}</div>}
    </div>
  );
}
