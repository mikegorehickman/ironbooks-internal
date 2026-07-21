"use client";

import { useState, useMemo, Component, useEffect, useRef, type ReactNode } from "react";
import { CommsTracker } from "./comms-tracker";
import { PyTaxesWidget } from "./py-taxes-widget";
import { LIFECYCLE_META, type LifecycleStatus } from "@/lib/client-lifecycle";
import { InReviewAccounts, type InReviewClient } from "./in-review-accounts";
import { StripeInviteSuggestions, type StripeInviteSuggestion } from "./stripe-invite-suggestions";
import { LifecyclePill } from "@/components/LifecyclePill";
import { ClientBadges } from "@/components/ClientBadges";
import type { AttentionState } from "@/lib/client-attention-state";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Search,
  MapPin,
  MessageCircle,
  ExternalLink,
  ChevronDown,
  Zap,
  Flag,
  FileCheck,
  Clock,
  AlertCircle,
  CheckCircle2,
  Pause,
  CircleSlash,
  Sparkles,
  User as UserIcon,
  Loader2,
  Building2,
  Trash2,
  FileText,
  Play,
  Receipt,
  Wallet,
  MoreHorizontal,
  Sparkle,
  FileSpreadsheet,
  RotateCcw,
  Eye,
  Flame,
  Mail,
  Link2,
  Send,
  Copy,
  Check,
  X,
  Archive,
} from "lucide-react";
import { CleanupReportModal } from "@/components/CleanupReportModal";

interface ClientRow {
  id: string;
  client_name: string;
  client_email: string | null;
  jurisdiction: "US" | "CA";
  state_province: string | null;
  status: "onboarding" | "active" | "behind" | "paused" | "churned";
  /** Precise lifecycle stage from deriveLifecycleStatus (V2) — preferred over
   *  the crude derivedStatus() badge when present. */
  lifecycle?: LifecycleStatus | null;
  is_active: boolean;
  qbo_realm_id: string;
  double_client_id: string;
  double_client_name: string | null;
  qbo_token_expires_at: string | null;
  created_at: string;
  assigned_bookkeeper_id: string | null;
  assigned_bookkeeper_name: string | null;
  assigned_bookkeeper_avatar: string | null;
  total_cleanups: number;
  completed_cleanups: number;
  active_cleanups: number;
  flagged_cleanups: number;
  active_rules: number;
  last_cleanup_at: string | null;
  stripe_connection_status: string | null;
  due_date: string | null;
  /** Most recent resumable COA cleanup job for this client (if any).
   *  Used by the Continue button. Null when the client has no active /
   *  failed / cancelled jobs. */
  resumable_job: { id: string; status: string } | null;
  // Comms tracker (Ask Client email / Stripe Connect / Cleanup PDF)
  // All optional — populated by the server when the columns exist.
  ask_client_email_created_at?: string | null;
  ask_client_email_sent_at?: string | null;
  ask_client_email_body?: string | null;
  stripe_request_created_at?: string | null;
  stripe_request_sent_confirmed_at?: string | null;
  stripe_not_required?: boolean;
  cleanup_completed_at?: string | null;
  cleanup_range_start?: string | null;
  cleanup_range_end?: string | null;
  cleanup_pdf_sent_at?: string | null;
  // Prior-year taxes filing status (migration 32)
  py_taxes_filed?: boolean;
  py_taxes_filed_through_year?: number | null;
  /** Macro-stage (lifecycle spine): onboarding | cleanup | production. */
  macroStage?: "onboarding" | "cleanup" | "production" | null;
  /** Folded-in filter flags (from the retired strips). */
  needs_review?: boolean;
  stripe_pending?: boolean;
  // Clients-table revamp columns
  qbo_connected?: boolean;
  daily_recon_enabled?: boolean;
  portal_account?: { has_account: boolean; logged_in: boolean; last_login_at: string | null };
  unread_from_client?: number;
}

/** Derived workflow status for the clients table — replaces the old
 *  editable status menu. Production = on daily recon; Overdue = past its
 *  cleanup due date and not yet in production; otherwise still in cleanup. */
function derivedStatus(c: ClientRow): { label: string; color: string; bg: string } {
  if (c.daily_recon_enabled) return { label: "In production", color: "#047857", bg: "#D1FAE5" };
  const today = new Date().toISOString().slice(0, 10);
  if (c.due_date && c.due_date.slice(0, 10) < today)
    return { label: "Overdue", color: "#B91C1C", bg: "#FEE2E2" };
  return { label: "Needs cleanup", color: "#B45309", bg: "#FEF3C7" };
}

interface Bookkeeper {
  id: string;
  full_name: string;
  avatar_url: string | null;
}

const STATUS_CONFIG: Record<string, { icon: any; color: string; bg: string; label: string }> = {
  onboarding: { icon: Sparkles, color: "#7C3AED", bg: "#EDE9FE", label: "Onboarding" },
  active: { icon: CheckCircle2, color: "#10B981", bg: "#D1FAE5", label: "Active" },
  behind: { icon: AlertCircle, color: "#DC2626", bg: "#FEE2E2", label: "Behind" },
  paused: { icon: Pause, color: "#F59E0B", bg: "#FEF3C7", label: "Paused" },
  churned: { icon: CircleSlash, color: "#94A3B8", bg: "#F1F5F9", label: "Churned" },
};

