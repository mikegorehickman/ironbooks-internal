"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, ChevronDown, CheckCircle2, Clock, Loader2, Pause, Play, Trash2, X,
} from "lucide-react";
import {
  elapsedSeconds, formatClock, formatDuration, effectiveBudgetMinutes, isOverBudget,
} from "@/lib/time-tracking";
import { useTimeTracker, type EntryView } from "./TimeTrackerProvider";

/**
 * The floating timer. Four faces, in priority order:
 *   1. note modal      — completing an over-budget client demands a reason
 *   2. switch prompt    — a timer is running on ANOTHER client than this page
 *   3. running/paused   — expanded card, or a minimized ticking pill
 *   4. start prompt     — client page, nothing running yet
 *
 * Positioning/z-index follow the portal SupportWidget (fixed bottom-5 right-5,
 * z-40 pill / z-50 panel), which already clears the sticky sidebar.
 */

const NAVY_GRADIENT = "linear-gradient(135deg, #0F1F2E 0%, #1a3651 100%)";

/** Ticks once a second, recomputing elapsed from server timestamps + offset —
 *  never incrementing a counter (throttled tabs and clock skew can't drift it). */
function useLiveSeconds(entry: EntryView | null, offsetMs: number): number {
  const [, force] = useState(0);
  const ticking = entry?.status === "running";
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  if (!entry) return 0;
  return elapsedSeconds(
    {
      status: entry.status,
      last_resumed_at: entry.lastResumedAt,
      accumulated_seconds: entry.accumulatedSeconds,
      last_heartbeat_at: null,
    },
    Date.now() + offsetMs
  );
}

export function TimeTrackerWidget() {
  const t = useTimeTracker();
  if (!t) return null;
  const { context, running, paused, offsetMs, busy, error, noteRequest, minimized, setMinimized } = t;

  const live = useLiveSeconds(running, offsetMs);
  const activeOnThisPage = !!running && !!context && running.clientLinkId === context.clientLinkId;
  const pausedHere = useMemo(
    () => (context ? paused.find((p) => p.clientLinkId === context.clientLinkId) ?? null : null),
    [paused, context]
  );

  // 1. Over-budget note — blocking, because the rule is "explain or don't close".
  if (noteRequest) return <NoteModal />;

  // 2. Running on a different client than the page we're on.
  if (running && context && running.clientLinkId !== context.clientLinkId && !t.dismissedForClient(context.clientLinkId)) {
    return <SwitchPrompt live={live} />;
  }

  // 3. An active timer (this page's, or elsewhere → still show it).
  if (running) {
    return minimized ? (
      <Pill entry={running} seconds={live} onExpand={() => setMinimized(false)} />
    ) : (
      <Card entry={running} seconds={live} onMinimize={() => setMinimized(true)} />
    );
  }

  // 3b. Paused entries exist — surface the one for this page, else the newest.
  const pausedShow = pausedHere ?? paused[0] ?? null;
  if (pausedShow) {
    return minimized ? (
      <Pill entry={pausedShow} seconds={pausedShow.accumulatedSeconds} onExpand={() => setMinimized(false)} />
    ) : (
      <Card entry={pausedShow} seconds={pausedShow.accumulatedSeconds} onMinimize={() => setMinimized(true)} />
    );
  }

  // 4. On a client page with nothing tracking → offer to start.
  if (context && !activeOnThisPage && !t.dismissedForClient(context.clientLinkId)) {
    return <StartPrompt />;
  }

  // Error with nothing else to show (e.g. migration pending) — say so quietly.
  if (error && context) {
    return (
      <div className="fixed bottom-5 right-5 z-40 max-w-[320px] rounded-xl bg-amber-50 border border-amber-300 px-3 py-2 text-[11px] text-amber-900 shadow-lg">
        {error}
      </div>
    );
  }
  return null;
}

// ── Start prompt ────────────────────────────────────────────────────────────

function StartPrompt() {
  const t = useTimeTracker()!;
  const { context, busy, start, dismissPrompt } = t;
  if (!context) return null;
  const budget = effectiveBudgetMinutes(context.budgetMinutes);
  return (
    <div className="fixed bottom-5 right-5 z-50 w-[320px] max-w-[calc(100vw-2.5rem)] bg-white rounded-2xl shadow-2xl border border-cardline overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-200">
      <div className="px-4 py-3 flex items-start justify-between gap-2" style={{ background: NAVY_GRADIENT }}>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-wide text-white/60">Track time</div>
          <div className="text-sm font-bold text-white truncate">{context.clientName || "This client"}</div>
        </div>
        <button
          onClick={() => dismissPrompt(context.clientLinkId)}
          className="text-white/60 hover:text-white shrink-0"
          aria-label="Not now"
        >
          <X size={15} />
        </button>
      </div>
      <div className="px-4 py-3">
        <div className="text-[11px] text-ink-slate mb-2.5">
          {formatDuration(context.mtdSeconds)} logged of {formatDuration(budget * 60)} this month
        </div>
        <button
          onClick={() => start(context.clientLinkId)}
          disabled={busy}
          className="w-full inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-3 py-2.5 rounded-lg disabled:opacity-60"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Start timer
        </button>
      </div>
    </div>
  );
}

