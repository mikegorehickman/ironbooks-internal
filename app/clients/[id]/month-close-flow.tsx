"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowRight, Check, CircleDashed, Loader2, MinusCircle, Mail, RefreshCw, Search, RotateCcw,
} from "lucide-react";
import { AskClientComposer } from "@/components/AskClientComposer";
import {
  MONTH_STAGES, monthProgress, stageState, formatMonth,
  type ClientMonth,
} from "@/lib/client-months";

/**
 * A production client's monthly close — THE sequence, not a second opinion.
 *
 * This used to be four hand-written steps (categorize / ask / docs / close)
 * with no relationship to the seven stages the monthly-close board tracks in
 * `client_months`. So the board said one thing and the client page said
 * another, while "Monthly close" on the stage banner jumped to /production —
 * a fleet list, not this client's close.
 *
 * Both now render the same MONTH_STAGES: Confirm COA → Transaction reclass →
 * Bank rules → Ask client → BS / statement request → Duplicates → Send
 * month-end. Each stage deep-links its real tool already scoped to this client
 * and month, and can be marked done or skipped here — done and skipped are
 * deliberately different facts (see stageState).
 */

const STAGE_ICON = { done: Check, skipped: MinusCircle, todo: CircleDashed } as const;

export function MonthCloseFlow({
  clientLinkId,
  clientName,
}: {
  clientLinkId: string;
  clientName: string;
}) {
  const [composer, setComposer] = useState<null | "ask" | "docs">(null);
  const [row, setRow] = useState<ClientMonth | null>(null);
  const [periodMonth, setPeriodMonth] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/client-months?client=${clientLinkId}`);
      const j = await res.json();
      if (res.ok) {
        setRow(j.month || null);
        setPeriodMonth(j.period_month || "");
      } else {
        setError(j.error || "Couldn't load this month");
      }
    } catch (e: any) {
      setError(e?.message || "Couldn't load this month");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientLinkId]);

  async function mark(stageKey: string, body: Record<string, any>) {
    if (!row?.id) return;
    setSaving(stageKey);
    setError(null);
    try {
      const res = await fetch(`/api/client-months/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: stageKey, ...body }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      if (j.month) setRow(j.month);
      else await load();
    } catch (e: any) {
      setError(e?.message || "Couldn't save");
    } finally {
      setSaving(null);
    }
  }

  const progress = monthProgress(row);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-semibold text-navy">
            Close {periodMonth ? formatMonth(periodMonth) : "this month"} — {clientName}
          </div>
          <p className="text-xs text-ink-slate mt-0.5">
            Work top to bottom. Each step opens the right tool already scoped to this client.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-light tabular-nums">
            {progress.resolved} of {progress.total} done
          </span>
          <button onClick={load} className="text-ink-light hover:text-navy" title="Refresh">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full bg-teal transition-all" style={{ width: `${progress.pct}%` }} />
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">{error}</div>
      )}

      <div className="space-y-2">
        {MONTH_STAGES.map((stage, i) => {
          const st = stageState(row, stage.key);
          const isNext = progress.nextStage?.key === stage.key;
          const Icon = STAGE_ICON[st];
          const busy = saving === stage.key;
          // Ask-client opens the composer in place rather than bouncing away.
          const isAsk = stage.key === "ask_client_at";
          const href = (stage.href as any)(clientLinkId, periodMonth);

          return (
            <div
              key={stage.key}
              className={`rounded-xl border px-4 py-3 transition-colors ${
                isNext
                  ? "border-teal bg-teal-light/30"
                  : st === "done"
                  ? "border-gray-200 bg-gray-50/60"
                  : "border-gray-200 bg-white"
              }`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`flex-shrink-0 mt-0.5 h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-bold ${
                    st === "done"
                      ? "bg-emerald-50 text-emerald-700"
                      : st === "skipped"
                      ? "bg-gold-tint text-gold-deep"
                      : "bg-gray-100 text-ink-slate"
                  }`}
                >
                  {st === "todo" ? i + 1 : <Icon size={13} />}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-navy">{stage.label}</span>
                    {st === "done" && (
                      <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">Done</span>
                    )}
                    {st === "skipped" && (
                      <span className="text-[10px] font-bold uppercase tracking-wide text-gold-deep">Skipped</span>
                    )}
                    {isNext && (
                      <span className="text-[10px] font-bold uppercase tracking-wide text-teal">← you are here</span>
                    )}
                  </div>
                  <p className="text-[11px] text-ink-slate mt-0.5">{stage.blurb}</p>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {isAsk ? (
                      <button
                        type="button"
                        onClick={() => setComposer("ask")}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:border-teal"
                      >
                        <Mail size={13} /> Ask a question
                      </button>
                    ) : (
                      <Link
                        href={href}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:border-teal"
                      >
                        Open <ArrowRight size={12} className="text-ink-light" />
                      </Link>
                    )}

                    {st !== "done" && (
                      <button
                        type="button"
                        disabled={busy || !row?.id}
                        onClick={() => mark(stage.key, { done: true })}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50"
                      >
                        {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Mark done
                      </button>
                    )}
                    {st === "todo" && (
                      <button
                        type="button"
                        disabled={busy || !row?.id}
                        onClick={() => mark(stage.key, { skip: true })}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold text-ink-slate hover:bg-gray-100 disabled:opacity-50"
                      >
                        <MinusCircle size={11} /> Not needed
                      </button>
                    )}
                    {st !== "todo" && (
                      <button
                        type="button"
                        disabled={busy || !row?.id}
                        onClick={() => mark(stage.key, st === "skipped" ? { skip: false } : { done: false })}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold text-ink-light hover:bg-gray-100 disabled:opacity-50"
                      >
                        <RotateCcw size={11} /> Reopen
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
        <p className="text-[11px] text-ink-slate">
          {progress.allResolved
            ? "Every step resolved — this month is ready to send."
            : `Next: ${progress.nextStage?.label ?? "—"}`}
        </p>
        <Link href="/monthly-close" className="text-xs font-semibold text-teal hover:text-teal-dark">
          Monthly close board →
        </Link>
      </div>

      {/* Re-run a cleanup check — production clients still need to re-scan for
          revenue / expense double-counts when something looks off. */}
      <div className="rounded-xl border border-gray-200 bg-gray-50/60 px-4 py-3">
        <div className="text-xs font-bold uppercase tracking-wide text-ink-slate">
          Something look off? Re-run a cleanup check
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Link
            href={`/revenue-check/${clientLinkId}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:border-teal"
          >
            <Search size={13} /> Revenue &amp; payroll check <ArrowRight size={12} className="text-ink-light" />
          </Link>
          <Link
            href={`/admin/duplicates?client=${clientLinkId}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:border-teal"
          >
            <Search size={13} /> Duplicate expenses <ArrowRight size={12} className="text-ink-light" />
          </Link>
        </div>
      </div>

      {composer && (
        <AskClientComposer
          clientLinkId={clientLinkId}
          clientName={clientName}
          emailType={composer === "docs" ? "docs_request" : "ask_client"}
          defaultSubject={
            composer === "docs"
              ? `Documents needed to close your month — ${clientName}`
              : `Quick question closing your month — ${clientName}`
          }
          onClose={() => setComposer(null)}
        />
      )}
    </div>
  );
}
