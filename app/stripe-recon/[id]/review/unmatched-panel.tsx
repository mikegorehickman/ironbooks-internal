"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, CreditCard, Loader2, ArrowRight, CheckCircle2,
} from "lucide-react";
import { StripeConnectModal } from "@/components/StripeConnectModal";

/**
 * Review-page sub-screen shown when EVERY Stripe deposit has zero QBO
 * candidates within ±30 days (the Despres Painting class of failure — the
 * client doesn't invoice through QBO, so AR matching is structurally
 * impossible). Two clear actions:
 *
 * 1. Send Stripe Connect link → opens the existing connect modal with this
 *    client pre-selected, so the bookkeeper can generate the link + copy
 *    the branded email in two clicks.
 * 2. Acknowledge & finish → marks the recon job complete with an explicit
 *    audit note, redirects to the parent reclass job (or /clients if
 *    standalone). The deposits will need to be reconciled later, but
 *    Despres-style clients can be "finished" for this cycle without
 *    leaving phantom flagged rows in the bookkeeper's queue.
 */
export function UnmatchedPanel({
  jobId,
  clientLinkId,
  clientName,
  depositCount,
  totalAmount,
  reclassJobId,
}: {
  jobId: string;
  clientLinkId: string;
  clientName: string;
  depositCount: number;
  totalAmount: number;
  reclassJobId: string | null;
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

        {/* Path 1: Send connect link */}
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

        {/* Path 2: Acknowledge */}
        <div className="pt-3 border-t border-gray-100 space-y-3">
          <div>
            <p className="text-sm font-semibold text-navy">
              Or: acknowledge and finish the account
            </p>
            <p className="text-xs text-ink-slate mt-1">
              If you don&apos;t want to wait for {clientName} to connect, you can
              close out this cycle and come back later. The deposits stay
              flagged in the database with an audit note so you can pick this
              up when they&apos;re ready.
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
