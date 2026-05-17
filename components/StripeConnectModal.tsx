"use client";

import { useEffect, useState, useMemo } from "react";
import { createBrowserClient } from "@supabase/ssr";
import {
  X, Loader2, CreditCard, Copy, CheckCircle2, Search, Send, Mail,
} from "lucide-react";
import type { Database } from "@/lib/database.types";

interface ClientLite {
  id: string;
  client_name: string;
  stripe_connection_status: string | null;
}

export function StripeConnectModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<{
    url: string;
    expires_at: string;
    client_name: string;
  } | null>(null);
  const [copied, setCopied] = useState<"url" | "email" | null>(null);

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
      });
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

  async function copyUrl() {
    if (!generated) return;
    await navigator.clipboard.writeText(generated.url);
    setCopied("url");
    setTimeout(() => setCopied(null), 2000);
  }

  async function copyEmail() {
    if (!generated) return;
    const firstName = generated.client_name.split(" ")[0] || "there";
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

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-navy flex items-center gap-2">
              <CreditCard size={18} className="text-purple-600" />
              Stripe Connect Link
            </h3>
            <p className="text-xs text-ink-slate mt-1">
              Generate a one-time link for a client to connect their Stripe (read-only OAuth).
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
              {/* Client picker */}
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

              {selected?.stripe_connection_status === "connected" && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900">
                  This client already has Stripe connected. Generating a new link will replace the existing connection once they complete OAuth again.
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

              {/* Email composer (copy/paste into Double) */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
                  Or copy a full email to send
                </label>
                <p className="text-xs text-ink-slate mb-2">
                  Includes the link with branded styling. Paste into the Double client portal email or any rich-text editor.
                </p>
                <button
                  onClick={copyEmail}
                  className="w-full inline-flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
                >
                  {copied === "email" ? <CheckCircle2 size={15} /> : <Mail size={15} />}
                  {copied === "email" ? "Copied — paste into Double!" : "Copy Branded Email to Clipboard"}
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
          {!generated && (
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
    <p style="margin:0 0 14px 0;color:${BRAND.navy};line-height:1.55;">As we clean up your books for ${clientName}, we'd like read-only access to your Stripe account so we can match your Stripe deposits directly to the invoices in QuickBooks. This makes the books significantly more accurate and saves us hours of guesswork.</p>
    <p style="margin:0 0 18px 0;color:${BRAND.navy};line-height:1.55;">Click the button below to connect — it'll take about 30 seconds:</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${url}" style="display:inline-block;background:${BRAND.stripe};color:${BRAND.white};font-weight:600;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none;">Connect Stripe to Ironbooks &rarr;</a>
    </div>
    <div style="background:${BRAND.tealLighter};border:1px solid ${BRAND.border};border-radius:8px;padding:14px 16px;margin:18px 0;">
      <div style="font-size:13px;font-weight:600;color:${BRAND.teal};margin-bottom:8px;">What this gives us</div>
      <ul style="margin:0;padding-left:18px;color:${BRAND.slate};font-size:13px;line-height:1.6;">
        <li><strong style="color:${BRAND.navy};">Read-only access</strong> to your payouts, charges, and balance transactions — nothing else</li>
        <li><strong style="color:${BRAND.navy};">No write access</strong> — we can't move money, change settings, or refund customers</li>
        <li><strong style="color:${BRAND.navy};">Revoke anytime</strong> from your Stripe Dashboard &rarr; Settings &rarr; Connected applications</li>
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

As we clean up your books for ${clientName}, we'd like read-only access to your Stripe account so we can match your Stripe deposits directly to the invoices in QuickBooks.

Click here to connect (takes about 30 seconds):
${url}

What this gives us:
  • Read-only access to your payouts, charges, and balance transactions — nothing else
  • No write access — we can't move money, change settings, or refund customers
  • Revoke anytime from your Stripe Dashboard → Settings → Connected applications

The link expires in 7 days.

Kindly,
Ironbooks`;
}
