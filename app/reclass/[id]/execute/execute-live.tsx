"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  RotateCcw,
  ArrowRight,
  Receipt,
} from "lucide-react";

interface JobView {
  id: string;
  status: string;
  workflow: string;
  source_account_name: string;
  target_account_name: string | null;
  date_range_start: string;
  date_range_end: string;
  reason: string;
  execution_started_at: string | null;
  execution_completed_at: string | null;
  execution_duration_seconds: number | null;
  transactions_moved: number;
  transactions_failed: number;
  error_message: string | null;
  is_rollback: boolean;
  rolled_back: boolean;
  parent_job_id: string | null;
  double_task_id: string | null;
  client_name: string;
  bookkeeper_name: string;
  client_link_id?: string;
}

export function ExecuteLive({ job: initialJob, userRole }: { job: JobView; userRole: string }) {
  const router = useRouter();
  const [job, setJob] = useState(initialJob);
  const [progress, setProgress] = useState({ total: 0, completed: 0, percentage: 0 });
  const [events, setEvents] = useState<any[]>([]);
  const [rollbackConfirm, setRollbackConfirm] = useState("");
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackError, setRollbackError] = useState("");

  const isLeadOrAdmin = userRole === "admin" || userRole === "lead";
  const isComplete = job.status === "complete" || job.status === "failed";

  useEffect(() => {
    if (isComplete) return;

    let lastSeen: string | null = null;
    let cancelled = false;

    async function poll() {
      try {
        const url = lastSeen
          ? `/api/reclass/${job.id}/status?since=${encodeURIComponent(lastSeen)}`
          : `/api/reclass/${job.id}/status`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;

        setJob((prev) => ({
          ...prev,
          status: data.status,
          execution_completed_at: data.execution_completed_at,
          execution_duration_seconds: data.duration_seconds,
          transactions_moved: data.stats.moved,
          transactions_failed: data.stats.failed,
          error_message: data.error_message,
        }));
        setProgress(data.progress);

        if (data.events && data.events.length > 0) {
          setEvents((prev) => [...prev, ...data.events]);
          lastSeen = data.events[data.events.length - 1].occurred_at;
        }

        if (data.status === "complete" || data.status === "failed") {
          router.refresh();
          return;
        }

        setTimeout(poll, 1500);
      } catch {
        if (!cancelled) setTimeout(poll, 3000);
      }
    }

    poll();
    return () => {
      cancelled = true;
    };
  }, [job.id, isComplete, router]);

  async function handleRollback() {
    if (rollbackConfirm !== "ROLLBACK") {
      setRollbackError('You must type "ROLLBACK" exactly (uppercase)');
      return;
    }
    setRollingBack(true);
    setRollbackError("");
    try {
      const res = await fetch(`/api/reclass/${job.id}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation_phrase: rollbackConfirm }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Rollback failed");
      router.push(`/reclass/${data.rollback_job_id}/execute`);
    } catch (e: any) {
      setRollbackError(e.message);
      setRollingBack(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Status header */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-ink-slate mb-1">
              {job.is_rollback ? "Rollback" : "Reclassification"}
              {job.rolled_back && " · ROLLED BACK"}
            </div>
            <div className="text-lg font-bold text-navy">
              {job.source_account_name}
              {job.target_account_name && (
                <>
                  <ArrowRight className="inline mx-2 text-teal" size={18} />
                  {job.target_account_name}
                </>
              )}
            </div>
            <div className="text-sm text-ink-slate mt-1">
              {job.date_range_start} → {job.date_range_end} · "{job.reason}" · by {job.bookkeeper_name}
            </div>
          </div>
          <StatusBadge status={job.status} />
        </div>

        {/* Progress bar */}
        {!isComplete && progress.total > 0 && (
          <>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden mb-2">
              <div
                className="h-full bg-teal transition-all duration-500"
                style={{ width: `${progress.percentage}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-ink-slate">
              <span>
                {progress.completed} of {progress.total} transactions
              </span>
              <span>{progress.percentage}%</span>
            </div>
          </>
        )}

        {/* Completion stats */}
        {isComplete && (
          <div className="grid grid-cols-3 gap-3 mt-4">
            <div className="p-3 bg-emerald-50 rounded-lg text-center">
              <div className="text-2xl font-bold text-emerald-700">{job.transactions_moved}</div>
              <div className="text-xs text-emerald-700 uppercase tracking-wide">Moved</div>
            </div>
            <div className="p-3 bg-red-50 rounded-lg text-center">
              <div className="text-2xl font-bold text-red-700">{job.transactions_failed}</div>
              <div className="text-xs text-red-700 uppercase tracking-wide">Failed</div>
            </div>
            <div className="p-3 bg-gray-50 rounded-lg text-center">
              <div className="text-2xl font-bold text-navy">
                {job.execution_duration_seconds || 0}s
              </div>
              <div className="text-xs text-ink-slate uppercase tracking-wide">Duration</div>
            </div>
          </div>
        )}

        {/* Error */}
        {job.error_message && (
          <div className="mt-4 p-3 bg-red-50 text-red-800 rounded-lg text-sm">
            <div className="font-semibold mb-1">Errors:</div>
            <div className="whitespace-pre-wrap">{job.error_message}</div>
          </div>
        )}

        {/* Double sync confirmation */}
        {job.double_task_id && (
          <div className="mt-3 p-3 bg-blue-50 text-blue-800 rounded-lg text-sm">
            Posted summary to Double as task #{job.double_task_id}
          </div>
        )}
      </div>

      {/* Bank Rules handoff — only for completed full_categorization jobs */}
      {job.status === "complete" &&
        job.workflow === "full_categorization" &&
        !job.is_rollback &&
        job.transactions_moved > 0 &&
        job.client_link_id && (
          <div className="rounded-2xl p-5 bg-gradient-to-br from-teal-lighter to-blue-50 border-2 border-teal/30">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className="rounded-full flex items-center justify-center w-10 h-10 bg-white flex-shrink-0">
                  <Receipt className="text-teal" size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-base text-navy mb-1">
                    Generate Bank Rules from these categorizations
                  </h3>
                  <p className="text-sm text-ink-slate">
                    Turn the {job.transactions_moved} approved decisions into QBO Bank Rules so future
                    transactions from the same vendors are auto-categorized.
                  </p>
                </div>
              </div>
              <Link
                href={`/rules/new?client=${job.client_link_id}&from_reclass=${job.id}`}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg flex-shrink-0 shadow-md"
              >
                Generate Bank Rules <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        )}

      {/* Event log */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <h3 className="font-bold text-navy mb-3">Activity log</h3>
        {events.length === 0 ? (
          <div className="text-sm text-ink-slate">Waiting for events...</div>
        ) : (
          <div className="space-y-1.5 text-sm max-h-80 overflow-y-auto">
            {events.map((e, i) => (
              <div key={i} className="flex items-start gap-2 py-1 border-b border-gray-50 last:border-0">
                <span className="text-xs text-ink-slate font-mono whitespace-nowrap">
                  {new Date(e.occurred_at).toLocaleTimeString()}
                </span>
                <span className="text-ink-slate flex-1">
                  {e.request_payload?.message || e.event_type}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rollback section - only show for completed, non-rollback jobs */}
      {job.status === "complete" &&
        !job.is_rollback &&
        !job.rolled_back &&
        job.transactions_moved > 0 &&
        isLeadOrAdmin && (
          <div className="bg-white rounded-2xl border-2 border-red-200 p-6">
            <div className="flex items-start gap-3 mb-3">
              <RotateCcw className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
              <div>
                <h3 className="font-bold text-navy mb-1">Rollback (last resort)</h3>
                <p className="text-sm text-ink-slate">
                  Reverses all {job.transactions_moved} transactions back to their original accounts.
                  Creates a new audit entry. Use only if you executed in error.
                </p>
              </div>
            </div>
            <div className="space-y-3">
              <input
                type="text"
                value={rollbackConfirm}
                onChange={(e) => setRollbackConfirm(e.target.value)}
                placeholder='Type "ROLLBACK" to confirm'
                className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-red-500 focus:outline-none font-mono text-sm"
              />
              {rollbackError && (
                <div className="p-3 bg-red-50 text-red-800 rounded-lg text-sm">{rollbackError}</div>
              )}
              <button
                onClick={handleRollback}
                disabled={rollbackConfirm !== "ROLLBACK" || rollingBack}
                className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold px-6 py-2.5 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {rollingBack && <Loader2 className="animate-spin" size={16} />}
                Rollback {job.transactions_moved} transactions
              </button>
            </div>
          </div>
        )}

      {/* Back to history */}
      {isComplete && (
        <div className="text-center">
          <a href="/history" className="text-sm text-teal hover:text-teal-dark underline">
            ← Back to Job History
          </a>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "complete") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-semibold">
        <CheckCircle2 size={14} /> Complete
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-100 text-red-700 text-xs font-semibold">
        <AlertCircle size={14} /> Failed
      </span>
    );
  }
  if (status === "executing") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-100 text-amber-700 text-xs font-semibold">
        <Loader2 className="animate-spin" size={14} /> Executing
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-gray-100 text-ink-slate text-xs font-semibold">
      {status}
    </span>
  );
}
