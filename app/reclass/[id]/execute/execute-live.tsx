"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  RotateCcw,
  ArrowRight,
  Receipt,
  CreditCard,
  Rewind,
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

export function ExecuteLive({
  job: initialJob,
  userRole,
  hasStripeDeposits = false,
}: {
  job: JobView;
  userRole: string;
  hasStripeDeposits?: boolean;
}) {
  const router = useRouter();
  const [job, setJob] = useState(initialJob);
  const [progress, setProgress] = useState({ total: 0, completed: 0, percentage: 0 });
  const [events, setEvents] = useState<any[]>([]);
  const [rollbackConfirm, setRollbackConfirm] = useState("");
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackError, setRollbackError] = useState("");
  const [cascading, setCascading] = useState(false);
  const [cascadeError, setCascadeError] = useState("");

  const isLeadOrAdmin = userRole === "admin" || userRole === "lead";
  const isComplete = job.status === "complete" || job.status === "failed";
  // Guards against two overlapping polls both POSTing a continuation.
  const continuingRef = useRef(false);

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

        // A large job pauses between time-budgeted batches (status stays
        // "executing", execution_resumable=true). Kick the next pass — the
        // route atomically claims it, so overlapping triggers are no-ops.
        if (data.status === "executing" && data.execution_resumable && !continuingRef.current) {
          continuingRef.current = true;
          fetch(`/api/reclass/${job.id}/execute`, { method: "POST" })
            .catch(() => {})
            .finally(() => { continuingRef.current = false; });
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

  async function handleCascadePriorYear() {
    setCascading(true);
    setCascadeError("");
    try {
      const res = await fetch(`/api/reclass/${job.id}/cascade-prior-year`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start prior-year cleanup");
      router.push(`/reclass/${data.job_id}/review`);
    } catch (e: any) {
      setCascadeError(e.message);
      setCascading(false);
    }
  }

  // Compute prior-year window. Always shows the CTA for full_categorization
  // jobs (multi-year sources still cascade to the year before their earliest
  // date). Chain-length cap on the API side prevents runaway recursion.
  const { priorYear, priorStartLabel, priorEndLabel, cascadeApplicable } = (() => {
    const start = new Date(job.date_range_start);
    if (isNaN(start.getTime())) {
      return { priorYear: null, priorStartLabel: "", priorEndLabel: "", cascadeApplicable: false };
    }
    const priorStart = new Date(start);
    priorStart.setUTCFullYear(priorStart.getUTCFullYear() - 1);
    const priorEnd = new Date(start);
    priorEnd.setUTCDate(priorEnd.getUTCDate() - 1);
    return {
      priorYear: priorStart.getUTCFullYear(),
      priorStartLabel: priorStart.toISOString().slice(0, 10),
      priorEndLabel: priorEnd.toISOString().slice(0, 10),
      cascadeApplicable: true,
    };
  })();

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

      {/* Next-step handoff — matches the stepper order: Bank Rules is
          ALWAYS the primary Step 3 card; Stripe Recon (when deposits are
          detected) follows as the Step 4 card, not in front of it. */}
      {job.status === "complete" &&
        job.workflow === "full_categorization" &&
        !job.is_rollback &&
        job.client_link_id && (
          <>
            <h2 className="text-sm font-semibold text-ink-slate">Next steps based on your workflow</h2>
            <div className="rounded-2xl p-5 bg-gradient-to-br from-teal-lighter to-blue-50 border-2 border-teal/30">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div className="rounded-full flex items-center justify-center w-10 h-10 bg-white flex-shrink-0">
                    <Receipt className="text-teal" size={20} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-teal">Step 3 · Always next</span>
                    <h3 className="font-bold text-base text-navy mt-0.5 mb-1">
                      Generate Bank Rules
                    </h3>
                    <p className="text-sm text-ink-slate">
                      {job.transactions_moved > 0
                        ? `Turn the ${job.transactions_moved} approved categorizations into bank rules so future transactions auto-categorize.`
                        : "All transactions were already correctly categorized — nothing to move. Create bank rules to lock in vendor→account mappings going forward."}
                    </p>
                  </div>
                </div>
                <Link
                  href={`/reclass/${job.id}/bank-rules`}
                  className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg flex-shrink-0 shadow-md"
                >
                  Generate Bank Rules <ArrowRight size={16} />
                </Link>
              </div>
            </div>
            {hasStripeDeposits && (
              <div className="rounded-2xl p-5 bg-gradient-to-br from-purple-50 to-pink-50 border-2 border-purple-200">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="rounded-full flex items-center justify-center w-10 h-10 bg-white flex-shrink-0">
                      <CreditCard className="text-purple-600" size={20} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-purple-700">Step 4 · Optional</span>
                      <h3 className="font-bold text-base text-navy mt-0.5 mb-1">
                        Stripe AR Reconciliation
                      </h3>
                      <p className="text-sm text-ink-slate">
                        Stripe deposits detected. Match them to customer invoices, split out processing fees,
                        and apply sales tax (Canada). Skip if this client doesn&apos;t use Stripe.
                      </p>
                    </div>
                  </div>
                  <Link
                    href={`/stripe-recon/new?client=${job.client_link_id}&reclass_job_id=${job.id}`}
                    className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg flex-shrink-0 shadow-md"
                  >
                    Start Stripe Recon <ArrowRight size={16} />
                  </Link>
                </div>
              </div>
            )}
          </>
        )}

      {/* Year cascade — "Continue with Previous Year"
          Computes a FULL 12-month prior window based on source start date, so
          calendar-year jobs cascade to full calendar years and fiscal-year jobs
          cascade to full fiscal years automatically. Skipped for multi-year
          source jobs (already covered older periods in one shot). */}
      {job.status === "complete" &&
        job.workflow === "full_categorization" &&
        !job.is_rollback &&
        !job.rolled_back &&
        job.transactions_moved > 0 &&
        job.client_link_id &&
        cascadeApplicable &&
        priorYear && (
          <div className="rounded-2xl p-5 bg-gradient-to-br from-amber-50 to-orange-50 border-2 border-amber-200">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className="rounded-full flex items-center justify-center w-10 h-10 bg-white flex-shrink-0">
                  <Rewind className="text-amber-700" size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Optional · Year-by-Year Cleanup</span>
                  <h3 className="font-bold text-base text-navy mt-0.5 mb-1">
                    Continue with Previous Year ({priorYear})
                  </h3>
                  <p className="text-sm text-ink-slate">
                    Full prior {priorStartLabel.startsWith(`${priorYear}-01-01`) ? "calendar year" : "fiscal year"}: <span className="font-mono font-semibold">{priorStartLabel} → {priorEndLabel}</span>. Every account the bookkeeper picked just got saved as a bank rule — most of those vendors will auto-categorize from the cache, so this should run faster than year 1.
                  </p>
                  {cascadeError && (
                    <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                      {cascadeError}
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={handleCascadePriorYear}
                disabled={cascading}
                className="inline-flex items-center gap-2 bg-amber-700 hover:bg-amber-800 disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-lg flex-shrink-0 shadow-md"
              >
                {cascading ? <Loader2 className="animate-spin" size={16} /> : <Rewind size={16} />}
                {cascading ? "Starting..." : `Categorize ${priorYear} →`}
              </button>
            </div>
            <div className="mt-3 pt-3 border-t border-amber-200 flex items-center justify-between text-xs">
              <span className="text-ink-slate">
                Or stop here if this client doesn't need older books cleaned up
              </span>
              <Link
                href="/today"
                className="font-semibold text-amber-700 hover:text-amber-900"
              >
                I'm done with this client
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
