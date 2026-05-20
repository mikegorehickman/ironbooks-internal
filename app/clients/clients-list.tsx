"use client";

import { useState, useMemo, Component, type ReactNode } from "react";
import { CommsTracker } from "./comms-tracker";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Search,
  MapPin,
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
} from "lucide-react";
import { CleanupReportModal } from "@/components/CleanupReportModal";

interface ClientRow {
  id: string;
  client_name: string;
  client_email: string | null;
  jurisdiction: "US" | "CA";
  state_province: string | null;
  status: "onboarding" | "active" | "behind" | "paused" | "churned";
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
  bookkeepers,
  currentUserId,
  canEdit,
}: {
  initialClients: ClientRow[];
  bookkeepers: Bookkeeper[];
  currentUserId: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [clients, setClients] = useState(initialClients);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all_active");
  const [assignmentFilter, setAssignmentFilter] = useState<string>("all");
  const [jurisdictionFilter, setJurisdictionFilter] = useState<string>("all");
  const [view, setView] = useState<"grid" | "table">("table");
  const [deleteTarget, setDeleteTarget] = useState<ClientRow | null>(null);

  // Filters
  const filtered = useMemo(() => {
    let r = clients;

    if (statusFilter === "all_active") {
      r = r.filter((c) => c.is_active && c.status !== "churned");
    } else if (statusFilter === "all") {
      // no filter
    } else if (statusFilter === "inactive") {
      r = r.filter((c) => !c.is_active || c.status === "churned");
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
  }, [clients, search, statusFilter, assignmentFilter, jurisdictionFilter, currentUserId]);

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
            style={{ gridTemplateColumns: "1.4fr 0.8fr 1fr 0.9fr 0.8fr 0.8fr 1fr 0.9fr 0.4fr" }}
          >
            <div>Client</div>
            <div>Status</div>
            <div>Double</div>
            <div>Assigned</div>
            <div>Last Cleanup</div>
            <div>Stats</div>
            <div>Quick Actions</div>
            <div>Stripe</div>
            <div></div>
          </div>

          {filtered.map((client) => (
            <RowErrorBoundary key={client.id} clientName={client.client_name || "Unknown"}>
              <ClientRow
                client={client}
                bookkeepers={bookkeepers}
                canEdit={canEdit}
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
  onUpdate,
  onDelete,
}: {
  client: ClientRow;
  bookkeepers: Bookkeeper[];
  canEdit: boolean;
  onUpdate: (updates: Partial<ClientRow>) => void;
  onDelete?: () => void;
}) {
  const statusCfg = STATUS_CONFIG[client.status];
  const StatusIcon = statusCfg.icon;

  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [assignMenuOpen, setAssignMenuOpen] = useState(false);
  const [pendingAssignee, setPendingAssignee] = useState<{ id: string; name: string } | null>(null);
  const [pendingDueDate, setPendingDueDate] = useState("");
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeCopied, setStripeCopied] = useState(false);
  const [stripeError, setStripeError] = useState("");
  const [reportOpen, setReportOpen] = useState(false);

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
      style={{ gridTemplateColumns: "1.4fr 0.8fr 1fr 0.9fr 0.8fr 0.8fr 1fr 0.9fr 0.4fr" }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="rounded-lg flex items-center justify-center font-bold text-sm flex-shrink-0 w-9 h-9 bg-teal-light text-teal">
          {(client.client_name || "?").charAt(0)}
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-sm text-navy truncate">{client.client_name}</div>
          <div className="text-xs text-ink-slate flex items-center gap-1">
            <MapPin size={10} />
            {client.jurisdiction}{client.state_province ? ` · ${client.state_province}` : ""}
          </div>
        </div>
      </div>

      <div className="relative">
        <button
          onClick={() => canEdit && setStatusMenuOpen(!statusMenuOpen)}
          disabled={!canEdit}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold disabled:cursor-default"
          style={{ color: statusCfg.color, backgroundColor: statusCfg.bg }}
        >
          <StatusIcon size={11} />
          {statusCfg.label}
          {canEdit && <ChevronDown size={10} />}
        </button>

        {statusMenuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setStatusMenuOpen(false)} />
            <div className="absolute left-0 top-full mt-1 z-20 rounded-lg shadow-lg overflow-hidden bg-white border border-gray-200 min-w-[140px]">
              {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
                const Icon = cfg.icon;
                return (
                  <button
                    key={key}
                    onClick={() => {
                      if (key !== client.status) onUpdate({ status: key as any });
                      setStatusMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-teal-lighter"
                    style={{ color: cfg.color }}
                  >
                    <Icon size={12} />
                    {cfg.label}
                    {key === client.status && <CheckCircle2 size={11} className="ml-auto" />}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Double column */}
      <div className="min-w-0">
        {client.double_client_id?.startsWith("pending_") ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200">
            Not matched
          </span>
        ) : (
          <div className="min-w-0">
            <div className="text-xs font-semibold text-navy truncate" title={client.double_client_name || ""}>
              {client.double_client_name || `ID ${client.double_client_id}`}
            </div>
            <div className="text-[10px] text-ink-slate">Linked</div>
          </div>
        )}
      </div>

      <div className="relative">
        <button
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
                const daysLeft = Math.ceil((new Date(client.due_date).getTime() - Date.now()) / 86400000);
                return (
                  <div className={`text-[10px] mt-0.5 font-medium ${
                    daysLeft < 0 ? "text-red-600" : daysLeft <= 1 ? "text-amber-600" : "text-ink-slate"
                  }`}>
                    {daysLeft < 0 ? `Overdue ${Math.abs(daysLeft)}d` : daysLeft === 0 ? "Due today" : daysLeft === 1 ? "Due tomorrow" : `Due ${new Date(client.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                  </div>
                );
              })()}
            </div>
          ) : (
            <span className="text-xs italic text-ink-light">Unassigned</span>
          )}
          {canEdit && <ChevronDown size={10} className="text-ink-light" />}
        </button>

        {assignMenuOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => { setAssignMenuOpen(false); setPendingAssignee(null); setPendingDueDate(""); }}
            />
            <div className="absolute left-0 top-full mt-1 z-20 rounded-lg shadow-lg bg-white border border-gray-200 min-w-[210px]">
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
                    Assign to {pendingAssignee.name}
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

      <div>
        {client.last_cleanup_at ? (
          <div>
            <div className="text-xs font-semibold text-navy">
              {formatRelativeDate(client.last_cleanup_at)}
            </div>
            <div className="text-[10px] text-ink-slate">
              {new Date(client.last_cleanup_at).toLocaleDateString()}
            </div>
          </div>
        ) : (
          <span className="text-xs italic text-ink-light">Never</span>
        )}
      </div>

      <div className="text-xs">
        <div className="flex items-center gap-3 text-ink-slate">
          <span title="Completed cleanups" className="flex items-center gap-1">
            <FileCheck size={11} />
            <span className="font-bold text-navy">{client.completed_cleanups}</span>
          </span>
          <span title="Active rules" className="flex items-center gap-1">
            <Zap size={11} />
            <span className="font-bold text-navy">{client.active_rules}</span>
          </span>
          {client.flagged_cleanups > 0 && (
            <span title="Flagged for review" className="flex items-center gap-1 text-yellow-600">
              <Flag size={11} />
              <span className="font-bold">{client.flagged_cleanups}</span>
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        {client.double_client_id?.startsWith("pending_") ? (
          <Link
            href={`/clients/${client.id}/match-double`}
            className="px-2 py-1 rounded text-[10px] font-semibold bg-red-600 hover:bg-red-700 text-white"
            title="Match this client to a Double HQ record"
          >
            Match
          </Link>
        ) : (
          <>
            <Link
              href={`/clients/${client.id}/match-double`}
              className="px-2 py-1 rounded text-[10px] font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200"
              title="Change the Double HQ match for this client"
            >
              Rematch
            </Link>
            {/* Continue an in-flight / errored cleanup. Shown only when the
                client has a resumable COA job (executing, in_review, failed,
                cancelled). The destination page handles whether to show the
                Execute button or the post-mortem with Revert/Report. */}
            {/* Defensive — verify shape and id before rendering. A malformed
                resumable_job (e.g. missing id) would otherwise render a
                link to /jobs/undefined which is harmless but cluttered. */}
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
                      : "bg-purple-100 text-purple-700 hover:bg-purple-200"
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
            <Link
              href={`/jobs/new?client=${client.id}`}
              className="px-2 py-1 rounded text-[10px] font-semibold bg-teal-light text-teal hover:bg-teal/20"
              title="New cleanup"
            >
              Clean
            </Link>
            <Link
              href={`/rules/new?client=${client.id}`}
              className="px-2 py-1 rounded text-[10px] font-semibold bg-teal-light text-teal hover:bg-teal/20"
              title="New rule discovery"
            >
              Rules
            </Link>
            <button
              onClick={() => setReportOpen(true)}
              className="inline-flex items-center gap-0.5 px-2 py-1 rounded text-[10px] font-semibold bg-navy/10 text-navy hover:bg-navy/15"
              title="Generate a branded cleanup-summary PDF for this client"
            >
              <FileText size={10} />
              Report
            </button>
          </>
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

      <div className="flex justify-end items-center gap-1">
        {client.jurisdiction === "CA" && (
          <Link
            href={`/tax-audit/${client.id}`}
            className="p-1.5 rounded hover:bg-teal-light text-ink-light hover:text-teal transition-colors"
            title="GST/HST Audit"
          >
            <Receipt size={13} />
          </Link>
        )}
        <a
          href={`https://app.qbo.intuit.com/app/account?cid=${client.qbo_realm_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1.5 rounded hover:bg-gray-100"
          title="Open in QuickBooks"
        >
          <ExternalLink size={13} className="text-ink-slate" />
        </a>
        {onDelete && (
          <button
            onClick={onDelete}
            className="p-1.5 rounded hover:bg-red-50 text-ink-light hover:text-red-600 transition-colors"
            title="Delete client"
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
    </div>
  );
}

function ClientCard({
  client,
  bookkeepers,
  canEdit,
  onUpdate,
  onDelete,
}: {
  client: ClientRow;
  bookkeepers: Bookkeeper[];
  canEdit: boolean;
  onUpdate: (updates: Partial<ClientRow>) => void;
  onDelete?: () => void;
}) {
  const statusCfg = STATUS_CONFIG[client.status];
  const StatusIcon = statusCfg.icon;

  return (
    <div className="rounded-xl bg-white border border-gray-200 p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="rounded-lg flex items-center justify-center font-bold text-base flex-shrink-0 w-10 h-10 bg-teal-light text-teal">
            {(client.client_name || "?").charAt(0)}
          </div>
          <div className="min-w-0">
            <div className="font-bold text-sm text-navy truncate">{client.client_name}</div>
            <div className="text-xs text-ink-slate flex items-center gap-1">
              <MapPin size={10} />
              {client.jurisdiction}{client.state_province ? ` · ${client.state_province}` : ""}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
            style={{ color: statusCfg.color, backgroundColor: statusCfg.bg }}
          >
            <StatusIcon size={9} />
            {statusCfg.label}
          </span>
          {client.jurisdiction === "CA" && (
            <Link
              href={`/tax-audit/${client.id}`}
              className="p-1 rounded hover:bg-teal-light text-ink-light hover:text-teal transition-colors"
              title="GST/HST Audit"
            >
              <Receipt size={13} />
            </Link>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="p-1 rounded hover:bg-red-50 text-ink-light hover:text-red-600 transition-colors"
              title="Delete client"
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
        <div className="flex items-center gap-1 mt-1">
          <span className="text-ink-light">Double:</span>
          {client.double_client_id?.startsWith("pending_") ? (
            <span className="font-semibold text-red-700">Not matched</span>
          ) : (
            <span className="font-semibold text-navy truncate" title={client.double_client_name || ""}>
              {client.double_client_name || `ID ${client.double_client_id}`}
            </span>
          )}
        </div>
        {client.last_cleanup_at && (
          <div className="flex items-center gap-1 mt-1">
            <Clock size={10} />
            Last cleanup {formatRelativeDate(client.last_cleanup_at)}
          </div>
        )}
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
        {client.double_client_id?.startsWith("pending_") ? (
          <Link
            href={`/clients/${client.id}/match-double`}
            className="flex-1 text-center px-3 py-1.5 rounded-md text-xs font-semibold bg-red-600 hover:bg-red-700 text-white"
          >
            Match Double →
          </Link>
        ) : (
          <>
            <Link
              href={`/jobs/new?client=${client.id}`}
              className="flex-1 text-center px-3 py-1.5 rounded-md text-xs font-semibold bg-teal hover:bg-teal-dark text-white"
            >
              New Cleanup
            </Link>
            <Link
              href={`/balance-sheet/${client.id}`}
              className="px-3 py-1.5 rounded-md text-xs font-semibold bg-teal-light text-teal hover:bg-teal/20"
              title="Balance Sheet cleanup — reconcile accounts, UF→A/R matching"
            >
              BS
            </Link>
            <Link
              href={`/rules/new?client=${client.id}`}
              className="px-3 py-1.5 rounded-md text-xs font-semibold bg-teal-light text-teal hover:bg-teal/20"
            >
              Rules
            </Link>
            <Link
              href={`/clients/${client.id}/match-double`}
              className="px-3 py-1.5 rounded-md text-xs font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200"
              title="Change the Double HQ match"
            >
              Rematch
            </Link>
          </>
        )}
      </div>
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
          <div className="p-2.5 rounded-lg bg-red-50">
            <Trash2 size={18} className="text-red-600" />
          </div>
          <div>
            <h2 className="text-base font-bold text-navy">Delete Client</h2>
            <p className="text-xs text-ink-slate mt-0.5">This action cannot be undone.</p>
          </div>
        </div>

        <p className="text-sm text-ink-slate mb-1">
          This will permanently delete <span className="font-semibold text-navy">{client.client_name}</span> and all
          associated jobs, rules, and history.
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
            className="flex-1 px-4 py-2 text-sm font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {deleting ? "Deleting..." : "Delete permanently"}
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
