"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, ChevronDown, CheckCircle2, Clock, GripVertical, Loader2, Pause, Pencil, Play,
  Search, Trash2, X,
} from "lucide-react";
import {
  elapsedSeconds, formatClock, formatDuration, effectiveBudgetMinutes, isOverBudget,
} from "@/lib/time-tracking";
import { useTimeTracker, type EntryView } from "./TimeTrackerProvider";

/**
 * The floating timer. Faces, in priority order:
 *   1. note modal    — completing an over-budget client demands a reason
 *   2. account check — 30+ min on one account: "still the right one?"
 *   3. work picker   — "what are you working on?": any client, or an overhead
 *                      bucket (so inbox/meeting time is recordable too)
 *   4. switch prompt — a timer runs on something other than this page's client
 *                      (hidden when auto-track is on — the switch just happens)
 *   5. running/paused— expanded card, or a minimized ticking pill
 *   6. start prompt  — client page, nothing running yet (client pre-filled)
 *   7. idle FAB      — anywhere else: a quiet way into the picker
 *
 * Client entries show a budget bar; overhead entries have no budget by design
 * and never count against one.
 *
 * Every floating face renders inside <Floating>, which owns position: default
 * bottom-right, or wherever the user dragged it (persisted). It was covering
 * page buttons — now it moves. The note modal stays centered: it's blocking on
 * purpose.
 */

const NAVY_GRADIENT = "linear-gradient(135deg, #0F1F2E 0%, #1a3651 100%)";

// ── Draggable positioning shell ──────────────────────────────────────────────
// One shell for every face so the pill, card and prompts all live at the same
// spot. Dragging works from any element marked data-drag-handle (the pill
// itself, the card headers). A real drag (>5px) suppresses the click that
// would otherwise fire on release — so drag-the-pill doesn't also expand it.
// Double-click a handle to snap back to the default corner.

/** Movement (px) before a press counts as a drag rather than a click. Measured
 *  as real distance, not dx+dy — the Manhattan sum turned a 4px-across,
 *  4px-down hand tremor into an 8px "drag" and ate the click. */
const DRAG_SLOP = 6;
/** After a real drag, ignore the click the release generates — for this long
 *  only. A time window, never a sticky flag: a flag left stuck true (drag
 *  ended off-window, gesture cancelled, no click ever arrived to clear it)
 *  silently eats the NEXT genuine click, which is the intermittent
 *  "won't expand" the team hit. */
const CLICK_SUPPRESS_MS = 300;