// ── Switch prompt (one click to close A and open B) ──────────────────────────

function SwitchPrompt({ live }: { live: number }) {
  const t = useTimeTracker()!;
  const { context, running, busy, start, dismissPrompt } = t;
  if (!context || !running) return null;
  return (
    <div className="fixed bottom-5 right-5 z-50 w-[340px] max-w-[calc(100vw-2.5rem)] bg-white rounded-2xl shadow-2xl border border-cardline overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-200">
      <div className="px-4 py-3 flex items-start justify-between gap-2" style={{ background: NAVY_GRADIENT }}>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-wide text-white/60">Still timing</div>
          <div className="text-sm font-bold text-white truncate">{running.clientName || "another client"}</div>
          <div className="font-mono text-xs text-teal-light mt-0.5">{formatClock(live)}</div>
        </div>
        <button
          onClick={() => dismissPrompt(context.clientLinkId)}
          className="text-white/60 hover:text-white shrink-0"
          aria-label="Keep timing"
        >
          <X size={15} />
        </button>
      </div>
      <div className="px-4 py-3 space-y-2">
        <div className="text-[11px] text-ink-slate">
          You&apos;re now on <span className="font-semibold text-navy">{context.clientName || "another client"}</span>.
        </div>
        <button
          onClick={() => start(context.clientLinkId, { completeActive: true })}
          disabled={busy}
          className="w-full inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-3 py-2.5 rounded-lg disabled:opacity-60"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          Complete &amp; start {context.clientName ? shortName(context.clientName) : "this one"}
        </button>
        <button
          onClick={() => start(context.clientLinkId)}
          disabled={busy}
          className="w-full text-[11px] font-semibold text-teal hover:underline disabled:opacity-60"
        >
          Just start this one (pause the other)
        </button>
      </div>
    </div>
  );
}

// ── Minimized pill ──────────────────────────────────────────────────────────

function Pill({ entry, seconds, onExpand }: { entry: EntryView; seconds: number; onExpand: () => void }) {
  const runningNow = entry.status === "running";
  return (
    <button
      onClick={onExpand}
      title={`${entry.clientName || "Client"} — ${formatClock(seconds)} (${runningNow ? "running" : "paused"})`}
      className="fixed bottom-5 right-5 z-40 flex items-center gap-2.5 pl-3 pr-4 py-2.5 rounded-full text-white shadow-xl hover:shadow-2xl transition-all hover:scale-105"
      style={{ background: NAVY_GRADIENT }}
    >
      <span className="relative flex items-center justify-center w-2.5 h-2.5 shrink-0">
        <span className={`w-2.5 h-2.5 rounded-full ${runningNow ? "bg-teal" : "bg-gold"}`} />
        {runningNow && <span className="absolute w-2.5 h-2.5 rounded-full bg-teal animate-ping opacity-60" />}
      </span>
      <span className="font-mono text-sm font-bold tabular-nums">{formatClock(seconds)}</span>
      <span className="text-[11px] text-white/70 max-w-[130px] truncate">{shortName(entry.clientName || "")}</span>
    </button>
  );
}

// ── Expanded card ───────────────────────────────────────────────────────────

