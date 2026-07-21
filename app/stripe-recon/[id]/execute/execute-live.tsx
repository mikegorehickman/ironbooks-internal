"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2, AlertTriangle, Loader2, CreditCard, ArrowRight, XCircle,
} from "lucide-react";

interface MatchState {
  id: string;
  qbo_deposit_id: string;
  decision: string;
  executed: boolean;
  executed_at: string | null;
  error_message: string | null;
  computed_fee: number;
  computed_tax: number;
  matched_customer_names: string[] | null;
  deposit_amount: number;
}

interface StatusResponse {
  job: {
    id: string;
    status: string;
    error_message: string | null;
    execution_completed_at: string | null;
    execution_duration_seconds: number | null;
    total_fees: number | null;
    total_tax: number | null;
    warnings: any;
  };
  progress: {
    total_approved: number;
    executed: number;
    failed: number;
    pending: number;
    percentage: number;
  };
  recent_failures: Array<{ qbo_deposit_id: string; error: string }>;
  matches: MatchState[];
}

export function StripeReconExecute({
  jobId,
  initialStatus,
  clientName,
  jurisdiction,
  clientLinkId,
}: {
  jobId: string;
  initialStatus: string;
  clientName: string;
  jurisdiction: string;
  clientLinkId: string;
}) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [autoStarted, setAutoStarted] = useState(false);
  const [startError, setStartError] = useState<string>("");
  const polling = useRef(false);

  // Auto-start execution
  useEffect(() => {
    if (!autoStarted && (initialStatus === "in_review" || initialStatus === "draft")) {
      setAutoStarted(true);
      fetch(`/api/stripe-recon/${jobId}/execute`, { method: "POST" })
        .then(async (r) => {
          if (!r.ok) {
            const data = await r.json().catch(() => ({}));
            setStartError(data.error || `HTTP ${r.status}`);
          }
        })
        .catch((e) => setStartError(String(e?.message || e)));
    } else {
      setAutoStarted(true);
    }
  }, [jobId, initialStatus, autoStarted]);

  // Poll
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (polling.current) return;
      polling.current = true;
      try {
        const res = await fetch(`/api/stripe-recon/${jobId}/status`);
        if (!res.ok) return;
        const data: StatusResponse = await res.json();
        if (cancelled) return;
        setStatus(data);
        if (data.job.status === "complete" || data.job.status === "failed") return;
      } finally {
        polling.current = false;
      }
      if (!cancelled) setTimeout(poll, 1500);
    }

    poll();
    return () => { cancelled = true; };
  }, [jobId]);

  const isComplete = status?.job.status === "complete";
  const isFailed = status?.job.status === "failed";
  const isExecuting = status?.job.status === "executing";
  const pct = status?.progress.percentage ?? 0;
  const isCanada = jurisdiction === "CA";

  return (
    <div className="space-y-6">
      {/* Big progress card */}
      <div className="rounded-2xl p-6 bg-white border border-gray-100">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-4">
            {isComplete ? (
              <div className="rounded-full w-14 h-14 flex items-center justify-center bg-green-100">
                <CheckCircle2 size={28} className="text-green-600" />
              </div>
            ) : isFailed ? (
              <div className="rounded-full w-14 h-14 flex items-center justify-center bg-red-100">
                <XCircle size={28} className="text-red-600" />
              </div>
            ) : (
              <div className="rounded-full w-14 h-14 flex items-center justify-center bg-teal-light">
                <Loader2 size={28} className="text-teal-dark animate-spin" />
              </div>
            )}
            <div>
              <h2 className="text-2xl font-bold text-navy">
                {isComplete ? "Complete" : isFailed ? "Failed" : "Writing to QBO..."}
              </h2>
              <p className="text-sm text-ink-slate mt-0.5">
                {isComplete
                  ? `${status?.progress.executed} of ${status?.progress.total_approved} deposits updated in ${status?.job.execution_duration_seconds ?? 0}s`
                  : isFailed
                  ? "Execution stopped"
                  : `${status?.progress.executed ?? 0} of ${status?.progress.total_approved ?? 0} deposits processed`}
              </p>
            </div>
          </div>
          <div className="text-4xl font-bold text-navy">{pct}%</div>
        </div>

        <div className="h-2 rounded-full overflow-hidden bg-gray-100 mb-4">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${pct}%`,
              backgroundColor: isFailed ? "#DC2626" : isComplete ? "#10B981" : "#7C3AED",
            }}
          />
        </div>

        <div className={`grid gap-3 mt-5 ${isCanada ? "grid-cols-4" : "grid-cols-3"}`}>
          <Stat label="Deposits Updated" value={status?.progress.executed ?? 0} />
          <Stat label="Failed" value={status?.progress.failed ?? 0} highlight={!!(status?.progress.failed && status.progress.failed > 0)} />
          <Stat label="Fees Recorded" value={`$${(status?.job.total_fees ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`} />
          {isCanada && (
            <Stat label="Tax Recovered" value={`$${(status?.job.total_tax ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`} />
          )}
        </div>
      </div>

      {startError && (
        <div className="rounded-xl p-4 bg-red-50 border border-red-200">
          <div className="text-sm font-semibold text-red-900 mb-1">Could not start execution</div>
          <div className="text-xs text-red-800 whitespace-pre-wrap">{startError}</div>
        </div>
      )}

      {status?.job.error_message && (
        <div className="rounded-xl p-4 bg-yellow-50 border border-yellow-200">
          <div className="text-sm font-semibold text-navy mb-1 flex items-center gap-1.5">
            <AlertTriangle size={14} className="text-yellow-600" /> Some operations had issues
          </div>
          <div className="text-xs text-ink-slate whitespace-pre-wrap">{status.job.error_message}</div>
        </div>
      )}

      {/* Per-deposit detail */}
      <div className="rounded-xl bg-white border border-gray-200">
        <div className="px-5 py-3 border-b border-gray-200">
          <h3 className="font-bold text-sm text-navy">Per-deposit results</h3>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {(status?.matches || []).filter((m) => m.decision === "auto_approve").length === 0 ? (
            <p className="text-sm text-ink-slate py-8 text-center">No approved matches found.</p>
          ) : (
            (status?.matches || [])
              .filter((m) => m.decision === "auto_approve")
              .map((m) => (
                <div
                  key={m.id}
                  className="grid items-center px-5 py-3 border-b border-gray-100 last:border-0"
                  style={{ gridTemplateColumns: "auto 1.5fr 2fr 1fr 0.8fr" }}
                >
                  <div className="pr-2">
                    {m.executed ? (
                      <CheckCircle2 size={14} className="text-green-500" />
                    ) : m.error_message ? (
                      <XCircle size={14} className="text-red-500" />
                    ) : (
                      <Loader2 size={14} className="text-teal-dark animate-spin" />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 font-semibold text-sm text-navy">
                      <CreditCard size={12} className="text-teal-dark" />
                      ${Number(m.deposit_amount).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                    </div>
                    <div className="text-[11px] text-ink-light">{m.qbo_deposit_id}</div>
                  </div>
                  <div className="text-xs text-ink-slate truncate">
                    {(m.matched_customer_names || []).join(", ") || "—"}
                  </div>
                  <div className="text-xs text-teal-dark">
                    ${Number(m.computed_fee).toFixed(2)}
                    {isCanada && Number(m.computed_tax) > 0 && (
                      <span className="text-blue-600 ml-1">+ ${Number(m.computed_tax).toFixed(2)}</span>
                    )}
                  </div>
                  <div className="text-xs">
                    {m.executed ? (
                      <span className="text-green-700">Updated</span>
                    ) : m.error_message ? (
                      <span className="text-red-700" title={m.error_message}>Failed</span>
                    ) : (
                      <span className="text-teal-dark">Pending</span>
                    )}
                  </div>
                </div>
              ))
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex justify-between items-center">
        <Link href={`/stripe-recon/${jobId}/review`} className="text-sm font-semibold text-ink-slate hover:text-navy">
          ← Back to Review
        </Link>
        {isComplete && clientLinkId && (
          <Link
            href={`/rules/new?client=${clientLinkId}`}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
          >
            Continue to Bank Rules <ArrowRight size={16} />
          </Link>
        )}
      </div>
    </div>
  );
}

function Stat({
  label, value, highlight,
}: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className="p-4 rounded-lg bg-gray-50">
      <div className="text-xl font-bold" style={{ color: highlight ? "#F59E0B" : "#0F1F2E" }}>
        {value}
      </div>
      <div className="text-xs mt-1 font-semibold text-ink-slate">{label}</div>
    </div>
  );
}
