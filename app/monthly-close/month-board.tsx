"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Check, Loader2, ArrowRight, AlertTriangle, MailQuestion, Unplug, ChevronDown, SkipForward, Minus,
} from "lucide-react";
import {
  MONTH_STAGES,
  formatMonth,
  monthBounds,
  monthProgress,
  effectiveStatus,
  stageState,
  type ClientMonth,
  type MonthStatus,
} from "@/lib/client-months";

interface Row {
  bucket: ClientMonth;
  clientName: string;
  qboConnected: boolean;
}

const STATUS_LABEL: Record<MonthStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  waiting_client: "Waiting on client",
  ready_for_review: "Ready for review",
  failed_review: "Failed review",
  complete: "Complete",
};

const STATUS_TONE: Record<MonthStatus, string> = {
  not_started: "bg-hairline/60 text-ink-slate",
  in_progress: "bg-teal-lighter text-teal-dark",
  waiting_client: "bg-gold-tint text-gold-deep",
  ready_for_review: "bg-teal-lighter text-teal-dark",
  failed_review: "bg-rust-tint text-rust",
  complete: "bg-emerald-50 text-emerald-700",
};

/** Filters, ordered so the two that matter most on a close day come first. */
const FILTERS = [
  { id: "todo", label: "Needs work" },
  { id: "blocked", label: "Blocked / waiting" },
  { id: "all", label: "All" },
  { id: "complete", label: "Complete" },
] as const;

