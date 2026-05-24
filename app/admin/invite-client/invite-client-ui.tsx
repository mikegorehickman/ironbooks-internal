"use client";

import { useState, useMemo } from "react";
import {
  Search, Mail, CheckCircle2, AlertCircle, Loader2, X,
  RefreshCw, Clock, UserMinus, Send,
} from "lucide-react";

interface Client {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  client_email: string | null;
}

interface Mapping {
  id: string;
  user_id: string;
  client_link_id: string;
  invited_at: string;
  first_login_at: string | null;
  last_login_at: string | null;
  active: boolean;
  user_email: string;
  user_full_name: string;
  user_active: boolean;
  client_name: string;
  invited_by_name: string;
}

export function InviteClientUI({
  clients,
  existingMappings,
}: {
  clients: Client[];
  existingMappings: Mapping[];
}) {
  const [clientId, setClientId] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [listSearch, setListSearch] = useState("");

  const filteredClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    if (!q) return clients.slice(0, 15);
    return clients.filter((c) =>
      c.client_name.toLowerCase().includes(q) ||
      (c.client_email || "").toLowerCase().includes(q)
    ).slice(0, 30);
  }, [clients, clientSearch]);

  const filteredMappings = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    if (!q) return existingMappings;
    return existingMappings.filter((m) =>
      m.user_email.toLowerCase().includes(q) ||
      m.user_full_name.toLowerCase().includes(q) ||
      m.client_name.toLowerCase().includes(q)
    );
  }, [existingMappings, listSearch]);

  // Auto-fill email from client_email when a client is picked
  function pickClient(c: Client) {
    setClientId(c.id);
    if (c.client_email && !email) setEmail(c.client_email);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    if (!clientId || !email || !fullName) {
      setError("All fields required.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/admin/invite-client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          full_name: fullName.trim(),
          client_link_id: clientId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSuccess(body.message || "Invite sent");
      setEmail("");
      setFullName("");
      setClientId("");
      // Quick-and-dirty refresh — server-rendered list lives one route up
      window.location.reload();
    } catch (e: any) {
      setError(e?.message || "Invite failed");
    } finally {
      setLoading(false);
    }
  }

  async function resend(targetEmail: string, fullName: string, clientLinkId: string) {
    setError("");
    setSuccess("");
    try {
      const res = await fetch("/api/admin/invite-client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetEmail,
          full_name: fullName,
          client_link_id: clientLinkId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSuccess(body.message || "Magic link re-sent");
    } catch (e: any) {
      setError(e?.message || "Resend failed");
    }
  }

  async function revoke(userId: string, label: string) {
    if (!confirm(`Revoke portal access for ${label}? Their account stays but they can no longer log in to the portal.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/admin/invite-client?user_id=${userId}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSuccess(`Revoked ${label}`);
      window.location.reload();
    } catch (e: any) {
      setError(e?.message || "Revoke failed");
    }
  }

  const selectedClient = clients.find((c) => c.id === clientId);

  return (
    <div className="space-y-6">
      {/* Invite form */}
      <form onSubmit={submit} className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
        <div>
          <h2 className="font-bold text-navy">Send a portal invite</h2>
          <p className="text-xs text-ink-slate mt-0.5">
            The client receives a magic-link email. Clicking it signs them in and drops them on{" "}
            <code className="bg-slate-100 px-1 rounded">/portal</code>.
          </p>
        </div>

        {/* Client picker */}
        <div>
          <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider">Client</label>
          {selectedClient ? (
            <div className="mt-1 flex items-center gap-2 p-2 bg-teal/5 border border-teal/30 rounded-lg">
              <CheckCircle2 size={14} className="text-teal-dark" />
              <span className="flex-1 text-sm font-semibold text-navy">
                {selectedClient.client_name}
                <span className="text-xs text-ink-slate ml-2 font-normal">
                  {selectedClient.jurisdiction}
                  {selectedClient.state_province ? ` · ${selectedClient.state_province}` : ""}
                </span>
              </span>
              <button
                type="button"
                onClick={() => { setClientId(""); setClientSearch(""); }}
                className="text-ink-slate hover:text-navy"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="mt-1">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-2.5 text-ink-slate" />
                <input
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                  placeholder="Search clients…"
                  className="w-full pl-8 pr-2 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              {filteredClients.length > 0 && (
                <ul className="mt-1 border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-48 overflow-y-auto">
                  {filteredClients.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => pickClient(c)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                      >
                        <span className="font-semibold text-navy">{c.client_name}</span>
                        <span className="text-xs text-ink-slate ml-2">
                          {c.jurisdiction}
                          {c.state_province ? ` · ${c.state_province}` : ""}
                          {c.client_email ? ` · ${c.client_email}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Email + name */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@business.com"
              className="mt-1 w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider">Full name</label>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Jane Smith"
              className="mt-1 w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>
        </div>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800 flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <div className="flex-1">{error}</div>
            <button type="button" onClick={() => setError("")} className="text-red-700">
              <X size={14} />
            </button>
          </div>
        )}
        {success && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-800 flex items-start gap-2">
            <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
            <div className="flex-1">{success}</div>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark disabled:opacity-50 inline-flex items-center gap-2"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          {loading ? "Sending…" : "Send invite"}
        </button>
      </form>

      {/* Existing portal users */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <h2 className="font-bold text-navy">
            Portal users
            <span className="text-xs text-ink-slate ml-2 font-normal">
              ({existingMappings.length} total · {existingMappings.filter((m) => m.active).length} active)
            </span>
          </h2>
          <div className="relative max-w-xs">
            <Search size={13} className="absolute left-2.5 top-2.5 text-ink-slate" />
            <input
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              placeholder="Search by name, email, or client…"
              className="pl-8 pr-2 py-1.5 text-sm border border-slate-200 rounded-lg w-full"
            />
          </div>
        </div>

        {filteredMappings.length === 0 ? (
          <div className="p-8 text-center text-sm text-ink-slate">
            {existingMappings.length === 0
              ? "No portal users yet — invite someone above."
              : "No matches for your search."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-ink-slate uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">User</th>
                <th className="text-left px-4 py-2 font-semibold">Client</th>
                <th className="text-left px-4 py-2 font-semibold">Status</th>
                <th className="text-left px-4 py-2 font-semibold">Last login</th>
                <th className="text-right px-4 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredMappings.map((m) => {
                const daysSinceInvite = Math.floor(
                  (Date.now() - new Date(m.invited_at).getTime()) / 86_400_000
                );
                const neverLoggedIn = !m.first_login_at;
                const staleInvite = neverLoggedIn && daysSinceInvite > 7;
                return (
                  <tr key={m.id} className={!m.active ? "opacity-50" : ""}>
                    <td className="px-4 py-2">
                      <div className="font-semibold text-navy">{m.user_full_name || "—"}</div>
                      <div className="text-xs text-ink-slate">{m.user_email}</div>
                    </td>
                    <td className="px-4 py-2 text-ink-slate">{m.client_name}</td>
                    <td className="px-4 py-2">
                      {!m.active ? (
                        <span className="text-[10px] font-bold bg-slate-200 text-ink-slate px-1.5 py-0.5 rounded">
                          REVOKED
                        </span>
                      ) : staleInvite ? (
                        <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                          NEVER LOGGED IN ({daysSinceInvite}d)
                        </span>
                      ) : neverLoggedIn ? (
                        <span className="text-[10px] font-bold bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">
                          INVITED ({daysSinceInvite}d)
                        </span>
                      ) : (
                        <span className="text-[10px] font-bold bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded">
                          ACTIVE
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-slate">
                      {m.last_login_at ? (
                        <>
                          <Clock size={10} className="inline mr-0.5" />
                          {timeAgo(m.last_login_at)}
                        </>
                      ) : (
                        <span className="italic text-ink-light">Never</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {m.active ? (
                        <div className="inline-flex gap-1">
                          <button
                            onClick={() => resend(m.user_email, m.user_full_name, m.client_link_id)}
                            title="Re-send magic link"
                            className="p-1.5 rounded hover:bg-slate-100 text-ink-slate hover:text-navy"
                          >
                            <RefreshCw size={13} />
                          </button>
                          <button
                            onClick={() => revoke(m.user_id, m.user_email)}
                            title="Revoke portal access"
                            className="p-1.5 rounded hover:bg-red-50 text-ink-slate hover:text-red-700"
                          >
                            <UserMinus size={13} />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => resend(m.user_email, m.user_full_name, m.client_link_id)}
                          title="Re-enable + resend magic link"
                          className="text-xs font-semibold text-teal hover:underline"
                        >
                          Re-enable
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="text-xs text-ink-light">
        <strong>Tip:</strong> The magic-link email comes from Supabase. If clients say they didn't get it,
        ask them to check spam. You can resend any time with the <RefreshCw size={10} className="inline" /> button.
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const mins = Math.floor(diffMs / 60_000);
  if (days >= 1) return `${days}d ago`;
  if (hours >= 1) return `${hours}h ago`;
  if (mins >= 1) return `${mins}m ago`;
  return "just now";
}
