"use client";

/**
 * One client's full activity trail — including what actually changed in
 * QuickBooks.
 *
 * The Activity tab used to render `fetchRecentActivity`, which filters
 * audit_log on `request_payload->>client_link_id` alone. Measured on one client
 * 2026-07-31: that finds 101 events where the trail holds 179, and none of the
 * 240 transaction repoints or 17 executed account actions — because those were
 * never audit_log rows at all. So the tab showed job summaries and called it
 * activity.
 *
 * This reads /api/clients/[id]/audit-trail, which merges all seven sources. The
 * two QBO-write sources are marked and can be isolated, because "what did we
 * change in their books" is a different question from "what did we do", and it
 * is the one people actually come here to answer.
 *
 * Data first, export second: the table is the artifact. CSV is offered beneath
 * it, once you can see what you would be exporting.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  RefreshCw,
  AlertTriangle,
  Pencil,
} from "lucide-react";

interface TrailEvent {
  id: string;
  source: string;
  occurred_at: string;
  event_type: string;
  label: string;
  category: string;
  user_id: string | null;
  user_name: string | null;
  summary: string;
  changed_books?: boolean;
  detail: Record<string, unknown> | null;
}

interface TrailResponse {
  client?: { id: string; name: string };
  counts?: {
    returned: number;
    by_source: Record<string, number>;
    qbo_writes: number;
    qbo_transaction_amount: number;
  };
  events?: TrailEvent[];
  next_cursor?: string | null;
  truncated?: string[];
  coverage_note?: string;
  error?: string;
}

const CATEGORIES: Array<{ key: string; label: string }> = [
  { key: "", label: "Everything" },
  { key: "transactions", label: "Transactions" },
  { key: "chart", label: "Chart of accounts" },
  { key: "recon", label: "Daily recon" },
  { key: "monthEnd", label: "Month end" },
  { key: "client", label: "Client comms" },
  { key: "access", label: "Access" },
  { key: "billing", label: "Billing" },
];

/** Sources whose events changed the client's QuickBooks. */
const WRITE_SOURCES = new Set(["qbo_transaction_write", "qbo_account_write"]);

const SOURCE_LABEL: Record<string, string> = {
  audit_log: "Audit log",
  qbo_transaction_write: "QBO · transaction",
  qbo_account_write: "QBO · account",
  reclass_job: "Reclass run",
  coa_job: "COA cleanup",
  daily_recon: "Daily recon",
  email: "Email",
};