export function ClientsList({
  initialClients,
  initialStage = "all",
  bookkeepers,
  currentUserId,
  canEdit,
  inReviewClients = [],
  stripeSuggestions = [],
}: {
  initialClients: ClientRow[];
  initialStage?: "all" | "onboarding" | "cleanup" | "production";
  bookkeepers: Bookkeeper[];
  currentUserId: string;
  canEdit: boolean;
  /** Folded-in action panels — shown only when their filter pill is active. */
  inReviewClients?: InReviewClient[];
  stripeSuggestions?: StripeInviteSuggestion[];
}) {
  const router = useRouter();
  const [clients, setClients] = useState(initialClients);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all_active");
  const [stageFilter, setStageFilter] = useState<"all" | "onboarding" | "cleanup" | "production">(initialStage);
  const [assignmentFilter, setAssignmentFilter] = useState<string>("all");
  const [jurisdictionFilter, setJurisdictionFilter] = useState<string>("all");
  const [view, setView] = useState<"grid" | "table">("table");
  const [deleteTarget, setDeleteTarget] = useState<ClientRow | null>(null);
  // Attention feed (escalations / billing / BS owed / disconnected / stuck job)
  // — the fleet-scan + risk signals surfaced as row badges, replacing the
  // separate ManagerDashboard that used to carry them.
  const [attention, setAttention] = useState<Record<string, AttentionState>>({});
  useEffect(() => {
    fetch("/api/attention")
      .then((r) => (r.ok ? r.json() : { clients: {} }))
      .then((j) => setAttention(j.clients || {}))
      .catch(() => {});
  }, []);

  // Filters
  const filtered = useMemo(() => {
    let r = clients;

    if (stageFilter !== "all") {
      r = r.filter((c) => c.macroStage === stageFilter);
    }

    if (statusFilter === "all_active") {
      r = r.filter((c) => c.is_active && c.status !== "churned");
    } else if (statusFilter === "all") {
      // no filter
    } else if (statusFilter === "inactive") {
      r = r.filter((c) => !c.is_active || c.status === "churned");
    } else if (statusFilter === "in_review") {
      r = r.filter((c) => c.needs_review);
    } else if (statusFilter === "stripe") {
      r = r.filter((c) => c.stripe_pending);
    } else {
      r = r.filter((c) => c.status === statusFilter && c.is_active);
    }

    if (assignmentFilter === "me") {
      r = r.filter((c) => c.assigned_bookkeeper_id === currentUserId);
    } else if (assignmentFilter === "unassigned") {
      r = r.filter((c) => !c.assigned_bookkeeper_id);
    } else if (assignmentFilter !== "all") {
      r = r.filter((c) => c.assigned_bookkeeper_id === assignmentFilter);
    }

    if (jurisdictionFilter !== "all") {
      r = r.filter((c) => c.jurisdiction === jurisdictionFilter);
    }

    if (search) {
      const s = search.toLowerCase();
      r = r.filter(
        (c) =>
          c.client_name.toLowerCase().includes(s) ||
          c.client_email?.toLowerCase().includes(s) ||
          c.state_province?.toLowerCase().includes(s)
      );
    }

    return r;
  }, [clients, search, statusFilter, stageFilter, assignmentFilter, jurisdictionFilter, currentUserId]);

  // Stage pill counts (macro-stage spine).
  const stageCounts = useMemo(() => {
    const a = clients.filter((c) => c.is_active && c.status !== "churned");
    return {
      all: a.length,
      onboarding: a.filter((c) => c.macroStage === "onboarding").length,
      cleanup: a.filter((c) => c.macroStage === "cleanup").length,
      production: a.filter((c) => c.macroStage === "production").length,
    };
  }, [clients]);

  // Counts for filter pills
  const statusCounts = useMemo(() => {
    const active = clients.filter((c) => c.is_active);
    return {
      all_active: active.filter((c) => c.status !== "churned").length,
      onboarding: active.filter((c) => c.status === "onboarding").length,
      active: active.filter((c) => c.status === "active").length,
      behind: active.filter((c) => c.status === "behind").length,
      paused: active.filter((c) => c.status === "paused").length,
      flagged: clients.filter((c) => c.flagged_cleanups > 0).length,
      archived: clients.filter((c) => !c.is_active || c.status === "churned").length,
      in_review: clients.filter((c) => c.needs_review).length,
      stripe: clients.filter((c) => c.stripe_pending).length,
    };
  }, [clients]);

  async function updateClient(id: string, updates: Partial<ClientRow>) {
    // Optimistic
    setClients((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              ...updates,
              assigned_bookkeeper_name:
                updates.assigned_bookkeeper_id !== undefined
                  ? (bookkeepers || []).find((b) => b.id === updates.assigned_bookkeeper_id)?.full_name || null
                  : c.assigned_bookkeeper_name,
            }
          : c
      )
    );

    const res = await fetch(`/api/clients/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });

    if (!res.ok) {
      const { error } = await res.json();
      alert(`Update failed: ${error}`);
      // Roll back
      setClients(initialClients);
    }
    router.refresh();
  }

  async function deleteClient(id: string) {
    const res = await fetch(`/api/clients/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const { error } = await res.json();
      alert(`Delete failed: ${error}`);
      return;
    }
    setClients((prev) => prev.filter((c) => c.id !== id));
    setDeleteTarget(null);
  }

  return (
    <div>
      {/* Stage pills — the lifecycle spine (primary organizing dimension). */}
      <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-1">
        {([
          ["all", "All stages", stageCounts.all],
          ["onboarding", "Onboarding", stageCounts.onboarding],
          ["cleanup", "Cleanup", stageCounts.cleanup],
          ["production", "Production", stageCounts.production],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setStageFilter(key as any)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors ${
              stageFilter === key ? "bg-navy text-white" : "bg-white text-ink-slate border border-gray-200 hover:border-gray-300"
            }`}
          >
            {label}
            <span className={`text-xs ${stageFilter === key ? "text-white/70" : "text-ink-light"}`}>{count}</span>
          </button>
        ))}
      </div>

      {/* Status filter pills */}
      <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-1">
        <FilterPill
          label="My Clients"
          icon={UserIcon}
          active={assignmentFilter === "me"}
          onClick={() => setAssignmentFilter(assignmentFilter === "me" ? "all" : "me")}
        />
        <div className="w-px h-6 bg-gray-200 mx-1" />
        <StatusPill
          label="All Active"
          count={statusCounts.all_active}
          active={statusFilter === "all_active"}
          onClick={() => setStatusFilter("all_active")}
        />
        <StatusPill
          label="Onboarding"
          count={statusCounts.onboarding}
          active={statusFilter === "onboarding"}
          onClick={() => setStatusFilter("onboarding")}
          color="#7C3AED"
        />
        <StatusPill
          label="Active"
          count={statusCounts.active}
          active={statusFilter === "active"}
          onClick={() => setStatusFilter("active")}
          color="#10B981"
        />
        <StatusPill
          label="Behind"
          count={statusCounts.behind}
          active={statusFilter === "behind"}
          onClick={() => setStatusFilter("behind")}
          color="#DC2626"
        />
        <StatusPill
          label="Paused"
          count={statusCounts.paused}
          active={statusFilter === "paused"}
          onClick={() => setStatusFilter("paused")}
          color="#F59E0B"
        />
        {statusCounts.flagged > 0 && (
          <>
            <div className="w-px h-6 bg-gray-200 mx-1" />
            <StatusPill
              label="Flagged"
              count={statusCounts.flagged}
              active={false}
              onClick={() => {}}
              color="#F59E0B"
              icon={Flag}
            />
          </>
        )}
        {/* Folded-in strips: In Review + Stripe pending are now filter pills;
            their action panels render above the table only when active. */}
        {(statusCounts.in_review > 0 || statusCounts.stripe > 0) && (
          <div className="w-px h-6 bg-gray-200 mx-1" />
        )}
        {statusCounts.in_review > 0 && (
          <StatusPill
            label="In Review"
            count={statusCounts.in_review}
            active={statusFilter === "in_review"}
            onClick={() => setStatusFilter(statusFilter === "in_review" ? "all_active" : "in_review")}
            color="#7C3AED"
          />
        )}
        {statusCounts.stripe > 0 && (
          <StatusPill
            label="Stripe"
            count={statusCounts.stripe}
            active={statusFilter === "stripe"}
            onClick={() => setStatusFilter(statusFilter === "stripe" ? "all_active" : "stripe")}
            color="#635BFF"
          />
        )}
        {/* Archived — the dedicated store for inactivated clients. They're
            excluded from every other view; this is the only place they
            surface, each with a Reactivate button to bring them back. */}
        <div className="w-px h-6 bg-gray-200 mx-1" />
        <StatusPill
          label="Archived"
          count={statusCounts.archived}
          active={statusFilter === "inactive"}
          onClick={() => setStatusFilter(statusFilter === "inactive" ? "all_active" : "inactive")}
          color="#94A3B8"
          icon={Archive}
        />
      </div>

      {/* Search + secondary filters */}
      <div className="rounded-xl bg-white border border-gray-200 mb-4">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2 flex-1">
            <Search size={16} className="text-ink-light" />
            <input
              type="text"
              placeholder="Search by name, email, or state..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 px-2 py-1.5 text-sm outline-none text-navy"
            />
          </div>

          <select
            value={assignmentFilter}
            onChange={(e) => setAssignmentFilter(e.target.value)}
            className="px-3 py-1.5 border border-gray-200 rounded-md text-xs text-navy bg-white"
          >
            <option value="all">All bookkeepers</option>
            <option value="me">My clients</option>
            <option value="unassigned">Unassigned</option>
            <option disabled>──────────</option>
            {bookkeepers.map((b) => (
              <option key={b.id} value={b.id}>{b.full_name}</option>
            ))}
          </select>

          <select
            value={jurisdictionFilter}
            onChange={(e) => setJurisdictionFilter(e.target.value)}
            className="px-3 py-1.5 border border-gray-200 rounded-md text-xs text-navy bg-white"
          >
            <option value="all">All jurisdictions</option>
            <option value="US">🇺🇸 United States</option>
            <option value="CA">🇨🇦 Canada</option>
          </select>

          <div className="flex border border-gray-200 rounded-md overflow-hidden">
            <button
              onClick={() => setView("table")}
              className={`px-3 py-1.5 text-xs font-semibold ${
                view === "table" ? "bg-navy text-white" : "bg-white text-ink-slate hover:bg-gray-50"
              }`}
            >
              Table
            </button>
            <button
              onClick={() => setView("grid")}
              className={`px-3 py-1.5 text-xs font-semibold ${
                view === "grid" ? "bg-navy text-white" : "bg-white text-ink-slate hover:bg-gray-50"
              }`}
            >
              Grid
            </button>
          </div>
        </div>
      </div>

      {/* Folded-in action panels — the old always-on strips, now shown only
          when their filter pill is active. */}
      {statusFilter === "in_review" && inReviewClients.length > 0 && (
        <div className="mb-4">
          <InReviewAccounts clients={inReviewClients} canApprove={canEdit} />
        </div>
      )}
      {statusFilter === "stripe" && stripeSuggestions.length > 0 && (
        <div className="mb-4">
          <StripeInviteSuggestions suggestions={stripeSuggestions} />
        </div>
      )}

      <div className="text-xs text-ink-slate mb-3">
        {filtered.length} of {clients.length} clients
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="rounded-xl bg-white border border-gray-200 py-16 px-8 text-center">
          <Building2 size={32} className="text-ink-light mx-auto mb-3" />
          <h3 className="text-base font-bold text-navy mb-1">No clients match your filters</h3>
          <p className="text-sm text-ink-slate">Try adjusting the filters above, or connect a new client.</p>
        </div>
      )}

      {/* Table view */}
      {filtered.length > 0 && view === "table" && (
        <div className="rounded-xl overflow-hidden bg-white border border-gray-200">
          <div
            className="grid items-center px-5 py-3 text-xs font-bold uppercase tracking-wider bg-gray-50 text-ink-slate border-b border-gray-200"
            style={{ gridTemplateColumns: "1.7fr 1fr 1fr 0.9fr 0.9fr 1fr 0.7fr" }}
          >
            <div>Client</div>
            <div>Status</div>
            <div>Assigned</div>
            <div>Portal</div>
            <div>Stripe</div>
            <div>Actions</div>
            <div></div>
          </div>

          {filtered.map((client) => (
            <RowErrorBoundary key={client.id} clientName={client.client_name || "Unknown"}>
              <ClientRow
                client={client}
                bookkeepers={bookkeepers}
                canEdit={canEdit}
                attention={attention[client.id] ?? null}
                onUpdate={(updates) => updateClient(client.id, updates)}
                onDelete={canEdit ? () => setDeleteTarget(client) : undefined}
              />
            </RowErrorBoundary>
          ))}
        </div>
      )}

      {/* Grid view */}
      {filtered.length > 0 && view === "grid" && (
        <div className="grid grid-cols-3 gap-4">
          {filtered.map((client) => (
            <RowErrorBoundary key={client.id} clientName={client.client_name || "Unknown"}>
              <ClientCard
                client={client}
                bookkeepers={bookkeepers}
                canEdit={canEdit}
                attention={attention[client.id] ?? null}
                onUpdate={(updates) => updateClient(client.id, updates)}
                onDelete={canEdit ? () => setDeleteTarget(client) : undefined}
              />
            </RowErrorBoundary>
          ))}
        </div>
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          client={deleteTarget}
          onConfirm={() => deleteClient(deleteTarget.id)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

function FilterPill({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: any;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors flex-shrink-0 ${
        active
          ? "bg-teal text-white"
          : "bg-white text-ink-slate border border-gray-200 hover:border-gray-300"
      }`}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

function StatusPill({
  label,
  count,
  active,
  onClick,
  color,
  icon: Icon,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  color?: string;
  icon?: any;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors flex-shrink-0 ${
        active
          ? "bg-navy text-white"
          : "bg-white text-ink-slate border border-gray-200 hover:border-gray-300"
      }`}
    >
      {Icon && <Icon size={12} style={{ color: active ? "white" : color }} />}
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

function ClientRow({
  client,
  bookkeepers,
  canEdit,
  attention,
  onUpdate,
  onDelete,
}: {
  client: ClientRow;
  bookkeepers: Bookkeeper[];
  canEdit: boolean;
  attention?: AttentionState | null;
  onUpdate: (updates: Partial<ClientRow>) => void;
  onDelete?: () => void;
}) {
  const statusCfg = STATUS_CONFIG[client.status];
  const StatusIcon = statusCfg.icon;

  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [assignMenuOpen, setAssignMenuOpen] = useState(false);
  const [pendingAssignee, setPendingAssignee] = useState<{ id: string; name: string } | null>(null);
  const [pendingDueDate, setPendingDueDate] = useState("");
  // Fixed-position coords for the assign popover. position:absolute got
  // clipped by the table container's overflow-hidden on the last rows
  // (Lisa: "can't assign the last 2 clients, ran out of real estate").
  // Computing fixed coords off the trigger's rect escapes the clip and
  // lets us flip upward when there's no room below. Mirrors ActionsMenu.
  const assignBtnRef = useRef<HTMLButtonElement>(null);
  const [assignPos, setAssignPos] = useState<{
    top: number; left: number; openUpward: boolean; maxHeight: number;
  } | null>(null);

  useEffect(() => {
    if (!assignMenuOpen) { setAssignPos(null); return; }
    function compute() {
      const btn = assignBtnRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const PAD = 8;
      const MENU_W = 230;
      const TARGET_H = 340; // two-step menu's worst-case height
      const spaceBelow = vh - rect.bottom - PAD;
      const spaceAbove = rect.top - PAD;
      const openUpward = spaceBelow < TARGET_H && spaceAbove > spaceBelow;
      const left = Math.max(PAD, Math.min(rect.left, vw - MENU_W - PAD));
      setAssignPos({
        top: openUpward ? rect.top - 4 : rect.bottom + 4,
        left,
        openUpward,
        maxHeight: Math.max(180, (openUpward ? spaceAbove : spaceBelow)),
      });
    }
    compute();
    function onScrollResize() { setAssignMenuOpen(false); }
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    return () => {
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
    };
  }, [assignMenuOpen]);
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeCopied, setStripeCopied] = useState(false);
  const [stripeError, setStripeError] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  async function handleGenerateLink() {
    setStripeLoading(true);
    setStripeError("");
    try {
      const res = await fetch("/api/stripe-connect/generate-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: client.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      await navigator.clipboard.writeText(data.url);
      setStripeCopied(true);
      setTimeout(() => setStripeCopied(false), 2500);
    } catch (e: any) {
      setStripeError(e.message);
    } finally {
      setStripeLoading(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm(`Disconnect Stripe for ${client.client_name}?`)) return;
    setStripeLoading(true);
    setStripeError("");
    try {
      const res = await fetch("/api/stripe-connect/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: client.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      onUpdate({ stripe_connection_status: "not_set" } as any);
    } catch (e: any) {
      setStripeError(e.message);
    } finally {
      setStripeLoading(false);
    }
  }

  return (
    <div
      className={`grid items-center px-5 py-3 border-b border-gray-100 hover:bg-teal-lighter transition-colors ${
        !client.is_active ? "opacity-50" : ""
      }`}
      style={{ gridTemplateColumns: "1.7fr 1fr 1fr 0.9fr 0.9fr 1fr 0.7fr" }}
    >
      <Link
        href={`/clients/${client.id}`}
        className="flex items-center gap-3 min-w-0 group"
        title={`Open ${client.client_name || "client"} profile`}
      >
        <div className="min-w-0">
          <div className="font-semibold text-sm text-navy truncate group-hover:text-teal transition-colors">
            {client.client_name}
          </div>
          <div className="text-xs text-ink-slate flex items-center gap-1.5 flex-wrap">
            <span className="flex items-center gap-1">
              <MapPin size={10} />
              {client.jurisdiction}{client.state_province ? ` · ${client.state_province}` : ""}
            </span>
            {client.qbo_connected === false && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] font-bold text-red-700 bg-red-50 px-1.5 py-0.5 rounded"
                title="QuickBooks is disconnected — reconnect before any cleanup or recon can run"
              >
                <AlertCircle size={9} /> QBO disconnected
              </span>
            )}
          </div>
          {attention && (
            <div className="mt-1">
              <ClientBadges attention={attention} stage={client.macroStage || "dashboard"} max={3} />
            </div>
          )}
        </div>
      </Link>

      {/* Status — derived from where the client actually is in the
          workflow (no manual override). */}
      <div>
        {(() => {
          // Prefer the precise 11-stage lifecycle label (V2); fall back to the
          // legacy 3-label derivedStatus when lifecycle isn't supplied.
          if (client.lifecycle && LIFECYCLE_META[client.lifecycle]) {
            return <LifecyclePill status={client.lifecycle} />;
          }
          const ds = derivedStatus(client);
          return (
            <span
              className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold"
              style={{ color: ds.color, backgroundColor: ds.bg }}
            >
              {ds.label}
            </span>
          );
        })()}
      </div>

      <div className="relative">
        <button
          ref={assignBtnRef}
          onClick={() => canEdit && setAssignMenuOpen(!assignMenuOpen)}
          disabled={!canEdit}
          className="flex items-center gap-2 disabled:cursor-default"
        >
          {client.assigned_bookkeeper_name ? (
            <div>
              <div className="flex items-center gap-1.5">
                <div className="rounded-full flex items-center justify-center font-bold text-[10px] flex-shrink-0 w-6 h-6 bg-teal-light text-teal">
                  {client.assigned_bookkeeper_name.charAt(0)}
                </div>
                <span className="text-xs font-medium text-navy truncate">
                  {client.assigned_bookkeeper_name}
                </span>
              </div>
              {client.due_date && (() => {
                // due_date is a DATE ("YYYY-MM-DD"). new Date(str) parses it
                // as UTC midnight, which renders a day EARLY in US timezones
                // (set Jun 19 → showed Jun 18). Parse as LOCAL midnight by
                // appending a time component so the displayed day matches
                // what the bookkeeper picked.
                const due = new Date(`${client.due_date.slice(0, 10)}T00:00:00`);
                const startOfToday = new Date();
                startOfToday.setHours(0, 0, 0, 0);
                const daysLeft = Math.round((due.getTime() - startOfToday.getTime()) / 86400000);
                return (
                  <div className={`text-[10px] mt-0.5 font-medium ${
                    daysLeft < 0 ? "text-red-600" : daysLeft <= 1 ? "text-amber-600" : "text-ink-slate"
                  }`}>
                    {daysLeft < 0 ? `Overdue ${Math.abs(daysLeft)}d` : daysLeft === 0 ? "Due today" : daysLeft === 1 ? "Due tomorrow" : `Due ${due.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                  </div>
                );
              })()}
            </div>
          ) : (
            <span className="text-xs italic text-ink-light">Unassigned</span>
          )}
          {canEdit && <ChevronDown size={10} className="text-ink-light" />}
        </button>

        {assignMenuOpen && assignPos && (
          <>
            <div
              className="fixed inset-0 z-[60]"
              onClick={() => { setAssignMenuOpen(false); setPendingAssignee(null); setPendingDueDate(""); }}
            />
            <div
              className="fixed z-[61] rounded-lg shadow-lg bg-white border border-gray-200 w-[230px] overflow-hidden"
              style={{
                top: assignPos.top,
                left: assignPos.left,
                maxHeight: assignPos.maxHeight,
                transform: assignPos.openUpward ? "translateY(-100%)" : undefined,
              }}
            >
              {!pendingAssignee ? (
                // Step 1: pick bookkeeper
                <div className="overflow-y-auto max-h-[280px]">
                  <button
                    onClick={() => {
                      onUpdate({ assigned_bookkeeper_id: null, due_date: null } as any);
                      setAssignMenuOpen(false);
                    }}
                    className="w-full px-3 py-2 text-left text-xs italic text-ink-slate hover:bg-teal-lighter"
                  >
                    Unassign
                  </button>
                  {bookkeepers.map((b) => (
                    <button
                      key={b.id}
                      onClick={() => setPendingAssignee({ id: b.id, name: b.full_name })}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-teal-lighter text-navy"
                    >
                      <div className="rounded-full flex items-center justify-center font-bold text-[10px] flex-shrink-0 w-5 h-5 bg-teal-light text-teal">
                        {b.full_name.charAt(0)}
                      </div>
                      {b.full_name}
                      {b.id === client.assigned_bookkeeper_id && (
                        <CheckCircle2 size={11} className="ml-auto text-teal" />
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                // Step 2: set due date
                <div className="p-3">
                  <div className="text-xs font-semibold text-navy mb-1">
                    Set due date for {pendingAssignee.name}
                  </div>
                  <div className="text-[10px] text-ink-slate mb-1.5">
                    Due date <span className="text-red-500">*</span>
                  </div>
                  <input
                    type="date"
                    value={pendingDueDate}
                    min={new Date().toISOString().split("T")[0]}
                    onChange={(e) => setPendingDueDate(e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-md mb-2.5 focus:outline-none focus:ring-1 focus:ring-teal"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setPendingAssignee(null); setPendingDueDate(""); }}
                      className="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded-md hover:bg-gray-50"
                    >
                      Back
                    </button>
                    <button
                      onClick={() => {
                        if (!pendingDueDate) return;
                        onUpdate({ assigned_bookkeeper_id: pendingAssignee.id, due_date: pendingDueDate } as any);
                        setAssignMenuOpen(false);
                        setPendingAssignee(null);
                        setPendingDueDate("");
                      }}
                      disabled={!pendingDueDate}
                      className="flex-1 px-2 py-1.5 text-xs font-semibold bg-teal text-white rounded-md hover:bg-teal-dark disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Assign
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Portal — account state + unread inbound messages */}
      <div className="text-xs">
        {client.portal_account?.has_account ? (
          <div className="space-y-0.5">
            <div
              className="flex items-center gap-1 font-semibold"
              title={
                client.portal_account.last_login_at
                  ? `Last login: ${new Date(client.portal_account.last_login_at).toLocaleString()}`
                  : client.portal_account.logged_in
                  ? "Has logged in"
                  : "Invited — not logged in yet"
              }
            >
              {client.portal_account.logged_in ? (
                <>
                  <CheckCircle2 size={11} className="text-emerald-600" />
                  <span className="text-emerald-700">Active</span>
                </>
              ) : (
                <>
                  <Clock size={11} className="text-amber-600" />
                  <span className="text-amber-700">Invited</span>
                </>
              )}
            </div>
            {/* Stale-login flag: active client who hasn't logged in for 30+ days. */}
            {(() => {
              const ll = client.portal_account.last_login_at;
              if (!client.portal_account.logged_in || !ll) return null;
              const days = Math.floor((Date.now() - new Date(ll).getTime()) / 86400000);
              if (days < 30) return null;
              return (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded-full"
                  title={`No login in ${days} days — last on ${new Date(ll).toLocaleDateString()}. Consider a portal reminder.`}
                >
                  <Clock size={9} /> Idle {days}d
                </span>
              );
            })()}
            {(client.unread_from_client ?? 0) > 0 && (
              <Link
                href={`/clients/${client.id}/messages`}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-[10px] font-bold text-red-700 bg-red-50 px-1.5 py-0.5 rounded-full hover:bg-red-100"
                title={`${client.unread_from_client} unread message${client.unread_from_client === 1 ? "" : "s"} from the client`}
              >
                <MessageCircle size={9} /> {client.unread_from_client} unread
              </Link>
            )}
          </div>
        ) : (
          <span className="text-[11px] text-ink-light">No portal</span>
        )}
      </div>

      <div className="min-w-0">
        {client.stripe_connection_status === "connected" ? (
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-xs font-semibold text-emerald-700">
              <CheckCircle2 size={11} />
              Connected
            </div>
            <button
              onClick={handleDisconnect}
              disabled={stripeLoading}
              className="text-[10px] text-red-600 hover:text-red-800 underline disabled:opacity-50"
            >
              {stripeLoading ? "..." : "Disconnect"}
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            {client.stripe_connection_status === "pending" && (
              <div className="text-[10px] text-amber-600 font-semibold">Pending</div>
            )}
            <button
              onClick={handleGenerateLink}
              disabled={stripeLoading}
              className="text-[10px] font-semibold text-teal hover:underline disabled:opacity-50"
            >
              {stripeLoading ? <Loader2 size={10} className="animate-spin inline" /> : stripeCopied ? "Copied!" : "Copy Link"}
            </button>
          </div>
        )}
        {stripeError && (
          <div className="text-[10px] text-red-600 mt-0.5 truncate" title={stripeError}>
            {stripeError}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 flex-wrap">
          <>
            {/* Continue an in-flight / errored cleanup. Shown only when the
                client has a resumable COA job (executing, in_review, failed). */}
            {client.resumable_job &&
              typeof client.resumable_job === "object" &&
              typeof client.resumable_job.id === "string" &&
              client.resumable_job.id.length > 0 && (
                <Link
                  href={
                    client.resumable_job.status === "executing"
                      ? `/jobs/${client.resumable_job.id}/execute`
                      : `/jobs/${client.resumable_job.id}/review`
                  }
                  className={`inline-flex items-center gap-0.5 px-2 py-1 rounded text-[10px] font-semibold ${
                    client.resumable_job.status === "failed"
                      ? "bg-red-100 text-red-700 hover:bg-red-200"
                      : client.resumable_job.status === "executing"
                      ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                      : "bg-teal-light text-teal-dark hover:bg-teal-light"
                  }`}
                  title={
                    client.resumable_job.status === "failed"
                      ? "Failed cleanup — resume from where it errored (completed actions are skipped)"
                      : client.resumable_job.status === "executing"
                      ? "Cleanup is running right now — view live progress"
                      : "Cleanup in review — finish or execute"
                  }
                >
                  <Play size={10} />
                  Continue
                </Link>
              )}
            <ActionsDropdown
              clientId={client.id}
              jurisdiction={client.jurisdiction}
              isSenior={canEdit}
              onReport={() => setReportOpen(true)}
              onEmail={() => setEmailOpen(true)}
            />
          </>
      </div>

      <div className="flex justify-end items-center gap-1">
        <Link
          href={`/clients/${client.id}/messages`}
          onClick={(e) => e.stopPropagation()}
          className="p-1.5 rounded hover:bg-teal/10 text-ink-slate hover:text-teal-dark transition-colors"
          title={`Message ${client.client_name || "client"}`}
        >
          <MessageCircle size={13} />
        </Link>
        <a
          href={`https://app.qbo.intuit.com/app/account?cid=${client.qbo_realm_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1.5 rounded hover:bg-gray-100"
          title="Open in QuickBooks"
        >
          <ExternalLink size={13} className="text-ink-slate" />
        </a>
        {/* Reactivate — only visible on archived clients. Admin/lead-gated
            by the API (PATCH /api/clients/[id]). Bookkeepers will get a
            403 if they somehow click it. */}
        {!client.is_active && (
          <button
            onClick={() => onUpdate({ is_active: true } as any)}
            className="p-1.5 rounded hover:bg-green-50 text-ink-slate hover:text-green-600 transition-colors"
            title="Reactivate client"
          >
            <RotateCcw size={13} />
          </button>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            className="p-1.5 rounded hover:bg-amber-50 text-ink-light hover:text-amber-600 transition-colors"
            title="Archive client (reversible)"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {reportOpen && (
        <CleanupReportModal
          clientId={client.id}
          clientName={client.client_name}
          onClose={() => setReportOpen(false)}
        />
      )}
      {emailOpen && (
        <EmailClientModal
          clientId={client.id}
          clientName={client.client_name}
          isSenior={canEdit}
          onClose={() => setEmailOpen(false)}
        />
      )}
    </div>
  );
}

function ClientCard({
  client,
  bookkeepers,
  canEdit,
  onUpdate,
  onDelete,
  attention,
}: {
  client: ClientRow;
  bookkeepers: Bookkeeper[];
  canEdit: boolean;
  onUpdate: (updates: Partial<ClientRow>) => void;
  onDelete?: () => void;
  attention?: AttentionState | null;
}) {
  const statusCfg = STATUS_CONFIG[client.status];
  const StatusIcon = statusCfg.icon;
  const [emailOpen, setEmailOpen] = useState(false);

  return (
    <div className="rounded-xl bg-white border border-gray-200 p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <Link
          href={`/clients/${client.id}`}
          className="flex items-center gap-3 min-w-0 group"
          title={`Open ${client.client_name || "client"} profile`}
        >
          <div className="rounded-lg flex items-center justify-center font-bold text-base flex-shrink-0 w-10 h-10 bg-teal-light text-teal group-hover:bg-teal group-hover:text-white transition-colors">
            {(client.client_name || "?").charAt(0)}
          </div>
          <div className="min-w-0">
            <div className="font-bold text-sm text-navy truncate group-hover:text-teal transition-colors">
              {client.client_name}
            </div>
            <div className="text-xs text-ink-slate flex items-center gap-1">
              <MapPin size={10} />
              {client.jurisdiction}{client.state_province ? ` · ${client.state_province}` : ""}
            </div>
            {attention && (
              <div className="mt-1">
                <ClientBadges attention={attention} stage={client.macroStage || "dashboard"} max={3} />
              </div>
            )}
          </div>
        </Link>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
            style={{ color: statusCfg.color, backgroundColor: statusCfg.bg }}
          >
            <StatusIcon size={9} />
            {statusCfg.label}
          </span>
          <Link
            href={`/clients/${client.id}/messages`}
            onClick={(e) => e.stopPropagation()}
            className="p-1 rounded hover:bg-teal/10 text-ink-slate hover:text-teal-dark transition-colors"
            title={`Message ${client.client_name || "client"}`}
          >
            <MessageCircle size={13} />
          </Link>
          <ActionsDropdown
            clientId={client.id}
            jurisdiction={client.jurisdiction}
            isSenior={canEdit}
            onEmail={() => setEmailOpen(true)}
            compact
          />
          {!client.is_active && (
            <button
              onClick={() => onUpdate({ is_active: true } as any)}
              className="p-1 rounded hover:bg-green-50 text-ink-slate hover:text-green-600 transition-colors"
              title="Reactivate client"
            >
              <RotateCcw size={12} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="p-1 rounded hover:bg-red-50 text-ink-light hover:text-red-600 transition-colors"
              title="Archive client (reversible)"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 my-3 py-3 border-y border-gray-100">
        <CardStat icon={FileCheck} value={client.completed_cleanups} label="Cleanups" />
        <CardStat icon={Zap} value={client.active_rules} label="Rules" />
        <CardStat
          icon={Flag}
          value={client.flagged_cleanups}
          label="Flags"
          highlight={client.flagged_cleanups > 0}
        />
      </div>

      <div className="text-xs text-ink-slate mb-3">
        {client.assigned_bookkeeper_name ? (
          <div className="flex items-center gap-1.5">
            <div className="rounded-full flex items-center justify-center font-bold text-[10px] w-5 h-5 bg-teal-light text-teal">
              {client.assigned_bookkeeper_name.charAt(0)}
            </div>
            <span className="text-navy font-medium">{client.assigned_bookkeeper_name}</span>
          </div>
        ) : (
          <span className="italic">Unassigned</span>
        )}
        {client.last_cleanup_at && (
          <div className="flex items-center gap-1 mt-1">
            <Clock size={10} />
            Last cleanup {formatRelativeDate(client.last_cleanup_at)}
          </div>
        )}
      </div>

      {/* Prior-year taxes status — controls whether reclass should touch
          pre-filed years. Sits above the comms tracker for visibility. */}
      <div className="mb-2">
        <PyTaxesWidget
          clientLinkId={client.id}
          pyTaxesFiled={!!client.py_taxes_filed}
          pyTaxesFiledThroughYear={client.py_taxes_filed_through_year ?? null}
          compact
        />
      </div>

      {/* Comms trackers — Ask Client / Stripe / PDF */}
      <div className="mb-3">
        <CommsTracker
          compact
          data={{
            client_link_id: client.id,
            client_name: client.client_name,
            ask_client_email_created_at: client.ask_client_email_created_at ?? null,
            ask_client_email_sent_at: client.ask_client_email_sent_at ?? null,
            ask_client_email_body: client.ask_client_email_body ?? null,
            stripe_request_created_at: client.stripe_request_created_at ?? null,
            stripe_request_sent_confirmed_at:
              client.stripe_request_sent_confirmed_at ?? null,
            stripe_connection_status: client.stripe_connection_status ?? null,
            stripe_not_required: !!client.stripe_not_required,
            cleanup_completed_at: client.cleanup_completed_at ?? null,
            cleanup_range_start: client.cleanup_range_start ?? null,
            cleanup_range_end: client.cleanup_range_end ?? null,
            cleanup_pdf_sent_at: client.cleanup_pdf_sent_at ?? null,
          }}
        />
      </div>

      <div className="flex gap-2">
        <Link
          href={`/clients/${client.id}`}
          className="flex-1 text-center px-3 py-1.5 rounded-md text-xs font-semibold bg-teal hover:bg-teal-dark text-white"
        >
          Open client
        </Link>
      </div>
      {emailOpen && (
        <EmailClientModal
          clientId={client.id}
          clientName={client.client_name}
          isSenior={canEdit}
          onClose={() => setEmailOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Consolidated per-client action menu. Replaces the prior cluster of inline
 * buttons (Clean / Rules / Report / A/R Recovery / GST) so the row stays
 * readable as more tools land. Destructive actions and direct-to-QBO links
 * stay outside this menu (one-click value).
 *
 * Variants:
 *   - default (label "Actions")  — row view
 *   - compact                    — card view (icon-only trigger)
 */
function ActionsDropdown({
  clientId,
  jurisdiction,
  isSenior = false,
  onReport,
  onEmail,
  compact,
}: {
  clientId: string;
  jurisdiction: string;
  isSenior?: boolean;
  onReport?: () => void;
  onEmail?: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Viewport-anchored menu position. position:absolute (the previous
  // approach) gets clipped by the parent table's overflow:auto when the
  // button is on the last visible row. Computing fixed coords off the
  // button's getBoundingClientRect escapes every parent container and
  // lets us flip-to-upward when the menu won't fit below.
  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    openUpward: boolean;
    maxHeight: number;
  } | null>(null);

  // Approx height of the menu (10 items × ~32px + headers + padding).
  // We use a target height to decide flip; actual menu is bounded by
  // maxHeight so it scrolls instead of overflowing the viewport in
  // pathological cases.
  const MENU_TARGET_HEIGHT = 380;
  const MENU_WIDTH = 256;
  const VIEWPORT_PADDING = 8;

  function computePosition() {
    if (!buttonRef.current) return null;
    const rect = buttonRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const spaceBelow = vh - rect.bottom - VIEWPORT_PADDING;
    const spaceAbove = rect.top - VIEWPORT_PADDING;
    const openUpward = spaceBelow < MENU_TARGET_HEIGHT && spaceAbove > spaceBelow;
    // Right-align to the button; clamp so we never extend past the
    // left edge of the viewport on narrow screens.
    const left = Math.max(
      VIEWPORT_PADDING,
      Math.min(rect.right - MENU_WIDTH, vw - MENU_WIDTH - VIEWPORT_PADDING)
    );
    const maxHeight = openUpward ? spaceAbove : spaceBelow;
    return {
      top: openUpward ? rect.top - 4 : rect.bottom + 4,
      left,
      openUpward,
      maxHeight: Math.max(160, maxHeight),
    };
  }

  useEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    // Compute once on open. Re-compute on scroll/resize would be
    // nicer, but closing on either is simpler + matches typical
    // dropdown UX (user scrolls = they're moving on).
    setMenuPos(computePosition());
    function onClick(e: MouseEvent) {
      if (ref.current?.contains(e.target as Node)) return;
      // Menu is portaled out via position:fixed, so check both the
      // wrapper AND any element with our menu marker attribute.
      const target = e.target as HTMLElement;
      if (target.closest("[data-actions-menu]")) return;
      setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onScrollOrResize() {
      setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onEsc);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onEsc);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  const items: Array<{
    label: string;
    href?: string;
    onClick?: () => void;
    icon: any;
    section?: string;
    hidden?: boolean;
  }> = [
    {
      section: "Workflow",
      label: "Account cleanup",
      href: `/jobs/new?client=${clientId}`,
      icon: Sparkle,
    },
    {
      label: "Balance sheet cleanup",
      href: `/balance-sheet/${clientId}/cleanup`,
      icon: FileSpreadsheet,
    },
    {
      label: "Bank rules",
      href: `/rules/new?client=${clientId}`,
      icon: Zap,
    },
    {
      label: "Cleanup report (PDF)",
      onClick: onReport,
      icon: FileText,
      hidden: !onReport,
    },
    {
      section: "Tools",
      label: "COA editor",
      href: `/balance-sheet/${clientId}/coa`,
      icon: FileSpreadsheet,
      hidden: !isSenior,
    },
    {
      label: "Advanced cleanup",
      href: `/balance-sheet/${clientId}/hardcore-cleanup`,
      icon: Flame,
      hidden: !isSenior,
    },
    {
      section: "Compliance",
      label: "GST/HST audit",
      href: `/tax-audit/${clientId}`,
      icon: Receipt,
      hidden: jurisdiction !== "CA" || !isSenior,
    },
    {
      section: "Portal",
      label: "Email client",
      onClick: onEmail,
      icon: Mail,
      hidden: !onEmail,
    },
    {
      label: "View as client",
      onClick: async () => {
        try {
          const res = await fetch("/api/admin/impersonate/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_link_id: clientId }),
          });
          const body = await res.json();
          if (!res.ok) {
            if (body.code === "no_portal_user") {
              if (confirm(`${body.error}\n\nGo to invite page now?`)) {
                window.location.href = "/admin/invite-client";
              }
              return;
            }
            alert(body.error || "Could not start portal session");
            return;
          }
          window.location.href = body.redirect || "/portal";
        } catch (e: any) {
          alert(e?.message || "Could not start portal session");
        }
      },
      icon: Eye,
      hidden: !isSenior,
    },
  ];

  const visible = items.filter((i) => !i.hidden);

  // Translate the openUpward flag into a CSS transform so the menu's
  // bottom edge aligns to the button's top when flipped.
  const menuStyle = menuPos
    ? {
        position: "fixed" as const,
        top: menuPos.top,
        left: menuPos.left,
        width: MENU_WIDTH,
        maxHeight: menuPos.maxHeight,
        transform: menuPos.openUpward ? "translateY(-100%)" : undefined,
      }
    : undefined;

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className={
          compact
            ? "p-1 rounded hover:bg-slate-100 text-ink-light hover:text-navy transition-colors"
            : "inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold bg-teal-light text-teal hover:bg-teal/20"
        }
        title="Actions for this client"
      >
        {compact ? (
          <MoreHorizontal size={13} />
        ) : (
          <>
            Actions
            <ChevronDown size={10} />
          </>
        )}
      </button>
      {open && menuPos && (
        <div
          data-actions-menu
          style={menuStyle}
          className="bg-white border border-gray-200 rounded-lg shadow-xl z-[100] overflow-y-auto"
        >
          {visible.map((item, idx) => {
            const Icon = item.icon;
            const sectionLabel = item.section;
            const inner = (
              <>
                <Icon size={13} className="text-ink-slate flex-shrink-0" />
                <span className="flex-1 text-left">{item.label}</span>
              </>
            );
            return (
              <div key={idx}>
                {sectionLabel && (
                  <div className="px-3 pt-2 pb-1 text-[9px] font-bold text-ink-light uppercase tracking-wider border-t border-gray-100 first:border-t-0">
                    {sectionLabel}
                  </div>
                )}
                {item.href ? (
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2 px-3 py-2 text-xs text-navy hover:bg-slate-50"
                  >
                    {inner}
                  </Link>
                ) : (
                  <button
                    onClick={() => {
                      item.onClick?.();
                      setOpen(false);
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-navy hover:bg-slate-50"
                  >
                    {inner}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CardStat({
  icon: Icon,
  value,
  label,
  highlight,
}: {
  icon: any;
  value: number;
  label: string;
  highlight?: boolean;
}) {
  return (
    <div className="text-center">
      <div className="flex items-center justify-center gap-1 mb-0.5">
        <Icon size={11} className={highlight ? "text-yellow-600" : "text-ink-slate"} />
        <span
          className={`text-sm font-bold ${highlight ? "text-yellow-600" : "text-navy"}`}
        >
          {value}
        </span>
      </div>
      <div className="text-[10px] uppercase tracking-wider text-ink-light">{label}</div>
    </div>
  );
}

function DeleteConfirmModal({
  client,
  onConfirm,
  onCancel,
}: {
  client: ClientRow;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const match = typed.trim().toLowerCase() === client.client_name.trim().toLowerCase();

  async function handleConfirm() {
    if (!match) return;
    setDeleting(true);
    await onConfirm();
    setDeleting(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-md mx-4 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2.5 rounded-lg bg-amber-50">
            <Trash2 size={18} className="text-amber-600" />
          </div>
          <div>
            <h2 className="text-base font-bold text-navy">Archive client</h2>
            <p className="text-xs text-ink-slate mt-0.5">Removes them from the active list — reversible.</p>
          </div>
        </div>

        <p className="text-sm text-ink-slate mb-1">
          <span className="font-semibold text-navy">{client.client_name}</span> will be moved out of your active
          clients. Their jobs, rules, history, and portal data are <span className="font-semibold">kept</span>, and you
          can restore them anytime with the <span className="font-semibold">Reactivate</span> button.
        </p>

        <p className="text-sm text-ink-slate mt-4 mb-2">
          Type <span className="font-mono font-bold text-navy">{client.client_name}</span> to confirm:
        </p>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
          placeholder={client.client_name}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-300 mb-4"
        />

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!match || deleting}
            className="flex-1 px-4 py-2 text-sm font-semibold rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {deleting ? "Archiving..." : "Archive client"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Per-row error boundary. If any single ClientRow throws during render
 * (bad data, undefined property access, etc.), the row renders a small
 * red "failed to render" placeholder instead of crashing the whole page.
 * The error message is also logged to the browser console so we can
 * still diagnose, but the bookkeeper can still use the rest of the list.
 */
class RowErrorBoundary extends Component<
  { children: ReactNode; clientName: string },
  { hasError: boolean; error: Error | null }
> {
  state: { hasError: boolean; error: Error | null } = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error(
      `[clients-list] Row for "${this.props.clientName}" crashed:`,
      error,
      info
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="px-5 py-3 border-b border-red-100 bg-red-50 text-xs text-red-800 flex items-center justify-between gap-3">
          <span>
            <strong>{this.props.clientName}</strong> — couldn't render this row.{" "}
            <span className="text-red-600">
              {this.state.error?.message || "Unknown error"}
            </span>
          </span>
          <span className="text-[10px] text-red-600">Other rows still work; see console for details.</span>
        </div>
      );
    }
    return this.props.children;
  }
}

function formatRelativeDate(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  const days = Math.floor(seconds / 86400);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ───────────────────────── Email client modal ─────────────────────────
//
// One hub for every client-facing email a bookkeeper might want to
// (re)send: the "ask the client" transaction questions, a document /
// statement request, a fresh portal sign-in link, and the Stripe connect
// link. Each option expands in place; composed emails go out through the
// branded Resend sender at /api/clients/[id]/request-docs-email, and the
// portal link re-fires the Supabase magic-link invite.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmails(s: string): string[] {
  return s
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e));
}

/** Wrap plain body HTML in the Ironbooks branded email shell. */
function brandEmailHtml(title: string, bodyHtml: string): string {
  const navy = "#0F1F2E";
  const border = "#CBD5E1";
  const white = "#FFFFFF";
  return `<div style="font-family:'Figtree','Helvetica Neue',Helvetica,Arial,sans-serif;color:${navy};max-width:640px;margin:0 auto;background:${white};">
  <div style="background:${navy};color:${white};padding:18px 22px;border-radius:10px 10px 0 0;">
    <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${white};">Ironbooks</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-top:3px;letter-spacing:0.06em;text-transform:uppercase;">${title}</div>
  </div>
  <div style="border:1px solid ${border};border-top:none;padding:24px 22px;border-radius:0 0 10px 10px;background:${white};line-height:1.55;">
    ${bodyHtml}
  </div>
</div>`;
}

function EmailClientModal({
  clientId,
  clientName,
  isSenior = false,
  onClose,
}: {
  clientId: string;
  clientName: string;
  isSenior?: boolean;
  onClose: () => void;
}) {
  const [emailsLoading, setEmailsLoading] = useState(true);
  const [recipients, setRecipients] = useState("");
  const [hadPortalEmail, setHadPortalEmail] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Pull the client's active portal-user emails to prefill recipients.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/clients/${clientId}/request-docs-email`);
        const data = await res.json().catch(() => ({}));
        if (!cancelled) {
          const list: string[] = Array.isArray(data.emails) ? data.emails : [];
          setRecipients(list.join(", "));
          setHadPortalEmail(list.length > 0);
        }
      } catch {
        /* leave recipients empty — bookkeeper can type one */
      } finally {
        if (!cancelled) setEmailsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const to = parseEmails(recipients);

  const options: Array<{
    key: string;
    title: string;
    desc: string;
    icon: any;
  }> = [
    {
      key: "ask_client",
      title: "Ask the client about transactions",
      desc: "Draft questions about the flagged / uncategorized transactions from the latest reclass, then send.",
      icon: MessageCircle,
    },
    {
      key: "doc_request",
      title: "Request documents / statements",
      desc: "Compose a request for bank statements or anything else you need to finish the books.",
      icon: FileText,
    },
    {
      key: "portal_link",
      title: "Re-send portal sign-in link",
      desc: "Email the client a fresh magic link to log in to their portal.",
      icon: Mail,
    },
    {
      key: "stripe_link",
      title: "Stripe connection link",
      desc: "Generate a secure link for the client to connect their Stripe account.",
      icon: Link2,
    },
  ];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(15, 31, 46, 0.6)", backdropFilter: "blur(4px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-lg w-full flex flex-col relative max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between flex-shrink-0">
          <div>
            <h3 className="text-lg font-bold text-navy flex items-center gap-2">
              <Mail size={18} className="text-teal" />
              Email {clientName}
            </h3>
            <p className="text-xs text-ink-slate mt-1">
              Re-send any of the client-facing emails below. Each goes out with Ironbooks branding via Resend.
            </p>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto">
          {/* Recipients */}
          <div className="mb-4">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">
              Recipients
            </label>
            <input
              type="text"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder={emailsLoading ? "Loading portal email…" : "client@example.com"}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
            />
            <p className="text-[11px] text-ink-light mt-1">
              {emailsLoading
                ? "Looking up the client's portal email…"
                : hadPortalEmail
                ? "Prefilled from the client's portal account — edit or add more, comma-separated."
                : "No portal account on file yet — type an address, or invite them to the portal first."}
            </p>
          </div>

          <div className="space-y-2">
            {options.map((opt) => {
              const Icon = opt.icon;
              const isOpen = expanded === opt.key;
              return (
                <div
                  key={opt.key}
                  className={`rounded-xl border transition-colors ${
                    isOpen ? "border-teal/50 bg-teal-lighter" : "border-gray-200 bg-white hover:border-gray-300"
                  }`}
                >
                  <button
                    onClick={() => setExpanded(isOpen ? null : opt.key)}
                    className="w-full flex items-start gap-3 px-4 py-3 text-left"
                  >
                    <div className="p-2 rounded-lg bg-teal-light flex-shrink-0">
                      <Icon size={15} className="text-teal" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-navy">{opt.title}</div>
                      <div className="text-xs text-ink-slate mt-0.5">{opt.desc}</div>
                    </div>
                    <ChevronDown
                      size={16}
                      className={`text-ink-light flex-shrink-0 mt-1 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-4 pt-1 border-t border-teal/20">
                      {opt.key === "ask_client" && (
                        <AskClientEmailPanel clientId={clientId} recipients={to} />
                      )}
                      {opt.key === "doc_request" && (
                        <DocRequestEmailPanel clientId={clientId} clientName={clientName} recipients={to} />
                      )}
                      {opt.key === "portal_link" && (
                        <PortalLinkEmailPanel
                          clientId={clientId}
                          clientName={clientName}
                          recipients={to}
                          isSenior={isSenior}
                        />
                      )}
                      {opt.key === "stripe_link" && (
                        <StripeLinkEmailPanel clientId={clientId} recipients={to} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Shared little "Send" footer button + status line for composed emails. */
function SendBar({
  onSend,
  sending,
  sent,
  error,
  recipientCount,
  label = "Send email",
}: {
  onSend: () => void;
  sending: boolean;
  sent: boolean;
  error: string;
  recipientCount: number;
  label?: string;
}) {
  return (
    <div className="mt-3">
      {error && (
        <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">{error}</div>
      )}
      {sent ? (
        <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-green-700">
          <Check size={15} /> Sent to {recipientCount} recipient{recipientCount === 1 ? "" : "s"}
        </div>
      ) : (
        <button
          onClick={onSend}
          disabled={sending || recipientCount === 0}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
          title={recipientCount === 0 ? "Add a recipient first" : undefined}
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          {sending ? "Sending…" : label}
        </button>
      )}
    </div>
  );
}

function AskClientEmailPanel({ clientId, recipients }: { clientId: string; recipients: string[] }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [subject, setSubject] = useState("A few questions about your transactions");
  const [preview, setPreview] = useState<{ html: string; text: string; count: number; vendors: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function generate() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientId}/ask-client-email`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to generate the email");
      setPreview({
        html: data.email_html,
        text: data.email_text,
        count: data.transaction_count || 0,
        vendors: data.vendor_count || 0,
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    if (!preview) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientId}/request-docs-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: recipients, subject, html: preview.html, text: preview.text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Send failed");
      setSent(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  if (!preview) {
    return (
      <div>
        <p className="text-xs text-ink-slate mb-3">
          Pulls the flagged / low-confidence transactions from the most recent reclass and drafts a vendor-grouped
          question email you can review before sending.
        </p>
        {error && (
          <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">{error}</div>
        )}
        <button
          onClick={generate}
          disabled={loading}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkle size={14} />}
          {loading ? "Drafting…" : "Draft email"}
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs text-ink-slate mb-2">
        Draft covers <strong className="text-navy">{preview.count}</strong> transaction
        {preview.count === 1 ? "" : "s"} across <strong className="text-navy">{preview.vendors}</strong> vendor
        {preview.vendors === 1 ? "" : "s"}.
      </p>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">Subject</label>
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        className="w-full px-3 py-2 mb-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
      />
      <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">Preview</label>
      <div
        className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2"
        dangerouslySetInnerHTML={{ __html: preview.html }}
      />
      <SendBar
        onSend={send}
        sending={sending}
        sent={sent}
        error={error}
        recipientCount={recipients.length}
      />
    </div>
  );
}

function DocRequestEmailPanel({
  clientId,
  clientName,
  recipients,
}: {
  clientId: string;
  clientName: string;
  recipients: string[];
}) {
  const firstName = (clientName || "there").split(/[ ,]/)[0] || "there";
  const [subject, setSubject] = useState("Documents we need to finish your books");
  const [body, setBody] = useState(
    `Hi ${firstName},\n\nTo finish cleaning up your books, we need a few documents from you:\n\n• Bank statements for the period we're cleaning up\n• Credit card statements (if applicable)\n• Any loan or merchant-account statements\n\nReply to this email with the files attached, or upload them in your portal. Let us know if anything is hard to track down — happy to help.\n\nThanks,\nIronbooks`
  );
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function send() {
    setSending(true);
    setError("");
    try {
      const bodyHtml = body
        .split("\n")
        .map((line) => (line.trim() === "" ? "<br>" : escapeHtmlClient(line)))
        .join("<br>");
      const res = await fetch(`/api/clients/${clientId}/request-docs-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: recipients,
          subject,
          html: brandEmailHtml("Documents we need", bodyHtml),
          text: body,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Send failed");
      setSent(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">Subject</label>
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        className="w-full px-3 py-2 mb-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
      />
      <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">Message</label>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={9}
        className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy resize-y"
      />
      <SendBar onSend={send} sending={sending} sent={sent} error={error} recipientCount={recipients.length} />
    </div>
  );
}

function PortalLinkEmailPanel({
  clientId,
  clientName,
  recipients,
  isSenior,
}: {
  clientId: string;
  clientName: string;
  recipients: string[];
  isSenior: boolean;
}) {
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const [error, setError] = useState("");

  async function resend() {
    if (recipients.length === 0) {
      setError("Add a recipient email first.");
      return;
    }
    setSending(true);
    setError("");
    setResults([]);
    const msgs: string[] = [];
    for (const email of recipients) {
      try {
        const res = await fetch("/api/admin/invite-client", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, full_name: clientName, client_link_id: clientId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Failed");
        msgs.push(`✓ ${email} — ${data.message || "link sent"}`);
      } catch (e: any) {
        msgs.push(`✕ ${email} — ${e.message}`);
      }
    }
    setResults(msgs);
    setSending(false);
  }

  if (!isSenior) {
    return (
      <p className="text-xs text-ink-slate">
        Re-sending the portal sign-in link requires an admin or lead. Ask a senior teammate, or send the client a
        document request above in the meantime.
      </p>
    );
  }

  return (
    <div>
      <p className="text-xs text-ink-slate mb-3">
        Sends a fresh Supabase magic sign-in link to the recipient{recipients.length === 1 ? "" : "s"} above. Use this
        when a client says they can&apos;t find their original invite or it expired.
      </p>
      {error && (
        <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">{error}</div>
      )}
      {results.length > 0 && (
        <div className="mb-2 space-y-1">
          {results.map((r, i) => (
            <div key={i} className="text-xs text-navy">
              {r}
            </div>
          ))}
        </div>
      )}
      <button
        onClick={resend}
        disabled={sending || recipients.length === 0}
        className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
      >
        {sending ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
        {sending ? "Sending…" : "Re-send sign-in link"}
      </button>
    </div>
  );
}

function StripeLinkEmailPanel({ clientId, recipients }: { clientId: string; recipients: string[] }) {
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [emailed, setEmailed] = useState(false);

  async function generate() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/stripe-connect/generate-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to generate link");
      setUrl(data.url);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the URL is visible to select manually */
    }
  }

  async function emailLink() {
    setEmailing(true);
    setError("");
    try {
      const subject = "Connect your Stripe account";
      const text = `Hi,\n\nPlease connect your Stripe account so we can automatically reconcile your payments. Use this secure link (valid for 7 days):\n\n${url}\n\nThanks,\nIronbooks`;
      const html = brandEmailHtml(
        "Connect your Stripe account",
        `Please connect your Stripe account so we can automatically reconcile your payments. Use this secure link (valid for 7 days):<br><br><a href="${url}" style="color:#2D7A75;font-weight:600;">Connect Stripe →</a>`
      );
      const res = await fetch(`/api/clients/${clientId}/request-docs-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: recipients, subject, html, text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Send failed");
      setEmailed(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setEmailing(false);
    }
  }

  if (!url) {
    return (
      <div>
        <p className="text-xs text-ink-slate mb-3">
          Generates a one-time, 7-day Stripe Connect link. Already-connected clients can&apos;t be re-linked without
          disconnecting first.
        </p>
        {error && (
          <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">{error}</div>
        )}
        <button
          onClick={generate}
          disabled={loading}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
          {loading ? "Generating…" : "Generate link"}
        </button>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">
        Stripe connect link (valid 7 days)
      </label>
      <div className="flex items-center gap-2 mb-3">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-xs text-navy font-mono"
        />
        <button
          onClick={copy}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-xs font-semibold text-navy hover:bg-gray-50"
        >
          {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {error && (
        <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">{error}</div>
      )}
      {emailed ? (
        <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-green-700">
          <Check size={15} /> Link emailed to {recipients.length} recipient{recipients.length === 1 ? "" : "s"}
        </div>
      ) : (
        <button
          onClick={emailLink}
          disabled={emailing || recipients.length === 0}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
          title={recipients.length === 0 ? "Add a recipient to email the link" : undefined}
        >
          {emailing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          {emailing ? "Sending…" : "Email this link"}
        </button>
      )}
    </div>
  );
}

function escapeHtmlClient(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
