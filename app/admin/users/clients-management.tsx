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
  Mail,
  Ban,
  RotateCcw,
  AlertTriangle,
  MailX, MailOpen, MailQuestion,
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
  /** Has a portal mapping ever (active OR deactivated) — tells a never-invited
   *  client apart from one whose access was turned off. */
  portal_provisioned: boolean;
  last_login_at: string | null;
  created_at: string | null;
  /** Login-reminder tracking (migration 106). */
  reminder_last_sent_at: string | null;
  reminder_count: number;
  email_bounced: boolean;
  last_email_opened_at: string | null;
}

type FilterMode = "all" | "in_portal" | "not_in_portal" | "missing_email" | "never_logged_in";

// checkbox · client · email · status · portal · last login · reminded · actions
const GRID = "32px 1.5fr 1.45fr 0.8fr 0.9fr 0.8fr 1.05fr 1.6fr";

/** Reminder cell state for a never-logged-in client. */
function reminderState(c: ClientRow): {
  label: string;
  days: number | null;
  stale: boolean; // reminded 7+ days ago and STILL no login — chase again
} {
  if (!c.reminder_last_sent_at) return { label: "never reminded", days: null, stale: false };
  const days = Math.floor((Date.now() - new Date(c.reminder_last_sent_at).getTime()) / 86_400_000);
  const d = new Date(c.reminder_last_sent_at);
  return {
    label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    days,
    stale: days >= 7,
  };
}

interface BulkResult {
  invited: number;
  provisioned: number;
  already: number;
  deactivated: number;
  reactivated: number;
  skippedNoEmail: number;
  errors: string[];
}