function Card({ entry, seconds, onMinimize }: { entry: EntryView; seconds: number; onMinimize: () => void }) {
  const t = useTimeTracker()!;
  const { context, paused, busy, error, pause, resume, complete, discard } = t;
  const runningNow = entry.status === "running";
  // Budget context is only meaningful when the page's client IS this timer's.
  const onThisClient = !!context && context.clientLinkId === entry.clientLinkId;
  const budgetMinutes = onThisClient ? effectiveBudgetMinutes(context!.budgetMinutes) : null;
  const mtd = onThisClient ? context!.mtdSeconds : null;
  const projected = mtd !== null ? mtd + seconds : null;
  const over =
    onThisClient && isOverBudget(context!.mtdSeconds, seconds, context!.budgetMinutes);
  const pct =
    projected !== null && budgetMinutes && budgetMinutes > 0
      ? Math.min(100, Math.round((projected / (budgetMinutes * 60)) * 100))
      : null;
  const otherPaused = paused.filter((p) => p.id !== entry.id);

  return (
    <div className="fixed bottom-5 right-5 z-50 w-[340px] max-w-[calc(100vw-2.5rem)] bg-white rounded-2xl shadow-2xl border border-cardline overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-200">
      <div className="px-4 py-3" style={{ background: NAVY_GRADIENT }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-white/60">
              <Clock size={11} /> {runningNow ? "Tracking" : entry.autoPaused ? "Auto-paused" : "Paused"}
            </div>
            <div className="text-sm font-bold text-white truncate">{entry.clientName || "Client"}</div>
          </div>
          <button onClick={onMinimize} className="text-white/60 hover:text-white shrink-0" aria-label="Minimize">
            <ChevronDown size={16} />
          </button>
        </div>
        <div className="font-mono text-3xl font-bold text-white mt-1.5 tabular-nums">{formatClock(seconds)}</div>
      </div>

      <div className="px-4 py-3 space-y-2.5">
        {entry.autoPaused && (
          <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            This timer was left running, so it was paused at your last activity — the idle time wasn&apos;t counted.
          </div>
        )}

        {onThisClient && budgetMinutes !== null && (
          <div>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <span className="text-ink-slate">
                {formatDuration(projected!)} of {formatDuration(budgetMinutes * 60)} this month
              </span>
              {over && <span className="font-bold text-rust">over budget</span>}
            </div>
            <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full rounded-full ${over ? "bg-rust" : "bg-teal"}`}
                style={{ width: `${pct ?? 100}%` }}
              />
            </div>
            {over && (
              <div className="text-[10px] text-ink-slate mt-1">Completing will ask why this client needed the extra time.</div>
            )}
          </div>
        )}

        {error && (
          <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">{error}</div>
        )}

        <div className="flex items-center gap-2">
          {runningNow ? (
            <button
              onClick={() => pause(entry.id)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg border border-gray-200 text-navy hover:border-gray-300 disabled:opacity-60"
            >
              <Pause size={13} /> Pause
            </button>
          ) : (
            <button
              onClick={() => resume(entry.id)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg border border-teal text-teal hover:bg-teal-light/40 disabled:opacity-60"
            >
              <Play size={13} /> Resume
            </button>
          )}
          <button
            onClick={() => complete(entry.id)}
            disabled={busy}
            className="flex-1 inline-flex items-center justify-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-3 py-2 rounded-lg disabled:opacity-60"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Complete
          </button>
          <button
            onClick={() => {
              if (confirm(`Discard this session on ${entry.clientName || "this client"}? The time won't be recorded.`)) {
                void discard(entry.id);
              }
            }}
            disabled={busy}
            title="Discard — wrong client, or the time isn't real"
            className="text-ink-light hover:text-rust shrink-0 disabled:opacity-60"
          >
            <Trash2 size={14} />
          </button>
        </div>

        {otherPaused.length > 0 && (
          <div className="pt-2 border-t border-gray-100">
            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-light mb-1">
              Also paused ({otherPaused.length})
            </div>
            <div className="space-y-1">
              {otherPaused.slice(0, 3).map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate text-navy">{p.clientName || "Client"}</span>
                  <span className="font-mono text-ink-slate shrink-0">{formatClock(p.accumulatedSeconds)}</span>
                  <button
                    onClick={() => complete(p.id)}
                    disabled={busy}
                    className="text-teal font-semibold hover:underline shrink-0 disabled:opacity-60"
                  >
                    Complete
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Over-budget note modal ──────────────────────────────────────────────────

function NoteModal() {
  const t = useTimeTracker()!;
  const { noteRequest, busy, complete, start, cancelNote } = t;
  const [note, setNote] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  if (!noteRequest) return null;
  const n = noteRequest;
  const projected = n.mtdSeconds + n.entrySeconds;
  const overBy = Math.max(0, projected - n.budgetMinutes * 60);

  const submit = () => {
    const text = note.trim();
    if (!text) return;
    // Two callers: a plain Complete, or the compound "Complete A & start B".
    if (n.thenStartClientLinkId) void start(n.thenStartClientLinkId, { completeActive: true, overBudgetNote: text });
    else if (n.entryId) void complete(n.entryId, text);
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" role="dialog" aria-modal="true">
        <div className="px-6 pt-5 pb-4 bg-amber-50 border-b border-amber-200">
          <div className="flex items-start gap-2.5">
            <AlertCircle size={20} className="text-amber-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-base font-bold text-navy">Over the monthly budget</h3>
              <p className="text-xs text-ink-slate mt-0.5">
                <span className="font-semibold text-navy">{n.clientName || "This client"}</span> is at{" "}
                {formatDuration(projected)} against a {formatDuration(n.budgetMinutes * 60)} budget
                {overBy > 0 && <> — <span className="font-semibold text-rust">{formatDuration(overBy)} over</span></>}.
              </p>
            </div>
          </div>
        </div>
        <div className="px-6 py-4">
          <label className="block text-xs font-semibold text-navy mb-1.5">
            What took the extra time? <span className="text-rust">*</span>
          </label>
          <textarea
            ref={ref}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
            rows={3}
            placeholder="e.g. Two years of unreconciled Stripe deposits; client sent statements late."
            className="w-full text-xs border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal/40 resize-none"
          />
          <p className="text-[10px] text-ink-light mt-1.5">
            This shows on the time report next to the overage, so the extra time is explained rather than questioned.
          </p>
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-3">
          <button onClick={cancelNote} disabled={busy} className="text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-60">
            Keep timing
          </button>
          <button
            onClick={submit}
            disabled={busy || !note.trim()}
            className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-4 py-2 rounded-lg disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Save &amp; complete
          </button>
        </div>
      </div>
    </div>
  );
}

/** Keep pills and buttons readable: "Charles and Crew Painting" → "Charles and Crew…" */
function shortName(name: string): string {
  return name.length > 22 ? name.slice(0, 21).trimEnd() + "…" : name;
}
