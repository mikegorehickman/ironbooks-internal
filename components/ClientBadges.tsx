"use client";

import { AlertTriangle, Unplug, CreditCard, Scale, PauseCircle } from "lucide-react";
import type { AttentionState } from "@/lib/client-attention-state";

/**
 * ClientBadges — the attention states, rendered identically everywhere.
 *
 * Severity stack (worst first): ESCALATED > DISCONNECTED > BILLING > BS OWED
 * > STUCK JOB. Cards show the top `max` (default 2) with a "+N" overflow so
 * five colors never scream at once; the wide manager dashboard passes a
 * higher max. `stage` scopes what's relevant: billing badges are meaningless
 * on a cleanup card (the client isn't billing yet), so they only render for
 * production/dashboard contexts.
 */

type Stage = "onboarding" | "cleanup" | "production" | "dashboard" | "profile";

interface Badge {
  key: string;
  label: string;
  cls: string;
  icon: React.ReactNode;
  title: string;
}

export function buildBadges(a: AttentionState, stage: Stage): Badge[] {
  const badges: Badge[] = [];

  if (a.escalations.length > 0) {
    const top = a.escalations[0];
    const aging = a.escalations.some((e) => e.aging);
    badges.push({
      key: "escalated",
      label: a.escalations.length > 1 ? `ESCALATED ×${a.escalations.length}` : "ESCALATED",
      cls: aging ? "bg-red-200 text-red-900 border-red-400" : "bg-red-100 text-red-800 border-red-200",
      icon: <AlertTriangle size={9} />,
      title: `${top.reason}${top.note ? ` · ${top.note.slice(0, 140)}` : ""}`,
    });
  }

  if (a.disconnected) {
    badges.push({
      key: "disconnected",
      label: "DISCONNECTED",
      cls: "bg-red-100 text-red-800 border-red-200",
      icon: <Unplug size={9} />,
      title: "QuickBooks connection is dead — client must reconnect before any work can sync",
    });
  }

  if (a.billing && (stage === "production" || stage === "dashboard" || stage === "profile")) {
    const label = a.billing === "hold" ? "BILLING HOLD" : a.billing === "past_due" ? "PAST DUE" : "UNBILLED";
    badges.push({
      key: "billing",
      label,
      cls:
        a.billing === "unbilled"
          ? "bg-amber-100 text-amber-800 border-amber-200"
          : "bg-red-100 text-red-800 border-red-200",
      icon: <CreditCard size={9} />,
      title:
        a.billing === "hold"
          ? "Portal billing hold is active"
          : a.billing === "past_due"
          ? "Subscription is past due"
          : "In production with no billing set up — flag to Mike",
    });
  }

  // On the production board bs_owed already has a dedicated banner + action
  // button — a third rendering of the same fact is noise, so skip it there.
  if (a.bs_owed && stage !== "production") {
    badges.push({
      key: "bs_owed",
      label: "BS OWED",
      cls: "bg-amber-100 text-amber-800 border-amber-200",
      icon: <Scale size={9} />,
      title: "Balance-sheet cleanup deferred — still owed (P&L-only service until it's done)",
    });
  }

  if (a.stuck_job) {
    badges.push({
      key: "stuck_job",
      label: "RECLASS PAUSED",
      cls: "bg-slate-200 text-slate-700 border-slate-300",
      icon: <PauseCircle size={9} />,
      title: "A reclass job is paused mid-run — use Get unstuck on the manager dashboard",
    });
  }

  return badges;
}

export function ClientBadges({
  attention,
  stage,
  max = 2,
}: {
  attention: AttentionState | undefined | null;
  stage: Stage;
  max?: number;
}) {
  if (!attention) return null;
  const badges = buildBadges(attention, stage);
  if (badges.length === 0) return null;
  const visible = badges.slice(0, max);
  const hidden = badges.slice(max);

  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {visible.map((b) => (
        <span
          key={b.key}
          title={b.title}
          className={`inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${b.cls}`}
        >
          {b.icon}
          {b.label}
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          title={hidden.map((b) => `${b.label}: ${b.title}`).join("\n")}
          className="inline-flex items-center text-[9px] font-bold px-1.5 py-0.5 rounded-full border bg-gray-100 text-ink-slate border-gray-200"
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}