export function MonthBoard({
  rows,
  months,
  selectedMonth,
}: {
  rows: Row[];
  months: string[];
  selectedMonth: string;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("todo");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  const withStatus = rows.map((r) => ({ ...r, status: effectiveStatus(r.bucket) }));

  const counts = {
    todo: withStatus.filter((r) => r.status === "not_started" || r.status === "in_progress").length,
    blocked: withStatus.filter((r) => r.status === "waiting_client" || r.status === "failed_review").length,
    all: withStatus.length,
    complete: withStatus.filter((r) => r.status === "complete").length,
  };

  const visible = withStatus.filter((r) => {
    if (filter === "all") return true;
    if (filter === "complete") return r.status === "complete";
    if (filter === "blocked") return r.status === "waiting_client" || r.status === "failed_review";
    return r.status === "not_started" || r.status === "in_progress";
  });

  const doneCount = counts.complete;
  const overallPct = counts.all ? Math.round((doneCount / counts.all) * 100) : 0;

  async function skip(bucketId: string, stage: string, on: boolean) {
    const reason = on
      ? window.prompt("Why is this step not needed this month? (recorded on the month)", "Not applicable this month")
      : null;
    if (on && reason === null) return; // cancelled
    await patch(bucketId, { stage, skip: on, reason });
  }

  async function patch(bucketId: string, body: any) {
    setBusyId(bucketId);
    setError("");
    try {
      const res = await fetch(`/api/client-months/${bucketId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Update failed");
      startTransition(() => router.refresh());
    } catch (e: any) {
      setError(e?.message || "Update failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Month selector + overall progress */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold uppercase tracking-wide text-ink-slate">Month</label>
          <div className="relative">
            <select
              value={selectedMonth}
              onChange={(e) => router.push(`/monthly-close?month=${e.target.value}`)}
              className="appearance-none pl-3 pr-9 py-2 rounded-lg border border-cardline bg-white text-sm font-semibold text-navy focus:border-teal outline-none"
            >
              {months.map((m) => (
                <option key={m} value={m}>{formatMonth(m)}</option>
              ))}
            </select>
            <ChevronDown size={15} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-light pointer-events-none" />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-sm text-ink-slate">
            <strong className="text-navy">{doneCount}</strong> of {counts.all} closed
          </div>
          <div className="w-40 h-2 rounded-full bg-hairline overflow-hidden">
            <div className="h-full bg-teal transition-all" style={{ width: `${overallPct}%` }} />
          </div>
          <span className="text-sm font-semibold text-navy tabular-nums">{overallPct}%</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold border transition-colors ${
              filter === f.id
                ? "border-teal bg-teal-lighter text-teal-dark"
                : "border-cardline bg-white text-ink-slate hover:text-navy"
            }`}
          >
            {f.label} <span className="tabular-nums opacity-70">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-rust-border bg-rust-tint text-sm text-rust">{error}</div>
      )}

      {/* Rows */}
      <div className="space-y-2">
        {visible.length === 0 && (
          <div className="rounded-xl border border-cardline bg-white px-4 py-8 text-center text-sm text-ink-slate">
            Nothing in this view.
            {filter === "todo" && counts.all > 0 && counts.todo === 0 && (
              <span className="block mt-1 font-semibold text-teal-dark">
                Every client is closed or blocked for {formatMonth(selectedMonth)}.
              </span>
            )}
          </div>
        )}

        {visible.map((r) => {
          const prog = monthProgress(r.bucket);
          const bounds = monthBounds(r.bucket.period_month);
          const busy = busyId === r.bucket.id;
          const monthParam = r.bucket.period_month.slice(0, 7); // YYYY-MM

          return (
            <div
              key={r.bucket.id}
              className="rounded-xl border border-cardline bg-white px-4 py-3.5 hover:border-teal/40 transition-colors"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/clients/${r.bucket.client_link_id}`}
                      className="font-semibold text-navy hover:text-teal-dark truncate"
                    >
                      {r.clientName}
                    </Link>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_TONE[r.status]}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                    {!r.qboConnected && (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rust-tint text-rust"
                        title="No QuickBooks connection — nothing can be pulled for this client"
                      >
                        <Unplug size={11} /> QBO not connected
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-ink-light mt-0.5 tabular-nums">
                    {bounds.start} → {bounds.end} · {prog.done}/{prog.total} stages
                  </div>
                  {r.bucket.blocked_reason && (
                    <div className="text-xs text-gold-deep mt-1 flex items-start gap-1.5">
                      <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                      {r.bucket.blocked_reason}
                    </div>
                  )}
                </div>

                {/* Next action — the whole point of the board */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {r.status !== "waiting_client" && (
                    <button
                      onClick={() =>
                        patch(r.bucket.id, {
                          status: "waiting_client",
                          blocked_reason: "Waiting on the client for information or statements",
                        })
                      }
                      disabled={busy}
                      className="p-2 rounded-lg text-ink-light hover:text-gold-deep hover:bg-gold-tint disabled:opacity-50"
                      title="Mark as waiting on the client"
                    >
                      <MailQuestion size={15} />
                    </button>
                  )}
                  {r.status === "waiting_client" && (
                    <button
                      onClick={() => patch(r.bucket.id, { status: "in_progress", blocked_reason: null })}
                      disabled={busy}
                      className="text-xs font-semibold text-gold-deep hover:text-navy disabled:opacity-50"
                    >
                      Client replied
                    </button>
                  )}

                  {prog.nextStage ? (
                    <Link
                      href={
                        prog.nextStage.key === "reclass_completed_at"
                          ? `/reclass/new?client=${r.bucket.client_link_id}&month=${monthParam}`
                          : (prog.nextStage.href as any)(r.bucket.client_link_id, monthParam)
                      }
                      className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-3.5 py-2 rounded-lg whitespace-nowrap"
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                      {prog.done === 0 ? "Start" : "Continue"}: {prog.nextStage.label}
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
                      <Check size={15} /> Closed
                    </span>
                  )}
                </div>
              </div>

              {/* Stage strip — three states, because "checked and fine" and "not
                  applicable" are different facts. Click a pill to tick it; use the
                  small skip control on skippable stages to set it aside with a
                  reason. Manual ticks matter: a bookkeeper who did something
                  outside SNAP must be able to record it, or the board drifts from
                  reality and the team stops trusting it. */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {MONTH_STAGES.map((stage, i) => {
                  const st = stageState(r.bucket, stage.key);
                  const isNext = prog.nextStage?.key === stage.key;
                  const reason = (r.bucket.skip_reasons || {})[stage.key];
                  return (
                    <div key={stage.key} className="inline-flex items-center">
                      <button
                        onClick={() => patch(r.bucket.id, { stage: stage.key, done: st !== "done" })}
                        disabled={busy}
                        title={
                          st === "done"
                            ? `${stage.label} — done ${String((r.bucket as any)[stage.key]).slice(0, 10)}. Click to un-tick.`
                            : st === "skipped"
                            ? `${stage.label} — skipped: ${reason || "not applicable"}. Click to mark done instead.`
                            : `${i + 1}. ${stage.blurb}. Click to mark done.`
                        }
                        className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold border transition-colors disabled:opacity-50 ${
                          stage.skippable ? "rounded-l-md border-r-0" : "rounded-md"
                        } ${
                          st === "done"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : st === "skipped"
                            ? "border-cardline bg-hairline/50 text-ink-light line-through"
                            : isNext
                            ? "border-teal bg-teal-lighter text-teal-dark"
                            : "border-cardline bg-white text-ink-light hover:text-navy"
                        }`}
                      >
                        {st === "done" && <Check size={10} />}
                        {st === "skipped" && <Minus size={10} />}
                        <span className="tabular-nums opacity-60">{i + 1}</span>
                        {stage.label}
                      </button>
                      {stage.skippable && (
                        <button
                          onClick={() => skip(r.bucket.id, stage.key, st !== "skipped")}
                          disabled={busy}
                          title={st === "skipped" ? "Un-skip this step" : "Skip this step for this month"}
                          className={`px-1.5 py-1 rounded-r-md border text-[11px] transition-colors disabled:opacity-50 ${
                            st === "skipped"
                              ? "border-cardline bg-hairline/50 text-ink-slate"
                              : "border-cardline bg-white text-ink-light hover:text-navy hover:bg-hairline/40"
                          }`}
                        >
                          <SkipForward size={10} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {isPending && (
        <div className="text-xs text-ink-light flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Refreshing…
        </div>
      )}
    </div>
  );
}
