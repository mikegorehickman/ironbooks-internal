"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Filter,
  RefreshCw,
  Search,
  Users,
  Plug,
  Activity as ActivityIcon,
  TrendingDown,
} from "lucide-react";
import type {
  FleetSnapshot,
  FailedJob,
  StuckItem,
  IntegrationIssue,
  DriftItem,
  BookkeeperLoad,
  ActivityEvent,
  Severity,
} from "@/lib/fleet-health";

interface Bookkeeper {
  id: string;
  full_name: string;
}
interface Props {
  snapshot: FleetSnapshot;
  bookkeepers: Bookkeeper[];
  currentUserId: string;
  isSenior: boolean;
  activeFilters: {
    bookkeeperId: string | null;
    severity: Severity | null;
    search: string | null;
  };
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}
function fmtAge(value: number, unit: "h" | "d"): string {
  if (unit === "h") {
    if (value < 1) return "<1h";
    if (value < 24) return `${value}h`;
    return `${Math.floor(value / 24)}d`;
  }
  return value === 0 ? "today" : `${value}d`;
}

export function FleetDashboardClient({
  snapshot,
  bookkeepers,
  currentUserId,
  isSenior,
  activeFilters,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [searchInput, setSearchInput] = useState(activeFilters.search || "");

  /**
   * Push a single filter change to the URL — server re-renders the
   * page with the new snapshot. We use replace() so the back button
   * doesn't get cluttered with filter toggles.
   */
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    startTransition(() => {
      router.replace(`/fleet?${next.toString()}`);
    });
  }

  function clearFilters() {
    startTransition(() => {
      router.replace("/fleet");
    });
    setSearchInput("");
  }

  const totalIssues =
    snapshot.panel_a_job_failures.length +
    snapshot.panel_b_stuck_workflows.length +
    snapshot.panel_c_integration_health.length +
    snapshot.panel_d_pipeline_drift.length;

  return (
    <div className="space-y-5">
      {/* ── Header strip ── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiTile
          label="Active clients"
          value={snapshot.total_clients.toLocaleString()}
          icon={Users}
          color="text-navy"
          bg="bg-white"
        />
        <KpiTile
          label="Healthy"
          value={snapshot.healthy.toLocaleString()}
          icon={CheckCircle2}
          color="text-green-700"
          bg="bg-green-50 border-green-200"
        />
        <KpiTile
          label="Warning"
          value={snapshot.warning.toLocaleString()}
          icon={AlertTriangle}
          color="text-amber-700"
          bg="bg-amber-50 border-amber-200"
        />
        <KpiTile
          label="Failing"
          value={snapshot.failing.toLocaleString()}
          icon={AlertCircle}
          color="text-red-700"
          bg="bg-red-50 border-red-200"
        />
        <KpiTile
          label="$ at risk"
          value={fmtMoney(snapshot.total_dollars_at_risk)}
          icon={TrendingDown}
          color="text-navy"
          bg="bg-white"
        />
      </div>

      {/* ── Filter bar ── */}
      <div className="flex items-center gap-2 flex-wrap bg-white border border-gray-100 rounded-xl p-3">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search size={13} className="absolute left-2.5 top-2.5 text-ink-slate" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setParam("search", searchInput || null);
            }}
            placeholder="Search client name, error text…"
            className="w-full pl-8 pr-2 py-1.5 text-sm border border-gray-200 rounded-lg outline-none focus:border-teal"
          />
        </div>

        {isSenior && (
          <select
            value={activeFilters.bookkeeperId || ""}
            onChange={(e) => setParam("bookkeeper_id", e.target.value || null)}
            className="text-xs font-semibold border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white outline-none focus:border-teal"
          >
            <option value="">All bookkeepers</option>
            <option value={currentUserId}>My clients</option>
            {bookkeepers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.full_name}
              </option>
            ))}
          </select>
        )}

        <select
          value={activeFilters.severity || ""}
          onChange={(e) => setParam("severity", e.target.value || null)}
          className="text-xs font-semibold border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white outline-none focus:border-teal"
        >
          <option value="">All severities</option>
          <option value="failing">Failing only</option>
          <option value="warning">Warning only</option>
        </select>

        {(activeFilters.bookkeeperId ||
          activeFilters.severity ||
          activeFilters.search) && (
          <button
            onClick={clearFilters}
            className="text-xs font-semibold text-ink-slate hover:text-navy underline"
          >
            Clear filters
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-ink-light">
            {totalIssues} issue{totalIssues === 1 ? "" : "s"} ·{" "}
            {new Date(snapshot.generated_at).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
          <button
            onClick={() => router.refresh()}
            disabled={pending}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-50"
          >
            <RefreshCw size={12} className={pending ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Main grid: 5 panels + activity feed ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <div className="space-y-4">
          <PanelA failures={snapshot.panel_a_job_failures} />
          <PanelB stuck={snapshot.panel_b_stuck_workflows} />
          <PanelC integrations={snapshot.panel_c_integration_health} isSenior={isSenior} />
          <PanelD drift={snapshot.panel_d_pipeline_drift} />
          <PanelE workload={snapshot.panel_e_bookkeeper_workload} />
        </div>
        <ActivityRail events={snapshot.activity_feed} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  icon: Icon,
  color,
  bg,
}: {
  label: string;
  value: string;
  icon: any;
  color: string;
  bg: string;
}) {
  return (
    <div className={`rounded-xl border p-3.5 ${bg}`}>
      <div className="flex items-center gap-2">
        <Icon size={14} className={color} />
        <span className={`text-[10px] font-bold uppercase tracking-wider ${color}`}>
          {label}
        </span>
      </div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
    </div>
  );
}

function PanelShell({
  title,
  subtitle,
  count,
  accent,
  icon: Icon,
  children,
  emptyMessage,
  action,
}: {
  title: string;
  subtitle: string;
  count: number;
  accent: "red" | "amber" | "purple" | "blue" | "slate";
  icon: any;
  children: React.ReactNode;
  emptyMessage: string;
  action?: React.ReactNode;
}) {
  const palette = {
    red: { color: "text-red-700", bg: "bg-red-50", border: "border-red-200" },
    amber: {
      color: "text-amber-700",
      bg: "bg-amber-50",
      border: "border-amber-200",
    },
    purple: {
      color: "text-purple-700",
      bg: "bg-purple-50",
      border: "border-purple-200",
    },
    blue: { color: "text-blue-700", bg: "bg-blue-50", border: "border-blue-200" },
    slate: {
      color: "text-slate-700",
      bg: "bg-slate-50",
      border: "border-slate-200",
    },
  }[accent];
  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <div className={`px-4 py-3 border-b ${palette.border} ${palette.bg}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Icon size={14} className={palette.color} />
            <div className="min-w-0">
              <div className={`text-sm font-bold ${palette.color}`}>{title}</div>
              <div className="text-[11px] text-ink-slate leading-snug">
                {subtitle}
              </div>
            </div>
          </div>
          {action}
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded-full bg-white border ${palette.border} ${palette.color}`}
          >
            {count}
          </span>
        </div>
      </div>
      {count === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-ink-light italic">
          {emptyMessage}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function ClientCell({
  client,
  href,
}: {
  client: FailedJob["client"];
  href?: string;
}) {
  const content = (
    <div className="min-w-0">
      <div className="text-sm font-semibold text-navy truncate hover:text-teal">
        {client.name}
      </div>
      <div className="text-[10px] text-ink-slate truncate">
        {client.bookkeeper_name || "Unassigned"}
        {client.jurisdiction ? ` · ${client.jurisdiction}` : ""}
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {content}
    </Link>
  ) : (
    content
  );
}

function AgeBadge({ days, hours }: { days?: number; hours?: number }) {
  const value = hours ?? days ?? 0;
  const unit: "h" | "d" = hours != null ? "h" : "d";
  // Color escalates with age
  let color = "bg-gray-100 text-ink-slate";
  if (unit === "d") {
    if (value > 14) color = "bg-red-100 text-red-700";
    else if (value > 7) color = "bg-amber-100 text-amber-700";
  } else {
    if (value > 48) color = "bg-red-100 text-red-700";
    else if (value > 24) color = "bg-amber-100 text-amber-700";
  }
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded ${color}`}
    >
      <Clock size={9} />
      {fmtAge(value, unit)}
    </span>
  );
}

// ─── Panel A — Job failures ───
function PanelA({ failures }: { failures: FailedJob[] }) {
  return (
    <PanelShell
      title="A · Job failures"
      subtitle="Jobs that errored — re-run, investigate, or escalate"
      count={failures.length}
      accent="red"
      icon={AlertCircle}
      emptyMessage="No failed jobs in the last 90 days. ✓"
    >
      <div className="divide-y divide-gray-100">
        {failures.slice(0, 20).map((f) => (
          <div
            key={`${f.kind}:${f.job_id}`}
            className="px-4 py-2.5 hover:bg-red-50/40 transition-colors flex items-start gap-3"
          >
            <div className="w-40 flex-shrink-0">
              <ClientCell client={f.client} href={`/clients/${f.client.id}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-bold uppercase tracking-wider text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
                  {f.kind.replace(/_/g, " ")}
                </span>
                <AgeBadge hours={f.age_hours} />
              </div>
              <div
                className="text-[11px] text-ink-slate mt-1 leading-snug"
                title={f.error_message}
              >
                {f.error_message.length > 200
                  ? f.error_message.slice(0, 200) + "…"
                  : f.error_message}
              </div>
            </div>
          </div>
        ))}
        {failures.length > 20 && (
          <div className="px-4 py-2 text-center text-[11px] text-ink-light">
            + {failures.length - 20} more (filter or search to narrow)
          </div>
        )}
      </div>
    </PanelShell>
  );
}