export function ClientsManagement({ clients }: { clients: ClientRow[] }) {
  const [rows, setRows] = useState(clients);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [reminderBusy, setReminderBusy] = useState<string | null>(null); // "all" or a client id
  const [reminderMsg, setReminderMsg] = useState("");

  // ── Login reminders (never-logged-in clients) ──
  // Backed by /api/admin/resend-logins: idempotent provisionPortalUser under
  // the hood (resend for existing portal users, first invite otherwise), with
  // the same exclusions as the bulk audit (test accts, @ironbooks, bounced).
  async function sendReminder(target: "all" | ClientRow) {
    const isAll = target === "all";
    const n = stats.neverLoggedIn;
    const label = isAll
      ? `Send a login reminder email to ALL ${n} never-logged-in client${n === 1 ? "" : "s"}?`
      : `Send ${(target as ClientRow).client_name} a login reminder email?`;
    if (!confirm(label)) return;
    setReminderBusy(isAll ? "all" : (target as ClientRow).id);
    setReminderMsg("");
    try {
      const res = await fetch("/api/admin/resend-logins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isAll ? { confirm: true, include_no_account: true } : { confirm: true, client_link_id: (target as ClientRow).id }
        ),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
      setReminderMsg(
        `Sent ${b.sent || 0} login reminder${(b.sent || 0) === 1 ? "" : "s"}${b.failed ? ` · ${b.failed} failed` : ""}.`
      );
      // Optimistic: stamp the rows so the red 7-day state resets immediately.
      const now = new Date().toISOString();
      setRows((prev) =>
        prev.map((c) => {
          const hit = isAll
            ? c.client_email && !c.last_login_at && c.is_active && !c.email_bounced
            : c.id === (target as ClientRow).id;
          return hit
            ? { ...c, reminder_last_sent_at: now, reminder_count: (c.reminder_count || 0) + 1 }
            : c;
        })
      );
    } catch (e: any) {
      setReminderMsg(`Reminder failed: ${e?.message || "unknown error"}`);
    } finally {
      setReminderBusy(null);
    }
  }

  // ── Portal-readiness counts (the audit, surfaced live) ──
  const stats = useMemo(() => {
    const active = rows.filter((c) => c.is_active);
    return {
      total: active.length,
      inPortal: active.filter((c) => c.has_portal).length,
      notInvited: active.filter((c) => !c.portal_provisioned).length,
      deactivated: active.filter((c) => c.portal_provisioned && !c.has_portal).length,
      missingEmail: active.filter((c) => !c.client_email).length,
      neverLoggedIn: active.filter((c) => c.client_email && !c.last_login_at).length,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((c) => {
      if (filter === "in_portal" && !c.has_portal) return false;
      if (filter === "not_in_portal" && c.has_portal) return false;
      if (filter === "missing_email" && c.client_email) return false;
      if (filter === "never_logged_in" && (!c.client_email || c.last_login_at || !c.is_active)) return false;
      if (!q) return true;
      return (
        c.client_name?.toLowerCase().includes(q) ||
        (c.client_email || "").toLowerCase().includes(q) ||
        (c.client_phone || "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, filter]);

  const selectedRows = useMemo(
    () => filtered.filter((c) => selected.has(c.id)),
    [filtered, selected]
  );
  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id));

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => {
      if (filtered.every((c) => prev.has(c.id))) {
        const next = new Set(prev);
        filtered.forEach((c) => next.delete(c.id));
        return next;
      }
      const next = new Set(prev);
      filtered.forEach((c) => next.add(c.id));
      return next;
    });
  }
  const clearSelection = () => setSelected(new Set());

  function markPortal(id: string, on: boolean) {
    setRows((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              has_portal: on,
              portal_provisioned: c.portal_provisioned || on,
              portal_user_count: on ? Math.max(1, c.portal_user_count) : 0,
            }
          : c
      )
    );
  }

  async function saveField(id: string, field: "client_email" | "client_phone", value: string) {
    // Email goes through a dedicated endpoint that also repoints the client's
    // portal LOGIN email (not just the business contact field). Confirm first
    // when they have a portal login, since it changes how they sign in.
    if (field === "client_email") {
      const row = rows.find((c) => c.id === id);
      if (
        row?.has_portal &&
        !confirm(
          `Change ${row.client_name}'s email to "${value}"?\n\n` +
            `This updates their contact email AND their portal LOGIN email — ` +
            `they'll sign in with the new address from now on.`
        )
      ) {
        return; // cancelled — the field reverts to the current value
      }
      const res = await fetch(`/api/admin/clients/${id}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error || "Couldn't update email");
      setRows((prev) => prev.map((c) => (c.id === id ? { ...c, client_email: value || null } : c)));
      if (b.note) alert(b.note);
      return;
    }
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

  // Invite/provision a single client via the shared, tested invite route.
  async function inviteOne(
    c: ClientRow,
    sendEmail: boolean
  ): Promise<"ok" | "already" | "error"> {
    const res = await fetch("/api/admin/invite-client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: c.client_email,
        full_name: c.client_name,
        client_link_id: c.id,
        send_invite: sendEmail,
      }),
    });
    if (res.ok) {
      markPortal(c.id, true);
      return "ok";
    }
    if (res.status === 409) {
      // Already has portal access — treat as success for bulk accounting.
      markPortal(c.id, true);
      return "already";
    }
    return "error";
  }

  async function setPortalAccess(c: ClientRow, action: "activate" | "deactivate") {
    const res = await fetch(`/api/admin/clients/${c.id}/portal-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    markPortal(c.id, action === "activate");
  }

  // ── Per-row actions ──
  async function rowInvite(c: ClientRow, sendEmail: boolean) {
    if (!c.client_email) {
      setError(`${c.client_name} has no email on file — add one in the Email column first.`);
      return;
    }
    setRowBusy(c.id);
    setError("");
    try {
      const r = await inviteOne(c, sendEmail);
      if (r === "error") setError(`Couldn't invite ${c.client_name}.`);
    } finally {
      setRowBusy(null);
    }
  }
  async function rowPortal(c: ClientRow, action: "activate" | "deactivate") {
    if (
      action === "deactivate" &&
      !confirm(`Turn OFF portal access for ${c.client_name}? They won't be able to log in or receive statement emails until re-activated.`)
    )
      return;
    setRowBusy(c.id);
    setError("");
    try {
      await setPortalAccess(c, action);
    } catch (e: any) {
      setError(`Couldn't update ${c.client_name}: ${e?.message || "unknown"}`);
    } finally {
      setRowBusy(null);
    }
  }

  // ── Bulk actions ──
  async function runBulk(
    kind: "invite" | "provision" | "deactivate",
    targets: ClientRow[]
  ) {
    setBulkBusy(true);
    setBulkResult(null);
    setError("");
    const result: BulkResult = {
      invited: 0, provisioned: 0, already: 0, deactivated: 0, reactivated: 0,
      skippedNoEmail: 0, errors: [],
    };
    const queue = [...targets];
    setBulkProgress({ done: 0, total: queue.length });
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const c = queue.shift()!;
        try {
          if (kind === "deactivate") {
            await setPortalAccess(c, "deactivate");
            result.deactivated++;
          } else {
            const sendEmail = kind === "invite";
            const r = await inviteOne(c, sendEmail);
            if (r === "error") result.errors.push(`${c.client_name}`);
            else if (r === "already") result.already++;
            else if (sendEmail) result.invited++;
            else result.provisioned++;
          }
        } catch (e: any) {
          result.errors.push(`${c.client_name}: ${e?.message || "error"}`);
        }
        done++;
        setBulkProgress({ done, total: targets.length });
      }
    };
    // Limited concurrency (3) — gentle on the auth-email rate limit and DB.
    await Promise.all([worker(), worker(), worker()]);
    setBulkBusy(false);
    setBulkProgress(null);
    setBulkResult(result);
    clearSelection();
  }

  function bulkInvite(sendEmail: boolean) {
    const withEmail = selectedRows.filter((c) => c.client_email);
    const noEmail = selectedRows.length - withEmail.length;
    if (withEmail.length === 0) {
      alert("None of the selected clients have an email on file. Add emails first (Email column).");
      return;
    }
    let msg = sendEmail
      ? `Send a branded portal invite email to ${withEmail.length} client${withEmail.length === 1 ? "" : "s"}?`
      : `Provision portal access for ${withEmail.length} client${withEmail.length === 1 ? "" : "s"} WITHOUT emailing them?\n\nUse this to preview / impersonate the portal before the real invite goes out.`;
    if (noEmail > 0)
      msg += `\n\n${noEmail} selected client${noEmail === 1 ? "" : "s"} have no email — they'll be skipped.`;
    if (sendEmail && withEmail.length > 100)
      msg += `\n\n⚠️ ${withEmail.length} is a large batch. Invites send through Resend (our email provider), not Supabase — Resend's free tier allows 100 emails/day. On the free plan, split into sub-100 daily batches or upgrade Resend; smaller batches send fine.`;
    if (!confirm(msg)) return;
    if (noEmail > 0) {
      // record skipped before running (runBulk only sees the with-email set)
      setBulkResult(null);
    }
    runBulk(sendEmail ? "invite" : "provision", withEmail).then(() => {
      if (noEmail > 0)
        setBulkResult((prev) => (prev ? { ...prev, skippedNoEmail: noEmail } : prev));
    });
  }

  function bulkDeactivate() {
    const targets = selectedRows.filter((c) => c.has_portal);
    if (targets.length === 0) {
      alert("None of the selected clients have active portal access.");
      return;
    }
    if (!confirm(`Turn OFF portal access for ${targets.length} client${targets.length === 1 ? "" : "s"}? They can't log in or get statement emails until re-activated.`))
      return;
    runBulk("deactivate", targets);
  }

  const FILTERS: { id: FilterMode; label: string; count: number }[] = [
    { id: "all", label: "All", count: stats.total },
    { id: "in_portal", label: "In portal", count: stats.inPortal },
    { id: "not_in_portal", label: "Not in portal", count: stats.total - stats.inPortal },
    { id: "missing_email", label: "Missing email", count: stats.missingEmail },
    { id: "never_logged_in", label: "Never logged in", count: stats.neverLoggedIn },
  ];

  return (
    <div>
      {/* ── Portal readiness banner (the audit, live) ── */}
      <div className="mb-4 grid grid-cols-2 md:grid-cols-5 gap-2">
        <StatCard label="Active clients" value={stats.total} tone="navy" />
        <StatCard label="In portal" value={stats.inPortal} tone="green" />
        <StatCard label="Not invited" value={stats.notInvited} tone="amber" />
        <StatCard label="Deactivated" value={stats.deactivated} tone="slate" />
        <StatCard label="Missing email" value={stats.missingEmail} tone="red" />
      </div>

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

        {/* Filter pills */}
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm font-semibold">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-3 py-2 inline-flex items-center gap-1.5 border-l border-gray-200 first:border-l-0 ${
                filter === f.id ? "bg-teal text-white" : "bg-white text-ink-slate hover:bg-gray-50"
              }`}
            >
              {f.label}
              <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${filter === f.id ? "bg-white/20" : "bg-gray-100"}`}>
                {f.count}
              </span>
            </button>
          ))}
        </div>

        <Link
          href="/admin/invite-client"
          className="inline-flex items-center gap-2 bg-white border border-gray-200 hover:border-teal text-ink-slate hover:text-navy text-sm font-semibold px-4 py-2 rounded-lg whitespace-nowrap"
          title="Invite a single client with a custom contact name"
        >
          <UserPlus size={16} />
          Invite one…
        </Link>
      </div>

      {/* ── Never-logged-in reminder bar ── */}
      {filter === "never_logged_in" && stats.neverLoggedIn > 0 && (
        <div className="mb-3 flex items-center gap-3 flex-wrap bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">
          <span className="text-sm text-amber-900">
            <strong>{stats.neverLoggedIn}</strong> client{stats.neverLoggedIn === 1 ? "" : "s"} with an
            email on file {stats.neverLoggedIn === 1 ? "has" : "have"} never signed in to the portal.
          </span>
          <div className="flex-1" />
          <button
            onClick={() => sendReminder("all")}
            disabled={reminderBusy !== null}
            className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-3.5 py-1.5 rounded-lg disabled:opacity-50"
          >
            {reminderBusy === "all" ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
            Send login reminder to all never-logged-in clients
          </button>
        </div>
      )}
      {reminderMsg && (
        <div className="mb-3 bg-teal-lighter border border-teal/30 rounded-lg px-4 py-2.5 text-sm text-navy flex items-center gap-2">
          <Check size={15} className="text-teal flex-shrink-0" />
          <span className="flex-1">{reminderMsg}</span>
          <button onClick={() => setReminderMsg("")} className="text-ink-light hover:text-navy"><X size={14} /></button>
        </div>
      )}

      {/* ── Bulk action bar ── */}
      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-2 flex-wrap bg-navy text-white rounded-xl px-4 py-2.5">
          <span className="text-sm font-bold">{selected.size} selected</span>
          <div className="flex-1" />
          {bulkBusy ? (
            <span className="inline-flex items-center gap-2 text-sm">
              <Loader2 size={14} className="animate-spin" />
              {bulkProgress ? `${bulkProgress.done}/${bulkProgress.total}…` : "Working…"}
            </span>
          ) : (
            <>
              <button
                onClick={() => bulkInvite(true)}
                className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-3 py-1.5 rounded-lg"
              >
                <Mail size={14} />
                Invite to portal (email)
              </button>
              <button
                onClick={() => bulkInvite(false)}
                title="Create portal access WITHOUT emailing — for previewing/impersonating before the real invite"
                className="inline-flex items-center gap-1.5 bg-white/10 hover:bg-white/20 text-white text-sm font-semibold px-3 py-1.5 rounded-lg"
              >
                <Eye size={14} />
                Provision only
              </button>
              <button
                onClick={bulkDeactivate}
                className="inline-flex items-center gap-1.5 bg-white/10 hover:bg-red-500/80 text-white text-sm font-semibold px-3 py-1.5 rounded-lg"
              >
                <Ban size={14} />
                Deactivate
              </button>
              <button onClick={clearSelection} className="text-white/70 hover:text-white p-1.5" title="Clear selection">
                <X size={16} />
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Bulk result summary ── */}
      {bulkResult && (
        <div className="mb-3 bg-teal-lighter border border-teal/30 rounded-lg p-3 text-sm text-navy flex items-start gap-2">
          <Check size={16} className="text-teal mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <span className="font-semibold">Done.</span>{" "}
            {[
              bulkResult.invited && `${bulkResult.invited} invited`,
              bulkResult.provisioned && `${bulkResult.provisioned} provisioned`,
              bulkResult.reactivated && `${bulkResult.reactivated} re-activated`,
              bulkResult.deactivated && `${bulkResult.deactivated} deactivated`,
              bulkResult.already && `${bulkResult.already} already had access`,
              bulkResult.skippedNoEmail && `${bulkResult.skippedNoEmail} skipped (no email)`,
            ]
              .filter(Boolean)
              .join(" · ") || "No changes."}
            {bulkResult.errors.length > 0 && (
              <div className="mt-1 text-red-700">
                {bulkResult.errors.length} failed: {bulkResult.errors.slice(0, 5).join(", ")}
                {bulkResult.errors.length > 5 ? "…" : ""}
              </div>
            )}
          </div>
          <button onClick={() => setBulkResult(null)} className="text-ink-light hover:text-navy">
            <X size={14} />
          </button>
        </div>
      )}

      {error && (
        <div className="mb-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="rounded-xl overflow-hidden bg-white border border-gray-200">
        <div
          className="grid items-center px-5 py-3 text-xs font-bold uppercase tracking-wider bg-gray-50 text-ink-slate border-b border-gray-200"
          style={{ gridTemplateColumns: GRID }}
        >
          <div>
            <input
              type="checkbox"
              checked={allFilteredSelected}
              onChange={toggleSelectAll}
              className="w-4 h-4 rounded border-gray-300 text-teal cursor-pointer"
              title="Select all (filtered)"
            />
          </div>
          <div>Client</div>
          <div>Email</div>
          <div>Status</div>
          <div>Portal</div>
          <div>Last login</div>
          <div>Reminded</div>
          <div></div>
        </div>

        {filtered.map((c) => {
          const busy = rowBusy === c.id;
          const deactivated = c.portal_provisioned && !c.has_portal;
          return (
            <div
              key={c.id}
              className={`grid items-center px-5 py-3.5 border-b border-gray-100 hover:bg-teal-lighter transition-colors ${
                !c.is_active ? "opacity-50" : ""
              } ${selected.has(c.id) ? "bg-teal-lighter/60" : ""}`}
              style={{ gridTemplateColumns: GRID }}
            >
              {/* Select */}
              <div>
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggleSelect(c.id)}
                  className="w-4 h-4 rounded border-gray-300 text-teal cursor-pointer"
                />
              </div>

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

              {/* Email — inline editable, flags when missing */}
              <div className="flex items-center gap-1.5 min-w-0">
                {!c.client_email && <AlertTriangle size={13} className="text-amber-500 flex-shrink-0" />}
                <EditableCell
                  value={c.client_email}
                  placeholder="Add email"
                  type="email"
                  onSave={(v) => saveField(c.id, "client_email", v)}
                />
              </div>

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
                ) : deactivated ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-amber-50 text-amber-700">
                    <Ban size={12} />
                    Deactivated
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

              {/* Login reminders — only meaningful before the first login */}
              <div className="text-xs">
                {c.last_login_at || !c.client_email ? (
                  <span className="text-ink-light">—</span>
                ) : (
                  (() => {
                    const r = reminderState(c);
                    return (
                      <div className="space-y-0.5">
                        <div
                          className={`inline-flex items-center gap-1 ${
                            r.stale ? "text-red-700 font-bold" : "text-ink-slate"
                          }`}
                          title={
                            r.stale
                              ? `Reminded ${r.days} days ago and still hasn't logged in — chase again`
                              : c.reminder_last_sent_at || "No reminder sent yet"
                          }
                        >
                          {r.stale && <AlertTriangle size={11} className="text-red-600" />}
                          {r.label}
                          {r.days !== null && <span className={r.stale ? "" : "text-ink-light"}>· {r.days}d</span>}
                          {c.reminder_count > 1 && (
                            <span className="font-bold text-ink-slate bg-gray-100 rounded px-1">×{c.reminder_count}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          {c.email_bounced && (
                            <span
                              className="inline-flex items-center gap-0.5 text-[10px] font-bold text-red-700 bg-red-50 border border-red-200 rounded px-1"
                              title="Email is hard-bouncing — reminders are skipped; fix the address first"
                            >
                              <MailX size={10} /> bouncing
                            </span>
                          )}
                          {c.last_email_opened_at ? (
                            <span
                              className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-700"
                              title={`Last opened one of our emails ${new Date(c.last_email_opened_at).toLocaleDateString()} — mail is reaching their inbox`}
                            >
                              <MailOpen size={10} /> opens
                            </span>
                          ) : c.reminder_count > 0 && !c.email_bounced ? (
                            <span
                              className="inline-flex items-center gap-0.5 text-[10px] text-ink-light"
                              title="No email opens recorded — could be landing in spam (needs Resend open tracking enabled)"
                            >
                              <MailQuestion size={10} /> no opens
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })()
                )}
              </div>

              {/* Actions */}
              <div className="flex justify-end items-center gap-1.5">
                {busy && <Loader2 size={13} className="animate-spin text-teal" />}
                {c.client_email && !c.last_login_at && c.is_active && (
                  <button
                    onClick={() => sendReminder(c)}
                    disabled={reminderBusy !== null || c.email_bounced}
                    title={
                      c.email_bounced
                        ? "Email is hard-bouncing — fix the address before reminding"
                        : "Email this client a login reminder (invite if they were never invited)"
                    }
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 hover:text-amber-900 border border-amber-300 hover:border-amber-500 px-2.5 py-1.5 rounded-lg disabled:opacity-50"
                  >
                    {reminderBusy === c.id ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
                    Remind
                  </button>
                )}
                {c.has_portal ? (
                  <>
                    <button
                      onClick={() => impersonate(c)}
                      disabled={impersonating === c.id}
                      title="Open this client's portal as them"
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark border border-teal/30 hover:border-teal px-2.5 py-1.5 rounded-lg disabled:opacity-50"
                    >
                      {impersonating === c.id ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
                      Impersonate
                    </button>
                    <button
                      onClick={() => rowPortal(c, "deactivate")}
                      disabled={busy}
                      title="Turn off portal access"
                      className="inline-flex items-center justify-center text-ink-light hover:text-red-600 border border-gray-200 hover:border-red-300 p-1.5 rounded-lg disabled:opacity-50"
                    >
                      <Ban size={13} />
                    </button>
                  </>
                ) : deactivated ? (
                  <button
                    onClick={() => rowPortal(c, "activate")}
                    disabled={busy}
                    title="Re-activate portal access (no new email sent)"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark border border-teal/30 hover:border-teal px-2.5 py-1.5 rounded-lg disabled:opacity-50"
                  >
                    <RotateCcw size={12} />
                    Re-activate
                  </button>
                ) : (
                  <button
                    onClick={() => rowInvite(c, true)}
                    disabled={busy || !c.client_email}
                    title={c.client_email ? "Send a portal invite email" : "No email on file — add one first"}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy border border-gray-200 hover:border-teal px-2.5 py-1.5 rounded-lg disabled:opacity-40"
                  >
                    <UserPlus size={12} />
                    Invite
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <p className="py-12 text-center text-sm text-ink-slate">No clients match your search.</p>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "navy" | "green" | "amber" | "slate" | "red";
}) {
  const tones: Record<string, string> = {
    navy: "bg-navy/5 text-navy",
    green: "bg-green-50 text-green-700",
    amber: "bg-amber-50 text-amber-700",
    slate: "bg-slate-100 text-slate-600",
    red: "bg-red-50 text-red-700",
  };
  return (
    <div className={`rounded-xl px-3 py-2.5 ${tones[tone]}`}>
      <div className="text-xl font-bold leading-none">{value}</div>
      <div className="text-xs font-semibold mt-1 opacity-80">{label}</div>
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
