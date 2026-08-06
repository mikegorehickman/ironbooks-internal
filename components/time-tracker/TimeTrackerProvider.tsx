"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { HEARTBEAT_MS, PAGE_PING_MS, elapsedSeconds, isClientShapedPath } from "@/lib/time-tracking";
import { TimeTrackerWidget } from "./TimeTrackerWidget";

/**
 * The time tracker's brain. Mounted ONCE from app/layout.tsx — the only node in
 * this app that survives every navigation (AppShell is rendered per page, so
 * anything inside it remounts and would reset the timer's UI state).
 *
 * Because the root layout also wraps the client portal and the public token
 * pages, this provider gates itself:
 *   - pathname skip-list (portal / auth / public links) → render nothing
 *   - role via GET /api/me (module-cached for the page's life) → only
 *     admin/lead/bookkeeper get a timer; anyone else goes permanently dormant
 *     with zero further requests
 *
 * Ticking never trusts the local clock: every response carries `serverNow`, we
 * keep the offset, and elapsed is RECOMPUTED from timestamps each tick — so
 * clock skew and background-tab throttling can't drift the displayed number.
 */

// ── /api/me, fetched once per page load ─────────────────────────────────────
type Me = { id: string; role: string | null; full_name: string | null };
const TIMER_ROLES = new Set(["admin", "lead", "bookkeeper"]);
let mePromise: Promise<Me | null> | null = null;
function fetchMe(): Promise<Me | null> {
  if (!mePromise) {
    mePromise = fetch("/api/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return mePromise;
}

/** Prefixes where a staff timer must never appear. */
const SKIP_PREFIXES = [
  "/portal", "/portal-mockup", "/auth", "/book", "/stripe-connect",
  "/unsubscribe", "/resubscribe", "/onboarding", "/connect-quickbooks",
];

const MINIMIZED_KEY = "snap.timer.minimized";
const AUTOTRACK_KEY = "snap.timer.autotrack";
const POS_KEY = "snap.timer.pos";
/** No input for this long with a timer running → ask if they're still working. */
const IDLE_MS = 10 * 60_000;
/** Dwell on a different client's page before auto-track switches the timer.
 *  Long enough that passing through a page to check one number doesn't churn
 *  the timer; short enough that real work is captured from near the start. */
const AUTO_TRACK_DWELL_MS = 12_000;
/** A session this long on one account triggers "still on the right account?" —
 *  unless the page you're on IS that account and you've been active (then the
 *  question would be noise; we skip it silently and re-arm). */
const ACCOUNT_CHECK_MS = 30 * 60;
/** "Recent input" window for that silent skip. */
const ACCOUNT_CHECK_ACTIVE_MS = 5 * 60_000;
const CHANNEL = "snap.timer";

export interface EntryView {
  id: string;
  /** NULL on overhead entries — `label` is what the UI should render. */
  clientLinkId: string | null;
  clientName: string | null;
  category: string | null;
  /** The client's name, or the overhead bucket's label. */
  label: string;
  status: string;
  elapsedSeconds: number;
  accumulatedSeconds: number;
  lastResumedAt: string | null;
  startedAt: string;
  autoPaused: boolean;
  sourcePath: string | null;
}
export interface PageContext {
  clientLinkId: string;
  clientName: string | null;
  mtdSeconds: number;
  budgetMinutes: number | null;
}
export interface MyProgress {
  todaySeconds: number;
  weekSeconds: number;
  targetMinutes: number;
  targetIsDefault: boolean;
  weekGoalMinutes: number;
  daysHitThisWeek: number;
  daysWorkedThisWeek: number;
  streakDays: number;
  perDay: { date: string; seconds: number; hit: boolean }[];
}
export interface Suggestion { clientLinkId: string; clientName: string; loggedSeconds: number }

export interface NoteRequest {
  entryId: string | null;
  clientName: string | null;
  mtdSeconds: number;
  entrySeconds: number;
  budgetMinutes: number;
  /** Set when the prompt came from "Complete A & start B" — B still needs starting. */
  thenStartClientLinkId?: string;
  thenStartCategory?: string;
}

interface TimerCtx {
  me: Me | null;
  context: PageContext | null;
  running: EntryView | null;
  paused: EntryView[];
  /** Server-clock offset (ms) — add to Date.now() for "server now". */
  offsetMs: number;
  busy: boolean;
  error: string | null;
  noteRequest: NoteRequest | null;
  minimized: boolean;
  setMinimized: (v: boolean) => void;
  /** Auto-track: navigating to another client's page moves the timer there
   *  (pausing the old one), and landing on a client page with nothing running
   *  starts a timer — no button. Persisted per browser. */
  autoTrack: boolean;
  setAutoTrack: (v: boolean) => void;
  /** Widget screen position, dragged by the user. null = default corner. */
  pos: { x: number; y: number } | null;
  setPos: (p: { x: number; y: number } | null) => void;
  /** "Still on the right account?" — a long session needs a nod. */
  accountCheck: boolean;
  /** Acknowledge the check; re-asks after another 30 minutes. */
  ackAccountCheck: () => void;
  /** Owner self-correction: set this session's banked time DOWN to `minutes`.
   *  Reduce-only — inflating time goes through an admin, not a self-serve UI. */
  adjust: (entryId: string, minutes: number) => Promise<void>;
  dismissedForClient: (clientLinkId: string) => boolean;
  dismissPrompt: (clientLinkId: string) => void;
  /** Start client work (clientLinkId) or overhead (category) — exactly one. */
  start: (
    target: { clientLinkId: string; category?: never } | { category: string; clientLinkId?: never },
    opts?: { completeActive?: boolean; overBudgetNote?: string }
  ) => Promise<void>;
  categories: { key: string; label: string; hint: string }[];
  /** The caller's OWN day/week progress — private, never a teammate's. */
  progress: MyProgress | null;
  suggestions: Suggestion[];
  /** True when there's been no keyboard/mouse activity while a timer runs. */
  idlePrompt: boolean;
  dismissIdle: () => void;
  /** Pause, backdated to the last real activity (drops the idle gap). */
  pauseAtLastActivity: () => void;
  /** Lazy-loaded client list for the "any client from anywhere" picker. */
  clients: { id: string; client_name: string }[] | null;
  loadClients: () => void;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
  pause: (entryId: string) => Promise<void>;
  resume: (entryId: string) => Promise<void>;
  complete: (entryId: string, overBudgetNote?: string) => Promise<void>;
  discard: (entryId: string) => Promise<void>;
  cancelNote: () => void;
  refresh: () => void;
}
const Ctx = createContext<TimerCtx | null>(null);
export const useTimeTracker = () => useContext(Ctx);

export function TimeTrackerProvider() {
  const pathname = usePathname() || "/";
  const skip = SKIP_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));

  const [me, setMe] = useState<Me | null>(null);
  const [meChecked, setMeChecked] = useState(false);
  const [context, setContext] = useState<PageContext | null>(null);
  const [running, setRunning] = useState<EntryView | null>(null);
  const [paused, setPaused] = useState<EntryView[]>([]);
  const [offsetMs, setOffsetMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteRequest, setNoteRequest] = useState<NoteRequest | null>(null);
  const [minimized, setMinimizedState] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<{ key: string; label: string; hint: string }[]>([]);
  const [clients, setClients] = useState<{ id: string; client_name: string }[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [progress, setProgress] = useState<MyProgress | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [idlePrompt, setIdlePrompt] = useState(false);
  const [autoTrack, setAutoTrackState] = useState(false);
  const [pos, setPosState] = useState<{ x: number; y: number } | null>(null);
  const [accountCheck, setAccountCheck] = useState(false);
  // Session-elapsed threshold (seconds) for the next account check, per entry.
  const accountCheckRef = useRef<{ entryId: string; at: number } | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const enabled = !skip && !!me && TIMER_ROLES.has(me.role || "");

  // Role, once. Non-staff never trigger another request.
  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    fetchMe().then((m) => {
      if (cancelled) return;
      setMe(m);
      setMeChecked(true);
    });
    return () => { cancelled = true; };
  }, [skip]);

  // Minimized preference — hydrated AFTER mount (house convention: reading
  // storage in a useState initializer mismatches SSR).
  useEffect(() => {
    try {
      if (window.localStorage.getItem(MINIMIZED_KEY) === "1") setMinimizedState(true);
    } catch { /* storage can be blocked */ }
  }, []);
  const setMinimized = useCallback((v: boolean) => {
    setMinimizedState(v);
    try { window.localStorage.setItem(MINIMIZED_KEY, v ? "1" : "0"); } catch { /* ignore */ }
  }, []);

  // Auto-track preference. Unset → default ON for bookkeepers (the "forgot to
  // click start" problem is theirs), OFF for seniors — an admin spot-checking
  // ten clients in ten minutes doesn't want ten timers.
  useEffect(() => {
    if (!me) return;
    try {
      const stored = window.localStorage.getItem(AUTOTRACK_KEY);
      if (stored === "1") setAutoTrackState(true);
      else if (stored === "0") setAutoTrackState(false);
      else setAutoTrackState(me.role === "bookkeeper");
    } catch { setAutoTrackState(me.role === "bookkeeper"); }
  }, [me]);
  const setAutoTrack = useCallback((v: boolean) => {
    setAutoTrackState(v);
    try { window.localStorage.setItem(AUTOTRACK_KEY, v ? "1" : "0"); } catch { /* ignore */ }
  }, []);

  // Dragged widget position — hydrated after mount (SSR convention), clamped so
  // an old saved position on a smaller window can't strand the widget offscreen.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(POS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p?.x === "number" && typeof p?.y === "number") {
        setPosState({
          x: Math.min(Math.max(0, p.x), window.innerWidth - 60),
          y: Math.min(Math.max(0, p.y), window.innerHeight - 40),
        });
      }
    } catch { /* ignore */ }
  }, []);
  const setPos = useCallback((p: { x: number; y: number } | null) => {
    setPosState(p);
    try {
      if (p) window.localStorage.setItem(POS_KEY, JSON.stringify(p));
      else window.localStorage.removeItem(POS_KEY);
    } catch { /* ignore */ }
  }, []);

  const applyState = useCallback((d: any) => {
    if (d?.serverNow) setOffsetMs(Date.parse(d.serverNow) - Date.now());
    if ("context" in d) setContext(d.context ?? null);
    if ("running" in d) setRunning(d.running ?? null);
    if ("paused" in d) setPaused(d.paused ?? []);
    if (Array.isArray(d?.categories)) setCategories(d.categories);
    if ("me" in d) setProgress(d.me ?? null);
    if (Array.isArray(d?.suggestions)) setSuggestions(d.suggestions);
  }, []);

  /** Client list for the picker — fetched once, on first open. */
  const loadClients = useCallback(() => {
    if (clients !== null) return;
    fetch("/api/clients/switcher", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { clients: [] }))
      .then((d) => setClients(d.clients || []))
      .catch(() => setClients([]));
  }, [clients]);

  /** One round-trip: page context + my entries + budget + server clock. */
  const loadState = useCallback(async () => {
    if (!enabled) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const full = pathname + (typeof window !== "undefined" ? window.location.search : "");
    try {
      const res = await fetch(`/api/time-tracking/state?path=${encodeURIComponent(full)}`, {
        cache: "no-store",
        signal: ac.signal,
      });
      if (!res.ok) return;
      applyState(await res.json());
    } catch { /* aborted or offline — the next nav/focus retries */ }
  }, [enabled, pathname, applyState]);

  // Refetch on navigation (debounced — rapid clicking shouldn't storm the API).
  // Only client-shaped paths need the resolver; on other pages we still refresh
  // so a running timer's pill stays truthful, but context resolves to null.
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => { void loadState(); }, isClientShapedPath(pathname) ? 120 : 300);
    return () => clearTimeout(t);
  }, [enabled, pathname, loadState]);

  // Resync when the tab regains attention (catches "completed in another tab").
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => { void loadState(); };
    const onVis = () => { if (!document.hidden) void loadState(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, loadState]);

  // Cross-tab: any tab that mutates broadcasts; the others resync immediately
  // (CustomEvent — the lib/sounds.ts precedent — is same-tab only).
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(CHANNEL);
    channelRef.current = ch;
    ch.onmessage = () => { void loadState(); };
    return () => { ch.close(); channelRef.current = null; };
  }, [enabled, loadState]);
  const broadcast = useCallback(() => {
    try { channelRef.current?.postMessage({ t: Date.now() }); } catch { /* ignore */ }
  }, []);

  // Heartbeat while running — proof of life for the stale cap, and the
  // reconciliation channel across devices. Deliberately keeps beating while the
  // tab is hidden: bookkeepers sit in QuickBooks with SNAP in the background.
  useEffect(() => {
    if (!enabled || !running || running.status !== "running") return;
    const entryId = running.id;
    const tick = async () => {
      try {
        const res = await fetch("/api/time-tracking/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entryId }),
        });
        if (!res.ok) return;
        const d = await res.json();
        if (d?.serverNow) setOffsetMs(Date.parse(d.serverNow) - Date.now());
        // Authoritative: if another device took over (or completed this), adopt it.
        setRunning(d.running ?? null);
      } catch { /* transient */ }
    };
    const id = setInterval(tick, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [enabled, running]);

  // ── Page dwell (migration 155) ──────────────────────────────────────────
  // Which page the timer was pointed at, so a session can be broken down by
  // route later. Writes ONLY while a timer is actually running — never when
  // it's off or paused, which is what keeps this an attribution tool for
  // billed time rather than general monitoring.
  //
  // One endpoint serves enter / ping / exit: it closes whatever view is open
  // and opens one for the current path, so a dropped call self-heals on the
  // next tick instead of leaving a row open forever.
  const runningPageId = running?.status === "running" ? running.id : null;

  const sendPageView = useCallback(
    (entryId: string, path: string, close: boolean) => {
      const payload = JSON.stringify({ entryId, path, close });
      // Unload can't await a fetch; sendBeacon survives the teardown.
      if (close && typeof navigator !== "undefined" && navigator.sendBeacon) {
        try {
          navigator.sendBeacon(
            "/api/time-tracking/page-view",
            new Blob([payload], { type: "application/json" })
          );
          return;
        } catch { /* fall through to fetch */ }
      }
      fetch("/api/time-tracking/page-view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: close,
      }).catch(() => { /* telemetry — never surface, never retry */ });
    },
    []
  );

  // Open a view for the current path, ping it on the heartbeat cadence, bank it
  // when the path changes or the timer stops.
  //
  // Hidden tabs keep accruing, deliberately — same reasoning as the heartbeat:
  // bookkeepers sit in QuickBooks with SNAP behind it, and the SNAP page they
  // worked from is the right attribution for that stretch. Background throttling
  // just means fewer pings, and since each increment is capped server-side, the
  // effect is to UNDER-count and show the remainder as unattributed.
  //
  // Idle is the exception: no keyboard or mouse for 10 minutes is the one signal
  // that nobody is working, so bank the page and stop pinging until they answer
  // the widget's "still working?" prompt.
  useEffect(() => {
    if (!enabled || !runningPageId) return;
    const entryId = runningPageId;
    const path = pathname;
    if (idlePrompt) {
      sendPageView(entryId, path, true);
      return;
    }
    sendPageView(entryId, path, false);
    const id = setInterval(() => sendPageView(entryId, path, false), PAGE_PING_MS);
    return () => {
      clearInterval(id);
      sendPageView(entryId, path, true);
    };
  }, [enabled, runningPageId, pathname, idlePrompt, sendPageView]);

  // Real teardown — tab closed, or navigated off the app. pagehide fires where
  // unload doesn't (bfcache, mobile Safari); the effect cleanup above can't run
  // once the page is gone.
  useEffect(() => {
    if (!enabled || !runningPageId) return;
    const bank = () => sendPageView(runningPageId, pathname, true);
    window.addEventListener("pagehide", bank);
    return () => window.removeEventListener("pagehide", bank);
  }, [enabled, runningPageId, pathname, sendPageView]);

  // ── Actions ──
  const act = useCallback(
    async (url: string, body?: any): Promise<any | null> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, {
          method: body === undefined ? "POST" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (d?.error === "over_budget_note_required") return { __noteRequired: d };
          if (d?.error === "setup_pending") {
            setError("Time tracking isn't set up yet — migration 146 is pending.");
            return null;
          }
          if (d?.error === "another_timer_running") {
            await loadState();
            setError("Another timer was started elsewhere — refreshed.");
            return null;
          }
          setError(d?.message || d?.error || "Something went wrong");
          return null;
        }
        return d;
      } catch (e: any) {
        setError(e?.message || "Network error");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [loadState]
  );

  const start: TimerCtx["start"] = useCallback(
    async (target, opts = {}) => {
      const d = await act("/api/time-tracking/start", {
        clientLinkId: (target as any).clientLinkId,
        category: (target as any).category,
        sourcePath: pathname,
        completeActive: opts.completeActive === true,
        overBudgetNote: opts.overBudgetNote,
      });
      if (!d) return;
      if (d.__noteRequired) {
        // The OLD client is over budget; note it, then this same start retries.
        const p = d.__noteRequired.previous || {};
        setNoteRequest({
          entryId: p.entryId ?? null,
          clientName: p.clientName ?? null,
          mtdSeconds: p.mtdSeconds ?? 0,
          entrySeconds: p.entrySeconds ?? 0,
          budgetMinutes: p.budgetMinutes ?? 0,
          thenStartClientLinkId: (target as any).clientLinkId,
          thenStartCategory: (target as any).category,
        });
        return;
      }
      setNoteRequest(null);
      setPickerOpen(false);
      // The moment tracking starts, get out of the way — the widget's job is
      // to record, not to sit over the buttons someone is trying to click.
      setMinimized(true);
      await loadState();
      broadcast();
    },
    [act, pathname, loadState, broadcast, setMinimized]
  );

  const pause: TimerCtx["pause"] = useCallback(
    async (entryId) => { if (await act(`/api/time-tracking/${entryId}/pause`)) { await loadState(); broadcast(); } },
    [act, loadState, broadcast]
  );
  const resume: TimerCtx["resume"] = useCallback(
    async (entryId) => {
      if (await act(`/api/time-tracking/${entryId}/resume`)) {
        setMinimized(true);
        await loadState();
        broadcast();
      }
    },
    [act, loadState, broadcast, setMinimized]
  );
  const adjust: TimerCtx["adjust"] = useCallback(
    async (entryId, minutes) => {
      if (await act(`/api/time-tracking/${entryId}/adjust`, { minutes })) {
        await loadState();
        broadcast();
      }
    },
    [act, loadState, broadcast]
  );
  const discard: TimerCtx["discard"] = useCallback(
    async (entryId) => { if (await act(`/api/time-tracking/${entryId}/discard`)) { await loadState(); broadcast(); } },
    [act, loadState, broadcast]
  );

  const complete: TimerCtx["complete"] = useCallback(
    async (entryId, overBudgetNote) => {
      const d = await act(`/api/time-tracking/${entryId}/complete`, { overBudgetNote });
      if (!d) return;
      if (d.__noteRequired) {
        const n = d.__noteRequired;
        setNoteRequest({
          entryId,
          clientName: n.clientName ?? null,
          mtdSeconds: n.mtdSeconds ?? 0,
          entrySeconds: n.entrySeconds ?? 0,
          budgetMinutes: n.budgetMinutes ?? 0,
        });
        return;
      }
      setNoteRequest(null);
      await loadState();
      broadcast();
    },
    [act, loadState, broadcast]
  );

  const dismissPrompt = useCallback((clientLinkId: string) => {
    setDismissed((prev) => new Set(prev).add(clientLinkId));
  }, []);
  const dismissedForClient = useCallback((clientLinkId: string) => dismissed.has(clientLinkId), [dismissed]);

  // ── Idle detection ──────────────────────────────────────────────────────
  // Heartbeats keep firing whether or not anyone is at the keyboard, so a timer
  // left running through a long lunch quietly banks it. Watching real input lets
  // us ASK rather than guess, and pause back at the last activity if the answer
  // is "no" — better than silently trusting or silently discarding.
  const runningId = running?.id ?? null;
  useEffect(() => {
    if (!enabled) return;
    const mark = () => {
      lastActivityRef.current = Date.now();
      if (idlePrompt) setIdlePrompt(false);
    };
    const evts = ["keydown", "mousedown", "mousemove", "wheel", "touchstart"] as const;
    for (const e of evts) window.addEventListener(e, mark, { passive: true });
    return () => { for (const e of evts) window.removeEventListener(e, mark); };
  }, [enabled, idlePrompt]);

  useEffect(() => {
    if (!enabled || !runningId) { setIdlePrompt(false); return; }
    const id = setInterval(() => {
      if (Date.now() - lastActivityRef.current > IDLE_MS) setIdlePrompt(true);
    }, 30_000);
    return () => clearInterval(id);
  }, [enabled, runningId]);

  const dismissIdle = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIdlePrompt(false);
  }, []);

  const pauseAtLastActivity = useCallback(async () => {
    if (!runningId) return;
    setIdlePrompt(false);
    const d = await act(`/api/time-tracking/${runningId}/pause`, { asOfMs: lastActivityRef.current });
    if (d) { await loadState(); broadcast(); }
  }, [runningId, act, loadState, broadcast]);

  // ── Auto-track ──────────────────────────────────────────────────────────
  // The forget-to-click-start fix. When the page you're on resolves to a
  // client and the timer disagrees, the timer follows you — after a 12s dwell,
  // so passing through a page to check one number doesn't churn anything.
  //
  //   nothing running            → start a timer for this page's client
  //   running on another client  → PAUSE it (never silently complete — the
  //     over-budget note is owed at completion, and an auto-switch must not
  //     become a way around it), then resume this client's paused entry if
  //     one exists, else start fresh. Back-and-forth therefore reopens the
  //     same sessions instead of littering new ones.
  //   running on overhead        → left alone. Fleet work legitimately walks
  //     through client pages; hijacking it would misbill every walk-through.
  //
  // Fire-time state is read from a ref so the dwell timer isn't reset by
  // unrelated re-renders, and so a note modal or idle prompt opening after the
  // timer was armed still vetoes the switch.
  const autoTrackSnap = useRef({ running, paused, noteRequest, idlePrompt, busy, dismissed });
  autoTrackSnap.current = { running, paused, noteRequest, idlePrompt, busy, dismissed };

  const ctxClientId = context?.clientLinkId ?? null;
  useEffect(() => {
    if (!enabled || !autoTrack || !ctxClientId) return;
    if (running && !running.clientLinkId) return;            // overhead — hands off
    if (running && running.clientLinkId === ctxClientId) return; // already right
    const t = setTimeout(() => {
      const s = autoTrackSnap.current;
      if (s.noteRequest || s.idlePrompt || s.busy) return;
      if (s.running && s.running.clientLinkId === ctxClientId) return;
      if (s.running && !s.running.clientLinkId) return;
      // "Not now" (the X on the prompt) means not automatically either.
      if (s.dismissed.has(ctxClientId)) return;
      const pausedHere = s.paused.find((p) => p.clientLinkId === ctxClientId);
      // resume() pauses the running timer server-side before reopening this
      // one; start() auto-pauses it too — one call either way, no race.
      if (pausedHere) void resume(pausedHere.id);
      else void start({ clientLinkId: ctxClientId });
    }, AUTO_TRACK_DWELL_MS);
    return () => clearTimeout(t);
  }, [enabled, autoTrack, ctxClientId, running, resume, start]);

  // ── 30-minute account check ─────────────────────────────────────────────
  // A session crossing 30 minutes (then 60, 90…) gets one question: still on
  // the right account? EXCEPT when the evidence says yes — you're on that
  // client's pages and the keyboard is warm — in which case asking is noise
  // and the check re-arms silently. The prompt is exactly for the other case:
  // half an hour on the clock while you've visibly moved on.
  useEffect(() => {
    if (!enabled || !running || running.status !== "running") {
      setAccountCheck(false);
      return;
    }
    if (accountCheckRef.current?.entryId !== running.id) {
      accountCheckRef.current = { entryId: running.id, at: ACCOUNT_CHECK_MS };
    }
    const iv = setInterval(() => {
      const s = autoTrackSnap.current;
      if (!s.running || s.running.status !== "running" || s.noteRequest || s.idlePrompt) return;
      const mark = accountCheckRef.current;
      if (!mark || mark.entryId !== s.running.id) return;
      const live = elapsedSeconds(
        {
          status: s.running.status,
          last_resumed_at: s.running.lastResumedAt,
          accumulated_seconds: s.running.accumulatedSeconds,
          last_heartbeat_at: null,
        },
        Date.now() + offsetMs
      );
      if (live < mark.at) return;
      const onThatClient =
        !!s.running.clientLinkId && ctxClientId === s.running.clientLinkId;
      const recentlyActive = Date.now() - lastActivityRef.current < ACCOUNT_CHECK_ACTIVE_MS;
      if (onThatClient && recentlyActive) {
        mark.at += ACCOUNT_CHECK_MS; // clearly still on it — don't ask
      } else {
        setAccountCheck(true);
      }
    }, 30_000);
    return () => clearInterval(iv);
  }, [enabled, running, ctxClientId, offsetMs]);

  const ackAccountCheck = useCallback(() => {
    const mark = accountCheckRef.current;
    if (mark) mark.at += ACCOUNT_CHECK_MS;
    setAccountCheck(false);
  }, []);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  // Alt-chords only, and never while typing — the whole point is saving a trip
  // to the mouse, not stealing keystrokes from a memo field.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        if (running) { void complete(running.id); }
        else if (context) { void start({ clientLinkId: context.clientLinkId }); }
        else { loadClients(); setPickerOpen(true); }
      } else if (k === "p") {
        e.preventDefault();
        if (running) void pause(running.id);
        else if (paused[0]) void resume(paused[0].id);
      } else if (k === "m") {
        e.preventDefault();
        setMinimized(!minimized);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, running, paused, context, minimized, complete, pause, resume, start, setMinimized, loadClients]);

  const value = useMemo<TimerCtx>(
    () => ({
      me, context, running, paused, offsetMs, busy, error, noteRequest, minimized,
      setMinimized, autoTrack, setAutoTrack, pos, setPos,
      accountCheck, ackAccountCheck, adjust,
      dismissedForClient, dismissPrompt,
      start, pause, resume, complete, discard,
      categories, clients, loadClients, pickerOpen, setPickerOpen,
      progress, suggestions, idlePrompt, dismissIdle,
      pauseAtLastActivity: () => { void pauseAtLastActivity(); },
      cancelNote: () => setNoteRequest(null),
      refresh: () => { void loadState(); },
    }),
    [me, context, running, paused, offsetMs, busy, error, noteRequest, minimized,
     setMinimized, autoTrack, setAutoTrack, pos, setPos,
     accountCheck, ackAccountCheck, adjust,
     dismissedForClient, dismissPrompt, start, pause, resume, complete, discard,
     categories, clients, loadClients, pickerOpen, loadState,
     progress, suggestions, idlePrompt, dismissIdle, pauseAtLastActivity]
  );

  // Nothing to show for portal/public pages, or before we know the role (no
  // flash), or for roles without a timer.
  if (skip || !meChecked || !enabled) return null;

  return (
    <Ctx.Provider value={value}>
      <TimeTrackerWidget />
    </Ctx.Provider>
  );
}