// ─── Panel B — Stuck workflows ───
function PanelB({ stuck }: { stuck: StuckItem[] }) {
  return (
    <PanelShell
      title="B · Stuck workflows"
      subtitle="No errors, but sitting too long in intermediate states"
      count={stuck.length}
      accent="amber"
      icon={AlertTriangle}
      emptyMessage="Nothing stuck. ✓"
    >
      <div className="divide-y divide-gray-100">
        {stuck.slice(0, 20).map((s) => (
          <div
            key={`${s.kind}:${s.reference_id}`}
            className="px-4 py-2.5 hover:bg-amber-50/40 transition-colors flex items-start gap-3"
          >
            <div className="w-40 flex-shrink-0">
              <ClientCell client={s.client} href={`/clients/${s.client.id}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded">
                  {s.kind.replace(/_/g, " ")}
                </span>
                <AgeBadge days={s.age_days} />
              </div>
              <div className="text-[11px] text-ink-slate mt-1">{s.detail}</div>
            </div>
          </div>
        ))}
        {stuck.length > 20 && (
          <div className="px-4 py-2 text-center text-[11px] text-ink-light">
            + {stuck.length - 20} more
          </div>
        )}
      </div>
    </PanelShell>
  );
}

// ─── Panel C — Integration health ───
function PanelC({ integrations, isSenior }: { integrations: IntegrationIssue[]; isSenior: boolean }) {
  return (
    <PanelShell
      title="C · Integration health"
      subtitle="QBO tokens, Stripe links, bank rules — fix before they fail"
      action={
        isSenior ? (
          <Link
            href="/fleet/qbo-health"
            className="text-xs font-semibold text-teal hover:text-teal-dark"
          >
            QBO Connections →
          </Link>
        ) : undefined
      }
      count={integrations.length}
      accent="purple"
      icon={Plug}
      emptyMessage="All integrations healthy. ✓"
    >
      <div className="divide-y divide-gray-100">
        {integrations.slice(0, 20).map((i, idx) => (
          <div
            key={`${i.kind}:${i.client.id}:${idx}`}
            className="px-4 py-2.5 hover:bg-purple-50/40 transition-colors flex items-start gap-3"
          >
            <div className="w-40 flex-shrink-0">
              <ClientCell client={i.client} href={`/clients/${i.client.id}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                    i.kind === "qbo_token_expired"
                      ? "text-red-700 bg-red-100"
                      : "text-purple-700 bg-purple-100"
                  }`}
                >
                  {i.kind.replace(/_/g, " ")}
                </span>
                <AgeBadge days={i.age_days} />
              </div>
              <div className="text-[11px] text-ink-slate mt-1">{i.detail}</div>
              <div className="text-[10px] text-purple-700 mt-0.5 font-semibold">
                → {i.recommended_action}
              </div>
            </div>
          </div>
        ))}
        {integrations.length > 20 && (
          <div className="px-4 py-2 text-center text-[11px] text-ink-light">
            + {integrations.length - 20} more
          </div>
        )}
      </div>
    </PanelShell>
  );
}

// ─── Panel D — Pipeline drift ───
function PanelD({ drift }: { drift: DriftItem[] }) {
  return (
    <PanelShell
      title="D · Pipeline drift"
      subtitle="Onboarding stalled, books going stale, work not progressing"
      count={drift.length}
      accent="blue"
      icon={TrendingDown}
      emptyMessage="No drift detected. ✓"
    >
      <div className="divide-y divide-gray-100">
        {drift.slice(0, 20).map((d, idx) => (
          <div
            key={`${d.kind}:${d.client.id}:${idx}`}
            className="px-4 py-2.5 hover:bg-blue-50/40 transition-colors flex items-start gap-3"
          >
            <div className="w-40 flex-shrink-0">
              <ClientCell client={d.client} href={`/clients/${d.client.id}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-bold uppercase tracking-wider text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded">
                  {d.kind.replace(/_/g, " ")}
                </span>
                <AgeBadge days={d.age_days} />
              </div>
              <div className="text-[11px] text-ink-slate mt-1">{d.detail}</div>
            </div>
          </div>
        ))}
        {drift.length > 20 && (
          <div className="px-4 py-2 text-center text-[11px] text-ink-light">
            + {drift.length - 20} more
          </div>
        )}
      </div>
    </PanelShell>
  );
}

