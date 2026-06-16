"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import {
  Search,
  Check,
  X,
  Pencil,
  Loader2,
  Eye,
  UserPlus,
  ExternalLink,
} from "lucide-react";

export interface ClientRow {
  id: string;
  client_name: string;
  client_email: string | null;
  client_phone: string | null;
  status: string | null;
  is_active: boolean;
  assigned_bookkeeper_name: string | null;
  has_portal: boolean;
  portal_user_count: number;
  last_login_at: string | null;
  created_at: string | null;
}

const GRID = "2fr 1.7fr 1.2fr 0.9fr 1fr 1fr 0.8fr";

export function ClientsManagement({ clients }: { clients: ClientRow[] }) {
  const [rows, setRows] = useState(clients);
  const [query, setQuery] = useState("");
  const [portalOnly, setPortalOnly] = useState(false);
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [error, setError] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((c) => {
      if (portalOnly && !c.has_portal) return false;
      if (!q) return true;
      return (
        c.client_name?.toLowerCase().includes(q) ||
        (c.client_email || "").toLowerCase().includes(q) ||
        (c.client_phone || "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, portalOnly]);

  const portalTotal = useMemo(() => rows.filter((c) => c.has_portal).length, [rows]);

  async function saveField(id: string, field: "client_email" | "client_phone", value: string) {
    const res = await fetch(`/api/clients/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value || null }),
    });
    if (!res.ok) {
      const { error: msg } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(msg || "Save failed");
    }
    setRows((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value || null } : c)));
  }

  async function impersonate(client: ClientRow) {
    setError("");
    setImpersonating(client.id);
    try {
      const res = await fetch("/api/admin/impersonate/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: client.id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      // Hard-navigate so the impersonation cookie is honored next request.
      window.location.href = body.redirect || "/portal";
    } catch (e: any) {
      setError(`Couldn't open ${client.client_name}'s portal: ${e?.message || "unknown"}`);
      setImpersonating(null);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search clients by name, email, or phone…"
            className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
          />
        </div>

        {/* Portal-only filter */}
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm font-semibold">
          <button
            onClick={() => setPortalOnly(false)}
            className={`px-3 py-2 ${!portalOnly ? "bg-teal text-white" : "bg-white text-ink-slate hover:bg-gray-50"}`}
          >
            All clients
          </button>
          <button
            onClick={() => setPortalOnly(true)}
            className={`px-3 py-2 inline-flex items-center gap-1.5 ${portalOnly ? "bg-teal text-white" : "bg-white text-ink-slate hover:bg-gray-50"}`}
          >
            <Eye size={13} />
            Portal users only
            <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${portalOnly ? "bg-white/20" : "bg-gray-100"}`}>
              {portalTotal}
            </span>
          </button>
        </div>

        <Link
          href="/admin/invite-client"
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg whitespace-nowrap"
        >
          <UserPlus size={16} />
          Invite to portal
        </Link>
      </div>

      {error && (
        <div className="mb-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="rounded-xl overflow-hidden bg-white border border-gray-200">
        <div
          className="grid items-center px-5 py-3 text-xs font-bold uppercase tracking-wider bg-gray-50 text-ink-slate border-b border-gray-200"
          style={{ gridTemplateColumns: GRID }}
        >
          <div>Client</div>
          <div>Email</div>
          <div>Phone</div>
          <div>Status</div>
          <div>Portal</div>
          <div>Last login</div>
          <div></div>
        </div>

        {filtered.map((c) => (
          <div
            key={c.id}
            className={`grid items-center px-5 py-3.5 border-b border-gray-100 hover:bg-teal-lighter transition-colors ${
              !c.is_active ? "opacity-50" : ""
            }`}
            style={{ gridTemplateColumns: GRID }}
          >
            {/* Client */}
            <Link href={`/clients/${c.id}`} className="flex items-center gap-3 min-w-0 group">
              <div className="rounded-lg flex items-center justify-center font-bold text-sm flex-shrink-0 w-9 h-9 bg-navy/5 text-navy">
                {c.client_name?.charAt(0) || "?"}
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-sm text-navy truncate group-hover:underline flex items-center gap-1">
                  {c.client_name}
                  <ExternalLink size={11} className="opacity-0 group-hover:opacity-60 flex-shrink-0" />
                </div>
                {c.assigned_bookkeeper_name && (
                  <div className="text-xs text-ink-slate truncate">BK: {c.assigned_bookkeeper_name}</div>
                )}
              </div>
            </Link>

            {/* Email — inline editable */}
            <EditableCell
              value={c.client_email}
              placeholder="Add email"
              type="email"
              onSave={(v) => saveField(c.id, "client_email", v)}
            />

            {/* Phone — inline editable */}
            <EditableCell
              value={c.client_phone}
              placeholder="Add phone"
              type="tel"
              onSave={(v) => saveField(c.id, "client_phone", v)}
            />

            {/* Status */}
            <div>
              <StatusBadge status={c.status} isActive={c.is_active} />
            </div>

            {/* Portal */}
            <div>
              {c.has_portal ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-green-50 text-green-700">
                  <Eye size={12} />
                  In portal
                  {c.portal_user_count > 1 && <span className="opacity-70">×{c.portal_user_count}</span>}
                </span>
              ) : (
                <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-gray-100 text-ink-slate">
                  No portal
                </span>
              )}
            </div>

            {/* Last login */}
            <div className="text-xs text-ink-slate" title={c.last_login_at || ""}>
              {formatLastLogin(c.last_login_at)}
            </div>

            {/* Actions */}
            <div className="flex justify-end">
              {c.has_portal ? (
                <button
                  onClick={() => impersonate(c)}
                  disabled={impersonating === c.id}
                  title="Open this client's portal as them"
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark border border-teal/30 hover:border-teal px-2.5 py-1.5 rounded-lg disabled:opacity-50"
                >
                  {impersonating === c.id ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
                  Impersonate
                </button>
              ) : (
                <Link
                  href="/admin/invite-client"
                  title="No portal login yet — invite one"
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy border border-gray-200 px-2.5 py-1.5 rounded-lg"
                >
                  <UserPlus size={12} />
                  Invite
                </Link>
              )}
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <p className="py-12 text-center text-sm text-ink-slate">
            {portalOnly
              ? "No clients with a portal login match your search."
              : "No clients match your search."}
          </p>
        )}
      </div>
    </div>
  );
}

function EditableCell({
  value,
  placeholder,
  type,
  onSave,
}: {
  value: string | null;
  placeholder: string;
  type: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const [saving, setSaving] = useState(false);

  async function commit() {
    if (draft === (value || "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch (e: any) {
      alert(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 pr-2">
        <input
          autoFocus
          type={type}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(value || "");
              setEditing(false);
            }
          }}
          disabled={saving}
          className="min-w-0 flex-1 px-2 py-1 border border-teal rounded-md text-sm outline-none text-navy"
        />
        <button onClick={commit} disabled={saving} className="p-1 text-green-600 hover:bg-green-50 rounded">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
        </button>
        <button
          onClick={() => {
            setDraft(value || "");
            setEditing(false);
          }}
          disabled={saving}
          className="p-1 text-ink-slate hover:bg-gray-100 rounded"
        >
          <X size={13} />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="group flex items-center gap-1.5 text-left min-w-0 pr-2 py-1"
      title="Click to edit"
    >
      {value ? (
        <span className="text-sm text-navy truncate">{value}</span>
      ) : (
        <span className="text-sm text-ink-light italic">{placeholder}</span>
      )}
      <Pencil size={11} className="text-ink-light opacity-0 group-hover:opacity-100 flex-shrink-0" />
    </button>
  );
}

/** Compact last-portal-login label: "Today" / "Yesterday" / "3d ago" /
 *  "Mar 14" for older, "Never" when the client has never signed in. */
function formatLastLogin(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Never";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function StatusBadge({ status, isActive }: { status: string | null; isActive: boolean }) {
  if (!isActive) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold bg-gray-100 text-ink-slate">
        Archived
      </span>
    );
  }
  const cfg: Record<string, { color: string; bg: string }> = {
    onboarding: { color: "#7C3AED", bg: "#EDE9FE" },
    active: { color: "#2D7A75", bg: "#E8F2F0" },
    behind: { color: "#B45309", bg: "#FEF3C7" },
    paused: { color: "#475569", bg: "#F1F5F9" },
    churned: { color: "#B91C1C", bg: "#FEE2E2" },
  };
  const s = status || "active";
  const c = cfg[s] || cfg.active;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold capitalize"
      style={{ color: c.color, backgroundColor: c.bg }}
    >
      {s}
    </span>
  );
}
