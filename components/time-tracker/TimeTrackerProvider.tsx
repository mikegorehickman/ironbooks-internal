"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { HEARTBEAT_MS, isClientShapedPath } from "@/lib/time-tracking";
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
/** No input for this long with a timer running → ask if they're still working. */
const IDLE_MS = 10 * 60_000;
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
      await loadState();
      broadcast();
    },
    [act, pathname, loadState, broadcast]
  );

  const pause: TimerCtx["pause"] = useCallback(
    async (entryId) => { if (await act(`/api/time-tracking/${entryId}/pause`)) { await loadState(); broadcast(); } },
    [act, loadState, broadcast]
  );
  const resume: TimerCtx["resume"] = useCallback(
    async (entryId) => { if (await act(`/api/time-tracking/${entryId}/resume`)) { await loadState(); broadcast(); } },
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
      setMinimized, dismissedForClient, dismissPrompt,
      start, pause, resume, complete, discard,
      categories, clients, loadClients, pickerOpen, setPickerOpen,
      progress, suggestions, idlePrompt, dismissIdle,
      pauseAtLastActivity: () => { void pauseAtLastActivity(); },
      cancelNote: () => setNoteRequest(null),
      refresh: () => { void loadState(); },
    }),
    [me, context, running, paused, offsetMs, busy, error, noteRequest, minimized,
     setMinimized, dismissedForClient, dismissPrompt, start, pause, resume, complete, discard,
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
