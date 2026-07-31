/**
 * Time tracking — server helpers (auth, state transitions, MTD math).
 * -------------------------------------------------------------------
 * The API routes under app/api/time-tracking/* are thin wrappers over these.
 * All the correctness rules live here so no route can forget one:
 *
 *   - Every write path folds the open segment through finalizeSegment(), which
 *     stale-caps at the last heartbeat. A tab left open on a dead laptop can
 *     never credit a night of wall clock, no matter which button gets clicked.
 *   - Every transition is compare-and-swap (`.eq("status", expected)`), so two
 *     tabs racing the same entry can't double-apply; zero rows updated means
 *     "someone else already moved it" → re-read and return the truth.
 *   - Month attribution is ended_at inside BUSINESS_TZ (lib/time-tracking.ts).
 *
 * time_entries is not in the generated types until `npm run types` runs after
 * migration 146, so table access goes through `(service as any)`. Reads also
 * tolerate the table not existing yet (Mike applies SQL by hand) — see
 * tableMissing().
 */

import {
  STALE_MS,
  elapsedSeconds,
  finalizeSegment,
  applyResume,
  monthRangeUtc,
  currentMonth,
  effectiveBudgetMinutes,
  isOverBudget,
  overheadLabel,
  type TimerFields,
} from "./time-tracking";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

/** Roles that get a timer. billing_admin (Mike's call), client and viewer
 *  (read-only, doesn't work accounts) are excluded. */
export const TIMER_ROLES = ["admin", "lead", "bookkeeper"] as const;
export const SENIOR_ROLES = ["admin", "lead"] as const;

export interface TimerActor {
  userId: string;
  role: string;
  fullName: string | null;
  isSenior: boolean;
}

/**
 * Authenticate + authorize a time-tracking caller. Uses the SESSION client for
 * identity and the SERVICE client for the role read (house pattern).
 * Returns null when unauthenticated; { forbidden: true } when the role has no
 * timer, so callers can pick 401 vs 403.
 */
export async function requireTimerActor(
  supabase: AnySupabase,
  service: AnySupabase,
  opts: { seniorOnly?: boolean } = {}
): Promise<{ actor: TimerActor } | { error: "unauthorized" } | { error: "forbidden" }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { data: profile } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const role = (profile as any)?.role || "";
  const allowed = opts.seniorOnly
    ? (SENIOR_ROLES as readonly string[]).includes(role)
    : (TIMER_ROLES as readonly string[]).includes(role);
  if (!allowed) return { error: "forbidden" };
  return {
    actor: {
      userId: user.id,
      role,
      fullName: (profile as any)?.full_name ?? null,
      isSenior: (SENIOR_ROLES as readonly string[]).includes(role),
    },
  };
}

/** True when the error means "migration 146 hasn't been applied yet". */
export function tableMissing(err: any): boolean {
  const msg = String(err?.message || err || "");
  return err?.code === "42P01" || /relation .*time_entries.* does not exist/i.test(msg);
}

export const ENTRY_COLS =
  "id, client_link_id, category, user_id, status, started_at, last_resumed_at, accumulated_seconds, " +
  "ended_at, source_path, over_budget_note, budget_minutes_at_completion, " +
  "mtd_seconds_at_completion, auto_paused, last_heartbeat_at, created_at, updated_at";

export interface TimeEntryRow extends TimerFields {
  id: string;
  /** NULL on overhead entries (migration 147) — exactly one of these two is set. */
  client_link_id: string | null;
  category: string | null;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  source_path: string | null;
  over_budget_note: string | null;
  budget_minutes_at_completion: number | null;
  mtd_seconds_at_completion: number | null;
  auto_paused: boolean;
}

/** Shape returned to the widget — server-computed so the client never guesses. */
export interface EntryView {
  id: string;
  clientLinkId: string | null;
  clientName: string | null;
  category: string | null;
  /** What to show: the client's name, or the overhead bucket's label. */
  label: string;
  status: string;
  elapsedSeconds: number;
  accumulatedSeconds: number;
  lastResumedAt: string | null;
  startedAt: string;
  autoPaused: boolean;
  sourcePath: string | null;
}

export function toEntryView(row: TimeEntryRow, nowMs: number, clientName?: string | null): EntryView {
  const name = clientName ?? null;
  return {
    id: row.id,
    clientLinkId: row.client_link_id,
    clientName: name,
    category: row.category,
    label: row.category ? overheadLabel(row.category) || "Other work" : name || "Client",
    status: String(row.status),
    elapsedSeconds: elapsedSeconds(row, nowMs),
    accumulatedSeconds: Math.max(0, row.accumulated_seconds | 0),
    lastResumedAt: row.last_resumed_at,
    startedAt: row.started_at,
    autoPaused: !!row.auto_paused,
    sourcePath: row.source_path,
  };
}

