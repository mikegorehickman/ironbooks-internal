"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ChevronDown, ChevronRight, Clock, Download, Layers, Loader2, MessageSquare,
  Pencil, Search, SlidersHorizontal, Trash2, Users,
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
interface StaffDay {
  date: string; seconds: number; clientSeconds: number; overheadSeconds: number;
  sessions: number; clients: number; clientNames: string[];
}
interface StaffRow {
  userId: string; userName: string; role: string | null;
  seconds: number; overheadSeconds: number; totalSeconds: number;
  sessions: number; clients: number;
  activeDays: number; avgSecondsPerActiveDay: number;
  busiestDay: { date: string; seconds: number } | null;
  byDay: StaffDay[];
  topClients: { clientLinkId: string; clientName: string; seconds: number }[];
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
interface FleetBudget {
  clientLinkId: string; clientName: string; assignedBookkeeperName?: string | null;
  budgetMinutes: number; budgetIsDefault: boolean;
}
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
  monthDays: string[];
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
  const [showClients, setShowClients] = useState(true);

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

          {/* By bookkeeper — first, because "how is each person's month
              shaped" is the question this page gets opened for. */}
          <StaffSection staff={data.staff} monthDays={data.monthDays} month={month} />

          {/* Forgotten timers */}
          {data.zombies.length > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={15} className="text-amber-600 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-bold text-amber-900">
                    {data.zombies.length} timer{data.zombies.length === 1 ? "" : "s"} left open
                  </div>
                  <p className="text-xs text-amber-800 mt-0.5">
                    Auto-paused after inactivity, or paused for over a week. The time isn&apos;t counted until someone
                    completes the session.
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {data.zombies.map((z) => (
                      <li key={z.entryId} className="text-xs text-amber-900 flex items-center gap-2">
                        <span className="font-semibold truncate">{z.clientName}</span>
                        <span className="text-amber-700">· {z.userName}</span>
                        <span className="font-mono">{formatDuration(z.seconds)}</span>
                        {z.autoPaused && <span className="text-[10px] font-bold uppercase bg-amber-200 px-1 rounded">auto</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Per-client — collapsible; the whole section folds away when the
              bookkeeper view is what's being read. */}
          <div className="rounded-xl border border-cardline bg-white overflow-hidden">
            <button
              onClick={() => setShowClients((v) => !v)}
              className="w-full px-4 py-2.5 border-b border-gray-100 flex items-center gap-2 text-left hover:bg-gray-50/60"
            >
              {showClients ? <ChevronDown size={14} className="text-ink-slate" /> : <ChevronRight size={14} className="text-ink-slate" />}
              <Clock size={14} className="text-teal" />
              <span className="text-sm font-bold text-navy">By client</span>
              <span className="text-xs text-ink-slate">
                · actual vs monthly budget
                {!showClients && data.clients.length > 0 && <> · {data.clients.length} client{data.clients.length === 1 ? "" : "s"}</>}
                {data.totals.overBudgetClients > 0 && <span className="text-rust font-semibold"> · {data.totals.overBudgetClients} over</span>}
              </span>
            </button>
            {!showClients ? null : data.clients.length === 0 ? (
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
                        <button onClick={() => toggle(c.clientLinkId)} className="shrink-0 text-ink-slate hover:text-navy">
                          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        <button onClick={() => toggle(c.clientLinkId)} className="min-w-0 flex-1 text-left">
                          <div className="text-xs font-bold text-navy truncate">
                            {c.clientName}
                            {!c.isActive && <span className="ml-1.5 text-[11px] font-semibold text-ink-slate">(inactive)</span>}
                          </div>
                          <div className="mt-1 h-1.5 rounded-full bg-gray-100 overflow-hidden max-w-[280px]">
                            <div className={`h-full rounded-full ${c.overBudget ? "bg-rust" : "bg-teal"}`} style={{ width: `${pct}%` }} />
                          </div>
                        </button>
                        <div className="shrink-0 text-right">
                          <div className={`font-mono text-xs font-bold ${c.overBudget ? "text-rust" : "text-navy"}`}>
                            {formatDuration(c.actualSeconds)}
                          </div>
                          <div className="text-[11px] text-ink-slate">
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
                                className="w-14 text-xs border border-gray-300 rounded px-1.5 py-1 text-right"
                              />
                              <button
                                onClick={() => void saveBudget(c.clientLinkId)}
                                disabled={saving}
                                className="text-xs font-bold text-teal hover:underline disabled:opacity-50"
                              >
                                {saving ? "…" : "Save"}
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setEditing(c.clientLinkId); setEditValue(c.budgetIsDefault ? "" : String(c.budgetMinutes)); }}
                              className="group inline-flex items-center gap-1 text-xs text-ink-slate hover:text-navy"
                              title="Set this client's monthly budget"
                            >
                              <span>
                                {formatDuration(c.budgetMinutes * 60)}
                                {c.budgetIsDefault && <span className="text-ink-slate"> (default)</span>}
                              </span>
                              <Pencil size={10} className="opacity-0 group-hover:opacity-100" />
                            </button>
                          )}
                          {c.overBudget && (
                            <div className="text-[11px] font-bold text-rust">+{formatDuration(c.overBySeconds)}</div>
                          )}
                        </div>
                      </div>

                      {open && (
                        <div className="px-4 pb-3 pl-11 space-y-2 bg-gray-50/40">
                          {c.byUser.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-2">
                              {c.byUser.map((u) => (
                                <span key={u.userId} className="text-[11px] font-semibold bg-white border border-gray-200 rounded-full px-2 py-0.5 text-ink-slate">
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
                                      <div className="text-xs text-amber-900">{n.note}</div>
                                      <div className="text-[11px] text-amber-700 mt-0.5">
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
                              .map((e) => <EntryLine key={e.id} entry={e} onChanged={() => void load(month)} />)}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Fleet budget setup — every active client, not just this month's */}
          <BudgetSetup defaultMinutes={data.defaultBudgetMinutes} />

          {/* Overhead — real work that belongs to no single client */}
          {data.overhead.length > 0 && (
            <div className="rounded-xl border border-cardline bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
                <Layers size={14} className="text-teal" />
                <span className="text-sm font-bold text-navy">Not for one client</span>
                <span className="text-xs text-ink-slate">· never counted against a client&apos;s budget</span>
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
                        <div className="text-[11px] text-ink-slate">
                          {o.sessions} session{o.sessions === 1 ? "" : "s"} · {share}%
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}


        </>
      )}
    </div>
  );
}

/**
 * By bookkeeper — the shape of each person's month, not just a total.
 *
 * A single number ("Lisa: 15h") answers almost nothing useful. What a manager
 * actually needs is the rhythm: which days were worked, how long each ran, how
 * many clients got touched in a day, and how much of it was client work versus
 * overhead. So each person gets a day-by-day bar strip across the month (teal =
 * client, navy = overhead), headline stats averaged over days ACTUALLY worked —
 * averaging over calendar days makes every part-timer look idle — and an
 * expandable day list with the clients touched on each.
 *
 * Everyone doing production is listed, managers included, even at zero: who
 * ISN'T logging is the adoption signal, and a table built only from existing
 * rows can never show it.
 */
function StaffSection({ staff, monthDays, month }: { staff: StaffRow[]; monthDays: string[]; month: string }) {
  const [open, setOpen] = useState(true);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [hideIdle, setHideIdle] = useState(false);

  const logged = staff.filter((s) => s.totalSeconds > 0);
  const idle = staff.filter((s) => s.totalSeconds === 0);
  const shown = hideIdle ? logged : staff;
  // One scale across everyone, so bar heights are comparable person to person.
  const peakDaySeconds = Math.max(1, ...staff.flatMap((s) => s.byDay.map((d) => d.seconds)));

  return (
    <div className="rounded-xl border border-cardline bg-white overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-2.5 border-b border-gray-100 flex items-center gap-2 text-left hover:bg-gray-50/60"
      >
        {open ? <ChevronDown size={14} className="text-ink-slate" /> : <ChevronRight size={14} className="text-ink-slate" />}
        <Users size={14} className="text-teal" />
        <span className="text-sm font-bold text-navy">By bookkeeper</span>
        <span className="text-xs text-ink-slate">
          · {logged.length} logging{idle.length > 0 && <> · {idle.length} with nothing this month</>}
        </span>
      </button>

      {open && (
        <>
          {idle.length > 0 && (
            <div className="px-4 pt-2.5 flex items-center justify-end">
              <label className="inline-flex items-center gap-1.5 text-xs text-ink-slate cursor-pointer">
                <input type="checkbox" checked={hideIdle} onChange={(e) => setHideIdle(e.target.checked)} className="accent-teal" />
                Hide the {idle.length} not logging
              </label>
            </div>
          )}
          {shown.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-ink-slate">No production staff found.</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {shown.map((s) => {
                const isOpen = expandedUser === s.userId;
                const byDate = new Map(s.byDay.map((d) => [d.date, d]));
                const nothing = s.totalSeconds === 0;
                return (
                  <div key={s.userId} className={nothing ? "bg-gray-50/40" : undefined}>
                    <div className="px-4 py-2.5">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <button
                          onClick={() => setExpandedUser(isOpen ? null : s.userId)}
                          className="text-xs font-bold text-navy hover:text-teal inline-flex items-center gap-1"
                          disabled={nothing}
                        >
                          {!nothing && (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
                          {s.userName}
                        </button>
                        {s.role && (
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-slate">{s.role}</span>
                        )}
                        <span className="flex-1" />
                        {nothing ? (
                          <span className="text-xs text-ink-slate">nothing logged in {monthLabel(month)}</span>
                        ) : (
                          <>
                            <span className="text-xs text-ink-slate">
                              {formatDuration(s.seconds)} client
                              {s.overheadSeconds > 0 && <> · {formatDuration(s.overheadSeconds)} other</>}
                            </span>
                            <span className="font-mono text-xs font-bold text-navy w-[70px] text-right">
                              {formatDuration(s.totalSeconds)}
                            </span>
                          </>
                        )}
                      </div>

                      {!nothing && (
                        <>
                          <div className="mt-1 text-[11px] text-ink-slate">
                            {s.activeDays} day{s.activeDays === 1 ? "" : "s"} worked · avg{" "}
                            <span className="font-semibold text-ink-slate">{formatDuration(s.avgSecondsPerActiveDay)}</span>/day ·{" "}
                            {s.clients} client{s.clients === 1 ? "" : "s"} · {s.sessions} session{s.sessions === 1 ? "" : "s"}
                            {s.busiestDay && (
                              <> · busiest {shortDate(s.busiestDay.date)} ({formatDuration(s.busiestDay.seconds)})</>
                            )}
                          </div>

                          {/* Daily strip — one column per calendar day. */}
                          <div className="mt-1.5 flex items-end gap-[2px] h-9" title="Hours logged per day">
                            {monthDays.map((date) => {
                              const d = byDate.get(date);
                              const total = d?.seconds ?? 0;
                              const h = total > 0 ? Math.max(3, Math.round((total / peakDaySeconds) * 34)) : 2;
                              const clientH = total > 0 ? Math.round((d!.clientSeconds / total) * h) : 0;
                              return (
                                <div
                                  key={date}
                                  className="flex-1 min-w-[2px] flex flex-col justify-end cursor-default"
                                  style={{ height: 34 }}
                                  title={
                                    total > 0
                                      ? `${shortDate(date)} — ${formatDuration(total)}, ${d!.clients} client${d!.clients === 1 ? "" : "s"}`
                                      : `${shortDate(date)} — nothing`
                                  }
                                >
                                  {total > 0 ? (
                                    <>
                                      {d!.overheadSeconds > 0 && (
                                        <div className="w-full rounded-t-sm bg-navy/35" style={{ height: h - clientH }} />
                                      )}
                                      <div
                                        className={`w-full bg-teal ${d!.overheadSeconds > 0 ? "" : "rounded-t-sm"}`}
                                        style={{ height: clientH }}
                                      />
                                    </>
                                  ) : (
                                    <div className="w-full rounded-sm bg-gray-100" style={{ height: 2 }} />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>

                    {isOpen && !nothing && (
                      <div className="px-4 pb-3 pl-8 bg-gray-50/40 space-y-2">
                        {s.topClients.length > 0 && (
                          <div className="pt-2 flex flex-wrap gap-1.5">
                            {s.topClients.map((c) => (
                              <span key={c.clientLinkId} className="text-[11px] font-semibold bg-white border border-gray-200 rounded-full px-2 py-0.5 text-ink-slate">
                                {c.clientName} · {formatDuration(c.seconds)}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-ink-slate">
                            <span className="w-[70px] shrink-0">Day</span>
                            <span className="w-[60px] shrink-0 text-right">Time</span>
                            <span className="w-[64px] shrink-0 text-right">Clients</span>
                            <span className="flex-1">Worked on</span>
                          </div>
                          {s.byDay.map((d) => (
                            <div key={d.date} className="flex items-center gap-2 text-xs text-ink-slate">
                              <span className="w-[70px] shrink-0 font-semibold text-navy">{shortDate(d.date)}</span>
                              <span className="w-[60px] shrink-0 text-right font-mono">{formatDuration(d.seconds)}</span>
                              <span className="w-[64px] shrink-0 text-right">{d.clients || "—"}</span>
                              <span className="flex-1 truncate" title={d.clientNames.join(", ")}>
                                {d.clientNames.length > 0 ? d.clientNames.join(", ") : <span className="text-ink-slate">overhead only</span>}
                                {d.overheadSeconds > 0 && d.clientNames.length > 0 && (
                                  <span className="text-ink-slate"> · +{formatDuration(d.overheadSeconds)} other</span>
                                )}
                              </span>
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
          <div className="px-4 py-2 border-t border-gray-100 flex items-center gap-3 text-[11px] text-ink-slate">
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-teal" /> client work</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-navy/35" /> overhead</span>
            <span>· one bar per day of {monthLabel(month)} · click a name for the day-by-day list</span>
          </div>
        </>
      )}
    </div>
  );
}

const shortDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
};

/**
 * Fleet budget setup. The "By client" table can only list clients with tracked
 * time, so without this there'd be no way to set a budget until someone had
 * already blown through the default — which is backwards at rollout. Lists every
 * ACTIVE client, unset ones showing the inherited default.
 */
function BudgetSetup({ defaultMinutes }: { defaultMinutes: number }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<FleetBudget[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [onlySet, setOnlySet] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/time-tracking/budgets", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || `Failed (${r.status})`);
      setRows(d.clients || []);
    } catch (e: any) {
      setErr(e?.message || "Failed to load clients");
    }
  }, []);

  const save = async (clientLinkId: string) => {
    const raw = val.trim();
    if (raw !== "" && (!Number.isInteger(Number(raw)) || Number(raw) < 0)) {
      setErr("Budget must be a whole number of minutes (or blank to inherit the default).");
      return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/time-tracking/budgets/${clientLinkId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeBudgetMinutes: raw === "" ? null : Number(raw) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || d?.error || "Failed to save");
      setEditing(null);
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  const filtered = (rows || [])
    .filter((c) => (onlySet ? !c.budgetIsDefault : true))
    .filter((c) => (q ? c.clientName.toLowerCase().includes(q.toLowerCase()) : true));
  const customCount = (rows || []).filter((c) => !c.budgetIsDefault).length;

  return (
    <div className="rounded-xl border border-cardline bg-white overflow-hidden">
      <button
        onClick={() => { setOpen((o) => !o); if (!rows) void load(); }}
        className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-gray-50/60"
      >
        {open ? <ChevronDown size={14} className="text-ink-slate" /> : <ChevronRight size={14} className="text-ink-slate" />}
        <SlidersHorizontal size={14} className="text-teal" />
        <span className="text-sm font-bold text-navy">Monthly budgets</span>
        <span className="text-xs text-ink-slate">
          · every active client · {rows ? `${customCount} set, rest inherit ${formatDuration(defaultMinutes * 60)}` : "set the time each client should take"}
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-100">
          {err && <div className="mx-4 mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">{err}</div>}
          <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-slate pointer-events-none" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={rows === null ? "Loading clients…" : `Search ${rows.length} clients…`}
                className="w-full text-xs border border-gray-300 rounded-lg pl-8 pr-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-teal/40"
              />
            </div>
            <label className="inline-flex items-center gap-1.5 text-xs text-ink-slate cursor-pointer">
              <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} className="accent-teal" />
              Only clients with a custom budget
            </label>
          </div>
          <div className="max-h-[420px] overflow-auto divide-y divide-gray-50">
            {rows === null ? (
              <div className="px-4 py-6 text-center text-xs text-ink-slate">
                <Loader2 size={13} className="animate-spin inline mr-1.5" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-ink-slate">No matching clients.</div>
            ) : (
              filtered.map((c) => (
                <div key={c.clientLinkId} className="px-4 py-2 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-navy truncate">{c.clientName}</div>
                    {c.assignedBookkeeperName && (
                      <div className="text-[11px] text-ink-slate">{c.assignedBookkeeperName}</div>
                    )}
                  </div>
                  {editing === c.clientLinkId ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <input
                        autoFocus
                        value={val}
                        onChange={(e) => setVal(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void save(c.clientLinkId); if (e.key === "Escape") setEditing(null); }}
                        placeholder="min"
                        className="w-16 text-xs border border-gray-300 rounded px-1.5 py-1 text-right"
                      />
                      <button onClick={() => void save(c.clientLinkId)} disabled={busy} className="text-xs font-bold text-teal hover:underline disabled:opacity-50">
                        {busy ? "…" : "Save"}
                      </button>
                      <button onClick={() => setEditing(null)} className="text-xs text-ink-slate hover:text-navy">Cancel</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setEditing(c.clientLinkId); setVal(c.budgetIsDefault ? "" : String(c.budgetMinutes)); }}
                      className="group shrink-0 inline-flex items-center gap-1 text-xs text-ink-slate hover:text-navy"
                      title="Set this client's monthly time budget (blank inherits the default)"
                    >
                      <span className={c.budgetIsDefault ? "text-ink-slate" : "font-semibold text-navy"}>
                        {formatDuration(c.budgetMinutes * 60)}
                        {c.budgetIsDefault && " (default)"}
                      </span>
                      <Pencil size={10} className="opacity-0 group-hover:opacity-100" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-ink-slate">
            Blank inherits the {formatDuration(defaultMinutes * 60)} default. <span className="font-semibold">0</span> means every
            session on that client needs an explanation.
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One session, correctable in place. A forgotten pause banks lunch as billable
 * work; a mis-picked client bills the wrong month. Numbers people can't fix are
 * numbers they stop trusting — so admins edit the minutes or remove the session
 * right here. Removal marks it discarded (out of every report and budget check)
 * and keeps the row for the audit trail.
 */
function EntryLine({ entry, onChanged }: { entry: EntryRow; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [mins, setMins] = useState(String(Math.round(entry.seconds / 60)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/time-tracking/entries/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minutes: Number(mins) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setEditing(false);
      onChanged();
    } catch (e: any) {
      setErr(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(
      `Remove this ${formatDuration(entry.seconds)} session (${entry.userName})?\n\n` +
      `It comes out of the report and the client's budget. The record is kept in the audit log.`
    )) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/time-tracking/entries/${entry.id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onChanged();
    } catch (e: any) {
      setErr(e?.message || "Failed");
      setBusy(false);
    }
  };

  return (
    <div className="group flex items-center gap-2 text-xs text-ink-slate">
      <span className="w-[86px] shrink-0">
        {entry.endedAt ? new Date(entry.endedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"}
      </span>
      <span className="flex-1 truncate">{entry.userName}</span>
      {err && <span className="text-red-600 shrink-0 max-w-[160px] truncate" title={err}>{err}</span>}
      {editing ? (
        <span className="flex items-center gap-1 shrink-0">
          <input
            autoFocus
            value={mins}
            onChange={(e) => setMins(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
            className="w-14 text-xs border border-gray-300 rounded px-1.5 py-0.5 text-right"
          />
          <span className="text-ink-slate">min</span>
          <button onClick={() => void save()} disabled={busy} className="font-bold text-teal hover:underline disabled:opacity-50">
            {busy ? "…" : "Save"}
          </button>
          <button onClick={() => setEditing(false)} className="text-ink-slate hover:text-navy">Cancel</button>
        </span>
      ) : (
        <>
          <span className="font-mono shrink-0">{formatDuration(entry.seconds)}</span>
          <span className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => setEditing(true)} title="Correct the minutes" className="text-ink-slate hover:text-teal">
              <Pencil size={10} />
            </button>
            <button onClick={() => void remove()} disabled={busy} title="Remove this session from the numbers" className="text-ink-slate hover:text-rust disabled:opacity-50">
              <Trash2 size={10} />
            </button>
          </span>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" }) {
  return (
    <div className={`rounded-xl border bg-white px-4 py-3 ${tone === "warn" ? "border-amber-300" : "border-cardline"}`}>
      <div className="text-[11px] font-bold uppercase tracking-wide text-ink-slate">{label}</div>
      <div className={`text-xl font-bold mt-0.5 ${tone === "warn" ? "text-rust" : "text-navy"}`}>{value}</div>
      {sub && <div className="text-[11px] text-ink-slate mt-0.5">{sub}</div>}
    </div>
  );
}
