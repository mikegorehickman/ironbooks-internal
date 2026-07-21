"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import {
  Search,
  Download,
  FileCheck,
  Zap,
  Shuffle,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  MapPin,
  ArrowRight,
  Flag,
  Calendar,
  User as UserIcon,
} from "lucide-react";

interface UnifiedJob {
  id: string;
  type: "cleanup" | "rules" | "reclass";
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  bookkeeper_id: string;
  bookkeeper_name: string | null;
  client_link_id: string;
  client_name: string | null;
  client_jurisdiction: string | null;
  client_state: string | null;
  flagged: boolean;
  error_message: string | null;
  summary: Record<string, any>;
}

interface User { id: string; full_name: string }
interface Client { id: string; client_name: string }

const STATUS_CONFIG: Record<string, { color: string; bg: string; icon: any; label: string }> = {
  complete: { color: "#10B981", bg: "#D1FAE5", icon: CheckCircle2, label: "Complete" },
  complete_with_errors: { color: "#F59E0B", bg: "#FEF3C7", icon: AlertTriangle, label: "Complete (with errors)" },
  failed: { color: "#DC2626", bg: "#FEE2E2", icon: XCircle, label: "Failed" },
  executing: { color: "#2563EB", bg: "#DBEAFE", icon: Loader2, label: "Running" },
  cancelled: { color: "#94A3B8", bg: "#F1F5F9", icon: XCircle, label: "Cancelled" },
  draft: { color: "#94A3B8", bg: "#F1F5F9", icon: Clock, label: "Draft" },
  in_review: { color: "#F59E0B", bg: "#FEF3C7", icon: AlertTriangle, label: "In Review" },
  pending_lisa: { color: "#F59E0B", bg: "#FEF3C7", icon: Flag, label: "Pending Approval" },
  approved: { color: "#2D7A75", bg: "#E8F2F0", icon: CheckCircle2, label: "Approved" },
};