// ── Stale sweep ─────────────────────────────────────────────────────────────

/**
 * Auto-pause abandoned running entries (heartbeat older than STALE_MS), banking
 * time only up to the last proof of life. Never completes anything — a paused
 * entry is resumable and still has to pass the required-note rule when it's
 * completed for real (the "un-park, don't kill" rule from lib/stale-jobs.ts).
 *
 * Lazy: called from the read endpoints (own entries on /state, fleet-wide on
 * /report) rather than a cron, so it costs nothing when nobody's looking.
 */
export async function sweepStaleEntries(
  service: AnySupabase,
  opts: { userId?: string; nowMs?: number } = {}
): Promise<{ auto_paused: number }> {
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - STALE_MS).toISOString();
  try {
    let q = (service as any)
      .from("time_entries")
      .select(ENTRY_COLS)
      .eq("status", "running")
      .lt("last_heartbeat_at", cutoff);
    if (opts.userId) q = q.eq("user_id", opts.userId);
    const { data, error } = await q;
    if (error) throw error;
    const rows: TimeEntryRow[] = data || [];
    let swept = 0;
    for (const row of rows) {
      const fold = finalizeSegment(row, nowMs);
      const { data: updated } = await (service as any)
        .from("time_entries")
        .update({
          status: "paused",
          last_resumed_at: null,
          accumulated_seconds: fold.accumulatedSeconds,
          auto_paused: true,
          updated_at: new Date(nowMs).toISOString(),
        })
        .eq("id", row.id)
        .eq("status", "running") // CAS — a live tab may have moved it
        .select("id");
      if (updated?.length) swept++;
    }
    return { auto_paused: swept };
  } catch (err) {
    if (tableMissing(err)) return { auto_paused: 0 };
    throw err;
  }
}

// ── Month-to-date ───────────────────────────────────────────────────────────

/**
 * Completed seconds for a client in a month (all bookkeepers — the budget is
 * the client's, not one person's). Discarded entries are excluded; in-flight
 * entries are excluded so the number is deterministic and the widget's warning
 * predicts the server check exactly. Overhead rows carry no client_link_id, so
 * they can never land in a client's month by construction.
 */
export async function clientMonthToDateSeconds(
  service: AnySupabase,
  clientLinkId: string,
  month: string
): Promise<number> {
  const { startUtc, endUtc } = monthRangeUtc(month);
  try {
    const { data, error } = await (service as any)
      .from("time_entries")
      .select("accumulated_seconds")
      .eq("client_link_id", clientLinkId)
      .eq("status", "completed")
      .gte("ended_at", startUtc)
      .lt("ended_at", endUtc);
    if (error) throw error;
    return (data || []).reduce((s: number, r: any) => s + Math.max(0, r.accumulated_seconds | 0), 0);
  } catch (err) {
    if (tableMissing(err)) return 0;
    throw err;
  }
}

/** The client's budget in minutes (NULL column → app default via `??`). */
export async function clientBudgetMinutes(service: AnySupabase, clientLinkId: string): Promise<number> {
  const { data } = await (service as any)
    .from("client_links")
    .select("time_budget_minutes")
    .eq("id", clientLinkId)
    .single();
  return effectiveBudgetMinutes((data as any)?.time_budget_minutes);
}

// ── Transitions ─────────────────────────────────────────────────────────────

export async function fetchEntry(service: AnySupabase, entryId: string): Promise<TimeEntryRow | null> {
  const { data } = await (service as any)
    .from("time_entries")
    .select(ENTRY_COLS)
    .eq("id", entryId)
    .single();
  return (data as TimeEntryRow) ?? null;
}

/** The caller's running entry, if any. */
export async function fetchRunningEntry(service: AnySupabase, userId: string): Promise<TimeEntryRow | null> {
  const { data } = await (service as any)
    .from("time_entries")
    .select(ENTRY_COLS)
    .eq("user_id", userId)
    .eq("status", "running")
    .maybeSingle();
  return (data as TimeEntryRow) ?? null;
}

/** The caller's paused entries, newest first. */
export async function fetchPausedEntries(service: AnySupabase, userId: string): Promise<TimeEntryRow[]> {
  const { data } = await (service as any)
    .from("time_entries")
    .select(ENTRY_COLS)
    .eq("user_id", userId)
    .eq("status", "paused")
    .order("started_at", { ascending: false });
  return (data as TimeEntryRow[]) || [];
}

