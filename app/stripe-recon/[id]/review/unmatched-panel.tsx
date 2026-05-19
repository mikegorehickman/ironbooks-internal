"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, CreditCard, Loader2, ArrowRight, CheckCircle2,
} from "lucide-react";
import { StripeConnectModal } from "@/components/StripeConnectModal";
import { UpgradeToStripeApiButton } from "./upgrade-button";

/**
 * Review-page sub-screen shown when EVERY Stripe deposit has zero QBO
 * candidates within ±30 days. Splits into two flavors:
 *
 *  - Client is NOT yet Stripe-connected: this is the Despres scenario.
 *    Primary CTA "Send Stripe Connect link" + secondary "Acknowledge
 *    & finish" so the bookkeeper can close out this cycle and pick
 *    it up later.
 *
 *  - Client IS already Stripe-connected (e.g. James Painting): the
 *    Connect-link CTA is redundant. The primary action here is "Re-run
 *    with Stripe API" — the deterministic path doesn't need QBO
 *    invoices at all, so re-running will succeed where the AI matcher
 *    couldn't. Acknowledge & finish stays as the secondary option.
 */
export function UnmatchedPanel({
  jobId,
  clientLinkId,
  clientName,
  depositCount,
  totalAmount,
  reclassJobId,
  stripeConnected,
  dateRangeStart,
  dateRangeEnd,
}: {
  jobId: string;
  clientLinkId: string;
  clientName: string;
  depositCount: number;
  totalAmount: number;
  reclassJobId: string | null;
  /** Whether this client currently has Stripe connected. When true, the
   *  panel surfaces a "Re-run with Stripe API" CTA instead of pushing
   *  another Connect link (the AI matcher only failed because there
   *  are no QBO invoices to match against — Stripe API doesn't need
   *  them, so the re-run will succeed). */
  stripeConnected: boolean;
  /** Used to pre-fill the same date range on the Stripe-API re-run. */
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
}) {
  const router = useRouter();
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [error, setError] = useState<string>("");


  async function handleAcknowledge() {
    if (!confirm(
      `Mark this Stripe reconciliation as finished without matching?\n\n` +
      `• All ${depositCount} deposits will remain flagged in the database.\n` +
      `• The cleanup will continue and this account closes out.\n` +
      `• You can re-run the recon later if ${clientName} connects Stripe.`
    )) return;

    setAcknowledging(true);
    setError("");
    try {
      const res = await fetch(`/api/stripe-recon/${jobId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      router.push(data.next || (reclassJobId ? `/reclass/${reclassJobId}/execute` : "/clients"));
    } catch (e: any) {
      setError(e.message || "Failed to acknowledge");
      setAcknowledging(false);
    }
  }

  const formattedAmount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(totalAmount);

  return (
    <>
      <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5 max-w-2xl">
        {/* Header */}
        <div className="flex items-start gap-3">
          <AlertTriangle className="text-amber-600 flex-shrink-0 mt-0.5" size={24} />
          <div>
            <h2 className="text-lg font-bold text-navy">
              AR matching isn&apos;t possible for this client
            </h2>
            <p className="text-sm text-ink-slate mt-1">
              We found <span className="font-semibold">{depositCount} Stripe deposits</span>{" "}
              totaling <span className="font-semibold">{formattedAmount}</span>, but{" "}
              <span className="font-semibold">no QBO invoices or customer payments</span>{" "}
              exist within ±30 days of any of them.
            </p>
          </div>
        </div>

        {/* Why */}
        <div className="p-3 rounded-lg bg-gray-50 border border-gray-200 text-xs text-ink-slate leading-relaxed">
          <span className="font-semibold text-navy">What this means:</span>{" "}
          {clientName} likely takes payment through Stripe directly — Payment
          Links, subscriptions, or Stripe Invoicing — without creating QBO
          Invoice records. The deposits land in QBO but the receivable side
          doesn&apos;t exist, so there&apos;s nothing for the AI to match against.
        </div>

        {stripeConnected ? (
          /* Path 1 (Stripe IS connected): re-run with the deterministic
             Stripe API path. This is the right CTA when the client has
             already connected — the AI matcher just failed because
             there are no QBO invoices, but the Stripe API path doesn't
             need them. */
          <div className="pt-2 border-t border-gray-100 space-y-3">
            <div>
              <p className="text-sm font-semibold text-navy">
                ✓ {clientName} is connected to Stripe — re-run with the deterministic path
              </p>
              <p className="text-xs text-ink-slate mt-1">
                The AI matcher couldn&apos;t match these deposits because there
                are no QBO invoices. The <strong>Stripe API</strong> path
                doesn&apos;t need QBO invoices — it pulls exact charges, fees,
                and customers straight from Stripe. Re-run will succeed
                where this one couldn&apos;t.
              </p>
            </div>
            <UpgradeToStripeApiButton
              jobId={jobId}
              clientLinkId={clientLinkId}
              dateRangeStart={dateRangeStart}
              dateRangeEnd={dateRangeEnd}
              variant="primary"
              label="Re-run with Stripe API"
            />
          </div>
        ) : (
          /* Path 1 (Stripe NOT connected): send Connect link to client. */
          <div className="pt-2 border-t border-gray-100 space-y-3">
            <div>
              <p className="text-sm font-semibold text-navy">
                Recommended: Connect Stripe for deterministic matching
              </p>
              <p className="text-xs text-ink-slate mt-1">
                Once {clientName} connects Stripe, the recon pulls exact charges,
                fees, and customers directly from Stripe — no AI guessing, no
                QBO invoices required. Generate a link and email it in two clicks:
              </p>
            </div>
            <button
              onClick={() => setConnectModalOpen(true)}
              className="w-full inline-flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            >
              <CreditCard size={16} />
              Send Stripe Connect link to {clientName}
            </button>
          </div>
        )}

        {/* Path 2: Acknowledge */}
        <div className="pt-3 border-t border-gray-100 space-y-3">
          <div>
            <p className="text-sm font-semibold text-navy">
              Or: acknowledge and finish the account
            </p>
            <p className="text-xs text-ink-slate mt-1">
              {stripeConnected
                ? `If you don't want to re-run right now, you can close out this cycle. The deposits stay flagged in the database with an audit note so you can pick this up later.`
                : `If you don't want to wait for ${clientName} to connect, you can close out this cycle and come back later. The deposits stay flagged in the database with an audit note so you can pick this up when they're ready.`}
            </p>
          </div>
          {error && (
            <div className="p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
              {error}
            </div>
          )}
          <button
            onClick={handleAcknowledge}
            disabled={acknowledging}
            className="w-full inline-flex items-center justify-center gap-2 bg-white hover:bg-gray-50 disabled:opacity-60 border border-gray-200 text-navy text-sm font-semibold px-5 py-2.5 rounded-lg"
          >
            {acknowledging ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <CheckCircle2 size={16} />
            )}
            {acknowledging
              ? "Marking finished..."
              : `Acknowledge & finish (${reclassJobId ? "continue cleanup" : "back to clients"})`}
            <ArrowRight size={14} />
          </button>
        </div>
      </div>

      {connectModalOpen && (
        <StripeConnectModal
          onClose={() => setConnectModalOpen(false)}
          preselectedClientId={clientLinkId}
        />
      )}
    </>
  );
}
