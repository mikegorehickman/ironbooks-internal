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

/** What we're waiting on the client for + since when — surfaced on the
 * "Waiting on client" status pill as a hover tooltip. Sourced from the current
 * month's rec run (production) or open ask-client questions (cleanup). */
export interface WaitingInfo {
  reasons: string[]; // human-readable, already mapped
  note?: string | null;
  sinceIso?: string | null;
}

const REASON_LABELS: Record<string, string> = {
  waiting_reply: "a reply to our questions",
  waiting_statements: "bank / credit-card statements",
  disconnected_feed: "a reconnected bank feed",
  open_questions: "answers to open transaction questions",
};

function mapReason(r: string): string {
  return REASON_LABELS[r] || r.replace(/_/g, " ");
}

/** "3 days" / "today" / "5 weeks" from an ISO timestamp. */
function waitedFor(sinceIso?: string | null): string | null {
  if (!sinceIso) return null;
  const then = new Date(sinceIso).getTime();
  if (!Number.isFinite(then)) return null;
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  if (days < 14) return `${days} days`;
  const weeks = Math.round(days / 7);
  return `${weeks} weeks`;
}

/** Compose the full tooltip string for the waiting pill. */
function waitingTooltip(info: WaitingInfo): string {
  const reasons = (info.reasons || []).map(mapReason).filter(Boolean);
  const waited = waitedFor(info.sinceIso);
  const what = reasons.length
    ? `Waiting for ${reasons.join(" and ")}`
    : "Waiting on the client";
  const how = waited ? ` · ${waited === "today" ? "since today" : `for ${waited}`}` : "";
  const note = info.note ? `\n“${info.note}”` : "";
  return `${what}${how}${note}`;
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
  waitingInfo = null,
  onGoToTab,
}: {
  stage: MacroStage;
  status?: LifecycleStatus | null;
  clientLinkId: string;
  /** Senior (admin/lead) — may Manager-Reject a cleanup that's in review. */
  canReject?: boolean;
  /** Detail for the "Waiting on client" pill tooltip (what + how long). */
  waitingInfo?: WaitingInfo | null;
  onGoToTab: (tab: TabTarget) => void;
}) {
  const router = useRouter();
  const meta = MACRO_STAGE_META[stage];
  const hint = statusHint(status) || meta.description;
  const [rejecting, setRejecting] = useState(false);

  // Manager Reject (profile) — bounce a cleanup that's in review back to the
  // bookkeeper (Failed Review) with a required note. Same path as the review
  // modal; senior-only, shown only while ready_for_review.
  const showReject = canReject && stage === "cleanup" && status === "ready_for_review";
  async function reject() {
    const note = window.prompt(
      "Reject this cleanup — what does the bookkeeper need to fix?\n(They'll see this note on their Today.)"
    );
    if (note === null) return;
    if (!note.trim()) {
      alert("A note is required to reject.");
      return;
    }
    setRejecting(true);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/reject-review`, {
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
    // View P&L removed (Mike 2026-07-21) — the financials are one tab click
    // away; a second CTA here was noise.
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
            {statusLabel && (() => {
              const isWaiting = status === "waiting_on_client";
              const waited = isWaiting && waitingInfo ? waitedFor(waitingInfo.sinceIso) : null;
              const tip = isWaiting && waitingInfo ? waitingTooltip(waitingInfo) : undefined;
              return (
                <span
                  className={`text-xs font-semibold text-ink-slate ${isWaiting && waitingInfo ? "underline decoration-dotted decoration-gold-border underline-offset-2 cursor-help" : ""}`}
                  title={tip}
                >
                  {statusLabel}
                  {waited && <span className="text-gold-deep"> · {waited === "today" ? "today" : waited}</span>}
                </span>
              );
            })()}
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