function Floating({ z, children }: { z: number; children: React.ReactNode }) {
  const t = useTimeTracker()!;
  const { pos, setPos } = t;
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null);
  const suppressClickUntil = useRef(0);

  // Move/up live on WINDOW, not on the element, and there is deliberately no
  // setPointerCapture: capturing retargets the subsequent click to this
  // container, so the pill's own onClick never fired and the timer wouldn't
  // expand. Window listeners give the same "keep tracking outside the box"
  // benefit with none of that, and pointercancel/button-released always end
  // the drag — otherwise a cancelled gesture left it armed and the widget
  // followed the bare cursor around.
  useEffect(() => {
    const end = () => {
      const d = drag.current;
      if (!d) return;
      if (d.moved) suppressClickUntil.current = Date.now() + CLICK_SUPPRESS_MS;
      drag.current = null;
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (e.buttons === 0) { end(); return; } // released somewhere we didn't see
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      d.moved = true;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({
        x: Math.min(Math.max(8, d.ox + dx), Math.max(8, window.innerWidth - r.width - 8)),
        y: Math.min(Math.max(8, d.oy + dy), Math.max(8, window.innerHeight - 40)),
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [setPos]);

  return (
    <div
      ref={ref}
      onPointerDown={(e) => {
        if (e.button !== 0) return; // left button / primary touch only
        const el = e.target as HTMLElement;
        if (!el.closest("[data-drag-handle]") || !ref.current) return;
        // Never hijack a control the user is trying to operate.
        if (el.closest("input, textarea, select, a")) return;
        const r = ref.current.getBoundingClientRect();
        drag.current = { px: e.clientX, py: e.clientY, ox: r.left, oy: r.top, moved: false };
      }}
      onClickCapture={(e) => {
        // A drag is not a click. Window-scoped and time-bounded, so this can
        // never get stuck and block a real click.
        if (Date.now() < suppressClickUntil.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-drag-handle]")) setPos(null);
      }}
      className="fixed touch-none"
      style={pos ? { left: pos.x, top: pos.y, zIndex: z } : { bottom: 20, right: 20, zIndex: z }}
    >
      {children}
    </div>
  );
}

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
  const { context, running, paused, offsetMs, error, noteRequest, minimized, setMinimized, pickerOpen } = t;

  const live = useLiveSeconds(running, offsetMs);
  const activeOnThisPage = !!running && !!context && running.clientLinkId === context.clientLinkId;
  const pausedHere = useMemo(
    () => (context ? paused.find((p) => p.clientLinkId === context.clientLinkId) ?? null : null),
    [paused, context]
  );

  // 1. Over-budget note — blocking, because the rule is "explain or don't close".
  if (noteRequest) return <NoteModal />;

  // 1b. Idle: a timer is running but nobody's been at the keyboard. Ask instead
  // of silently banking it — or silently throwing it away.
  if (t.idlePrompt && running) {
    return <Floating z={50}><IdlePrompt entry={running} seconds={live} /></Floating>;
  }

  // 1c. Long session — is the timer still pointed at the right account?
  if (t.accountCheck && running) {
    return <Floating z={50}><AccountCheckPrompt entry={running} seconds={live} /></Floating>;
  }

  // 2. The "what are you working on?" picker (any client, or overhead).
  if (pickerOpen) return <Floating z={50}><WorkPicker /></Floating>;

  // 3. Running on a different client than the page we're on. With auto-track
  // on this prompt never shows — the switch happens by itself after the dwell.
  if (
    !t.autoTrack &&
    running && context && running.clientLinkId !== context.clientLinkId &&
    !t.dismissedForClient(context.clientLinkId)
  ) {
    return <Floating z={50}><SwitchPrompt live={live} /></Floating>;
  }

  // 3. An active timer (this page's, or elsewhere → still show it).
  if (running) {
    return (
      <Floating z={minimized ? 40 : 50}>
        {minimized ? (
          <Pill entry={running} seconds={live} onExpand={() => setMinimized(false)} />
        ) : (
          <Card entry={running} seconds={live} onMinimize={() => setMinimized(true)} />
        )}
      </Floating>
    );
  }

  // 3b. Paused entries exist — surface the one for this page, else the newest.
  const pausedShow = pausedHere ?? paused[0] ?? null;
  if (pausedShow) {
    return (
      <Floating z={minimized ? 40 : 50}>
        {minimized ? (
          <Pill entry={pausedShow} seconds={pausedShow.accumulatedSeconds} onExpand={() => setMinimized(false)} />
        ) : (
          <Card entry={pausedShow} seconds={pausedShow.accumulatedSeconds} onMinimize={() => setMinimized(true)} />
        )}
      </Floating>
    );
  }

  // 4. On a client page with nothing tracking → offer to start, pre-filled.
  if (context && !activeOnThisPage && !t.dismissedForClient(context.clientLinkId)) {
    return <Floating z={50}><StartPrompt /></Floating>;
  }

  // Error with nothing else to show (e.g. migration pending) — say so quietly.
  if (error && context) {
    return (
      <Floating z={40}>
        <div className="max-w-[320px] rounded-xl bg-amber-50 border border-amber-300 px-3 py-2 text-[11px] text-amber-900 shadow-lg">
          {error}
        </div>
      </Floating>
    );
  }

  // 5. Idle anywhere else (inbox, /today, admin…). A quiet way in, so time on a
  // non-client page can still be attributed — to a client, or to an overhead
  // bucket. Without this, that work is simply unrecordable.
  return <Floating z={40}><IdleFab /></Floating>;
}

function IdleFab() {
  const t = useTimeTracker()!;
  return (
    <button
      onClick={() => { t.loadClients(); t.setPickerOpen(true); }}
      title="Track time — pick a client or a category · drag to move"
      aria-label="Track time"
      data-drag-handle
      className="flex items-center gap-2 pl-3 pr-4 py-2.5 rounded-full text-white/90 shadow-lg hover:shadow-2xl transition-all hover:scale-105 opacity-70 hover:opacity-100 cursor-grab active:cursor-grabbing"
      style={{ background: NAVY_GRADIENT }}
    >
      <Clock size={15} />
      <span className="text-xs font-semibold">Track time</span>
    </button>
  );
}

// ── "What are you working on?" — any client, or an overhead bucket ───────────

function WorkPicker() {
  const t = useTimeTracker()!;
  const { clients, categories, busy, start, setPickerOpen, running } = t;
  const [q, setQ] = useState("");
  const filtered = (clients || [])
    .filter((c) => (q ? c.client_name.toLowerCase().includes(q.toLowerCase()) : true))
    .slice(0, 40);
  const switching = !!running;

  return (
    <div className="w-[340px] max-w-[calc(100vw-2.5rem)] bg-white rounded-2xl shadow-2xl border border-cardline overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-200">
      <div data-drag-handle className="px-4 py-3 flex items-start justify-between gap-2 cursor-grab active:cursor-grabbing" style={{ background: NAVY_GRADIENT }}>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-wide text-white/60">Track time</div>
          <div className="text-sm font-bold text-white">What are you working on?</div>
        </div>
        <button onClick={() => setPickerOpen(false)} className="text-white/60 hover:text-white shrink-0" aria-label="Close">
          <X size={15} />
        </button>
      </div>

      <div className="px-4 py-3 space-y-3 max-h-[62vh] overflow-auto">
        {switching && (
          <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            Starting something new pauses <span className="font-semibold">{running!.label}</span>.
          </div>
        )}

        {/* A client — this is how inbox/request time still lands on their budget. */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1.5">For a client</div>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-slate pointer-events-none" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={clients === null ? "Loading clients…" : "Search clients…"}
              className="w-full text-xs border border-gray-300 rounded-lg pl-8 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal/40"
            />
          </div>
          {q && (
            <div className="mt-1 max-h-40 overflow-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
              {filtered.length === 0 ? (
                <div className="px-2.5 py-2 text-[11px] text-ink-slate">No match</div>
              ) : (
                filtered.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => start({ clientLinkId: c.id })}
                    disabled={busy}
                    className="w-full text-left px-2.5 py-1.5 text-xs text-navy hover:bg-teal-lighter/40 truncate disabled:opacity-60"
                  >
                    {c.client_name}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Overhead — real work that belongs to no one client. */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1.5">Not for one client</div>
          <div className="space-y-1">
            {categories.map((c) => (
              <button
                key={c.key}
                onClick={() => start({ category: c.key })}
                disabled={busy}
                title={c.hint}
                className="w-full text-left px-2.5 py-2 rounded-lg border border-gray-200 hover:border-teal hover:bg-teal-lighter/20 disabled:opacity-60"
              >
                <div className="text-xs font-semibold text-navy">{c.label}</div>
                <div className="text-[11px] text-ink-slate leading-snug">{c.hint}</div>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-ink-slate mt-1.5">
            These don&apos;t count against any client&apos;s budget — they show separately on the time report.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Start prompt ────────────────────────────────────────────────────────────

function StartPrompt() {
  const t = useTimeTracker()!;
  const { context, busy, start, dismissPrompt } = t;
  if (!context) return null;
  const budget = effectiveBudgetMinutes(context.budgetMinutes);
  return (
    <div className="w-[320px] max-w-[calc(100vw-2.5rem)] bg-white rounded-2xl shadow-2xl border border-cardline overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-200">
      <div data-drag-handle className="px-4 py-3 flex items-start justify-between gap-2 cursor-grab active:cursor-grabbing" style={{ background: NAVY_GRADIENT }}>
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
          onClick={() => start({ clientLinkId: context.clientLinkId })}
          disabled={busy}
          className="w-full inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-3 py-2.5 rounded-lg disabled:opacity-60"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Start timer
          <span className="text-white/50 font-normal">alt+T</span>
        </button>
      </div>
      <div className="px-4 pb-3 space-y-2" style={{ background: NAVY_GRADIENT }}>
        <MyProgressPanel />
        <NextUp />
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
    <div className="w-[340px] max-w-[calc(100vw-2.5rem)] bg-white rounded-2xl shadow-2xl border border-cardline overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-200">
      <div data-drag-handle className="px-4 py-3 flex items-start justify-between gap-2 cursor-grab active:cursor-grabbing" style={{ background: NAVY_GRADIENT }}>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-wide text-white/60">Still timing</div>
          <div className="text-sm font-bold text-white truncate">{running.label}</div>
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
          onClick={() => start({ clientLinkId: context.clientLinkId }, { completeActive: true })}
          disabled={busy}
          className="w-full inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-3 py-2.5 rounded-lg disabled:opacity-60"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          Complete &amp; start {context.clientName ? shortName(context.clientName) : "this one"}
        </button>
        <button
          onClick={() => start({ clientLinkId: context.clientLinkId })}
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
      title={`${entry.label} — ${formatClock(seconds)} (${runningNow ? "running" : "paused"}) · drag to move`}
      data-drag-handle
      className="flex items-center gap-2.5 pl-3 pr-4 py-2.5 rounded-full text-white shadow-xl hover:shadow-2xl transition-all hover:scale-105 cursor-grab active:cursor-grabbing"
      style={{ background: NAVY_GRADIENT }}
    >
      <span className="relative flex items-center justify-center w-2.5 h-2.5 shrink-0">
        <span className={`w-2.5 h-2.5 rounded-full ${runningNow ? "bg-teal" : "bg-gold"}`} />
        {runningNow && <span className="absolute w-2.5 h-2.5 rounded-full bg-teal animate-ping opacity-60" />}
      </span>
      <span className="font-mono text-sm font-bold tabular-nums">{formatClock(seconds)}</span>
      <span className="text-[11px] text-white/70 max-w-[130px] truncate">{shortName(entry.label)}</span>
    </button>
  );
}

// ── Expanded card ───────────────────────────────────────────────────────────

function Card({ entry, seconds, onMinimize }: { entry: EntryView; seconds: number; onMinimize: () => void }) {
  const t = useTimeTracker()!;
  const { context, paused, busy, error, pause, resume, complete, discard, adjust, autoTrack, setAutoTrack } = t;
  const runningNow = entry.status === "running";
  // 30+ minutes is real money on the line — discarding it gets a two-step
  // confirm (armed button, self-disarms), and editing it down becomes possible.
  const longSession = seconds >= 30 * 60;
  const [armDiscard, setArmDiscard] = useState(false);
  useEffect(() => {
    if (!armDiscard) return;
    const id = setTimeout(() => setArmDiscard(false), 6000);
    return () => clearTimeout(id);
  }, [armDiscard]);
  const [editing, setEditing] = useState(false);
  const [editMins, setEditMins] = useState("");
  const [confirmEdit, setConfirmEdit] = useState(false);
  const editTarget = Math.max(0, Math.round(Number(editMins) || 0));
  // Budget context is only meaningful when the page's client IS this timer's.
  // Budget context only applies to CLIENT entries whose client is this page's.
  const onThisClient = !!entry.clientLinkId && !!context && context.clientLinkId === entry.clientLinkId;
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
    <div className="w-[340px] max-w-[calc(100vw-2.5rem)] bg-white rounded-2xl shadow-2xl border border-cardline overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-200">
      <div data-drag-handle className="px-4 py-3 cursor-grab active:cursor-grabbing" style={{ background: NAVY_GRADIENT }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-white/60">
              <GripVertical size={11} className="text-white/40" />
              <Clock size={11} /> {runningNow ? "Tracking" : entry.autoPaused ? "Auto-paused" : "Paused"}
            </div>
            <div className="text-sm font-bold text-white truncate">{entry.label}</div>
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
            {/* Over budget is a warning the bookkeeper should see WHILE working,
                not a surprise at completion — by then the time is already spent
                and the only option left is writing an explanation. */}
            {over && (
              <div className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-rust-tint border border-rust-border px-2 py-1.5">
                <AlertCircle size={12} className="text-rust shrink-0 mt-0.5" />
                <div className="text-[11px] text-rust leading-snug">
                  <span className="font-bold">
                    {formatDuration(projected! - budgetMinutes * 60)} over this client&apos;s monthly budget.
                  </span>{" "}
                  Completing will ask why — worth flagging to a lead if it&apos;s becoming the norm.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Your own day/week — private. */}
        <MyProgressPanel />

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
          {longSession && armDiscard ? (
            <button
              onClick={() => { setArmDiscard(false); void discard(entry.id); }}
              disabled={busy}
              className="shrink-0 text-[11px] font-bold text-white bg-rust hover:bg-rust/90 rounded-lg px-2 py-2 disabled:opacity-60"
            >
              Discard {formatDuration(seconds)}?
            </button>
          ) : (
            <button
              onClick={() => {
                if (longSession) setArmDiscard(true);
                else if (confirm(`Discard this session on ${entry.label}? The time won't be recorded.`)) {
                  void discard(entry.id);
                }
              }}
              disabled={busy}
              title={longSession ? "Discard — asks twice, this session is 30+ minutes" : "Discard — wrong client, or the time isn't real"}
              className="text-ink-slate hover:text-rust shrink-0 disabled:opacity-60"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>

        {/* Self-correction for a long session that over-counted — wrong account
            for a stretch, a call in the middle. Reduce-only: adding time is an
            admin correction on the time report, not a self-serve button. */}
        {longSession && (
          <div className="pt-1">
            {!editing ? (
              <button
                onClick={() => { setEditing(true); setEditMins(String(Math.floor(seconds / 60))); setConfirmEdit(false); }}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-slate hover:text-navy"
              >
                <Pencil size={10} /> Ran long? Adjust the time down
              </button>
            ) : (
              <div className="flex items-center gap-1.5 text-[11px]">
                <input
                  autoFocus
                  value={editMins}
                  onChange={(e) => { setEditMins(e.target.value); setConfirmEdit(false); }}
                  onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
                  className="w-14 border border-gray-300 rounded px-1.5 py-1 text-right font-mono"
                />
                <span className="text-ink-slate">min</span>
                {!confirmEdit ? (
                  <button
                    onClick={() => setConfirmEdit(true)}
                    disabled={busy || editTarget * 60 > seconds}
                    className="font-bold text-teal hover:underline disabled:opacity-50"
                    title={editTarget * 60 > seconds ? "Reduce-only — you can't add time here" : undefined}
                  >
                    Save
                  </button>
                ) : (
                  <button
                    onClick={() => { setEditing(false); setConfirmEdit(false); void adjust(entry.id, editTarget); }}
                    disabled={busy}
                    className="font-bold text-white bg-rust hover:bg-rust/90 rounded px-2 py-0.5 disabled:opacity-50"
                  >
                    Confirm — {formatDuration(seconds)} → {formatDuration(editTarget * 60)}
                  </button>
                )}
                <button onClick={() => setEditing(false)} className="text-ink-slate hover:text-navy">Cancel</button>
              </div>
            )}
          </div>
        )}

        {/* Auto-track: follow me around, or wait for the button. */}
        <label className="flex items-center gap-2 pt-1 text-[11px] text-ink-slate cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoTrack}
            onChange={(e) => setAutoTrack(e.target.checked)}
            className="accent-teal"
          />
          <span>
            <span className="font-semibold text-navy">Auto-track</span> — the timer follows the client
            page I&apos;m on (pauses the old one)
          </span>
        </label>

        {otherPaused.length > 0 && (
          <div className="pt-2 border-t border-gray-100">
            <div className="text-[10px] font-bold uppercase tracking-wide text-ink-slate mb-1">
              Also paused ({otherPaused.length})
            </div>
            <div className="space-y-1">
              {otherPaused.slice(0, 3).map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate text-navy">{p.label}</span>
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
    // Two callers: a plain Complete, or the compound "Complete A & start B"
    // (where B is either a client or an overhead bucket).
    if (n.thenStartClientLinkId) void start({ clientLinkId: n.thenStartClientLinkId }, { completeActive: true, overBudgetNote: text });
    else if (n.thenStartCategory) void start({ category: n.thenStartCategory }, { completeActive: true, overBudgetNote: text });
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
          <p className="text-[11px] text-ink-slate mt-1.5">
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


// ── Idle prompt ─────────────────────────────────────────────────────────────

function IdlePrompt({ entry, seconds }: { entry: EntryView; seconds: number }) {
  const t = useTimeTracker()!;
  return (
    <div className="w-[320px] max-w-[calc(100vw-2.5rem)] bg-white rounded-2xl shadow-2xl border border-amber-300 overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-200">
      <div data-drag-handle className="px-4 py-3 bg-amber-50 border-b border-amber-200 cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-800">
          <AlertCircle size={12} /> Still there?
        </div>
        <div className="mt-1 text-sm font-bold text-navy">{entry.label}</div>
        <div className="text-[11px] text-amber-900">
          {formatClock(seconds)} on the clock · no activity for a while
        </div>
      </div>
      <div className="p-3 space-y-1.5">
        <button
          onClick={() => t.dismissIdle()}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-teal text-white text-xs font-bold hover:bg-teal-dark"
        >
          <Play size={13} /> Yes, keep timing
        </button>
        <button
          onClick={() => t.pauseAtLastActivity()}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-navy text-xs font-semibold hover:border-gray-300"
        >
          <Pause size={13} /> Pause back at my last activity
        </button>
        <p className="text-[11px] text-ink-slate leading-snug pt-0.5">
          Pausing drops the idle stretch instead of billing it — the honest answer
          if you stepped away.
        </p>
      </div>
    </div>
  );
}

// ── 30-minute account check ─────────────────────────────────────────────────
// Only fires when the evidence DOESN'T already say "yes, still on it" — being
// on that client's pages with a warm keyboard re-arms silently. So when this
// does appear, take it seriously: the clock's been running half an hour and
// you've visibly moved elsewhere.

function AccountCheckPrompt({ entry, seconds }: { entry: EntryView; seconds: number }) {
  const t = useTimeTracker()!;
  const { context, busy, start, pause, ackAccountCheck } = t;
  const elsewhere =
    !!context && !!entry.clientLinkId && context.clientLinkId !== entry.clientLinkId;
  return (
    <div className="w-[330px] max-w-[calc(100vw-2.5rem)] bg-white rounded-2xl shadow-2xl border border-amber-300 overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-200">
      <div data-drag-handle className="px-4 py-3 bg-amber-50 border-b border-amber-200 cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-800">
          <Clock size={12} /> Right account?
        </div>
        <div className="mt-1 text-sm font-bold text-navy">{entry.label}</div>
        <div className="text-[11px] text-amber-900">
          {formatClock(seconds)} on the clock — just checking it&apos;s still this one.
        </div>
      </div>
      <div className="p-3 space-y-1.5">
        <button
          onClick={ackAccountCheck}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-teal text-white text-xs font-bold hover:bg-teal-dark"
        >
          <CheckCircle2 size={13} /> Yes — still {shortName(entry.label)}
        </button>
        {elsewhere && (
          <button
            onClick={() => { ackAccountCheck(); void start({ clientLinkId: context!.clientLinkId }); }}
            disabled={busy}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-teal text-teal text-xs font-bold hover:bg-teal-light/30 disabled:opacity-60"
          >
            <Play size={13} /> No — switch to {shortName(context!.clientName || "this client")}
          </button>
        )}
        <button
          onClick={() => { ackAccountCheck(); void pause(entry.id); }}
          disabled={busy}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-navy text-xs font-semibold hover:border-gray-300 disabled:opacity-60"
        >
          <Pause size={13} /> Pause it
        </button>
        <p className="text-[11px] text-ink-slate leading-snug pt-0.5">
          Wrong account for a while? Expand the timer — a 30+ minute session can be
          adjusted down or discarded.
        </p>
      </div>
    </div>
  );
}

// ── Private progress: today, this week, streak ───────────────────────────────
// Yours only. Nothing here shows a teammate's numbers — a nudge you can act on,
// not a ranking.

function MyProgressPanel() {
  const t = useTimeTracker()!;
  const p = t.progress;
  if (!p || p.targetMinutes <= 0) return null;
  const todayPct = Math.min(100, Math.round((p.todaySeconds / (p.targetMinutes * 60)) * 100));
  const weekPct = p.weekGoalMinutes > 0
    ? Math.min(100, Math.round((p.weekSeconds / (p.weekGoalMinutes * 60)) * 100))
    : 0;
  const hitToday = p.todaySeconds >= p.targetMinutes * 60;
  return (
    <div className="rounded-lg bg-white/5 px-2.5 py-2 space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-white/60">Today</span>
        <span className={`font-mono font-bold ${hitToday ? "text-teal-light" : "text-white/90"}`}>
          {formatDuration(p.todaySeconds)} / {formatDuration(p.targetMinutes * 60)}
          {hitToday && " ✓"}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full rounded-full ${hitToday ? "bg-teal-light" : "bg-teal"}`} style={{ width: `${todayPct}%` }} />
      </div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-white/60">This week</span>
        <span className="font-mono text-white/80">
          {formatDuration(p.weekSeconds)} / {formatDuration(p.weekGoalMinutes * 60)}
        </span>
      </div>
      <div className="h-1 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full rounded-full bg-white/40" style={{ width: `${weekPct}%` }} />
      </div>
      <div className="flex items-center gap-2 text-[11px] text-white/60">
        <span>{p.daysHitThisWeek} of {p.daysWorkedThisWeek || 0} days hit</span>
        {p.streakDays > 1 && (
          <span className="font-bold text-gold">🔥 {p.streakDays}-day streak</span>
        )}
      </div>
    </div>
  );
}

// ── What next ───────────────────────────────────────────────────────────────
// Offered right after a Complete, so the next client is one click rather than a
// hunt. Least-tracked first — rotation, not ranking.

function NextUp() {
  const t = useTimeTracker()!;
  if (t.running || t.suggestions.length === 0) return null;
  return (
    <div className="rounded-lg bg-white/5 px-2.5 py-2">
      <div className="text-[11px] font-bold uppercase tracking-wide text-white/50 mb-1.5">Start next</div>
      <div className="flex flex-wrap gap-1">
        {t.suggestions.map((sug) => (
          <button
            key={sug.clientLinkId}
            onClick={() => t.start({ clientLinkId: sug.clientLinkId })}
            disabled={t.busy}
            title={sug.loggedSeconds > 0 ? `${formatDuration(sug.loggedSeconds)} logged this month` : "nothing logged this month"}
            className="text-[11px] font-semibold px-2 py-1 rounded bg-white/10 text-white/90 hover:bg-white/20 disabled:opacity-50"
          >
            {sug.clientName}
            {sug.loggedSeconds === 0 && <span className="ml-1 text-gold">·new</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
