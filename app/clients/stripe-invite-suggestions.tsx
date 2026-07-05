"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CreditCard, X, Send, Clock, Loader2 } from "lucide-react";
import { StripeConnectModal } from "@/components/StripeConnectModal";

export interface StripeInviteSuggestion {
  client_link_id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  deposit_count: number;
  deposit_total: number;
  suggested_at: string;
}

/**
 * Dashboard widget — "Pending Stripe Invites Detected".
 *
 * Detector cron runs nightly; each row here is a client where we found
 * Stripe-tagged QBO deposits in the last 3 months but the client isn't
 * connected. One click on "Send invite" opens the existing Stripe
 * Connect modal pre-selected on the right client, so the bookkeeper
 * goes straight from "the dashboard told me X needs a link" → generate
 * → copy email → paste into Double. Six manual steps collapse to two.
 *
 * "Dismiss" is the escape hatch — sets stripe_invite_dismissed_at so we
 * stop suggesting this client. Bookkeeper might dismiss because:
 *  - Client already has the link, just hasn't clicked
 *  - Client doesn't use Stripe in any meaningful way
 *  - The QBO deposits matching our "stripe" regex aren't actually Stripe
 */
export function StripeInviteSuggestions({
  suggestions: initial,
}: {
  suggestions: StripeInviteSuggestion[];
}) {
  const router = useRouter();
  const [suggestions, setSuggestions] = useState(initial);
  const [openModalForClient, setOpenModalForClient] = useState<string | null>(
    null
  );
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
      setSuggestions((prev) =>
        prev.filter((x) => x.client_link_id !== s.client_link_id)
      );
      router.refresh();
    } catch (e: any) {
      setError(`${s.client_name}: ${e.message || "Failed to dismiss"}`);
      setDismissing(null);
    }
  }

  if (suggestions.length === 0) return null;

  const formatCurrency = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(n);

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
                <h2 className="text-base font-bold text-navy">
                  Pending Stripe Invites Detected
                </h2>
                <p className="text-xs text-ink-slate mt-0.5">
                  {suggestions.length} client
                  {suggestions.length !== 1 ? "s" : ""} have Stripe deposits in
                  QBO over the last 3 months but no Stripe connection yet.
                  Sending the Connect link unlocks deterministic recon for them.
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

        <div className="divide-y divide-gray-100">
          {suggestions.map((s) => (
            <div
              key={s.client_link_id}
              className="flex items-center gap-4 px-5 py-3 hover:bg-purple-50/30 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-navy">
                    {s.client_name}
                  </span>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-ink-light">
                    {s.jurisdiction}
                    {s.state_province ? ` · ${s.state_province}` : ""}
                  </span>
                </div>
                <div className="text-xs text-ink-slate mt-0.5 flex items-center gap-3 flex-wrap">
                  <span>
                    <strong className="text-navy">{s.deposit_count}</strong>{" "}
                    Stripe deposit{s.deposit_count === 1 ? "" : "s"} totaling{" "}
                    <strong className="text-navy">
                      {formatCurrency(s.deposit_total)}
                    </strong>
                  </span>
                  <span className="flex items-center gap-1 text-ink-light">
                    <Clock size={11} />
                    Detected {new Date(s.suggested_at).toLocaleDateString()}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => setOpenModalForClient(s.client_link_id)}
                  className="inline-flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold px-3 py-1.5 rounded-md"
                  title="Open the Stripe Connect modal pre-selected for this client"
                >
                  <Send size={12} />
                  Send invite
                </button>
                <button
                  onClick={() => handleDismiss(s)}
                  disabled={dismissing === s.client_link_id}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-60 px-2 py-1.5"
                  title="Stop suggesting Stripe invites for this client"
                >
                  {dismissing === s.client_link_id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <X size={12} />
                  )}
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
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
