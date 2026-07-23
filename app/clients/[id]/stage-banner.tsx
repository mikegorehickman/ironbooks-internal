"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ListChecks, FileText, CheckCircle2, Building2, XCircle, Loader2 } from "lucide-react";
import {
  MACRO_STAGE_META,
  LIFECYCLE_META,
  type MacroStage,
  type LifecycleStatus,
} from "@/lib/client-lifecycle";

/**
 * Stage banner — the one thing the bookkeeper should do next, in-body, so the
 * client workspace leads with its lifecycle stage instead of a flat tab strip.
 * The TopBar carries the stage/status pills for identity; this carries the
 * ACTION. Primary CTA is stage-driven (onboarding → foundation, cleanup → the
 * sequence, production → monthly close); the hint line is refined by the
 * detailed status so actionable states (waiting on client, ready for review,
 * ready to close) read true.
 */

type TabTarget = "overview" | "cleanup" | "profile" | "pl" | "bs";

interface Cta {
  label: string;
  tab?: TabTarget;
  href?: string;
  icon: any;
}

/** Status-specific hint override for the states a bookkeeper acts on. */
function statusHint(status: LifecycleStatus | null | undefined): string | null {
  switch (status) {
    case "waiting_on_client":
      return "Waiting on the client — chase the open questions, then resume.";
    case "ready_for_review":
      return "Submitted for manager review — awaiting sign-off.";
    case "ready_to_close":
      return "Cleanup pipeline is done — submit it for review.";
    case "completed":
      return "Cleanup signed off — promote to Production to go live.";
    case "done":
      return "This month is closed and statements are sent. 🎉";
    default:
      return null;
  }
}

export function StageBanner({
  stage,
  status,
  clientLinkId,
  canReject = false,
  onGoToTab,
}: {
  stage: MacroStage;
  status?: LifecycleStatus | null;
  clientLinkId: string;
  /** Senior (admin/lead) — may Manager-Reject a cleanup that's in review. */
  canReject?: boolean;
  onGoToTab: (tab: TabTarget) => void;
}) {
  const router = useRouter();
  const meta = MACRO_STAGE_META[stage];
  const hint = statusHint(status) || meta.description;
  const [rejecting, setRejecting] = useState(false);

  // Manager Reject (profile) — bounce a cleanup that's in review back to the
  // bookkeeper (Failed Review) with a required note. Same path as the review
  // modal; senior-only, shown only while ready_for_review.
  // Manager Reject is available whenever a file is awaiting manager review —
  // in BOTH the cleanup review (cleanup_review_state='in_review') and the
  // production monthly-close review (monthly_rec_runs.status='pending_review').
  // Each path posts to its own reject endpoint.
  const showReject = canReject && status === "ready_for_review";
  async function reject() {
    const note = window.prompt(
      "Reject — what does the bookkeeper need to fix?\n(They'll see this note on their Today.)"
    );
    if (note === null) return;
    if (!note.trim()) {
      alert("A note is required to reject.");
      return;
    }
    setRejecting(true);
    try {
      const res =
        stage === "production"
          ? await fetch(`/api/clients/${clientLinkId}/monthly-rec`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "reject", notes: note.trim() }),
            })
          : await fetch(`/api/clients/${clientLinkId}/reject-review`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ notes: note.trim() }),
            });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Couldn't reject");
      router.refresh();
    } catch (e: any) {
      alert(e?.message || "Couldn't reject");
      setRejecting(false);
    }
  }

  let title: string;
  let primary: Cta;
  let secondary: Cta | null = null;

  if (stage === "onboarding") {
    title = "Onboarding — get the foundation in";
    primary = { label: "Foundation details", tab: "profile", icon: Building2 };
    secondary = { label: "Request documents", tab: "overview", icon: FileText };
  } else if (stage === "cleanup") {
    title = "Cleanup — bring the books to correct";
    primary = { label: "Open cleanup sequence", tab: "cleanup", icon: ListChecks };
    // When cleanup is done but not yet promoted, point at review/approvals.
    if (status === "ready_to_close" || status === "ready_for_review") {
      secondary = { label: "Approvals", href: "/approvals", icon: CheckCircle2 };
    }
  } else {
    title = "Production — live books";
    primary = { label: "Monthly close", href: "/production", icon: CheckCircle2 };
    secondary = { label: "View P&L", tab: "pl", icon: FileText };
  }

  const statusLabel = status ? LIFECYCLE_META[status]?.label : null;

  function renderCta(cta: Cta, primaryStyle: boolean) {
    const cls = primaryStyle
      ? "inline-flex items-center gap-1.5 rounded-lg bg-teal px-3.5 py-2 text-sm font-semibold text-white hover:bg-teal-dark transition-colors"
      : "inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-ink-slate hover:text-navy hover:border-gray-300 transition-colors";
    const Icon = cta.icon;
    if (cta.href) {
      return (
        <Link href={cta.href} className={cls}>
          <Icon size={14} /> {cta.label}
          {primaryStyle && <ArrowRight size={14} />}
        </Link>
      );
    }
    return (
      <button type="button" onClick={() => cta.tab && onGoToTab(cta.tab)} className={cls}>
        <Icon size={14} /> {cta.label}
        {primaryStyle && <ArrowRight size={14} />}
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-gradient-to-r from-teal-light/30 to-white px-5 py-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ${meta.tone}`}
            >
              {meta.label}
            </span>
            {statusLabel && (
              <span className="text-xs font-semibold text-ink-slate">{statusLabel}</span>
            )}
          </div>
          <div className="mt-1 text-sm font-semibold text-navy">{title}</div>
          <p className="text-xs text-ink-slate mt-0.5 max-w-2xl">{hint}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {showReject && (
            <button
              type="button"
              onClick={reject}
              disabled={rejecting}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 transition-colors disabled:opacity-60"
              title="Manager Reject — bounce back to the bookkeeper (Failed Review) with a note; no client email"
            >
              {rejecting ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
              Reject
            </button>
          )}
          {secondary && renderCta(secondary, false)}
          {renderCta(primary, true)}
        </div>
      </div>
    </div>
  );
}
