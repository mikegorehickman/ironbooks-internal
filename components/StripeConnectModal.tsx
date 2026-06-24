"use client";

import { useEffect, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { createBrowserClient } from "@supabase/ssr";
import {
  X, Loader2, CreditCard, Copy, CheckCircle2, Search, Send, Mail, Unplug,
} from "lucide-react";
import type { Database } from "@/lib/database.types";
import { buildStripeConnectEmail } from "@/lib/stripe-connect-email";

interface ClientLite {
  id: string;
  client_name: string;
  stripe_connection_status: string | null;
}

export function StripeConnectModal({
  onClose,
  preselectedClientId,
}: {
  onClose: () => void;
  /** When provided, the modal opens with this client pre-selected and the
   *  picker scrolled to it. Used by the stripe-recon "all unmatched" panel
   *  so the bookkeeper goes straight from "AR matching failed" to
   *  "generate connect link for THIS client" with no extra clicks. */
  preselectedClientId?: string;
}) {
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string>(preselectedClientId || "");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<{
    url: string;
    expires_at: string;
    client_name: string;
  } | null>(null);
  const [copied, setCopied] = useState<"url" | "email" | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnectMessage, setDisconnectMessage] = useState<string>("");
  const [mounted, setMounted] = useState(false);
  // Direct send (the default now) — emails the client the branded connect
  // request via Resend + logs it, instead of copy/paste into Double.
  const [sendingDirect, setSendingDirect] = useState(false);
  const [sendResult, setSendResult] = useState<
    { kind: "sent"; to: string[] } | { kind: "no_address" } | { kind: "error"; msg: string } | null
  >(null);

  // Portal target only exists on the client — wait for hydration before rendering
  useEffect(() => {
    setMounted(true);
  }, []);

  // Lock body scroll while the modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  useEffect(() => {
    supabase
      .from("client_links")
      .select("id, client_name, stripe_connection_status")
      .eq("is_active", true)
      .order("client_name")
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setClients(data || []);
        setLoading(false);
        // Re-apply preselection after the list is in — covers the case
        // where the prop was set but `clients` hadn't loaded yet.
        if (preselectedClientId && !selectedId) {
          setSelectedId(preselectedClientId);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(
    () => clients.filter((c) => c.client_name.toLowerCase().includes(search.toLowerCase())),
    [clients, search]
  );

  const selected = clients.find((c) => c.id === selectedId);

  async function handleGenerate() {
    if (!selectedId) return;
    setGenerating(true);
    setError("");
    try {
      const res = await fetch("/api/stripe-connect/generate-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: selectedId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not generate link");
      setGenerated({ url: data.url, expires_at: data.expires_at, client_name: data.client_name });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  async function handleDisconnect() {
    if (!selectedId) return;
    setDisconnecting(true);
    setError("");
    setDisconnectMessage("");
    try {
      const res = await fetch("/api/stripe-connect/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: selectedId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not disconnect");
      // Locally flip the status so the UI reflects it without a reload
      setClients((prev) =>
        prev.map((c) =>
          c.id === selectedId ? { ...c, stripe_connection_status: "not_set" } : c
        )
      );
      setDisconnectMessage(data.message || "Disconnected.");
      setConfirmDisconnect(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDisconnecting(false);
    }
  }

  async function sendDirect() {
    if (!selectedId) return;
    setSendingDirect(true);
    setSendResult(null);
    setError("");
    try {
      const res = await fetch(`/api/clients/${selectedId}/send-stripe-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok && !data.no_address) throw new Error(data.error || "Could not send");
      if (data.no_address) setSendResult({ kind: "no_address" });
      else if (data.sent) setSendResult({ kind: "sent", to: data.addresses || [] });
      else setSendResult({ kind: "error", msg: data.error || "Email could not be sent" });
    } catch (e: any) {
      setSendResult({ kind: "error", msg: e.message });
    } finally {
      setSendingDirect(false);
    }
  }

  async function copyUrl() {
    if (!generated) return;
    await navigator.clipboard.writeText(generated.url);
    setCopied("url");
    setTimeout(() => setCopied(null), 2000);
  }

  async function copyEmail() {
    if (!generated) return;
    const firstName = generated.client_name.split(" ")[0] || "there";
    const { html, text: plain } = buildStripeConnectEmail(firstName, generated.url, generated.client_name);
    try {
      if (typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plain], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(plain);
      }
      setCopied("email");
      setTimeout(() => setCopied(null), 2500);
    } catch (err: any) {
      setError(err?.message || "Could not copy email");
    }
  }

  // Launched in-context (from a client's Stripe Recon page) → skip the picker
  // and generate the link straight away so the bookkeeper lands on the send step.
  useEffect(() => {
    if (preselectedClientId) handleGenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!mounted) return null;

  const modalContent = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(15, 31, 46, 0.6)", backdropFilter: "blur(4px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[92vh] flex flex-col relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-navy flex items-center gap-2">
              <CreditCard size={18} className="text-purple-600" />
              Stripe Connect Link
            </h3>
            <p className="text-xs text-ink-slate mt-1">
              Generate a one-time link for a client to connect their Stripe account.
              Valid for 7 days. Copy and send via Double or any other channel.
            </p>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy">
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
          {!generated && (
            <>
              {/* Client picker — hidden when a client is preselected (launched in-context) */}
              {!preselectedClientId && (
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-2">
                  Select Client
                </label>
                <div className="relative mb-2">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search clients..."
                    className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
                  />
                </div>
                <div className="rounded-lg border border-gray-200 max-h-72 overflow-y-auto">
                  {loading ? (
                    <div className="p-6 text-center text-ink-slate text-sm">
                      <Loader2 size={16} className="inline animate-spin mr-2" />
                      Loading clients...
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="p-6 text-center text-ink-slate text-sm">No matches.</div>
                  ) : (
                    filtered.map((c) => {
                      const isSelected = c.id === selectedId;
                      return (
                        <button
                          key={c.id}
                          onClick={() => setSelectedId(c.id)}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 text-left border-b border-gray-100 last:border-0 ${
                            isSelected ? "bg-teal-lighter" : "hover:bg-gray-50"
                          }`}
                        >
                          <div className="rounded-md flex items-center justify-center font-bold text-xs flex-shrink-0 w-8 h-8 bg-teal-light text-teal">
                            {c.client_name.charAt(0)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-sm text-navy truncate">{c.client_name}</div>
                            <div className="text-xs mt-0.5">
                              {c.stripe_connection_status === "connected" ? (
                                <span className="text-green-700">✓ Stripe connected</span>
                              ) : c.stripe_connection_status === "pending" ? (
                                <span className="text-amber-700">⏳ Pending connection</span>
                              ) : c.stripe_connection_status === "declined" ? (
                                <span className="text-ink-slate">Declined</span>
                              ) : (
                                <span className="text-ink-light">No Stripe connection</span>
                              )}
                            </div>
                          </div>
                          {isSelected && <CheckCircle2 size={16} className="text-teal flex-shrink-0" />}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
              )}

              {preselectedClientId && !generated && (
                <div className="p-8 text-center text-sm text-ink-slate">
                  <Loader2 size={18} className="inline animate-spin mr-2" />
                  Preparing the connect link…
                </div>
              )}

              {selected?.stripe_connection_status === "connected" && (
                <div className="p-4 bg-green-50 border border-green-200 rounded-lg space-y-3">
                  <div className="text-sm text-green-900">
                    <strong>{selected.client_name}</strong> already has Stripe connected.
                    Use Disconnect below if they requested removal or the wrong account
                    was connected.
                  </div>
                  {!confirmDisconnect ? (
                    <button
                      onClick={() => {
                        setConfirmDisconnect(true);
                        setError("");
                        setDisconnectMessage("");
                      }}
                      className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-red-700 hover:text-red-800"
                    >
                      <Unplug size={13} /> Disconnect Stripe
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <div className="text-xs text-red-800 font-semibold">
                        Confirm: revoke Ironbooks' access to {selected.client_name}'s Stripe?
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleDisconnect}
                          disabled={disconnecting}
                          className="inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold px-3 py-1.5 rounded-md"
                        >
                          {disconnecting ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Unplug size={12} />
                          )}
                          {disconnecting ? "Disconnecting..." : "Yes, disconnect"}
                        </button>
                        <button
                          onClick={() => setConfirmDisconnect(false)}
                          disabled={disconnecting}
                          className="text-xs font-semibold text-ink-slate hover:text-navy px-3 py-1.5"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {disconnectMessage && (
                <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                  {disconnectMessage}
                </div>
              )}

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
                  {error}
                </div>
              )}
            </>
          )}

          {/* Post-generation view */}
          {generated && (
            <div className="space-y-4">
              <div className="rounded-xl bg-gradient-to-br from-purple-50 to-pink-50 border border-purple-200 p-5">
                <div className="text-xs font-bold uppercase tracking-wider text-purple-700 mb-1">
                  ✓ Link generated
                </div>
                <div className="font-semibold text-navy">{generated.client_name}</div>
                <div className="text-xs text-ink-slate mt-1">
                  Expires {new Date(generated.expires_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                </div>
              </div>

              {/* URL + copy */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
                  Shareable URL
                </label>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={generated.url}
                    className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-xs text-navy bg-gray-50 font-mono"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    onClick={copyUrl}
                    className="inline-flex items-center gap-1.5 bg-navy hover:bg-ink-light text-white text-xs font-semibold px-3 py-2 rounded-lg"
                  >
                    {copied === "url" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                    {copied === "url" ? "Copied" : "Copy URL"}
                  </button>
                </div>
              </div>

              {/* Direct send (default) — email the client straight from SNAP */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
                  Send the email to the client
                </label>
                <p className="text-xs text-ink-slate mb-2">
                  Emails {generated.client_name} the branded connect request directly and logs it to
                  their Email History. Reminders go out automatically until they connect.
                </p>
                {sendResult?.kind === "sent" && (
                  <div className="mb-2 p-2.5 rounded-lg bg-green-50 border border-green-200 text-xs text-green-800">
                    ✓ Sent to {sendResult.to.join(", ")}.
                  </div>
                )}
                {sendResult?.kind === "no_address" && (
                  <div className="mb-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                    No email on file for this client. Add one on the client profile (or use the
                    Stripe Recon step, which lets you enter an address inline), then try again.
                  </div>
                )}
                {sendResult?.kind === "error" && (
                  <div className="mb-2 p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                    {sendResult.msg}
                  </div>
                )}
                <button
                  onClick={sendDirect}
                  disabled={sendingDirect}
                  className="w-full inline-flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
                >
                  {sendingDirect ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                  {sendingDirect ? "Sending…" : "Send email to client"}
                </button>
              </div>

              {/* Fallback: copy a branded email to send manually elsewhere */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
                  Or copy it to send manually
                </label>
                <button
                  onClick={copyEmail}
                  className="w-full inline-flex items-center justify-center gap-2 bg-white border border-gray-200 hover:bg-gray-50 text-navy text-sm font-semibold px-5 py-2.5 rounded-lg"
                >
                  {copied === "email" ? <CheckCircle2 size={15} /> : <Mail size={15} />}
                  {copied === "email" ? "Copied to clipboard!" : "Copy branded email"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
          <button
            onClick={onClose}
            className="text-sm font-semibold text-ink-slate hover:text-navy"
          >
            Close
          </button>
          {!generated && !preselectedClientId && (
            <button
              onClick={handleGenerate}
              disabled={!selectedId || generating}
              className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            >
              {generating ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {generating ? "Generating..." : "Generate Link"}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
