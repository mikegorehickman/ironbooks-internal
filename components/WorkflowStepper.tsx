"use client";

import Link from "next/link";
import { Check, Circle, Loader2 } from "lucide-react";

export type WorkflowStep = "coa" | "reclass" | "stripe" | "rules" | "bs";
export type StepState = "pending" | "active" | "complete" | "skipped";

interface StepDef {
  key: WorkflowStep;
  num: number;
  label: string;
  href: (clientLinkId?: string) => string;
}

const STEPS: StepDef[] = [
  {
    key: "coa", num: 1, label: "COA Cleanup",
    href: (cid) => cid ? `/jobs/new?client=${cid}` : "/jobs/new",
  },
  {
    key: "reclass", num: 2, label: "Reclass",
    href: (cid) => cid ? `/reclass/new?client=${cid}&workflow=full_categorization` : "/reclass/new",
  },
  {
    key: "rules", num: 3, label: "Bank Rules",
    href: (cid) => cid ? `/rules/new?client=${cid}` : "/rules/new",
  },
  {
    key: "stripe", num: 4, label: "Stripe Recon",
    href: (cid) => cid ? `/stripe-recon/new?client=${cid}` : "/stripe-recon/new",
  },
  {
    key: "bs", num: 5, label: "Balance Sheet",
    href: (cid) => cid ? `/balance-sheet/${cid}` : "/clients",
  },
];

/**
 * Persistent 4-pill workflow progress indicator.
 * Renders at the top of every workflow page so users always know:
 *   1. Where they are
 *   2. What comes next
 *   3. What's optional (Stripe) vs required (COA, Reclass) vs recommended (Bank Rules)
 */
export function WorkflowStepper({
  currentStep,
  currentState = "active",
  completedSteps = [],
  skippedSteps = [],
  clientLinkId,
}: {
  currentStep: WorkflowStep;
  currentState?: "active" | "complete";
  completedSteps?: WorkflowStep[];
  skippedSteps?: WorkflowStep[];
  clientLinkId?: string;
}) {
  function stateFor(key: WorkflowStep): StepState {
    if (key === currentStep) return currentState;
    if (completedSteps.includes(key)) return "complete";
    if (skippedSteps.includes(key)) return "skipped";
    return "pending";
  }

  return (
    <div className="bg-white border-b border-gray-200">
      <div className="px-8 py-3">
        <div className="flex items-center gap-2 max-w-4xl">
          {STEPS.map((step, idx) => {
            const state = stateFor(step.key);
            const isLast = idx === STEPS.length - 1;
            return (
              <div key={step.key} className="flex items-center flex-1">
                <StepPill step={step} state={state} clientLinkId={clientLinkId} />
                {!isLast && (
                  <div
                    className="flex-1 h-0.5 mx-2"
                    style={{
                      backgroundColor:
                        state === "complete" ? "#10B981" : "#E5E7EB",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StepPill({
  step,
  state,
  clientLinkId,
}: {
  step: StepDef;
  state: StepState;
  clientLinkId?: string;
}) {
  const isActive = state === "active";
  const isComplete = state === "complete";
  const isSkipped = state === "skipped";
  const isPending = state === "pending";

  const bg = isActive ? "#2D7A75" : isComplete ? "#10B981" : isSkipped ? "#94A3B8" : "#F3F4F6";
  const fg = isActive || isComplete || isSkipped ? "#FFFFFF" : "#9CA3AF";
  const labelColor = isActive ? "#0F1F2E" : isComplete ? "#0F1F2E" : "#9CA3AF";

  const content = (
    <div className="flex items-center gap-2.5 group">
      <div
        className="rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0 w-7 h-7 transition-colors"
        style={{ backgroundColor: bg, color: fg }}
      >
        {isComplete ? (
          <Check size={14} strokeWidth={3} />
        ) : isActive ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          step.num
        )}
      </div>
      <div className="flex flex-col leading-tight">
        <span
          className="text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap"
          style={{ color: labelColor }}
        >
          Step {step.num}
        </span>
        <span
          className="text-xs font-semibold whitespace-nowrap"
          style={{ color: isActive ? "#2D7A75" : labelColor }}
        >
          {step.label}
        </span>
      </div>
    </div>
  );

  // Make completed / skipped steps clickable to navigate back
  if ((isComplete || isSkipped) && clientLinkId) {
    return (
      <Link href={step.href(clientLinkId)} className="hover:opacity-80 transition-opacity">
        {content}
      </Link>
    );
  }
  return content;
}
