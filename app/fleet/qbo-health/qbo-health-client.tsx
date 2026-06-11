"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  HelpCircle,
  Slash,
  RefreshCw,
  ExternalLink,
  Search,
  Zap,
  Clock,
  Users as UsersIcon,
  Loader2,
  ArrowRight,
} from "lucide-react";

export type HealthStatus =
  | "ok"
  | "invalid_grant"
  | "other_error"
  | "no_realm"
  | "never_connected"
  | "unknown";

export interface ClientHealthRow {
  client_link_id: string;
  client_name: string;
  qbo_realm_id: string | null;
  jurisdiction: string | null;
  state_province: string | null;
  bookkeeper_id: string | null;
  bookkeeper_name: string | null;
  client_created_at: string;
  status: HealthStatus;
  last_checked_at: string | null;
  error_message: string | null;
  last_ok_at: string | null;
  first_failed_at: string | null;
  reconnect_initiated_at: string | null;
  reconnect_initiated_by_name: string | null;
}

interface Props {
  rows: ClientHealthRow[];
  probeNeverRun: boolean;
}

const STATUS_CONFIG: Record<
  HealthStatus,
  {
    label: string;
    color: string;
    bg: string;
    border: string;
    icon: any;
    severity: number; // sort order: 0 = worst, higher = better
  }
> = {
  invalid_grant: {
    label: "Dead — needs re-auth",
    color: "text-red-700",
    bg: "bg-red-50",
    border: "border-red-300",
    icon: XCircle,
    severity: 0,
  },
  other_error: {
    label: "Error (re-probe)",
    color: "text-orange-700",
    bg: "bg-orange-50",
    border: "border-orange-300",
    icon: AlertTriangle,
    severity: 1,
  },
  never_connected: {
    label: "Never connected",
    color: "text-slate-700",
    bg: "bg-slate-50",
    border: "border-slate-300",
    icon: Slash,
    severity: 2,
  },
  unknown: {
    label: "Not yet probed",
    color: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-300",
    icon: HelpCircle,
    severity: 3,
  },
  no_realm: {
    label: "No QBO realm",
    color: "text-slate-700",
    bg: "bg-slate-50",
    border: "border-slate-300",
    icon: Slash,
    severity: 2,
  },
  ok: {
    label: "Healthy",
    color: "text-green-700",
    bg: "bg-green-50",
    border: "border-green-300",
    icon: CheckCircle2,
    severity: 10,
  },
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function hoursSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 3_600_000);
}

/** How long an initiated reconnect may sit incomplete before we call it stale. */
const RECONNECT_STALE_HOURS = 24;

function isDeadStatus(s: HealthStatus): boolean {
  return s === "invalid_grant" || s === "other_error";
}

/**
 * "Reconnect started" only means a consent link was opened — NOT that the
 * OAuth flow finished. If the client is still dead 24h+ after initiation,
 * the handshake was never completed and someone needs to chase it. This is
 * the state that let 25 dead connections masquerade as "in progress" for
 * three days in June 2026.
 */
function isStaleReconnect(r: ClientHealthRow): boolean {
  if (!isDeadStatus(r.status) || !r.reconnect_initiated_at) return false;
  return (hoursSince(r.reconnect_initiated_at) ?? 0) >= RECONNECT_STALE_HOURS;
}