// ─── Panel E — Bookkeeper workload ───
function PanelE({ workload }: { workload: BookkeeperLoad[] }) {
  // Highlight bookkeepers with > 2× the median open-jobs count.
  const median = useMemo(() => {
    if (workload.length === 0) return 0;
    const sorted = [...workload].map((b) => b.open_jobs).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }, [workload]);

  return (
    <PanelShell
      title="E · Bookkeeper workload"
      subtitle="Who's drowning, who's idle — reshuffle assignments here"
      count={workload.length}
      accent="slate"
      icon={Users}
      emptyMessage="No bookkeepers with assigned clients."
    >
      <div className="divide-y divide-gray-100">
        {workload.map((b) => {
          const isOverloaded = median > 0 && b.open_jobs > median * 2;
          return (
            <div
              key={b.bookkeeper_id}
              className={`px-4 py-2.5 flex items-center gap-3 ${
                isOverloaded ? "bg-amber-50/60" : ""
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-navy flex items-center gap-2">
                  {b.bookkeeper_name}
                  {isOverloaded && (
                    <span className="text-[9px] font-bold text-amber-800 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded uppercase tracking-wider">
                      Over capacity
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-ink-slate mt-0.5">
                  {b.active_clients} client{b.active_clients === 1 ? "" : "s"} ·{" "}
                  {b.open_jobs} open job{b.open_jobs === 1 ? "" : "s"}
                  {b.failing_jobs > 0 && (
                    <>
                      {" "}
                      ·{" "}
                      <span className="text-red-700 font-semibold">
                        {b.failing_jobs} failing
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="text-xs font-mono text-ink-slate">
                {b.open_jobs}
              </div>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

// ─── Activity feed ───
function ActivityRail({ events }: { events: ActivityEvent[] }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden lg:sticky lg:top-4 h-fit">
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center gap-2">
          <ActivityIcon size={13} className="text-ink-slate" />
          <span className="text-sm font-bold text-navy">Recent activity</span>
        </div>
        <div className="text-[11px] text-ink-slate mt-0.5">
          Last {events.length} fleet events
        </div>
      </div>
      {events.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-ink-light italic">
          No recent activity.
        </div>
      ) : (
        <div className="divide-y divide-gray-100 max-h-[80vh] overflow-y-auto">
          {events.map((e, i) => (
            <div key={i} className="px-4 py-2 hover:bg-gray-50/60">
              <div className="text-[10px] text-ink-light">
                {new Date(e.occurred_at).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
                {e.user_name ? ` · ${e.user_name.split(" ")[0]}` : ""}
              </div>
              <div className="text-xs text-navy mt-0.5 leading-snug">
                {e.client_link_id ? (
                  <Link
                    href={`/clients/${e.client_link_id}`}
                    className="hover:text-teal"
                  >
                    {e.summary}
                    <ExternalLink
                      size={9}
                      className="inline ml-0.5 text-ink-light"
                    />
                  </Link>
                ) : (
                  e.summary
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
