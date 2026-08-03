"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Users, UserPlus, Mail, Loader2, Check, AlertTriangle, Trash2, X, KeyRound,
  LayoutList, Pencil, Lock,
} from "lucide-react";
import { PORTAL_PAGES, PORTAL_PAGE_KEYS, ALWAYS_ALLOWED_LABELS } from "@/lib/portal-pages";

/**
 * Profile-tab card: the client account's portal users. Admins/leads can add
 * additional users (same access as the first user — role=client), each with an
 * explicit "send login email" step so the bookkeeper controls when the client
 * is actually contacted. Additional users are FREE for now (see the route's
 * "FUTURE: paid seats" note before adding a seat charge).
 */
type PortalUser = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  active: boolean;
  is_primary: boolean;
  invited_at: string | null;
  first_login_at: string | null;
  last_login_at: string | null;
  has_logged_in: boolean;
  /** Page keys this user may open; null = every portal page. */
  allowed_pages: string[] | null;
};

export function PortalUsersCard({
  clientLinkId,
  canManage,
}: {
  clientLinkId: string;
  canManage: boolean;
}) {
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Add form
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Page access for the new user — everything pre-selected (full access).
  const [addPages, setAddPages] = useState<string[]>(PORTAL_PAGE_KEYS);

  // "Edit page access" modal target
  const [editingPages, setEditingPages] = useState<PortalUser | null>(null);

  // "User added — send login email?" popup
  const [justAdded, setJustAdded] = useState<{ user_id: string; name: string; email: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/portal-users`);
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "Couldn't load users");
      setUsers(json.users || []);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't load users");
    } finally {
      setLoading(false);
    }
  }, [clientLinkId]);

  useEffect(() => { load(); }, [load]);

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    if (adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/portal-users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          full_name: fullName.trim(),
          // Full selection is stored as "all pages" server-side.
          allowed_pages: addPages,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "Couldn't add user");
      const addedName = fullName.trim() || email.trim();
      const addedEmail = email.trim();
      setEmail("");
      setFullName("");
      setAddPages(PORTAL_PAGE_KEYS);
      await load();
      // Open the "send login email" popup for the user we just added.
      setJustAdded({ user_id: json.user_id, name: addedName, email: addedEmail });
    } catch (e: any) {
      setAddError(e?.message || "Couldn't add user");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-navy flex items-center gap-2">
          <Users size={15} /> Portal users
        </h3>
        <span className="text-[11px] text-ink-light">
          {users.filter((u) => u.active).length} active
        </span>
      </div>

      <p className="text-[11px] text-ink-light mb-3">
        Everyone here signs in to the client portal. Each user can be limited to specific
        pages ({ALWAYS_ALLOWED_LABELS.join(" and ")} are always available). Additional users are free.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-ink-light py-3">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : loadError ? (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{loadError}</div>
      ) : users.length === 0 ? (
        <div className="text-xs text-ink-light italic py-2">No portal users yet.</div>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden">
          {users.map((u) => (
            <UserRow
              key={u.user_id}
              user={u}
              clientLinkId={clientLinkId}
              canManage={canManage}
              onChanged={load}
              onEditPages={() => setEditingPages(u)}
            />
          ))}
        </ul>
      )}

      {canManage && (
        <form onSubmit={addUser} className="mt-4 border-t border-gray-100 pt-4">
          <div className="text-[11px] font-semibold text-ink-slate mb-2 flex items-center gap-1.5">
            <UserPlus size={13} /> Add a user
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Full name"
              className="w-full text-sm rounded-lg border border-gray-200 px-2.5 py-1.5 text-navy placeholder:text-ink-light focus:outline-none focus:border-teal"
            />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@company.com"
              className="w-full text-sm rounded-lg border border-gray-200 px-2.5 py-1.5 text-navy placeholder:text-ink-light focus:outline-none focus:border-teal"
            />
          </div>
          {/* Which portal pages this user may open — all checked = full access */}
          <div className="mt-3">
            <div className="text-[11px] font-semibold text-ink-slate mb-1.5 flex items-center gap-1.5">
              <LayoutList size={13} /> Page access
              <span className="font-normal text-ink-light">
                — {addPages.length === PORTAL_PAGE_KEYS.length ? "all pages" : `${addPages.length} of ${PORTAL_PAGE_KEYS.length} pages`}
              </span>
            </div>
            <PageChecklist selected={addPages} onChange={setAddPages} />
          </div>
          {addError && (
            <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{addError}</div>
          )}
          <button
            type="submit"
            disabled={adding || !email.trim() || !fullName.trim()}
            className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg bg-teal text-white hover:bg-teal-dark disabled:opacity-50"
          >
            {adding ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
            Add user
          </button>
        </form>
      )}

      {justAdded && (
        <SendLoginPopup
          clientLinkId={clientLinkId}
          user={justAdded}
          onClose={() => { setJustAdded(null); load(); }}
        />
      )}

      {editingPages && (
        <EditPagesModal
          clientLinkId={clientLinkId}
          user={editingPages}
          onClose={() => setEditingPages(null)}
          onSaved={() => { setEditingPages(null); load(); }}
        />
      )}
    </div>
  );
}

/** Human summary of a user's page access — "All pages" or "4 of 11 pages". */
function pagesSummary(allowed: string[] | null): string {
  if (!allowed) return "All pages";
  const count = allowed.filter((k) => PORTAL_PAGE_KEYS.includes(k)).length;
  if (count >= PORTAL_PAGE_KEYS.length) return "All pages";
  return `${count} of ${PORTAL_PAGE_KEYS.length} pages`;
}

/**
 * Grouped checkbox grid of restrictable portal pages, mirroring the portal
 * sidebar's sections, with locked-on rows for the always-available pages
 * and quick "All / None" toggles.
 */
function PageChecklist({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const sections = Array.from(new Set(PORTAL_PAGES.map((p) => p.section)));

  function toggle(key: string) {
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  }

  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-3">
      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          onClick={() => onChange(PORTAL_PAGE_KEYS)}
          className="text-[10px] font-bold uppercase tracking-wide text-teal hover:underline"
        >
          Select all
        </button>
        <span className="text-[10px] text-ink-light">·</span>
        <button
          type="button"
          onClick={() => onChange([])}
          className="text-[10px] font-bold uppercase tracking-wide text-ink-slate hover:underline"
        >
          None
        </button>
        <span className="ml-auto text-[10px] text-ink-light flex items-center gap-1">
          <Lock size={10} /> {ALWAYS_ALLOWED_LABELS.join(" & ")} always included
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
        {sections.map((section) => (
          <div key={section}>
            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-light mb-1">
              {section}
            </div>
            <div className="space-y-0.5">
              {PORTAL_PAGES.filter((p) => p.section === section).map((p) => (
                <label
                  key={p.key}
                  className="flex items-center gap-2 text-xs text-navy cursor-pointer select-none py-0.5"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(p.key)}
                    onChange={() => toggle(p.key)}
                    className="rounded border-gray-300 text-teal focus:ring-teal"
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Modal to edit an existing portal user's page access (PATCH). */
function EditPagesModal({
  clientLinkId,
  user,
  onClose,
  onSaved,
}: {
  clientLinkId: string;
  user: PortalUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(
    user.allowed_pages === null
      ? PORTAL_PAGE_KEYS
      : user.allowed_pages.filter((k) => PORTAL_PAGE_KEYS.includes(k))
  );
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    if (state === "saving") return;
    setState("saving");
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/portal-users`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: user.user_id, allowed_pages: selected }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "Couldn't save");
      onSaved();
    } catch (e: any) {
      setState("error");
      setMsg(e?.message || "Couldn't save");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/30 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl border border-gray-100 shadow-xl w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h4 className="text-sm font-bold text-navy flex items-center gap-2">
            <LayoutList size={15} /> Page access
          </h4>
          <button onClick={onClose} className="text-ink-light hover:text-navy"><X size={16} /></button>
        </div>
        <p className="text-xs text-ink-slate mb-3">
          Choose which portal pages <strong className="text-navy">{user.full_name || user.email}</strong> can
          open. Changes apply on their next page load.
        </p>

        <PageChecklist selected={selected} onChange={setSelected} />

        {msg && (
          <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{msg}</div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={save}
            disabled={state === "saving"}
            className="flex-1 inline-flex items-center justify-center gap-1.5 text-[11px] font-bold px-3 py-2 rounded-lg bg-teal text-white hover:bg-teal-dark disabled:opacity-50"
          >
            {state === "saving" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            Save page access
          </button>
          <button
            onClick={onClose}
            className="text-[11px] font-semibold px-3 py-2 rounded-lg border border-gray-200 text-ink-slate hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function UserRow({
  user,
  clientLinkId,
  canManage,
  onChanged,
  onEditPages,
}: {
  user: PortalUser;
  clientLinkId: string;
  canManage: boolean;
  onChanged: () => void;
  onEditPages: () => void;
}) {
  const [sending, setSending] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [removing, setRemoving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function sendLogin() {
    if (sending === "sending") return;
    setSending("sending");
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/portal-users/send-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: user.user_id }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "Couldn't send");
      setSending("sent");
      setTimeout(() => setSending("idle"), 3000);
    } catch (e: any) {
      setSending("error");
      setMsg(e?.message || "Couldn't send");
    }
  }

  async function remove() {
    if (removing) return;
    if (!confirm(`Remove ${user.full_name || user.email}'s access to this client's portal?`)) return;
    setRemoving(true);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/portal-users?user_id=${encodeURIComponent(user.user_id)}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "Couldn't remove");
      onChanged();
    } catch (e: any) {
      setMsg(e?.message || "Couldn't remove");
      setRemoving(false);
    }
  }

  if (!user.active) {
    return (
      <li className="flex items-center justify-between px-3 py-2 bg-gray-50/60">
        <div className="min-w-0">
          <div className="text-sm text-ink-light line-through truncate">{user.full_name || user.email}</div>
          <div className="text-[11px] text-ink-light">Access revoked</div>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center justify-between gap-2 px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm text-navy font-medium truncate flex items-center gap-1.5">
          {user.full_name || user.email}
          {user.is_primary && (
            <span className="text-[9px] font-bold uppercase tracking-wide text-teal bg-teal-lighter rounded px-1 py-0.5">
              Primary
            </span>
          )}
        </div>
        <div className="text-[11px] text-ink-light truncate">
          {user.email}
          {" · "}
          {user.has_logged_in ? "has logged in" : <span className="text-amber-600">not logged in yet</span>}
          {" · "}
          <span className={user.allowed_pages ? "text-amber-700 font-medium" : ""}>
            {pagesSummary(user.allowed_pages)}
          </span>
        </div>
        {msg && <div className="text-[11px] text-red-600 mt-0.5">{msg}</div>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {canManage && (
          <button
            onClick={onEditPages}
            title="Choose which portal pages this user can open"
            className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-gray-200 text-ink-slate hover:text-navy hover:border-gray-300"
          >
            <Pencil size={12} />
            Pages
          </button>
        )}
        <button
          onClick={sendLogin}
          disabled={sending === "sending"}
          title="Email this user a fresh login link"
          className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-gray-200 text-ink-slate hover:text-navy hover:border-gray-300 disabled:opacity-50"
        >
          {sending === "sending" ? <Loader2 size={12} className="animate-spin" />
            : sending === "sent" ? <Check size={12} className="text-emerald-600" />
            : sending === "error" ? <AlertTriangle size={12} className="text-red-600" />
            : <Mail size={12} />}
          {sending === "sent" ? "Sent" : "Send login"}
        </button>
        {canManage && !user.is_primary && (
          <button
            onClick={remove}
            disabled={removing}
            title="Revoke this user's portal access"
            className="inline-flex items-center p-1 rounded-lg border border-gray-200 text-ink-light hover:text-red-600 hover:border-red-200 disabled:opacity-50"
          >
            {removing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          </button>
        )}
      </div>
    </li>
  );
}

/** Modal shown right after adding a user, so staff can send the login email. */
function SendLoginPopup({
  clientLinkId,
  user,
  onClose,
}: {
  clientLinkId: string;
  user: { user_id: string; name: string; email: string };
  onClose: () => void;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function send() {
    if (state === "sending") return;
    setState("sending");
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/portal-users/send-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: user.user_id }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "Couldn't send");
      setState("sent");
    } catch (e: any) {
      setState("error");
      setMsg(e?.message || "Couldn't send");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/30 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl border border-gray-100 shadow-xl w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-2">
          <h4 className="text-sm font-bold text-navy flex items-center gap-2">
            <KeyRound size={15} /> User added
          </h4>
          <button onClick={onClose} className="text-ink-light hover:text-navy"><X size={16} /></button>
        </div>

        {state === "sent" ? (
          <div className="text-sm text-navy">
            <div className="flex items-center gap-2 text-emerald-700 font-semibold mb-1">
              <Check size={15} /> Login email sent
            </div>
            <p className="text-xs text-ink-slate">
              {user.name} will get a branded sign-in link at <strong className="text-navy">{user.email}</strong> (valid 7 days).
            </p>
            <button
              onClick={onClose}
              className="mt-4 w-full text-[11px] font-bold px-3 py-2 rounded-lg bg-teal text-white hover:bg-teal-dark"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <p className="text-xs text-ink-slate mb-1">
              <strong className="text-navy">{user.name}</strong> was added to the portal
              ({user.email}). Send them their login email now?
            </p>
            <p className="text-[11px] text-ink-light mb-4">
              You can also do this later from the user list.
            </p>
            {msg && (
              <div className="mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{msg}</div>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={send}
                disabled={state === "sending"}
                className="flex-1 inline-flex items-center justify-center gap-1.5 text-[11px] font-bold px-3 py-2 rounded-lg bg-teal text-white hover:bg-teal-dark disabled:opacity-50"
              >
                {state === "sending" ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
                Send login email
              </button>
              <button
                onClick={onClose}
                className="text-[11px] font-semibold px-3 py-2 rounded-lg border border-gray-200 text-ink-slate hover:bg-gray-50"
              >
                Not now
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