function fmtAge(days: number | null): string {
  if (days === null) return "—";
  if (days === 0) return "today";
  if (days === 1) return "1d";
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

export function QboHealthClient({ rows: initialRows, probeNeverRun }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [pending, startTransition] = useTransition();
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string>("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<
    "all" | "dead" | "healthy" | "in_progress" | "incomplete"
  >("dead");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // KPIs
  const counts = useMemo(() => {
    const c = {
      total: rows.length,
      ok: 0,
      invalid_grant: 0,
      other_error: 0,
      never_connected: 0,
      unknown: 0,
      in_progress: 0, // initiated <24h ago, still dead — plausibly mid-flow
      incomplete: 0, // initiated 24h+ ago, STILL dead — handshake never finished
    };
    for (const r of rows) {
      if (r.status === "ok") c.ok++;
      else if (r.status === "invalid_grant") c.invalid_grant++;
      else if (r.status === "other_error") c.other_error++;
      else if (r.status === "never_connected" || r.status === "no_realm")
        c.never_connected++;
      else if (r.status === "unknown") c.unknown++;
      if (r.reconnect_initiated_at && isDeadStatus(r.status)) {
        if (isStaleReconnect(r)) c.incomplete++;
        else c.in_progress++;
      }
    }
    return c;
  }, [rows]);

  // Filtering
  const filtered = useMemo(() => {
    let r = rows;
    if (filter === "dead") {
      r = r.filter(
        (x) => x.status === "invalid_grant" || x.status === "other_error"
      );
    } else if (filter === "healthy") {
      r = r.filter((x) => x.status === "ok");
    } else if (filter === "in_progress") {
      r = r.filter((x) => x.reconnect_initiated_at !== null);
    } else if (filter === "incomplete") {
      r = r.filter((x) => isStaleReconnect(x));
    }
    if (search) {
      const s = search.toLowerCase();
      r = r.filter(
        (x) =>
          x.client_name.toLowerCase().includes(s) ||
          (x.bookkeeper_name || "").toLowerCase().includes(s) ||
          (x.error_message || "").toLowerCase().includes(s)
      );
    }
    // Sort: worst-status first; within status, longest-dead first.
    return [...r].sort((a, b) => {
      const sa = STATUS_CONFIG[a.status].severity;
      const sb = STATUS_CONFIG[b.status].severity;
      if (sa !== sb) return sa - sb;
      const aDays = daysSince(a.first_failed_at) ?? -1;
      const bDays = daysSince(b.first_failed_at) ?? -1;
      return bDays - aDays;
    });
  }, [rows, filter, search]);

  // ── Actions ──
  async function runProbe() {
    setProbing(true);
    setProbeError("");
    try {
      const res = await fetch("/api/fleet/qbo-health-check");
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      // Re-render the server component to pick up the new state.
      startTransition(() => router.refresh());
    } catch (e: any) {
      setProbeError(e?.message || "Probe failed");
    } finally {
      setProbing(false);
    }
  }

  async function markReconnectInitiated(ids: string[]) {
    if (ids.length === 0) return;
    // Optimistic
    const now = new Date().toISOString();
    setRows((prev) =>
      prev.map((r) =>
        ids.includes(r.client_link_id)
          ? { ...r, reconnect_initiated_at: now }
          : r
      )
    );
    try {
      await fetch("/api/fleet/qbo-health-check/mark-reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_ids: ids }),
      });
    } catch {
      // Non-fatal — UI already updated optimistically
    }
  }

  function openReconnect(row: ClientHealthRow) {
    markReconnectInitiated([row.client_link_id]);
    window.open(
      `/api/qbo/connect?client_link_id=${row.client_link_id}`,
      "_blank"
    );
  }

  function bulkReconnectSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (
      !confirm(
        `Open ${ids.length} OAuth tab${ids.length === 1 ? "" : "s"}? Each will land on Intuit's consent screen. Sign in once per client; this will take a while.`
      )
    ) {
      return;
    }
    markReconnectInitiated(ids);
    // Stagger window.opens slightly — some browsers block N simultaneous popups.
    for (let i = 0; i < ids.length; i++) {
      setTimeout(() => {
        window.open(`/api/qbo/connect?client_link_id=${ids[i]}`, "_blank");
      }, i * 250);
    }
    setSelected(new Set());
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllVisible() {
    const ids = filtered
      .filter(
        (r) => r.status === "invalid_grant" || r.status === "other_error"
      )
      .map((r) => r.client_link_id);
    setSelected(new Set(ids));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  // ── First-run UX ──
  if (probeNeverRun) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl p-10 text-center max-w-2xl mx-auto">
        <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-3">
          <Zap size={26} className="text-amber-700" />
        </div>
        <h2 className="text-lg font-bold text-navy">No probe results yet</h2>
        <p className="text-sm text-ink-slate mt-2 max-w-md mx-auto">
          Click below to actively test every active client&apos;s QBO refresh
          token. Takes 30-60 seconds for ~60 clients. The page will populate
          afterward and you&apos;ll be able to re-auth the dead ones.
        </p>
        {probeError && (
          <p className="text-xs text-red-700 mt-3">{probeError}</p>
        )}
        <button
          onClick={runProbe}
          disabled={probing}
          className="mt-5 inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
        >
          {probing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
          {probing ? "Probing every client…" : "Run probe now"}
        </button>
      </div>
    );
  }

  // ── Normal render ──
  const deadCount = counts.invalid_grant + counts.other_error;
  return (
    <div className="space-y-5">
      {/* THE alert that was missing in June 2026: reconnects that were started
          but never finished look "handled" while the client stays dead. */}
      {counts.incomplete > 0 && (
        <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4 flex items-start gap-3">
          <AlertTriangle size={20} className="text-red-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-bold text-red-800">
              {counts.incomplete} reconnect{counts.incomplete === 1 ? " was" : "s were"} started
              but never finished
            </div>
            <p className="text-xs text-red-700 mt-1 leading-relaxed">
              A consent link was opened 24+ hours ago, but the Intuit sign-in was never
              completed — these clients are <strong>still dead</strong>. Opening the link
              isn&apos;t enough: someone with QuickBooks access must finish the OAuth screen.
              Re-run the reconnect and confirm each turns healthy.
            </p>
          </div>
          <button
            onClick={() => setFilter("incomplete")}
            className="shrink-0 inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-3.5 py-2 rounded-lg"
          >
            Show them <ArrowRight size={11} />
          </button>
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiTile
          label="Total"
          value={counts.total.toString()}
          color="text-navy"
          bg="bg-white"
          icon={UsersIcon}
        />
        <KpiTile
          label="Healthy"
          value={counts.ok.toString()}
          color="text-green-700"
          bg="bg-green-50 border-green-200"
          icon={CheckCircle2}
        />
        <KpiTile
          label="Dead"
          value={deadCount.toString()}
          color="text-red-700"
          bg="bg-red-50 border-red-200"
          icon={XCircle}
        />
        <KpiTile
          label="Started, never finished"
          value={counts.incomplete.toString()}
          color="text-amber-800"
          bg="bg-amber-50 border-amber-300"
          icon={AlertTriangle}
        />
        <KpiTile
          label="Re-auth in progress (<24h)"
          value={counts.in_progress.toString()}
          color="text-blue-700"
          bg="bg-blue-50 border-blue-200"
          icon={Clock}
        />
        <KpiTile
          label="Never connected"
          value={(counts.never_connected + counts.unknown).toString()}
          color="text-slate-700"
          bg="bg-white"
          icon={Slash}
        />
      </div>

      {/* Action bar */}
      <div className="bg-white border border-gray-100 rounded-xl p-3 flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search size={13} className="absolute left-2.5 top-2.5 text-ink-slate" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search client, bookkeeper, error…"
            className="w-full pl-8 pr-2 py-1.5 text-sm border border-gray-200 rounded-lg outline-none focus:border-teal"
          />
        </div>

        <div className="flex items-center gap-1 text-xs font-semibold">
          <FilterPill
            label="Dead"
            active={filter === "dead"}
            onClick={() => setFilter("dead")}
            count={deadCount}
            color="red"
          />
          <FilterPill
            label="Never finished"
            active={filter === "incomplete"}
            onClick={() => setFilter("incomplete")}
            count={counts.incomplete}
            color="amber"
          />
          <FilterPill
            label="In progress"
            active={filter === "in_progress"}
            onClick={() => setFilter("in_progress")}
            count={counts.in_progress}
            color="blue"
          />
          <FilterPill
            label="Healthy"
            active={filter === "healthy"}
            onClick={() => setFilter("healthy")}
            count={counts.ok}
            color="green"
          />
          <FilterPill
            label="All"
            active={filter === "all"}
            onClick={() => setFilter("all")}
            count={counts.total}
            color="slate"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={runProbe}
            disabled={probing}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark border border-teal/30 hover:border-teal rounded-lg px-3 py-1.5 disabled:opacity-50"
          >
            {probing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            {probing ? "Probing…" : "Re-probe all"}
          </button>
        </div>
      </div>

      {probeError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800">
          <strong>Probe error:</strong> {probeError}
        </div>
      )}

      {/* Bulk action bar — only visible when something selected */}
      {selected.size > 0 && (
        <div className="bg-teal-lighter/60 border-2 border-teal/40 rounded-xl p-3 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-bold text-navy">
            {selected.size} selected
          </span>
          <button
            onClick={bulkReconnectSelected}
            className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-4 py-1.5 rounded-lg"
          >
            <Zap size={12} />
            Open {selected.size} reconnect tab{selected.size === 1 ? "" : "s"}
          </button>
          <button
            onClick={clearSelection}
            className="text-xs font-semibold text-ink-slate hover:text-navy underline"
          >
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100 text-[10px] font-bold uppercase tracking-wider text-ink-slate">
              <th className="w-10 px-3 py-2.5 text-left">
                <input
                  type="checkbox"
                  checked={
                    selected.size > 0 &&
                    selected.size ===
                      filtered.filter(
                        (r) =>
                          r.status === "invalid_grant" ||
                          r.status === "other_error"
                      ).length
                  }
                  onChange={(e) =>
                    e.target.checked ? selectAllVisible() : clearSelection()
                  }
                />
              </th>
              <th className="px-3 py-2.5 text-left">Client</th>
              <th className="px-3 py-2.5 text-left">Status</th>
              <th className="px-3 py-2.5 text-left">Dead for</th>
              <th className="px-3 py-2.5 text-left">Last checked</th>
              <th className="px-3 py-2.5 text-left">Bookkeeper</th>
              <th className="w-44 px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-sm text-ink-light italic">
                  No clients match the filter.
                </td>
              </tr>
            ) : (
              filtered.map((row) => {
                const cfg = STATUS_CONFIG[row.status];
                const Icon = cfg.icon;
                const isDead =
                  row.status === "invalid_grant" || row.status === "other_error";
                const isSelected = selected.has(row.client_link_id);
                const inProgress = !!row.reconnect_initiated_at;
                return (
                  <tr
                    key={row.client_link_id}
                    className={`hover:bg-gray-50/60 ${isSelected ? "bg-teal-lighter/40" : ""}`}
                  >
                    <td className="px-3 py-2.5">
                      {isDead && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelected(row.client_link_id)}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/clients/${row.client_link_id}`}
                        className="block group"
                      >
                        <div className="text-sm font-semibold text-navy group-hover:text-teal">
                          {row.client_name}
                        </div>
                        <div className="text-[10px] text-ink-slate truncate">
                          {row.jurisdiction || ""}
                          {row.state_province ? ` · ${row.state_province}` : ""}
                        </div>
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">
                      <div
                        className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${cfg.color} ${cfg.bg} border ${cfg.border} rounded-md px-2 py-0.5`}
                      >
                        <Icon size={11} />
                        {cfg.label}
                      </div>
                      {inProgress &&
                        (isStaleReconnect(row) ? (
                          <div className="mt-1 inline-flex items-center gap-1 rounded bg-amber-100 border border-amber-300 px-1.5 py-0.5 text-[10px] text-amber-900 font-bold">
                            <AlertTriangle size={10} />
                            Started {fmtAge(daysSince(row.reconnect_initiated_at))} ago
                            {row.reconnect_initiated_by_name
                              ? ` by ${row.reconnect_initiated_by_name.split(" ")[0]}`
                              : ""}{" "}
                            — never finished
                          </div>
                        ) : (
                          <div className="mt-1 text-[10px] text-blue-700 font-semibold inline-flex items-center gap-1">
                            <Clock size={10} />
                            Reconnect started {hoursSince(row.reconnect_initiated_at)}h ago
                            {row.reconnect_initiated_by_name
                              ? ` by ${row.reconnect_initiated_by_name.split(" ")[0]}`
                              : ""}
                          </div>
                        ))}
                      {row.error_message && (
                        <div
                          className="mt-1 text-[10px] text-ink-light truncate max-w-[280px]"
                          title={row.error_message}
                        >
                          {row.error_message.length > 80
                            ? row.error_message.slice(0, 80) + "…"
                            : row.error_message}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {isDead ? (
                        <span className="font-mono text-red-700 font-semibold">
                          {fmtAge(daysSince(row.first_failed_at))}
                        </span>
                      ) : (
                        <span className="text-ink-light">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-[11px] text-ink-slate">
                      {row.last_checked_at ? (
                        <>
                          {fmtAge(daysSince(row.last_checked_at))}
                          {row.last_ok_at && (
                            <div className="text-[10px] text-ink-light">
                              last ok: {fmtAge(daysSince(row.last_ok_at))} ago
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-light">never</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-[11px] text-ink-slate">
                      {row.bookkeeper_name || (
                        <span className="text-ink-light italic">unassigned</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {isDead || row.status === "never_connected" ? (
                        <button
                          onClick={() => openReconnect(row)}
                          className="inline-flex items-center gap-1 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded px-3 py-1.5"
                        >
                          <ExternalLink size={11} />
                          {row.status === "never_connected"
                            ? "Connect"
                            : "Reconnect"}
                          <ArrowRight size={10} />
                        </button>
                      ) : row.status === "ok" ? (
                        <span className="text-[10px] text-ink-light italic">
                          —
                        </span>
                      ) : (
                        <button
                          onClick={runProbe}
                          disabled={probing}
                          className="text-xs font-semibold text-teal hover:text-teal-dark"
                        >
                          Re-probe
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Help footer */}
      <div className="bg-blue-50/60 border border-blue-200 rounded-xl p-4 text-xs text-ink-slate leading-relaxed">
        <strong className="text-navy">How re-auth works:</strong> Click{" "}
        <strong>Reconnect</strong> on a dead row → opens Intuit&apos;s OAuth
        consent screen in a new tab. Sign in with the bookkeeper account
        that has accountant access to that client&apos;s QBO file, select
        the right company, click Connect. The token is rewritten in
        Supabase on callback; re-probe to confirm.{" "}
        <strong className="text-navy">Bulk re-auth:</strong> tick the
        checkboxes on multiple dead rows, then click the bulk button — N
        consent tabs open with a 250ms stagger. You&apos;ll click through
        each.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  color,
  bg,
  icon: Icon,
}: {
  label: string;
  value: string;
  color: string;
  bg: string;
  icon: any;
}) {
  return (
    <div className={`rounded-xl border p-3.5 ${bg}`}>
      <div className="flex items-center gap-1.5">
        <Icon size={13} className={color} />
        <span className={`text-[10px] font-bold uppercase tracking-wider ${color}`}>
          {label}
        </span>
      </div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
    </div>
  );
}

function FilterPill({
  label,
  count,
  active,
  onClick,
  color,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  color: "red" | "blue" | "green" | "slate" | "amber";
}) {
  const palette = {
    red: { active: "bg-red-600 text-white", hover: "hover:bg-red-50 text-red-700" },
    blue: { active: "bg-blue-600 text-white", hover: "hover:bg-blue-50 text-blue-700" },
    green: { active: "bg-green-600 text-white", hover: "hover:bg-green-50 text-green-700" },
    slate: { active: "bg-slate-700 text-white", hover: "hover:bg-slate-100 text-slate-700" },
    amber: { active: "bg-amber-600 text-white", hover: "hover:bg-amber-50 text-amber-800" },
  }[color];
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-md transition-colors ${
        active ? palette.active : `bg-white ${palette.hover}`
      }`}
    >
      {label}
      <span
        className={`ml-1 text-[10px] font-bold ${
          active ? "opacity-80" : "opacity-60"
        }`}
      >
        {count}
      </span>
    </button>
  );
}