export function JobHistory({
  initialJobs,
  bookkeepers,
  clients,
  currentUserId,
}: {
  initialJobs: UnifiedJob[];
  bookkeepers: User[];
  clients: Client[];
  currentUserId: string;
}) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "cleanup" | "rules" | "reclass">("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [bookkeeperFilter, setBookkeeperFilter] = useState<string>("all");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<"all" | "today" | "week" | "month" | "quarter">("all");

  const filtered = useMemo(() => {
    let r = initialJobs;

    if (typeFilter !== "all") r = r.filter((j) => j.type === typeFilter);
    if (statusFilter !== "all") r = r.filter((j) => j.status === statusFilter);
    if (bookkeeperFilter === "me") r = r.filter((j) => j.bookkeeper_id === currentUserId);
    else if (bookkeeperFilter !== "all") r = r.filter((j) => j.bookkeeper_id === bookkeeperFilter);
    if (clientFilter !== "all") r = r.filter((j) => j.client_link_id === clientFilter);

    if (dateRange !== "all") {
      const now = Date.now();
      const ranges: Record<string, number> = {
        today: 86400_000,
        week: 7 * 86400_000,
        month: 30 * 86400_000,
        quarter: 90 * 86400_000,
      };
      const cutoff = now - ranges[dateRange];
      r = r.filter((j) => new Date(j.created_at).getTime() >= cutoff);
    }

    if (search) {
      const s = search.toLowerCase();
      r = r.filter(
        (j) =>
          j.client_name?.toLowerCase().includes(s) ||
          j.bookkeeper_name?.toLowerCase().includes(s) ||
          j.error_message?.toLowerCase().includes(s)
      );
    }

    return r;
  }, [initialJobs, typeFilter, statusFilter, bookkeeperFilter, clientFilter, dateRange, search, currentUserId]);

  // Summary stats for filtered view
  const stats = useMemo(() => {
    const complete = filtered.filter((j) => j.status === "complete");
    const failed = filtered.filter((j) => j.status === "failed");
    const totalDuration = complete.reduce((sum, j) => sum + (j.duration_seconds || 0), 0);
    const avgDuration = complete.length > 0 ? Math.round(totalDuration / complete.length) : 0;

    return {
      total: filtered.length,
      complete: complete.length,
      failed: failed.length,
      successRate: filtered.length > 0
        ? Math.round((complete.length / (complete.length + failed.length || 1)) * 100)
        : 0,
      avgDurationMin: avgDuration > 0 ? Math.round(avgDuration / 60) : 0,
    };
  }, [filtered]);

  function exportCSV() {
    const headers = [
      "timestamp",
      "type",
      "status",
      "client",
      "jurisdiction",
      "bookkeeper",
      "duration_seconds",
      "summary",
      "error",
    ];
    const rows = filtered.map((j) => [
      j.created_at,
      j.type,
      j.status,
      j.client_name || "",
      j.client_jurisdiction || "",
      j.bookkeeper_name || "",
      j.duration_seconds?.toString() || "",
      JSON.stringify(j.summary),
      j.error_message || "",
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ironbooks-job-history-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      {/* Stats row */}
      <div className="grid grid-cols-5 gap-3 mb-5">
        <StatCard label="Total Jobs" value={stats.total.toString()} color="#0F1F2E" />
        <StatCard label="Complete" value={stats.complete.toString()} color="#10B981" />
        <StatCard label="Failed" value={stats.failed.toString()} color={stats.failed > 0 ? "#DC2626" : "#94A3B8"} />
        <StatCard label="Success Rate" value={`${stats.successRate}%`} color="#2D7A75" />
        <StatCard label="Avg Duration" value={stats.avgDurationMin > 0 ? `${stats.avgDurationMin}m` : "—"} color="#7C3AED" />
      </div>

      {/* Type tabs */}
      <div className="flex items-center gap-2 mb-4">
        <TypeTab
          label="All Jobs"
          count={initialJobs.length}
          active={typeFilter === "all"}
          onClick={() => setTypeFilter("all")}
        />
        <TypeTab
          label="COA Cleanups"
          icon={FileCheck}
          count={initialJobs.filter((j) => j.type === "cleanup").length}
          active={typeFilter === "cleanup"}
          onClick={() => setTypeFilter("cleanup")}
        />
        <TypeTab
          label="Rule Discoveries"
          icon={Zap}
          count={initialJobs.filter((j) => j.type === "rules").length}
          active={typeFilter === "rules"}
          onClick={() => setTypeFilter("rules")}
        />
        <TypeTab
          label="Reclassifications"
          icon={Shuffle}
          count={initialJobs.filter((j) => j.type === "reclass").length}
          active={typeFilter === "reclass"}
          onClick={() => setTypeFilter("reclass")}
        />
      </div>

      {/* Filter bar */}
      <div className="rounded-xl bg-white border border-gray-200 mb-4">
        <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search size={16} className="text-ink-light" />
            <input
              type="text"
              placeholder="Search by client, bookkeeper, or error..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 px-2 py-1.5 text-sm outline-none text-navy"
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-1.5 border border-gray-200 rounded-md text-xs text-navy bg-white"
          >
            <option value="all">All statuses</option>
            <option value="complete">Complete</option>
            <option value="complete_with_errors">Complete (with errors)</option>
            <option value="executing">Running</option>
            <option value="failed">Failed</option>
            <option value="in_review">In Review</option>
            <option value="pending_lisa">Pending Approval</option>
            <option value="cancelled">Cancelled</option>
          </select>

          <select
            value={bookkeeperFilter}
            onChange={(e) => setBookkeeperFilter(e.target.value)}
            className="px-3 py-1.5 border border-gray-200 rounded-md text-xs text-navy bg-white"
          >
            <option value="all">All bookkeepers</option>
            <option value="me">My jobs</option>
            <option disabled>──────────</option>
            {bookkeepers.map((b) => (
              <option key={b.id} value={b.id}>{b.full_name}</option>
            ))}
          </select>

          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="px-3 py-1.5 border border-gray-200 rounded-md text-xs text-navy bg-white max-w-[180px]"
          >
            <option value="all">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.client_name}</option>
            ))}
          </select>

          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as any)}
            className="px-3 py-1.5 border border-gray-200 rounded-md text-xs text-navy bg-white"
          >
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="week">Last 7 days</option>
            <option value="month">Last 30 days</option>
            <option value="quarter">Last 90 days</option>
          </select>

          <button
            onClick={exportCSV}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-xs font-semibold px-3 py-1.5 rounded-md"
          >
            <Download size={12} />
            Export CSV
          </button>
        </div>
      </div>

      <div className="text-xs text-ink-slate mb-3">
        Showing {filtered.length} of {initialJobs.length} jobs
      </div>

      {/* Job table */}
      <div className="rounded-xl overflow-hidden bg-white border border-gray-200">
        <div
          className="grid items-center px-5 py-3 text-xs font-bold uppercase tracking-wider bg-gray-50 text-ink-slate border-b border-gray-200"
          style={{ gridTemplateColumns: "0.6fr 1.4fr 1.1fr 1fr 0.9fr 1.4fr 0.7fr" }}
        >
          <div>Type</div>
          <div>Client</div>
          <div>Bookkeeper</div>
          <div>Status</div>
          <div>Duration</div>
          <div>Summary</div>
          <div></div>
        </div>

        {filtered.length === 0 ? (
          <p className="py-12 text-center text-sm text-ink-slate">
            No jobs match your filters.
          </p>
        ) : (
          filtered.map((job) => <JobRow key={`${job.type}-${job.id}`} job={job} />)
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="p-4 rounded-xl bg-white border border-gray-200">
      <div className="text-2xl font-bold tracking-tight" style={{ color }}>
        {value}
      </div>
      <div className="text-xs mt-1 font-semibold text-ink-slate">{label}</div>
    </div>
  );
}

