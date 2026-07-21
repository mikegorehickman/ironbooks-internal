"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  RefreshCw,
  Check,
  Circle,
  CircleDashed,
  MinusCircle,
  Loader2,
} from "lucide-react";
import { MonthCloseFlow } from "./month-close-flow";
import {
  CLEANUP_STEPS,
  effectiveStepStatus,
  activeCleanupStep,
  cleanupProgress,
  readCleanupSequence,
  type CleanupSequenceState,
  type CleanupStepKey,
  type CleanupStepStatus,
} from "@/lib/cleanup-sequence";

/**
 * Client-profile "Cleanup" tab (SNAP re-IA) — the single ORDERED sequence for
 * cleaning up THIS client. The 8 steps fold every scattered cleanup tool into
 * one spine; each step deep-links its tools pre-scoped to the client, shows a
 * status, and lets the bookkeeper mark it done / skipped / current. Status is
 * persisted on client_links.cleanup_sequence via /api/clients/[id]/cleanup-sequence.
 */

const STATUS_META: Record<
  CleanupStepStatus,
  { label: string; color: string; bg: string; icon: any }
> = {
  done: { label: "Done", color: "#0F7A4E", bg: "#E5F5EC", icon: Check },
  active: { label: "In progress", color: "#2D7A75", bg: "#E3F2F1", icon: Loader2 },
  skipped: { label: "Skipped", color: "#8A6D00", bg: "#FBF3D9", icon: MinusCircle },
  pending: { label: "Not started", color: "#5B6B7A", bg: "#EEF2F5", icon: CircleDashed },
};

