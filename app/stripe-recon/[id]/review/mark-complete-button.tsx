"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2, Flag } from "lucide-react";

/**
 * "Submit for senior review" — the canonical close-out action at the end
 * of the Stripe Recon step. Previously this button marked the client
 * fully complete; now it routes the cleanup into the senior-review
 * stage where an admin/lead reviews the work and sends the PDF to the
 * client before the cycle is officially closed and the client moves to
 * month-over-month.
 *
 * The full pipeline:
 *   Active cleanup
 *     → [Submit for Review] (this button)
 *   In Review
 *     → senior opens the review modal on /clients
 *     → reviewer copies branded email + PDF link to clipboard
 *     → pastes into Double and sends to client
 *     → reviewer clicks Approve → cleanup_completed_at set
 *   Completed (month-over-month)
 *
 * The button is callable by any role — junior bookkeepers submit for
 * review; only seniors can approve.
 */
export function MarkCleanupCompleteButton({
  clientLinkId,
  clientName,
  defaultRangeStart,
  defaultRangeEnd,
  /** Variant changes the visual weight — "primary" is the green CTA after
   *  the recon flow finishes; "secondary" is a quieter button shown
   *  alongside other actions (e.g. the unmatched panel). */
  variant = "primary",
  /** Gate the submit (e.g. until the P&L is attested in the BS stage). */
  disabled = false,
  disabledHint,
}: {
  clientLinkId: string;
  clientName: string;
  defaultRangeStart?: string | null;
  defaultRangeEnd?: string | null;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  disabledHint?: string;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");

  async function handleSubmit() {
    if (
      !confirm(
        `Submit ${clientName}'s cleanup for senior review?\n\n` +
          `• The client will move to the In Review list — out of your active queue.\n` +
          `• A senior bookkeeper will review the work + send the PDF report to the client.\n` +
          `• Once approved, the client moves to Completed Accounts (month-over-month).\n` +
          `• You can withdraw the submission if you realize more work is needed.`
      )
    )
      return;

    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/submit-for-review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            range_start: defaultRangeStart || undefined,
            range_end: defaultRangeEnd || undefined,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      router.push("/clients");
    } catch (e: any) {
      setError(e.message || "Failed to submit for review");
      setSubmitting(false);
    }
  }

  const isPrimary = variant === "primary";

  return (
    <div className={isPrimary ? "rounded-xl bg-teal-lighter border border-teal/30 p-4" : ""}>
      {isPrimary && (
        <div className="flex items-start gap-2 mb-3">
          <Flag className="text-teal flex-shrink-0 mt-0.5" size={18} />
          <div className="text-sm">
            <div className="font-semibold text-navy">
              Done with {clientName}? Submit for senior review.
            </div>
            <div className="text-xs text-ink-slate mt-0.5">
              The client moves to the In Review list. A senior reviews the
              work, sends the PDF report to the client, and approves — then
              the client moves to Completed Accounts (month-over-month).
            </div>
          </div>
        </div>
      )}
      {error && (
        <div className="mb-2 p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
          {error}
        </div>
      )}
      <button
        onClick={handleSubmit}
        disabled={submitting || disabled}
        className={
          isPrimary
            ? "w-full inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            : "w-full inline-flex items-center justify-center gap-2 bg-white hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed border border-gray-200 text-navy text-sm font-semibold px-5 py-2.5 rounded-lg"
        }
      >
        {submitting ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Send size={16} />
        )}
        {submitting
          ? "Submitting…"
          : `Submit ${clientName}'s cleanup for senior review`}
      </button>
      {disabled && disabledHint && (
        <div className="mt-2 text-xs text-ink-slate text-center">{disabledHint}</div>
      )}
    </div>
  );
}
