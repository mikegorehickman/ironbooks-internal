"use client";

import { useEffect, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { createBrowserClient } from "@supabase/ssr";
import {
  X, Loader2, CreditCard, Copy, CheckCircle2, Search, Send, Mail, Unplug, Eye, EyeOff,
} from "lucide-react";
import type { Database } from "@/lib/database.types";

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
    contact_first_name: string | null;
  } | null>(null);
  const [copied, setCopied] = useState<"url" | "email" | null>(null);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string[] | null>(null);
  const [needEmail, setNeedEmail] = useState(false);
  const [overrideEmail, setOverrideEmail] = useState("");
  const [sendError, setSendError] = useState("");
  const [preview, setPreview] = useState<{ html: string; subject: string; recipients: string[]; no_address: boolean } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnectMessage, setDisconnectMessage] = useState<string>("");
  const [mounted, setMounted] = useState(false);

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
      setGenerated({ url: data.url, expires_at: data.expires_at, client_name: data.client_name, contact_first_name: data.contact_first_name ?? null });
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

  async function loadPreview(address?: string) {
    if (!selectedId) return;
    try {
      const res = await fetch(`/api/clients/${selectedId}/preview-stripe-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(address ? { override_email: address } : {}),
      });
      const data = await res.json();
      if (res.ok) setPreview(data);
    } catch {
      /* preview is best-effort */
    }
  }

  // Fetch the preview as soon as a link exists, so the recipient + rendered
  // email are visible before the bookkeeper sends.
  useEffect(() => {
    if (generated) loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generated]);

  async function handleSendEmail(address?: string) {
    if (!selectedId) return;
    setSending(true);
    setSendError("");
    try {
      const res = await fetch(`/api/clients/${selectedId}/send-stripe-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(address ? { override_email: address } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not send the email");
      if (data.no_address) {
        // Nothing on file — reveal the address input so the bookkeeper can supply one.
        setNeedEmail(true);
        if (data.error) setSendError(data.error);
        return;
      }
      setSentTo(data.addresses || []);
      setNeedEmail(false);
    } catch (e: any) {
      setSendError(e.message);
    } finally {
      setSending(false);
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
    const firstName = (generated.contact_first_name || "").trim() || generated.client_name.split(" ")[0] || "there";
    const html = buildEmailHtml(firstName, generated.url, generated.client_name);
    const plain = buildEmailPlainText(firstName, generated.url, generated.client_name);
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
              <CreditCard size={18} className="text-teal-dark" />
              Stripe Connect Link
            </h3>
            <p className="text-xs text-ink-slate mt-1">
              Generate a one-time link for a client to connect their Stripe account.
              Valid for 7 days. Send it by email straight from SNAP, or copy it to
              send yourself.
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
              <div className="rounded-xl bg-teal-light border border-teal-border p-5">
                <div className="text-xs font-bold uppercase tracking-wider text-teal-dark mb-1">
                  ✓ Link generated
                </div>
                <div className="font-semibold text-navy">{generated.client_name}</div>
                <div className="text-xs text-ink-slate mt-1">
                  Expires {new Date(generated.expires_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                </div>
              </div>

              {/* Direct send from SNAP (primary path) */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
                  Send from SNAP
                </label>
                {sentTo ? (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800 flex items-start gap-2">
                    <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold">Email sent to {sentTo.join(", ")}</div>
                      <div className="text-xs mt-0.5 text-green-700">
                        Branded connect-request with a fresh 7-day link. A copy of the ask was also posted to their portal inbox.
                      </div>
                    </div>
                  </div>
                ) : needEmail ? (
                  <div className="space-y-2">
                    <p className="text-xs text-amber-700">
                      No usable email on file for this client — enter one below. It will be saved to their profile.
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        type="email"
                        value={overrideEmail}
                        onChange={(e) => setOverrideEmail(e.target.value)}
                        placeholder="client@example.com"
                        className="flex-1 px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
                      />
                      <button
                        onClick={() => handleSendEmail(overrideEmail)}
                        disabled={sending || !overrideEmail.includes("@")}
                        className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded-lg"
                      >
                        {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                        Send
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className="text-xs text-ink-slate">
                        {preview?.recipients?.length
                          ? <>Will send to <strong className="text-navy">{preview.recipients.join(", ")}</strong></>
                          : "Emails the branded connect request straight to the client's address on file."}
                      </p>
                      <button
                        onClick={() => setShowPreview((v) => !v)}
                        disabled={!preview}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-teal hover:text-teal-dark disabled:opacity-40 flex-shrink-0"
                      >
                        {showPreview ? <EyeOff size={13} /> : <Eye size={13} />}
                        {showPreview ? "Hide preview" : "Preview email"}
                      </button>
                    </div>
                    {showPreview && preview && (
                      <div className="mb-2 rounded-lg border border-gray-200 overflow-hidden">
                        <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 text-[11px] text-ink-slate">
                          <span className="font-semibold text-navy">Subject:</span> {preview.subject}
                        </div>
                        <iframe
                          title="Email preview"
                          srcDoc={preview.html}
                          className="w-full h-72 bg-white"
                          sandbox=""
                        />
                      </div>
                    )}
                    <button
                      onClick={() => handleSendEmail()}
                      disabled={sending}
                      className="w-full inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
                    >
                      {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                      {sending ? "Sending..." : preview?.recipients?.length ? `Send to ${preview.recipients.length > 1 ? `${preview.recipients.length} recipients` : preview.recipients[0]}` : "Send Email to Client"}
                    </button>
                  </>
                )}
                {sendError && (
                  <div className="mt-2 p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
                    {sendError}
                  </div>
                )}
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

              {/* Email composer (copy/paste fallback) */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
                  Or copy a full email to send yourself
                </label>
                <p className="text-xs text-ink-slate mb-2">
                  Same branded email, copied to your clipboard — paste into Gmail or any rich-text editor if you'd rather send it from your own inbox.
                </p>
                <button
                  onClick={copyEmail}
                  className="w-full inline-flex items-center justify-center gap-2 bg-navy hover:bg-navy-deep text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
                >
                  {copied === "email" ? <CheckCircle2 size={15} /> : <Mail size={15} />}
                  {copied === "email" ? "Copied!" : "Copy Branded Email to Clipboard"}
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
              className="inline-flex items-center gap-2 bg-navy hover:bg-navy-deep disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
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

// ─── Branded email content for clipboard ───

function buildEmailHtml(firstName: string, url: string, clientName: string) {
  const BRAND = {
    teal: "#2D7A75",
    tealDark: "#1F5D58",
    tealLighter: "#F4F9F8",
    navy: "#0F1F2E",
    slate: "#475569",
    lightSlate: "#94A3B8",
    border: "#CBD5E1",
    white: "#FFFFFF",
    stripe: "#635BFF",
  };
  return `<div style="font-family:'Figtree','Helvetica Neue',Helvetica,Arial,sans-serif;color:${BRAND.navy};max-width:640px;margin:0 auto;background:${BRAND.white};">
  <div style="background:${BRAND.navy};color:${BRAND.white};padding:18px 22px;border-radius:10px 10px 0 0;">
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="vertical-align:middle;width:54px;padding-right:14px;">
          <img src="https://internal.ironbooks.com/logo.png" alt="Ironbooks" width="44" height="44" style="display:block;width:44px;height:auto;" />
        </td>
        <td style="vertical-align:middle;color:${BRAND.white};">
          <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;line-height:1.1;color:${BRAND.white};">Ironbooks</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-top:3px;letter-spacing:0.06em;text-transform:uppercase;">Bookkeeping &middot; Cleanup</div>
        </td>
      </tr>
    </table>
  </div>
  <div style="border:1px solid ${BRAND.border};border-top:none;padding:24px 22px;border-radius:0 0 10px 10px;background:${BRAND.white};">
    <p style="margin:0 0 14px 0;color:${BRAND.navy};line-height:1.55;">Hi ${firstName},</p>
    <p style="margin:0 0 14px 0;color:${BRAND.navy};line-height:1.55;">As we clean up your books for ${clientName}, we'd like to connect to your Stripe account so we can match your Stripe deposits directly to the invoices in QuickBooks. This makes the books significantly more accurate and saves us hours of guesswork.</p>
    <p style="margin:0 0 18px 0;color:${BRAND.navy};line-height:1.55;">Click the button below to connect — it'll take about 30 seconds:</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${url}" style="display:inline-block;background:${BRAND.stripe};color:${BRAND.white};font-weight:600;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none;">Connect Stripe to Ironbooks &rarr;</a>
    </div>
    <div style="background:${BRAND.tealLighter};border:1px solid ${BRAND.border};border-radius:8px;padding:14px 16px;margin:18px 0;">
      <div style="font-size:13px;font-weight:600;color:${BRAND.teal};margin-bottom:8px;">What this gives us</div>
      <ul style="margin:0;padding-left:18px;color:${BRAND.slate};font-size:13px;line-height:1.6;">
        <li><strong style="color:${BRAND.navy};">Just for reconciliation</strong> — we look at your payouts, charges, and balance transactions to match them to invoices</li>
        <li><strong style="color:${BRAND.navy};">No charges, no transfers</strong> — Ironbooks won't issue refunds, move money, or charge your customers</li>
        <li><strong style="color:${BRAND.navy};">Disconnect anytime</strong> — from your Stripe Dashboard (Settings &rarr; Connected applications), or just ask us</li>
      </ul>
    </div>
    <p style="margin:18px 0 0 0;color:${BRAND.navy};line-height:1.55;">The link expires in 7 days. If you have questions or want a walkthrough, just reply to this email.</p>
    <p style="margin:14px 0 0 0;color:${BRAND.navy};line-height:1.55;">Kindly,<br>Ironbooks</p>
    <div style="border-top:2px solid ${BRAND.teal};margin:24px 0 12px 0;width:60px;"></div>
    <div style="color:${BRAND.lightSlate};font-size:11px;line-height:1.5;">If the button above doesn't work, copy and paste this URL into your browser:<br><span style="color:${BRAND.teal};word-break:break-all;">${url}</span></div>
  </div>
</div>`;
}

function buildEmailPlainText(firstName: string, url: string, clientName: string) {
  return `Hi ${firstName},

As we clean up your books for ${clientName}, we'd like to connect to your Stripe account so we can match your Stripe deposits directly to the invoices in QuickBooks.

Click here to connect (takes about 30 seconds):
${url}

What this gives us:
  • Just for reconciliation — we look at your payouts, charges, and balance transactions to match them to invoices
  • No charges, no transfers — Ironbooks won't issue refunds, move money, or charge your customers
  • Disconnect anytime — from your Stripe Dashboard (Settings → Connected applications), or just ask us

The link expires in 7 days.

Kindly,
Ironbooks`;
}