export function CleanupTab({
  clientLinkId,
  clientName,
  cleanupCompletedAt,
  initialSequence,
  stage,
  onNavigateTab,
}: {
  clientLinkId: string;
  clientName: string;
  cleanupCompletedAt?: string | null;
  initialSequence?: CleanupSequenceState | { cleanup_sequence?: any } | null;
  stage?: "onboarding" | "cleanup" | "production" | null;
  onNavigateTab?: (tab: "overview" | "bs" | "pl") => void;
}) {
  // Accept either a normalized state or a raw row; normalize once.
  const seeded: CleanupSequenceState = useMemo(() => {
    if (initialSequence && "steps" in initialSequence) return initialSequence as CleanupSequenceState;
    return readCleanupSequence((initialSequence as any) || {});
  }, [initialSequence]);

  const [state, setState] = useState<CleanupSequenceState>(seeded);
  const [saving, setSaving] = useState<CleanupStepKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the persisted sequence from the API on mount. This is resilient to
  // the shell not passing it (and to migration 137 not being applied yet — the
  // GET falls back to an empty sequence rather than erroring).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/clients/${clientLinkId}/cleanup-sequence`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j?.sequence) setState(j.sequence);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [clientLinkId]);

  const signals = { cleanupCompletedAt: cleanupCompletedAt || null };
  const currentKey = activeCleanupStep(state, signals);
  const progress = cleanupProgress(state, signals);

  // Production clients don't do cleanup — they run a monthly close. Same tab,
  // stage-appropriate flow. (Checked after hooks to respect rules-of-hooks.)
  if (stage === "production") {
    return <MonthCloseFlow clientLinkId={clientLinkId} clientName={clientName} />;
  }

  async function setStep(step: CleanupStepKey, status: CleanupStepStatus) {
    setSaving(step);
    setError(null);
    // Optimistic update.
    const prev = state;
    setState({
      steps: { ...state.steps, [step]: { status, at: new Date().toISOString() } },
    });
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/cleanup-sequence`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step, status }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Couldn't save");
      }
      const j = await res.json();
      if (j.sequence) setState(j.sequence);
    } catch (e: any) {
      setState(prev); // roll back
      setError(e?.message || "Couldn't save step status");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Header + progress */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-sm text-ink-slate">
            Cleanup sequence for <strong className="text-navy">{clientName}</strong> — work top to
            bottom.
          </div>
          <div className="text-xs text-ink-light mt-0.5">
            {progress.done} of {progress.total} steps done
            {currentKey ? (
              <> · next: {CLEANUP_STEPS.find((s) => s.key === currentKey)?.title}</>
            ) : (
              <> · cleanup complete 🎉</>
            )}
          </div>
        </div>
        <Link href="/cleanup" className="text-xs text-teal font-semibold hover:underline">
          Cleanup board →
        </Link>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
        <div
          className="h-full bg-teal transition-all"
          style={{ width: `${(progress.done / progress.total) * 100}%` }}
        />
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Steps */}
      <div className="space-y-2">
        {CLEANUP_STEPS.map((step) => {
          const status = effectiveStepStatus(state, step.key, signals);
          const isCurrent = step.key === currentKey;
          const meta = STATUS_META[status];
          const StatusIcon = meta.icon;
          const busy = saving === step.key;

          return (
            <div
              key={step.key}
              className={`rounded-xl border px-4 py-3 transition-colors ${
                isCurrent
                  ? "border-teal bg-teal-light/30"
                  : status === "done"
                  ? "border-gray-200 bg-gray-50/60"
                  : "border-gray-200 bg-white"
              }`}
            >
              <div className="flex items-start gap-3">
                {/* Step number / done check */}
                <div
                  className="flex-shrink-0 mt-0.5 h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-bold"
                  style={{ color: meta.color, backgroundColor: meta.bg }}
                >
                  {status === "done" ? <Check size={13} /> : step.num}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-navy">{step.title}</span>
                    <span
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
                      style={{ color: meta.color, backgroundColor: meta.bg }}
                    >
                      <StatusIcon size={9} className={busy ? "animate-spin" : ""} /> {meta.label}
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] font-bold uppercase tracking-wide text-teal">
                        ← you are here
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-ink-slate mt-0.5">{step.blurb}</p>

                  {/* Tool launch links */}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {step.tools.map((tool) =>
                      tool.tab ? (
                        <button
                          key={tool.label}
                          type="button"
                          onClick={() => onNavigateTab?.(tool.tab!)}
                          title={tool.desc}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:border-teal transition-colors"
                        >
                          {tool.label}
                          <ArrowRight size={12} className="text-ink-light" />
                        </button>
                      ) : (
                        <Link
                          key={tool.label}
                          href={tool.href!(clientLinkId)}
                          title={tool.desc}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:border-teal transition-colors"
                        >
                          {tool.label}
                          <ArrowRight size={12} className="text-ink-light" />
                        </Link>
                      )
                    )}
                  </div>

                  {/* Status controls */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    {status !== "done" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setStep(step.key, "done")}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50"
                      >
                        <Check size={11} /> Mark done
                      </button>
                    )}
                    {status !== "active" && status !== "done" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setStep(step.key, "active")}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 font-semibold text-teal hover:bg-teal-light/50 disabled:opacity-50"
                      >
                        <Loader2 size={11} /> Start
                      </button>
                    )}
                    {status !== "skipped" && status !== "done" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setStep(step.key, "skipped")}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 font-semibold text-ink-slate hover:bg-gray-100 disabled:opacity-50"
                      >
                        <MinusCircle size={11} /> Skip
                      </button>
                    )}
                    {(status === "done" || status === "skipped") && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setStep(step.key, "pending")}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 font-semibold text-ink-slate hover:bg-gray-100 disabled:opacity-50"
                      >
                        <Circle size={11} /> Reopen
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Re-run shortcut for already-cleaned clients (kept from the old tab). */}
      <Link
        href={`/jobs/new?client=${clientLinkId}&redo=1`}
        className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 hover:border-teal transition-colors"
      >
        <div className="p-2 rounded-lg bg-teal-light text-teal">
          <RefreshCw size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-navy">Re-run COA Cleanup (updated master chart)</div>
          <div className="text-[11px] text-ink-slate">
            Redo an already-cleaned client — applies the latest master COA and re-categorizes. Skips the redo checkbox.
          </div>
        </div>
        <ArrowRight size={14} className="text-teal" />
      </Link>
    </div>
  );
}