/** Pause a running entry (CAS + stale-cap). Idempotent: already-paused → as-is. */
export async function pauseEntry(
  service: AnySupabase,
  row: TimeEntryRow,
  nowMs: number
): Promise<TimeEntryRow | null> {
  if (row.status !== "running") return row;
  const fold = finalizeSegment(row, nowMs);
  const { data } = await (service as any)
    .from("time_entries")
    .update({
      status: "paused",
      last_resumed_at: null,
      accumulated_seconds: fold.accumulatedSeconds,
      auto_paused: fold.autoPaused,
      updated_at: new Date(nowMs).toISOString(),
    })
    .eq("id", row.id)
    .eq("status", "running")
    .select(ENTRY_COLS);
  // Zero rows = another tab moved it; caller re-reads.
  return (data as TimeEntryRow[])?.[0] ?? null;
}

/** Resume a paused entry, first pausing whatever else is running for this user. */
export async function resumeEntry(
  service: AnySupabase,
  row: TimeEntryRow,
  nowMs: number
): Promise<TimeEntryRow | null> {
  if (row.status === "running") return row;
  const running = await fetchRunningEntry(service, row.user_id);
  if (running && running.id !== row.id) await pauseEntry(service, running, nowMs);
  const { data } = await (service as any)
    .from("time_entries")
    .update({ ...applyResume(nowMs), updated_at: new Date(nowMs).toISOString() })
    .eq("id", row.id)
    .eq("status", "paused")
    .select(ENTRY_COLS);
  return (data as TimeEntryRow[])?.[0] ?? null;
}

export interface CompleteOutcome {
  ok: boolean;
  /** Set when the client's month is over budget and no note was supplied. */
  noteRequired?: { mtdSeconds: number; entrySeconds: number; budgetMinutes: number };
  entry?: TimeEntryRow;
  conflict?: TimeEntryRow;
}

/**
 * Complete an entry: fold (stale-capped), enforce the over-budget note, snapshot
 * the budget + MTD for the note's context, and stamp ended_at (which is what
 * attributes the session to a month).
 */
export async function completeEntry(
  service: AnySupabase,
  row: TimeEntryRow,
  nowMs: number,
  overBudgetNote?: string | null
): Promise<CompleteOutcome> {
  if (row.status === "completed" || row.status === "discarded") return { ok: true, entry: row };

  const fold = finalizeSegment(row, nowMs);
  const entrySeconds = fold.accumulatedSeconds;
  // ended_at is the fold's effective end (the last proof of life for a stale
  // entry) — never a fabricated "now" hours after the laptop died.
  const endedAtMs = row.status === "running" ? fold.effectiveEndMs : nowMs;
  const note = (overBudgetNote || "").trim();

  // Overhead (no client) has no budget to exceed — nothing to explain, and it
  // must never be measured against a client's month.
  let budgetMinutes: number | null = null;
  let mtdSeconds: number | null = null;
  if (row.client_link_id) {
    const month = currentMonth(endedAtMs);
    budgetMinutes = await clientBudgetMinutes(service, row.client_link_id);
    mtdSeconds = await clientMonthToDateSeconds(service, row.client_link_id, month);
    if (isOverBudget(mtdSeconds, entrySeconds, budgetMinutes) && !note) {
      return { ok: false, noteRequired: { mtdSeconds, entrySeconds, budgetMinutes } };
    }
  }

  const { data } = await (service as any)
    .from("time_entries")
    .update({
      status: "completed",
      last_resumed_at: null,
      accumulated_seconds: entrySeconds,
      ended_at: new Date(endedAtMs).toISOString(),
      auto_paused: false,
      over_budget_note: note || null,
      budget_minutes_at_completion: budgetMinutes,
      mtd_seconds_at_completion: mtdSeconds,
      updated_at: new Date(nowMs).toISOString(),
    })
    .eq("id", row.id)
    .in("status", ["running", "paused"])
    .select(ENTRY_COLS);
  const updated = (data as TimeEntryRow[])?.[0];
  if (!updated) {
    const fresh = await fetchEntry(service, row.id);
    return { ok: true, entry: fresh ?? row };
  }
  return { ok: true, entry: updated };
}

/** Discard an accidental start — kept for audit, excluded from all reporting. */
export async function discardEntry(
  service: AnySupabase,
  row: TimeEntryRow,
  nowMs: number
): Promise<TimeEntryRow | null> {
  if (row.status === "completed" || row.status === "discarded") return row;
  const { data } = await (service as any)
    .from("time_entries")
    .update({
      status: "discarded",
      last_resumed_at: null,
      ended_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    })
    .eq("id", row.id)
    .in("status", ["running", "paused"])
    .select(ENTRY_COLS);
  return (data as TimeEntryRow[])?.[0] ?? (await fetchEntry(service, row.id));
}

/** Postgres unique-violation (the one-running-per-user index). */
export function isUniqueViolation(err: any): boolean {
  return err?.code === "23505";
}
