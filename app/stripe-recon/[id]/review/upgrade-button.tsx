"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ArrowRight, Loader2 } from "lucide-react";

/**
 * "Upgrade to Stripe API" CTA button.
 *
 * Breaks the loop that existed before: the upgrade banner used to be a
 * <Link> to /stripe-recon/new, but the new-recon form's concurrency
 * pre-check would see the current job (still in_review) and refuse,
 * routing the user back to this page → upgrade banner → new form → ...
 *
 * This button acknowledges the current job FIRST (marks it complete
 * with a reason that says "closed to upgrade to Stripe API"), THEN
 * navigates to the new-recon form. By the time the user lands, the
 * pre-check sees no active job and the form submits cleanly. If the
 * job is already 'complete' the acknowledge endpoint returns
 * { already: 'complete' } and we just navigate.
 */
export function UpgradeToStripeApiButton({
  jobId,
  clientLinkId,
  dateRangeStart,
  dateRangeEnd,
  variant = "primary",
  label,
}: {
  jobId: string;
  clientLinkId: string;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  variant?: "primary" | "secondary";
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  async function handleClick() {
    setBusy(true);
    setError("");
    try {
      // Close out the prior job so the concurrency guard doesn't block
      // the new one. The acknowledge endpoint is idempotent — already-
      // complete jobs return { already: 'complete' } without erroring.
      const ackRes = await fetch(`/api/stripe-recon/${jobId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason:
            "Closed to upgrade to the Stripe API path. The prior QBO-invoice-matcher run couldn't match deposits because there were no QBO invoices; the Stripe API path doesn't need them. Follow-up job links via upgrade_from.",
        }),
      });
      if (!ackRes.ok) {
        const data = await ackRes.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${ackRes.status}`);
      }

      const params = new URLSearchParams({
        client: clientLinkId,
        method: "stripe_api",
        upgrade_from: jobId,
        ...(dateRangeStart ? { start: dateRangeStart } : {}),
        ...(dateRangeEnd ? { end: dateRangeEnd } : {}),
      });
      router.push(`/stripe-recon/new?${params.toString()}`);
    } catch (e: any) {
      setError(e.message || "Failed to start upgrade");
      setBusy(false);
    }
  }

  const isPrimary = variant === "primary";

  return (
    <div className="space-y-2">
      {error && (
        <div className="p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
          {error}
        </div>
      )}
      <button
        onClick={handleClick}
        disabled={busy}
        className={
          isPrimary
            ? "w-full inline-flex items-center justify-center gap-2 bg-navy hover:bg-navy-deep disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            : "inline-flex items-center gap-2 bg-navy hover:bg-navy-deep disabled:opacity-60 text-white text-sm font-semibold px-4 py-2 rounded-lg"
        }
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
        {busy ? "Closing prior run…" : label || "Upgrade to Stripe API"}
        <ArrowRight size={14} />
      </button>
    </div>
  );
}
