"use client";

import { useEffect, useState, useRef } from "react";
import { CheckCircle2, Loader2, AlertTriangle, ExternalLink, ArrowRight, GitMerge, X, RefreshCw, Edit3, XCircle } from "lucide-react";
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

interface MergeCandidate {
  id: string;
  type: "existing_target" | "new_consolidation";
  target_name: string;
  target_account_id: string | null;
  source_accounts: Array<{
    id: string;
    name: string;
    transaction_count: number;
    balance: number;
  }>;
  recommended_winner_id: string | null;
  status: "pending" | "in_progress" | "complete" | "failed" | "ignored";
  error_message: string | null;
  completed_at: string | null;
  user_choice: any;
}

interface StatusResponse {
  status: string;
  execution_started_at: string | null;
  execution_completed_at: string | null;
  duration_seconds: number | null;
  error_message: string | null;
  manual_cleanup_items: ManualCleanupItem[];
  merge_candidates: MergeCandidate[];
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
}: {
  jobId: string;
  initialStatus: string;
  clientName: string;
}) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [autoStarted, setAutoStarted] = useState(false);
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
  const fetchStatusOnce = async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/status`);
      if (!res.ok) return;
      const data: StatusResponse = await res.json();
      setStatus(data);
    } catch {
      /* swallow */
    }
  };

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

      {/* Merge Candidates — interactive cards for account merges */}
      {status?.merge_candidates && status.merge_candidates.length > 0 && (
        <MergeCandidatesPanel
          jobId={jobId}
          merges={status.merge_candidates}
          onRefresh={fetchStatusOnce}
        />
      )}

      {/* Manual Cleanup Report — items the user must handle in QBO manually */}
      {status?.manual_cleanup_items && status.manual_cleanup_items.length > 0 && (
        <div className="bg-white border border-orange-200 rounded-xl p-5 mb-6">
          <div className="flex items-start gap-3 mb-4">
            <AlertTriangle size={20} className="text-orange-500 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="font-bold text-sm text-navy">
                Manual Cleanup Report ({status.manual_cleanup_items.length} {status.manual_cleanup_items.length === 1 ? "item" : "items"})
              </h3>
              <p className="text-xs text-ink-slate mt-1">
                These accounts could not be auto-cleaned because of QBO platform limits
                (typically: account has transactions, balance, or naming conflicts).
                Please handle each one manually in QBO using the steps below.
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

      {/* Action buttons */}
      <div className="flex justify-between items-center">
        <Link href="/today" className="text-sm font-semibold text-ink-slate hover:text-navy">
          ← Back to Today
        </Link>
        {isComplete && (
          <Link
            href="/jobs/new"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
          >
            Start Another Cleanup <ArrowRight size={16} />
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

// ============================================================================
// Merge Candidates Panel
// ============================================================================
// Interactive cards for the account-merge workflow. Each card represents one
// merge candidate. Lisa can:
//   - Transfer & Merge   → POST /api/jobs/[id]/merges/[mergeId]/action {action: "execute"}
//   - Rename to other    → POST /api/jobs/[id]/merges/[mergeId]/action {action: "rename", new_name}
//   - Ignore             → POST /api/jobs/[id]/merges/[mergeId]/action {action: "ignore"}
//   - Try Again          → POST /api/jobs/[id]/merges/[mergeId]/action {action: "retry"}
// All actions trigger an onRefresh() to repull job status.
// ============================================================================

function MergeCandidatesPanel({
  jobId,
  merges,
  onRefresh,
}: {
  jobId: string;
  merges: MergeCandidate[];
  onRefresh: () => void;
}) {
  const pending = merges.filter((m) => m.status === "pending" || m.status === "in_progress" || m.status === "failed");
  const done = merges.filter((m) => m.status === "complete" || m.status === "ignored");

  return (
    <div className="bg-white border border-teal-border rounded-xl p-5 mb-6">
      <div className="flex items-start gap-3 mb-4">
        <GitMerge size={20} className="text-teal-dark mt-0.5 flex-shrink-0" />
        <div>
          <h3 className="font-bold text-sm text-navy">
            Account Merges Needed ({merges.length} total · {pending.length} pending · {done.length} done)
          </h3>
          <p className="text-xs text-ink-slate mt-1">
            Multiple accounts want to use the same name. Decide what to do for each merge below.
            Transactions will be moved into the chosen account, and emptied accounts will be inactivated.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {merges.map((m) => (
          <MergeCard key={m.id} jobId={jobId} merge={m} onRefresh={onRefresh} />
        ))}
      </div>
    </div>
  );
}

function MergeCard({
  jobId,
  merge,
  onRefresh,
}: {
  jobId: string;
  merge: MergeCandidate;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [renameMode, setRenameMode] = useState(false);
  const [renameValue, setRenameValue] = useState(merge.target_name);
  const [winnerOverride, setWinnerOverride] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const isDone = merge.status === "complete";
  const isIgnored = merge.status === "ignored";
  const isFailed = merge.status === "failed";
  const isInProgress = merge.status === "in_progress" || busy;

  async function callAction(body: any) {
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/merges/${merge.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok && data?.error) {
        alert(`Could not complete action: ${data.error}`);
      }
    } catch (e: any) {
      alert(`Network error: ${e?.message || e}`);
    } finally {
      setBusy(false);
      onRefresh();
    }
  }

  // Determine the winner for display purposes
  const winnerId =
    merge.type === "existing_target"
      ? merge.target_account_id
      : (winnerOverride || merge.recommended_winner_id);

  const winnerInfo =
    merge.type === "existing_target"
      ? { id: merge.target_account_id, name: merge.target_name, balance: 0, transaction_count: 0 }
      : merge.source_accounts.find((s) => s.id === winnerId);

  const drainees = merge.source_accounts.filter((s) => s.id !== winnerId);

  // Compute total tx + balance about to move
  const totalTx = drainees.reduce((sum, s) => sum + s.transaction_count, 0);
  const totalBal = drainees.reduce((sum, s) => sum + s.balance, 0);

  return (
    <div className={`border rounded-lg p-4 ${
      isDone ? "bg-green-50 border-green-200" :
      isIgnored ? "bg-gray-50 border-gray-200 opacity-70" :
      isFailed ? "bg-red-50 border-red-200" :
      isInProgress ? "bg-blue-50 border-blue-200" :
      "bg-teal-light border-teal-border"
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-navy">
            {merge.type === "existing_target"
              ? `Merge into existing "${merge.target_name}"`
              : `Consolidate ${merge.source_accounts.length} accounts → "${merge.target_name}"`}
          </p>
          <p className="text-[11px] text-ink-slate mt-0.5">
            {merge.type === "existing_target"
              ? "Target name already exists in QBO."
              : "Multiple accounts mapped to the same target name."}
          </p>
        </div>
        <MergeStatusPill status={merge.status} />
      </div>

      {/* Winner row */}
      {winnerInfo && !isIgnored && (
        <div className={`rounded-md px-3 py-2 mb-2 border ${
          isDone ? "bg-white border-green-300" : "bg-white border-teal-border"
        }`}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide font-bold text-teal-dark">
                {merge.type === "existing_target" ? "Existing target (keeps)" : "Winner (gets the name)"}
              </p>
              <p className="text-sm font-semibold text-navy truncate">
                ✓ {winnerInfo.name}
                <span className="ml-2 text-[11px] text-ink-light font-normal">id {winnerInfo.id}</span>
              </p>
            </div>
            {merge.type === "new_consolidation" && !isDone && !isInProgress && (
              <button
                onClick={() => setPickerOpen(!pickerOpen)}
                className="text-[11px] text-teal-dark hover:text-teal-dark font-semibold whitespace-nowrap"
              >
                {pickerOpen ? "Close" : "Change winner"}
              </button>
            )}
          </div>

          {pickerOpen && merge.type === "new_consolidation" && (
            <div className="mt-2 pt-2 border-t border-teal-border space-y-1">
              <p className="text-[10px] font-bold text-teal-dark uppercase tracking-wide">Pick which account wins:</p>
              {merge.source_accounts.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-teal-light rounded px-1 py-0.5">
                  <input
                    type="radio"
                    name={`winner-${merge.id}`}
                    checked={(winnerOverride || merge.recommended_winner_id) === s.id}
                    onChange={() => { setWinnerOverride(s.id); setPickerOpen(false); }}
                  />
                  <span className="font-semibold text-navy">{s.name}</span>
                  <span className="text-ink-light">· {s.transaction_count} tx · ${s.balance.toFixed(2)}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Drainees row */}
      {drainees.length > 0 && !isIgnored && (
        <div className="bg-white rounded-md px-3 py-2 mb-3 border border-gray-200">
          <p className="text-[10px] uppercase tracking-wide font-bold text-ink-slate mb-1">
            {isDone ? "Drained & inactivated:" : "Will be drained & inactivated:"}
          </p>
          <ul className="space-y-0.5">
            {drainees.map((s) => (
              <li key={s.id} className="text-xs text-navy">
                <span className="font-semibold">{s.name}</span>
                <span className="text-ink-light ml-2">
                  id {s.id} · {s.transaction_count} tx · ${s.balance.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
          {!isDone && (
            <p className="text-[11px] text-ink-slate mt-2">
              <strong>Total to move:</strong> {totalTx} transactions · ${totalBal.toFixed(2)} balance
            </p>
          )}
        </div>
      )}

      {/* Error banner for failed */}
      {isFailed && merge.error_message && (
        <div className="bg-red-100 border border-red-300 rounded-md px-3 py-2 mb-3">
          <p className="text-[11px] font-bold text-red-700 uppercase tracking-wide mb-1">Merge failed</p>
          <p className="text-xs text-red-800 whitespace-pre-wrap">{merge.error_message}</p>
          <p className="text-[11px] text-red-700 mt-2">
            Resolve the issue in QBO (e.g., unlock a closed period, fix permissions, sort a name conflict), then click <strong>Try Again</strong>.
          </p>
        </div>
      )}

      {/* Action buttons */}
      {!isDone && !isIgnored && !isInProgress && !renameMode && (
        <div className="flex flex-wrap items-center gap-2">
          {isFailed ? (
            <button
              onClick={() => callAction({ action: "retry", winner_id: winnerOverride || merge.recommended_winner_id })}
              disabled={busy}
              className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-semibold px-3 py-1.5 rounded-md"
            >
              <RefreshCw size={12} /> Try Again
            </button>
          ) : (
            <button
              onClick={() => callAction({ action: "execute", winner_id: winnerOverride || merge.recommended_winner_id })}
              disabled={busy}
              className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-semibold px-3 py-1.5 rounded-md"
            >
              <CheckCircle2 size={12} /> Transfer & Merge
            </button>
          )}
          <button
            onClick={() => setRenameMode(true)}
            className="inline-flex items-center gap-1.5 bg-white hover:bg-gray-50 text-navy text-xs font-semibold px-3 py-1.5 rounded-md border border-gray-300"
          >
            <Edit3 size={12} /> Rename to something else
          </button>
          <button
            onClick={() => callAction({ action: "ignore" })}
            disabled={busy}
            className="inline-flex items-center gap-1.5 bg-white hover:bg-gray-50 text-ink-slate text-xs font-semibold px-3 py-1.5 rounded-md border border-gray-300"
          >
            <XCircle size={12} /> Ignore
          </button>
        </div>
      )}

      {/* Rename mode */}
      {renameMode && !isDone && !isIgnored && (
        <div className="flex items-center gap-2 mt-1">
          <input
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="New unique name..."
            className="flex-1 px-3 py-1.5 text-xs border border-gray-300 rounded-md outline-none focus:ring-1 focus:ring-teal"
          />
          <button
            onClick={() => {
              if (!renameValue.trim()) { alert("Enter a name."); return; }
              callAction({ action: "rename", new_name: renameValue.trim(), winner_id: winnerOverride || merge.recommended_winner_id });
              setRenameMode(false);
            }}
            disabled={busy}
            className="bg-teal hover:bg-teal-dark text-white text-xs font-semibold px-3 py-1.5 rounded-md"
          >
            Save
          </button>
          <button
            onClick={() => setRenameMode(false)}
            className="text-xs text-ink-slate hover:text-navy px-2"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Done/ignored state */}
      {isDone && (
        <p className="text-xs text-green-700 mt-1">
          <CheckCircle2 size={12} className="inline mr-1" />
          {merge.user_choice?.action === "rename"
            ? `Renamed to "${merge.user_choice?.new_name}".`
            : `Merged ${merge.user_choice?.transactions_moved ?? 0} transactions. Inactivated ${(merge.user_choice?.accounts_inactivated ?? []).length} account(s).`}
        </p>
      )}
      {isIgnored && <p className="text-xs text-ink-slate italic mt-1">Ignored.</p>}
      {isInProgress && (
        <div className="flex items-center gap-2 text-xs text-blue-700 mt-1">
          <Loader2 size={12} className="animate-spin" />
          Working… moving transactions and inactivating accounts. This may take a minute.
        </div>
      )}
    </div>
  );
}

function MergeStatusPill({ status }: { status: MergeCandidate["status"] }) {
  const config: Record<MergeCandidate["status"], { color: string; bg: string; label: string }> = {
    pending: { color: "#6B21A8", bg: "#F3E8FF", label: "Pending" },
    in_progress: { color: "#1E40AF", bg: "#DBEAFE", label: "Working…" },
    complete: { color: "#065F46", bg: "#D1FAE5", label: "Done" },
    failed: { color: "#991B1B", bg: "#FEE2E2", label: "Failed" },
    ignored: { color: "#475569", bg: "#F1F5F9", label: "Ignored" },
  };
  const c = config[status];
  return (
    <span
      className="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded whitespace-nowrap"
      style={{ color: c.color, backgroundColor: c.bg }}
    >
      {c.label}
    </span>
  );
}
