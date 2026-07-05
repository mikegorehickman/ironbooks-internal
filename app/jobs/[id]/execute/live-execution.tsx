"use client";

import { useEffect, useState, useRef } from "react";
import {
  CheckCircle2, Loader2, AlertTriangle, ExternalLink, ArrowRight,
  StopCircle, RotateCcw, FileDown,
} from "lucide-react";
import Link from "next/link";

interface AuditEvent {
  event_type: string;
  request_payload: any;
  response_payload: any;
  occurred_at: string;
  action_id: string | null;
}

interface ManualCleanupItem {
  account_id: string | null;
  account_name: string;
  intended_action: "rename" | "inactivate" | "create";
  reason: string;
  suggestion: string;
  qbo_response?: string;
}

interface StatusResponse {
  status: string;
  execution_started_at: string | null;
  execution_completed_at: string | null;
  duration_seconds: number | null;
  error_message: string | null;
  manual_cleanup_items: ManualCleanupItem[];
  progress: { total: number; completed: number; percentage: number };
  stats: {
    to_rename: number | null;
    to_create: number | null;
    to_delete: number | null;
    flagged: number | null;
  };
  events: AuditEvent[];
}

export function LiveExecution({
  jobId,
  initialStatus,
  clientName,
  clientLinkId,
}: {
  jobId: string;
  initialStatus: string;
  clientName: string;
  clientLinkId?: string;
}) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [autoStarted, setAutoStarted] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string>("");

  // Detect which stage failed by scanning the audit log for the most recent
  // stage_start event whose stage_complete never landed. Falls back to
  // 'merge' if we can't tell (most common failure stage).
  function detectFailedStage(): "create" | "rename" | "merge" | "delete" | null {
    const stageStarts = events.filter((e) => e.event_type === "stage_start");
    const stageCompletes = events.filter((e) => e.event_type === "stage_complete");
    const completedStages = new Set(
      stageCompletes.map((e) => String(e.request_payload?.stage || ""))
    );
    // Walk starts in reverse order — most recent first
    for (let i = stageStarts.length - 1; i >= 0; i--) {
      const stage = String(stageStarts[i].request_payload?.stage || "");
      if (!completedStages.has(stage)) {
        if (stage === "merge" || stage === "rename" || stage === "delete" || stage === "inactivate") {
          return stage === "inactivate" ? "delete" : stage;
        }
        if (stage === "create_parents" || stage === "create_children" || stage === "create_missing_parents") {
          return "create";
        }
      }
    }
    return null;
  }
  const failedStage = detectFailedStage();

  async function handleRevertStage(stage: "create" | "rename" | "merge" | "delete") {
    const label = stage === "delete" ? "inactivate" : stage;
    if (!confirm(
      `Revert the "${label}" stage? This undoes only the ${label} actions that already executed — other stages stay applied. Safe to re-execute afterwards.`
    )) return;
    try {
      const res = await fetch(`/api/jobs/${jobId}/revert-stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      alert(
        `Started revert of ${data.actions_to_revert} ${label} action${data.actions_to_revert === 1 ? "" : "s"}. Refresh in ~30 seconds to see progress.`
      );
    } catch (e: any) {
      alert(`Revert failed: ${e?.message || e}`);
    }
  }

  async function handleDownloadReport() {
    try {
      const res = await fetch(`/api/jobs/${jobId}/error-report`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Ironbooks Error Report - ${jobId.slice(0, 8)}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Report download failed: ${e?.message || e}`);
    }
  }

  async function handleCancel(hard: boolean) {
    const confirmText = hard
      ? "HARD STOP this cleanup? This will invalidate the QBO token (you'll need to reconnect QuickBooks for this client). Use only if the regular stop isn't working."
      : "Stop this cleanup? Already-completed actions stay applied. Remaining actions are skipped. The background process exits within ~60 seconds.";
    if (!confirm(confirmText)) return;
    setCancelling(true);
    setCancelError("");
    try {
      const res = await fetch(`/api/jobs/${jobId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hard }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
    } catch (e: any) {
      setCancelError(e?.message || String(e));
    } finally {
      setCancelling(false);
    }
  }
  const lastSeen = useRef<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-start execution if not already running
  useEffect(() => {
    if (!autoStarted && (initialStatus === "draft" || initialStatus === "in_review" || initialStatus === "approved")) {
      setAutoStarted(true);
      fetch(`/api/jobs/${jobId}/execute`, { method: "POST" })
        .then((r) => r.json())
        .catch((e) => console.error("Failed to start execution:", e));
    } else {
      setAutoStarted(true);
    }
  }, [jobId, initialStatus, autoStarted]);

  // Poll for status
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const url = lastSeen.current
          ? `/api/jobs/${jobId}/status?since=${encodeURIComponent(lastSeen.current)}`
          : `/api/jobs/${jobId}/status`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data: StatusResponse = await res.json();

        if (cancelled) return;

        setStatus(data);

        // Append new events
        if (data.events.length > 0) {
          setEvents((prev) => [...prev, ...data.events]);
          lastSeen.current = data.events[data.events.length - 1].occurred_at;
        }

        // Stop polling when terminal state reached
        if (data.status === "complete" || data.status === "failed") {
          return;
        }

        // Continue polling
        if (!cancelled) {
          setTimeout(poll, 1500);
        }
      } catch (e) {
        if (!cancelled) setTimeout(poll, 3000);
      }
    }

    poll();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const isComplete = status?.status === "complete";
  const isFailed = status?.status === "failed";
  const isExecuting = status?.status === "executing";
  const pct = status?.progress.percentage ?? 0;

  return (
    <div>
      {/* Big progress card */}
      <div className="rounded-xl p-8 mb-6 bg-white border border-gray-200">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-4">
            {isComplete ? (
              <div className="rounded-full flex items-center justify-center w-14 h-14 bg-green-100">
                <CheckCircle2 size={28} className="text-green-500" />
              </div>
            ) : isFailed ? (
              <div className="rounded-full flex items-center justify-center w-14 h-14 bg-red-100">
                <AlertTriangle size={28} className="text-red-500" />
              </div>
            ) : (
              <div className="rounded-full flex items-center justify-center w-14 h-14 bg-teal-light">
                <Loader2 size={28} className="text-teal animate-spin" />
              </div>
            )}
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-navy" style={{ letterSpacing: "-0.02em" }}>
                {isComplete ? "Complete" : isFailed ? "Failed" : "Working..."}
              </h2>
              <p className="text-sm text-ink-slate mt-0.5">
                {isComplete
                  ? `Finished in ${status?.duration_seconds || 0}s`
                  : isFailed
                  ? "Execution stopped"
                  : `${status?.progress.completed || 0} of ${status?.progress.total || 0} actions complete`}
              </p>
            </div>
          </div>
          <div className="text-4xl font-bold tracking-tight text-navy" style={{ letterSpacing: "-0.03em" }}>
            {pct}%
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-2 rounded-full overflow-hidden bg-gray-100 mb-4">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${pct}%`,
              backgroundColor: isFailed ? "#DC2626" : isComplete ? "#10B981" : "#2D7A75",
            }}
          />
        </div>

        {/* Stop button — visible while the job is running. The executor
            checks job.status between every action and exits cleanly when
            it sees 'cancelled'. Already-completed actions stay applied. */}
        {isExecuting && (
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-red-50 border border-red-100 mb-2">
            <div className="text-xs text-red-900 leading-relaxed">
              <strong>Need to stop this?</strong> Already-done actions stay applied. The
              background process exits within ~60 seconds at the next action boundary.
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => handleCancel(false)}
                disabled={cancelling}
                className="inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-semibold px-3 py-2 rounded-lg"
                title="Stop the cleanup at the next safe boundary"
              >
                <StopCircle size={14} />
                {cancelling ? "Stopping…" : "Stop Cleanup"}
              </button>
              <button
                onClick={() => handleCancel(true)}
                disabled={cancelling}
                className="text-[10px] text-red-700 hover:text-red-900 underline"
                title="Hard stop — invalidates QBO token, exits within seconds. Use only if regular stop isn't working."
              >
                Hard stop
              </button>
            </div>
          </div>
        )}
        {cancelError && (
          <div className="p-2 mb-2 text-xs bg-red-50 border border-red-200 rounded text-red-800">
            Cancel failed: {cancelError}
          </div>
        )}

        {/* Stats grid */}
        <div className="grid grid-cols-4 gap-3 mt-6">
          <Stat label="To Create" value={status?.stats.to_create ?? 0} />
          <Stat label="To Rename" value={status?.stats.to_rename ?? 0} />
          <Stat label="To Delete" value={status?.stats.to_delete ?? 0} />
          <Stat label="Flagged" value={status?.stats.flagged ?? 0} highlight={!!(status?.stats.flagged && status.stats.flagged > 0)} />
        </div>
      </div>

      {/* Error message — only for true errors, not platform limits */}
      {status?.error_message && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-6">
          <p className="text-sm font-semibold text-navy mb-1">⚠ Some operations had issues:</p>
          <p className="text-xs text-ink-slate whitespace-pre-wrap">{status.error_message}</p>
        </div>
      )}

      {/* Revert + Report banner — visible when the job failed OR has any
          manual cleanup items. Revert is now stage-scoped: only undoes the
          actions of the stage that errored, leaving completed stages
          (renames, creates) intact. */}
      {(isFailed ||
        status?.status === "cancelled" ||
        (status?.manual_cleanup_items && status.manual_cleanup_items.length > 0)) && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="text-sm text-red-900 leading-relaxed">
              <p className="font-semibold mb-1">Hit a problem — quick recovery actions:</p>
              <p className="text-xs">
                <strong>Revert {failedStage ? `(${failedStage === "delete" ? "inactivate" : failedStage} stage)` : "stage"}</strong>{" "}
                undoes only the actions of the stage that errored. Other stages stay applied.{" "}
                <strong>Download Error Report</strong> saves a Claude-friendly markdown file you
                can paste into a Claude conversation for diagnosis.
              </p>
            </div>
            <div className="flex flex-col items-end gap-2 flex-shrink-0">
              <div className="flex items-center gap-2">
                {failedStage && (
                  <button
                    onClick={() => handleRevertStage(failedStage)}
                    className="inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold px-3 py-2 rounded-lg"
                    title={`Revert only the ${failedStage} stage`}
                  >
                    <RotateCcw size={14} />
                    Revert {failedStage === "delete" ? "Inactivate" : failedStage.charAt(0).toUpperCase() + failedStage.slice(1)} Stage
                  </button>
                )}
                {!isFailed && status?.status !== "cancelled" && (
                  <button
                    onClick={() => handleCancel(false)}
                    disabled={cancelling}
                    className="inline-flex items-center gap-1.5 bg-red-100 hover:bg-red-200 disabled:opacity-50 text-red-800 text-xs font-semibold px-3 py-2 rounded-lg border border-red-300"
                    title="Stop the run without reverting (remaining actions get flagged)"
                  >
                    <RotateCcw size={14} />
                    {cancelling ? "Stopping…" : "Stop"}
                  </button>
                )}
                <button
                  onClick={handleDownloadReport}
                  className="inline-flex items-center gap-1.5 bg-navy hover:bg-ink-slate text-white text-xs font-semibold px-3 py-2 rounded-lg"
                  title="Download a markdown report you can paste into Claude for diagnosis"
                >
                  <FileDown size={14} />
                  Download Error Report
                </button>
              </div>
              {/* Optional: surface per-stage revert if the bookkeeper wants
                  to revert something other than the auto-detected failed stage */}
              <details className="text-[10px] text-red-700 cursor-pointer">
                <summary className="hover:text-red-900">Revert a different stage…</summary>
                <div className="flex items-center gap-2 mt-2">
                  {(["create", "rename", "merge", "delete"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => handleRevertStage(s)}
                      className="px-2 py-1 rounded border border-red-300 bg-white hover:bg-red-50 text-red-800 font-semibold"
                    >
                      {s === "delete" ? "Inactivate" : s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
              </details>
            </div>
          </div>
        </div>
      )}

      {/* Manual Cleanup Report — items the user must handle in QBO manually */}
      {status?.manual_cleanup_items && status.manual_cleanup_items.length > 0 && (
        <div className="bg-white border border-orange-200 rounded-xl p-5 mb-6">
          <div className="flex items-start gap-3 mb-4">
            <AlertTriangle size={20} className="text-orange-500 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="font-bold text-sm text-navy">
                Flagged for Manual Review — QBO Platform Limits ({status.manual_cleanup_items.length} {status.manual_cleanup_items.length === 1 ? "item" : "items"})
              </h3>
              <p className="text-xs text-ink-slate mt-1">
                These accounts hit QuickBooks limits (typically: account has transactions,
                balance, or naming conflicts), so they could not be auto-cleaned. You must
                handle each one manually in QBO using the steps below.
              </p>
            </div>
          </div>
          <div className="space-y-3">
            {status.manual_cleanup_items.map((item, i) => (
              <div key={i} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <p className="font-semibold text-sm text-navy">{item.account_name}</p>
                    <p className="text-[11px] text-ink-slate uppercase tracking-wide font-semibold mt-0.5">
                      Intended action: {item.intended_action}
                    </p>
                  </div>
                  <span className="text-[10px] bg-orange-100 text-orange-800 px-2 py-1 rounded font-semibold uppercase tracking-wide">
                    Manual
                  </span>
                </div>
                <p className="text-xs text-ink-slate mb-2">
                  <span className="font-semibold text-navy">Why: </span>{item.reason}
                </p>
                <p className="text-xs text-ink-slate">
                  <span className="font-semibold text-navy">What to do: </span>{item.suggestion}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Terminal log */}
      <div className="rounded-xl overflow-hidden bg-white border border-gray-200 mb-6">
        <div className="px-5 py-3 border-b border-gray-200">
          <h3 className="font-bold text-sm text-navy">Execution Log</h3>
        </div>
        <div className="p-4 font-mono text-xs space-y-1 max-h-96 overflow-y-auto bg-navy text-[#A8C5C2]">
          {events.length === 0 && (
            <div className="text-white/40 italic">Waiting for first events...</div>
          )}
          {events.map((event, i) => (
            <LogLine key={i} event={event} />
          ))}
          {isExecuting && (
            <div className="flex gap-3 items-start">
              <span className="text-white/40">{formatTime(new Date().toISOString())}</span>
              <Loader2 size={12} className="animate-spin text-yellow-500 mt-0.5 flex-shrink-0" />
              <span className="text-yellow-500">Processing...</span>
            </div>
          )}
          <div ref={logEndRef} />
        </div>
      </div>

      {/* Reclass handoff banner (only after COA complete) */}
      {isComplete && clientLinkId && (
        <div className="rounded-xl p-5 mb-6 bg-gradient-to-br from-teal-lighter to-blue-50 border-2 border-teal/30">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <span className="text-[10px] font-bold uppercase tracking-wider text-teal">Step 2 of 4 · Required</span>
              <h3 className="font-bold text-base text-navy mt-0.5 mb-1">
                COA cleanup complete — next: reclassify transactions
              </h3>
              <p className="text-sm text-ink-slate">
                Now that {clientName}'s chart of accounts is aligned to the Ironbooks master,
                run AI transaction reclassification to map historical transactions to the new accounts.
              </p>
            </div>
            <Link
              href={`/reclass/new?client=${clientLinkId}&workflow=full_categorization`}
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg flex-shrink-0 shadow-md"
            >
              Start Reclassification <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex justify-between items-center">
        <Link href="/today" className="text-sm font-semibold text-ink-slate hover:text-navy">
          ← Back to Today
        </Link>
        {isComplete && (
          <Link
            href="/jobs/new"
            className="text-sm font-semibold text-ink-slate hover:text-navy"
          >
            or Start Another COA Cleanup
          </Link>
        )}
      </div>
    </div>
  );
}

function LogLine({ event }: { event: AuditEvent }) {
  const time = formatTime(event.occurred_at);
  const payload = event.response_payload || event.request_payload || {};

  const isError = event.event_type === "error" || event.event_type === "job_failed";
  const isWarning = event.event_type === "warning";
  const isStageStart = event.event_type === "stage_start";
  const isStageComplete = event.event_type === "stage_complete";

  let icon = <CheckCircle2 size={12} className="text-green-500 mt-0.5 flex-shrink-0" />;
  let textColor = "text-[#A8C5C2]";

  if (isError) {
    icon = <AlertTriangle size={12} className="text-red-500 mt-0.5 flex-shrink-0" />;
    textColor = "text-red-300";
  } else if (isWarning) {
    icon = <AlertTriangle size={12} className="text-yellow-500 mt-0.5 flex-shrink-0" />;
    textColor = "text-yellow-300";
  } else if (isStageStart) {
    textColor = "text-blue-300 font-semibold";
  }

  const message = formatMessage(event);

  return (
    <div className="flex gap-3 items-start">
      <span className="text-white/40 flex-shrink-0">{time}</span>
      {icon}
      <span className={textColor}>{message}</span>
    </div>
  );
}

function formatMessage(event: AuditEvent): string {
  const payload = event.response_payload || event.request_payload || {};

  if (payload.message) return payload.message;

  switch (event.event_type) {
    case "qbo_create_parent":
      return `Created parent: ${payload.name}`;
    case "qbo_create_child":
      return `Created: ${payload.name} (under ${payload.parent})`;
    case "qbo_rename":
      return `Renamed: "${payload.from}" → "${payload.to}"`;
    case "qbo_inactivate":
      return `Inactivated: ${payload.name}`;
    default:
      return event.event_type;
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="p-4 rounded-lg bg-gray-50">
      <div
        className="text-xl font-bold"
        style={{ color: highlight ? "#F59E0B" : "#0F1F2E" }}
      >
        {value}
      </div>
      <div className="text-xs mt-1 font-semibold text-ink-slate">{label}</div>
    </div>
  );
}
