"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";

/** Where each step hands off to next in the cleanup workflow. */
const NEXT_STEP: Record<"coa" | "reclass" | "rules", { label: string; path: string }> = {
  coa: { label: "Reclass", path: "/reclass/new" },
  reclass: { label: "Bank Rules", path: "/rules/new" },
  rules: { label: "Stripe Recon", path: "/stripe-recon/new" },
};

/**
 * Warns (never blocks) when the selected client has already been cleaned up or
 * already has a completed job of this type — the start button stays disabled
 * until the user ticks the explicit override. Fetches load-time from
 * /api/clients/[id]/redo-status so deep-links are covered. Reports the allowed
 * state up via onAllowChange so the parent form can gate its submit.
 */
export function RedoWarning({
  clientId,
  kind,
  onAllowChange,
}: {
  clientId: string | null | undefined;
  kind: "coa" | "reclass" | "rules";
  onAllowChange?: (allowed: boolean) => void;
}) {
  const [status, setStatus] = useState<{
    alreadyCleanedUp: boolean;
    cleanupCompletedAt: string | null;
    hasCompletedJobOfType: boolean;
    lastCompletedAt: string | null;
    lastRangeStart: string | null;
    lastRangeEnd: string | null;
    usesStripe: boolean | null;
  } | null>(null);
  const [override, setOverride] = useState(false);

  useEffect(() => {
    setStatus(null);
    setOverride(false);
    if (!clientId) {
      onAllowChange?.(true);
      return;
    }
    let cancelled = false;
    fetch(`/api/clients/${clientId}/redo-status?kind=${kind}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, kind]);

  const flagged = !!status && (status.alreadyCleanedUp || status.hasCompletedJobOfType);

  useEffect(() => {
    onAllowChange?.(!flagged || override);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagged, override]);

  if (!flagged || !status) return null;
  const date = status.cleanupCompletedAt || status.lastCompletedAt;
  const dateStr = date ? ` on ${new Date(date).toLocaleDateString()}` : "";

  // Where this step hands off next. Bank Rules normally → Stripe Recon, but if
  // the client has no Stripe activity (usesStripe === false) we skip Stripe
  // entirely and jump straight to the Balance Sheet. usesStripe null ⇒ unknown,
  // keep the default Stripe hop.
  const nextStep =
    kind === "rules" && status.usesStripe === false
      ? { label: "Balance Sheet", path: `/balance-sheet/${clientId}`, isPath: true }
      : { ...NEXT_STEP[kind], isPath: false };

  // Carry the upstream period into the next step so it doesn't ask again. Pass
  // the actual reclass start date — Bank Rules shows/uses "looking back to
  // <date>" rather than a generic month count. (Balance Sheet takes the client
  // in the path, so no ?client query there.)
  let skipHref = nextStep.isPath ? nextStep.path : `${nextStep.path}?client=${clientId}`;
  if (kind === "reclass" && status.lastRangeStart) {
    skipHref += `&start=${status.lastRangeStart}`;
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="flex items-center gap-2 font-semibold text-amber-900">
        <AlertTriangle size={15} />
        {status.alreadyCleanedUp
          ? "This company was already cleaned up"
          : "This step was already completed"}
      </div>
      <p className="text-amber-800 mt-1 text-[13px] leading-snug">
        {status.alreadyCleanedUp
          ? `Cleanup was signed off${dateStr}. Redoing it starts fresh and re-posts to QuickBooks.`
          : `A ${kind} job already finished${dateStr}. Running another creates a brand-new job.`}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        {clientId && (
          <Link
            href={skipHref}
            className="inline-flex items-center gap-1.5 text-[13px] font-bold bg-teal text-white px-3 py-1.5 rounded-lg hover:bg-teal-dark"
          >
            It&apos;s done — skip to {nextStep.label}
            <ArrowRight size={14} />
          </Link>
        )}
        <label className="flex items-center gap-2 text-[13px] font-semibold text-amber-900 cursor-pointer">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
            className="w-4 h-4 rounded border-amber-400"
          />
          or redo from scratch
        </label>
      </div>
    </div>
  );
}