function TypeTab({
  label,
  count,
  active,
  onClick,
  icon: Icon,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  icon?: any;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold transition-colors ${
        active
          ? "bg-navy text-white"
          : "bg-white text-ink-slate border border-gray-200 hover:border-gray-300"
      }`}
    >
      {Icon && <Icon size={14} />}
      {label}
      <span
        className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
          active ? "bg-white/20 text-white" : "bg-gray-100 text-navy"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function JobRow({ job }: { job: UnifiedJob }) {
  const sc = STATUS_CONFIG[job.status] || STATUS_CONFIG.draft;
  const StatusIcon = sc.icon;
  const isRunning = job.status === "executing";

  // Route to appropriate page based on job type and status
  const detailHref =
    job.type === "cleanup"
      ? job.status === "executing" || job.status === "complete" || job.status === "failed"
        ? `/jobs/${job.id}/execute`
        : `/jobs/${job.id}/review`
      : job.type === "reclass"
      ? job.started_at
        ? `/reclass/${job.id}/execute`
        : `/reclass/${job.id}/review`
      : `/rules/${job.id}/review`;

  return (
    <div
      className="grid items-center px-5 py-3 border-b border-gray-100 hover:bg-teal-lighter transition-colors"
      style={{ gridTemplateColumns: "0.6fr 1.4fr 1.1fr 1fr 0.9fr 1.4fr 0.7fr" }}
    >
      <div className="flex items-center gap-2">
        {job.type === "cleanup" ? (
          <span title="COA Cleanup" className="flex items-center gap-1.5">
            <FileCheck size={14} className="text-teal" />
            <span className="text-xs font-semibold text-navy">COA</span>
          </span>
        ) : job.type === "reclass" ? (
          <span title="Reclassification" className="flex items-center gap-1.5">
            <Shuffle size={14} className="text-teal-dark" />
            <span className="text-xs font-semibold text-navy">
              {job.summary.is_rollback ? "Rollback" : "Reclass"}
            </span>
          </span>
        ) : (
          <span title="Bank Rule Discovery" className="flex items-center gap-1.5">
            <Zap size={14} className="text-yellow-600" />
            <span className="text-xs font-semibold text-navy">Rules</span>
          </span>
        )}
      </div>

      <div className="min-w-0">
        <div className="font-semibold text-sm text-navy truncate">
          {job.client_name || "Unknown client"}
        </div>
        <div className="text-xs text-ink-slate flex items-center gap-2">
          <span className="flex items-center gap-0.5">
            <MapPin size={9} />
            {job.client_jurisdiction}{job.client_state ? ` · ${job.client_state}` : ""}
          </span>
          <span className="flex items-center gap-0.5">
            <Calendar size={9} />
            {new Date(job.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 min-w-0">
        {job.bookkeeper_name ? (
          <>
            <div className="rounded-full flex items-center justify-center font-bold text-[10px] flex-shrink-0 w-6 h-6 bg-teal-light text-teal">
              {job.bookkeeper_name.charAt(0)}
            </div>
            <span className="text-xs text-navy truncate">{job.bookkeeper_name}</span>
          </>
        ) : (
          <span className="text-xs italic text-ink-light">—</span>
        )}
      </div>

      <div>
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
          style={{ color: sc.color, backgroundColor: sc.bg }}
        >
          <StatusIcon size={9} className={isRunning ? "animate-spin" : ""} />
          {sc.label}
        </span>
        {job.flagged && (
          <Flag size={11} className="inline ml-1 text-yellow-500" />
        )}
      </div>

      <div className="text-xs">
        {job.duration_seconds ? (
          <span className="font-semibold text-navy">
            {job.duration_seconds < 60
              ? `${job.duration_seconds}s`
              : `${Math.round(job.duration_seconds / 60)}m`}
          </span>
        ) : (
          <span className="italic text-ink-light">—</span>
        )}
      </div>

      <div className="text-xs text-ink-slate truncate">
        {job.type === "cleanup" ? (
          <SummaryCells
            cells={[
              { label: "renamed", value: job.summary.renamed },
              { label: "created", value: job.summary.created },
              { label: "deleted", value: job.summary.deleted },
              { label: "flagged", value: job.summary.flagged, highlight: !!job.summary.flagged },
              { label: "manual", value: job.summary.manual_cleanup ?? 0, highlight: !!job.summary.manual_cleanup },
              { label: "merges", value: job.summary.merges ?? 0, highlight: !!job.summary.merges },
            ]}
          />
        ) : job.type === "reclass" ? (
          <SummaryCells
            cells={[
              { label: "moved", value: job.summary.moved },
              { label: "auto", value: job.summary.auto },
              { label: "review", value: job.summary.review, highlight: !!job.summary.review },
              { label: "failed", value: job.summary.failed, highlight: !!job.summary.failed },
            ]}
          />
        ) : (
          <SummaryCells
            cells={[
              { label: "vendors", value: job.summary.vendors },
              { label: "suggested", value: job.summary.suggested },
              { label: "pushed", value: job.summary.pushed, highlight: !!job.summary.pushed },
            ]}
          />
        )}
      </div>

      <div className="flex justify-end">
        <Link
          href={detailHref}
          className="inline-flex items-center gap-1 text-xs font-semibold text-teal hover:text-teal-dark"
        >
          View <ArrowRight size={11} />
        </Link>
      </div>
    </div>
  );
}

function SummaryCells({
  cells,
}: {
  cells: { label: string; value: number; highlight?: boolean }[];
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {cells.map((c) => (
        <span
          key={c.label}
          className={c.highlight ? "text-yellow-600 font-bold" : ""}
        >
          <span className={`font-bold ${c.highlight ? "text-yellow-600" : "text-navy"}`}>
            {c.value}
          </span>
          <span className="ml-0.5 text-ink-light">{c.label}</span>
        </span>
      ))}
    </div>
  );
}
