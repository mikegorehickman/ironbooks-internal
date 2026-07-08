"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CreditCard, X, Send, Clock, Loader2, RefreshCw, CheckCircle2, MousePointerClick, MailOpen, AlertTriangle } from "lucide-react";
import { StripeConnectModal } from "@/components/StripeConnectModal";

export interface StripeInviteSuggestion {
  client_link_id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  deposit_count: number;
  deposit_total: number;
  suggested_at: string;
  /** Send state (null until we've emailed a connect request). */
  requested_at: string | null;
  to_address: string | null;
  delivery_status: string | null; // sent | delivered | opened | clicked | bounced | complained | failed
  expires_at: string | null;
  expired: boolean;
}

/**
 * "Pending Stripe Invites Detected" — clients with Stripe-tagged QBO deposits
 * but no Stripe connection. Split in two:
 *   • Top: not yet invited → one-click "Send invite" (opens the Connect modal
 *     pre-selected, where you can preview + send the branded email from SNAP).
 *   • Bottom: already requested → last-requested date, delivery status
 *     (delivered / opened / clicked / bounced / expired) so you can see at a
 *     glance whether to resend. "Resend" reopens the modal for a fresh link.
 */
export function StripeInviteSuggestions({
  suggestions: initial,
}: {
  suggestions: StripeInviteSuggestion[];
}) {
  const router = useRouter();
  const [suggestions, setSuggestions] = useState(initial);
  const [openModalForClient, setOpenModalForClient] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [error, setError] = useState<string>("");

  async function handleDismiss(s: StripeInviteSuggestion) {
    if (
      !confirm(
        `Stop suggesting Stripe invites for ${s.client_name}?\n\n` +
          `Choose this if:\n` +
          `• They already have the link\n` +
          `• Their "Stripe" deposits aren't actually Stripe\n` +
          `• You don't want to invite them right now\n\n` +
          `You can re-enable suggestions later if needed.`
      )
    )
      return;
    setDismissing(s.client_link_id);
    setError("");
    try {
      const res = await fetch(
        `/api/clients/${s.client_link_id}/stripe-invite-dismiss`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSuggestions((prev) => prev.filter((x) => x.client_link_id !== s.client_link_id));
      router.refresh();
    } catch (e: any) {
      setError(`${s.client_name}: ${e.message || "Failed to dismiss"}`);
      setDismissing(null);
    }
  }

  if (suggestions.length === 0) return null;

  const formatCurrency = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
  const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const pending = suggestions.filter((s) => !s.requested_at);
  const requested = suggestions.filter((s) => s.requested_at);

  return (
    <>
      <div className="rounded-xl bg-white border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 bg-gradient-to-r from-purple-50 to-white">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-purple-100">
                <CreditCard size={16} className="text-purple-700" />
              </div>
              <div>
                <h2 className="text-base font-bold text-navy">Pending Stripe Invites Detected</h2>
                <p className="text-xs text-ink-slate mt-0.5">
                  Clients with Stripe deposits in QBO over the last 3 months but no Stripe connection yet.
                  Sending the Connect link unlocks deterministic recon.
                </p>
              </div>
            </div>
            <span className="rounded-full bg-purple-600 text-white text-xs font-bold px-2.5 py-1">
              {suggestions.length}
            </span>
          </div>
        </div>

        {error && (
          <div className="m-4 p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
            {error}
          </div>
        )}

        {/* Not yet invited — the action list */}
        <div className="divide-y divide-gray-100">
          {pending.map((s) => (
            <div key={s.client_link_id} className="flex items-center gap-4 px-5 py-3 hover:bg-purple-50/30 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-navy">{s.client_name}</span>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-ink-light">
                    {s.jurisdiction}{s.state_province ? ` · ${s.state_province}` : ""}
                  </span>
                </div>
                <div className="text-xs text-ink-slate mt-0.5 flex items-center gap-3 flex-wrap">
                  <span>
                    <strong className="text-navy">{s.deposit_count}</strong> Stripe deposit{s.deposit_count === 1 ? "" : "s"} totaling{" "}
                    <strong className="text-navy">{formatCurrency(s.deposit_total)}</strong>
                  </span>
                  <span className="flex items-center gap-1 text-ink-light">
                    <Clock size={11} />
                    Detected {fmtDate(s.suggested_at)}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => setOpenModalForClient(s.client_link_id)}
                  className="inline-flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold px-3 py-1.5 rounded-md"
                  title="Open the Stripe Connect modal pre-selected for this client"
                >
                  <Send size={12} /> Send invite
                </button>
                <button
                  onClick={() => handleDismiss(s)}
                  disabled={dismissing === s.client_link_id}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-60 px-2 py-1.5"
                  title="Stop suggesting Stripe invites for this client"
                >
                  {dismissing === s.client_link_id ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Already requested — status + resend */}
        {requested.length > 0 && (
          <div className="border-t border-gray-200">
            <div className="px-5 py-2 bg-gray-50 text-[11px] font-bold uppercase tracking-wider text-ink-light">
              Invite sent · {requested.length} awaiting connection
            </div>
            <div className="divide-y divide-gray-100">
              {requested.map((s) => (
                <RequestedRow
                  key={s.client_link_id}
                  s={s}
                  fmtDate={fmtDate}
                  dismissing={dismissing === s.client_link_id}
                  onResend={() => setOpenModalForClient(s.client_link_id)}
                  onDismiss={() => handleDismiss(s)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {openModalForClient && (
        <StripeConnectModal
          onClose={() => setOpenModalForClient(null)}
          preselectedClientId={openModalForClient}
        />
      )}
    </>
  );
}

function inviteStatus(s: StripeInviteSuggestion): { label: string; cls: string; Icon: any } {
  if (s.delivery_status && ["bounced", "complained", "failed"].includes(s.delivery_status))
    return { label: s.delivery_status === "failed" ? "Send failed" : "Bounced — bad email", cls: "bg-red-100 text-red-800", Icon: AlertTriangle };
  if (s.expired)
    return { label: "Link expired", cls: "bg-amber-100 text-amber-800", Icon: AlertTriangle };
  switch (s.delivery_status) {
    case "clicked": return { label: "Clicked link", cls: "bg-emerald-100 text-emerald-800", Icon: MousePointerClick };
    case "opened": return { label: "Opened", cls: "bg-blue-100 text-blue-800", Icon: MailOpen };
    case "delivered": return { label: "Delivered", cls: "bg-slate-100 text-slate-700", Icon: CheckCircle2 };
    case "sent": return { label: "Sent", cls: "bg-slate-100 text-slate-600", Icon: CheckCircle2 };
    default: return { label: "Requested", cls: "bg-slate-100 text-slate-600", Icon: CheckCircle2 };
  }
}

function RequestedRow({
  s, fmtDate, dismissing, onResend, onDismiss,
}: {
  s: StripeInviteSuggestion;
  fmtDate: (d: string) => string;
  dismissing: boolean;
  onResend: () => void;
  onDismiss: () => void;
}) {
  const st = inviteStatus(s);
  const needsResend = s.expired || (!!s.delivery_status && ["bounced", "complained", "failed"].includes(s.delivery_status));
  return (
    <div className="flex items-center gap-4 px-5 py-3 hover:bg-gray-50/60 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm text-navy">{s.client_name}</span>
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${st.cls}`}>
            <st.Icon size={11} /> {st.label}
          </span>
        </div>
        <div className="text-xs text-ink-slate mt-0.5 flex items-center gap-3 flex-wrap">
          {s.requested_at && <span>Requested {fmtDate(s.requested_at)}</span>}
          {s.to_address && <span className="text-ink-light">→ {s.to_address}</span>}
          {s.expires_at && (
            <span className={`flex items-center gap-1 ${s.expired ? "text-amber-700 font-semibold" : "text-ink-light"}`}>
              <Clock size={11} />
              {s.expired ? `expired ${fmtDate(s.expires_at)}` : `link expires ${fmtDate(s.expires_at)}`}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={onResend}
          className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md ${
            needsResend ? "bg-purple-600 hover:bg-purple-700 text-white" : "border border-gray-200 text-ink-slate hover:bg-gray-50"
          }`}
          title="Generate a fresh link and resend the connect email"
        >
          <RefreshCw size={12} /> Resend
        </button>
        <button
          onClick={onDismiss}
          disabled={dismissing}
          className="inline-flex items-center gap-1 text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-60 px-2 py-1.5"
          title="Stop suggesting Stripe invites for this client"
        >
          {dismissing ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
          Dismiss
        </button>
      </div>
    </div>
  );
}