export function AuditTimeline({ clientId }: { clientId: string }) {
  const [events, setEvents] = useState<TrailEvent[]>([]);
  const [meta, setMeta] = useState<TrailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [category, setCategory] = useState("");
  const [writesOnly, setWritesOnly] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");

  const buildParams = useCallback(
    (cursor?: string | null) => {
      const p = new URLSearchParams();
      if (category) p.set("category", category);
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      if (q.trim()) p.set("q", q.trim());
      if (cursor) p.set("cursor", cursor);
      return p;
    },
    [category, from, to, q]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/audit-trail?${buildParams()}`);
      const data: TrailResponse = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setEvents(data.events || []);
      setMeta(data);
    } catch (e: any) {
      // Surfaced, not swallowed. An empty timeline and a failed request look the
      // same to a reader, and only one of them means "nothing happened".
      setError(e?.message || "Could not load the trail");
      setEvents([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }, [clientId, buildParams]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!meta?.next_cursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/clients/${clientId}/audit-trail?${buildParams(meta.next_cursor)}`
      );
      const data: TrailResponse = await res.json();
      if (res.ok) {
        setEvents((prev) => [...prev, ...(data.events || [])]);
        setMeta(data);
      }
    } finally {
      setLoadingMore(false);
    }
  }

  const shown = writesOnly ? events.filter((e) => WRITE_SOURCES.has(e.source)) : events;
  const writeCount = events.filter((e) => WRITE_SOURCES.has(e.source)).length;

  function exportCSV() {
    const rows = [
      ["timestamp", "source", "event_type", "changed_quickbooks", "user", "what_changed", "detail"],
      ...shown.map((e) => [
        e.occurred_at,
        e.source,
        e.event_type,
        WRITE_SOURCES.has(e.source) ? "yes" : "no",
        e.user_name || "System",
        e.summary,
        JSON.stringify(e.detail ?? ""),
      ]),
    ];
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const name = (meta?.client?.name || "client").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    a.download = `audit-trail-${name}-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Grouped by calendar day so a cleanup session reads as one sitting rather
  // than 240 undifferentiated rows.
  const byDay: Array<[string, TrailEvent[]]> = [];
  for (const e of shown) {
    const day = (e.occurred_at || "").slice(0, 10);
    const last = byDay[byDay.length - 1];
    if (last && last[0] === day) last[1].push(e);
    else byDay.push([day, [e]]);
  }

  return (
    <div className="space-y-4">
      {/* ── Controls ─────────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            placeholder="Search accounts, vendors, events…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="flex-1 min-w-[200px] px-3 py-1.5 text-sm border border-gray-200 rounded-md text-navy outline-none focus:border-teal"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="px-3 py-1.5 border border-gray-200 rounded-md text-xs text-navy bg-white"
          >
            {CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="px-2 py-1.5 border border-gray-200 rounded-md text-xs text-navy"
            aria-label="From date"
          />
          <span className="text-xs text-ink-light">to</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="px-2 py-1.5 border border-gray-200 rounded-md text-xs text-navy"
            aria-label="To date"
          />
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 bg-navy text-white text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-navy-light disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            {loading ? "Loading" : "Refresh"}
          </button>
        </div>

        {/* The distinction that matters most, given one click. */}
        <div className="flex items-center gap-3 mt-3 pt-3 border-t border-gray-100 flex-wrap">
          <button
            onClick={() => setWritesOnly((v) => !v)}
            className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors ${
              writesOnly
                ? "bg-[#3E908D] text-white border-[#3E908D]"
                : "bg-white text-[#2F6F6C] border-[#3E908D]/40 hover:border-[#3E908D]"
            }`}
          >
            <Pencil size={11} />
            Changed QuickBooks only
            <span className={writesOnly ? "text-white/80" : "text-ink-light"}>({writeCount})</span>
          </button>
          {meta?.counts && (
            <span className="text-xs text-ink-slate">
              {meta.counts.qbo_writes} of {events.length} loaded events wrote to QuickBooks
              {meta.counts.qbo_transaction_amount > 0 && (
                <>
                  {" · "}
                  <span className="font-semibold text-navy">
                    $
                    {meta.counts.qbo_transaction_amount.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>{" "}
                  repointed
                </>
              )}
            </span>
          )}
        </div>
      </div>

      {/* ── Coverage + failures ─────────────────────────────────────────── */}
      {error && (
        <div className="rounded-lg border border-[#954E44]/40 bg-[#954E44]/8 px-4 py-3 flex items-start gap-2">
          <AlertTriangle size={14} className="text-[#954E44] mt-0.5 shrink-0" />
          <div className="text-xs text-[#7A3F37] leading-relaxed">
            <span className="font-semibold">Could not load the trail.</span> {error}
            <div className="mt-1">
              This is a load failure, not an empty history — do not read it as &ldquo;nothing
              happened&rdquo;.
            </div>
          </div>
        </div>
      )}

      {(meta?.truncated?.length || meta?.coverage_note) && !error && (
        <div className="rounded-lg border border-[#DAB461]/40 bg-[#DAB461]/10 px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-[#8A6D2F] mb-1">
            Coverage
          </div>
          {meta?.truncated?.map((t, i) => (
            <div key={i} className="text-xs text-[#6B5524] leading-relaxed font-semibold">
              {t}
            </div>
          ))}
          {meta?.coverage_note && (
            <div className="text-xs text-[#6B5524] leading-relaxed">{meta.coverage_note}</div>
          )}
        </div>
      )}

      {/* ── The trail ───────────────────────────────────────────────────── */}
      {loading && events.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-sm text-ink-slate">
          Loading the trail…
        </div>
      ) : shown.length === 0 && !error ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
          <p className="text-sm text-ink-slate">No events match these filters.</p>
          <p className="text-xs text-ink-light mt-1">
            {writesOnly
              ? "Nothing wrote to QuickBooks in this window. Clear the filter to see runs and comms."
              : "Widen the date range, or clear the category filter."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {byDay.map(([day, dayEvents]) => (
            <div key={day} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-2.5 bg-[#F5F7F9] border-b border-gray-200">
                <span className="text-xs font-bold uppercase tracking-wider text-navy">
                  {day
                    ? new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    : "Undated"}
                </span>
                <span className="text-[11px] text-ink-slate">
                  {dayEvents.length} event{dayEvents.length === 1 ? "" : "s"}
                  {dayEvents.some((e) => WRITE_SOURCES.has(e.source)) && (
                    <>
                      {" · "}
                      <span className="text-[#2F6F6C] font-semibold">
                        {dayEvents.filter((e) => WRITE_SOURCES.has(e.source)).length} wrote to QBO
                      </span>
                    </>
                  )}
                </span>
              </div>

              <div className="divide-y divide-gray-100">
                {dayEvents.map((e) => {
                  const isWrite = WRITE_SOURCES.has(e.source);
                  const open = expanded.has(e.id);
                  return (
                    <div key={e.id}>
                      <button
                        onClick={() => toggle(e.id)}
                        className={`w-full text-left px-5 py-2.5 hover:bg-[#FBFCFD] flex items-start gap-3 ${
                          isWrite ? "border-l-2 border-[#3E908D]" : "border-l-2 border-transparent"
                        }`}
                      >
                        <span className="text-ink-light mt-0.5 shrink-0">
                          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </span>
                        <span className="text-[11px] font-mono text-ink-light w-14 shrink-0 mt-0.5">
                          {new Date(e.occurred_at).toLocaleTimeString("en-US", {
                            hour12: false,
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-navy">{e.label}</span>
                            <span
                              className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                                isWrite
                                  ? "bg-[#3E908D]/12 text-[#2F6F6C]"
                                  : "bg-gray-100 text-ink-slate"
                              }`}
                            >
                              {SOURCE_LABEL[e.source] || e.source}
                            </span>
                          </span>
                          {/* The data, in the table — not behind a download. */}
                          <span className="block text-xs text-ink-slate mt-0.5 break-words">
                            {e.summary}
                          </span>
                        </span>
                        <span className="text-[11px] text-ink-slate shrink-0 text-right w-28 mt-0.5">
                          {e.user_name || "System"}
                        </span>
                      </button>

                      {open && (
                        <div className="px-5 pb-3 pl-[4.75rem] bg-[#FBFCFD]">
                          <div className="text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">
                            {e.event_type}
                          </div>
                          <pre className="bg-white border border-gray-200 rounded-md p-3 text-[11px] overflow-x-auto text-navy">
                            {JSON.stringify(e.detail, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Paging, then export ─────────────────────────────────────────── */}
      {meta?.next_cursor && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="w-full py-2.5 rounded-lg border border-gray-200 bg-white text-xs font-semibold text-navy hover:border-teal disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : "Load older events"}
        </button>
      )}

      {shown.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-[#F5F7F9] px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-xs text-ink-slate">
            <span className="font-semibold text-navy">{shown.length} events</span> shown above
            {meta?.next_cursor && " (more available — load them before exporting a full record)"}.
            Need it outside SNAP?
          </div>
          <button
            onClick={exportCSV}
            className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-semibold px-3 py-1.5 rounded-md shrink-0"
          >
            <Download size={12} />
            Export these {shown.length} as CSV
          </button>
        </div>
      )}
    </div>
  );
}
