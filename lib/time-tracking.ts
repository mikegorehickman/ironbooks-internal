/**
 * Time tracking — pure core (client-safe: no supabase, no next imports).
 * ----------------------------------------------------------------------
 * The single source of truth for the timer's math and routing rules, shared by
 * the API routes AND the floating widget so the number the bookkeeper watches
 * is computed by the exact code that enforces the over-budget check.
 *
 * Model (see scripts/migration_146_time_tracking.sql):
 *   - One row per work session. `accumulated_seconds` banks active time at
 *     every pause; while running, the live segment since `last_resumed_at` is
 *     added on top. After the completing fold, accumulated IS the total.
 *   - Heartbeats (~60s) anchor the stale cap: a running entry whose heartbeat
 *     is older than STALE_MS gets its segment capped AT the last heartbeat and
 *     is auto-paused — a dead laptop can never credit a night of wall clock.
 *     That cap is applied by EVERY write path via finalizeSegment(), not just
 *     the sweep (a stale tab's "Complete" must not credit dead time either).
 *   - Month attribution = ended_at in BUSINESS_TZ. A reviewed month can never
 *     change afterward, because nothing can complete INTO a past month.
 *   - Budget: minutes per client per month; NULL → DEFAULT_TIME_BUDGET_MINUTES
 *     (resolved with ?? — 0 is a valid "always explain this client" budget).
 *     Over ⇔ mtd + session STRICTLY exceeds budget.
 */

// ── Tunables ────────────────────────────────────────────────────────────────

/** Monthly budget applied when client_links.time_budget_minutes is NULL. */
export const DEFAULT_TIME_BUDGET_MINUTES = 120;
/** Expected logged minutes on a working day, when users.daily_target_minutes is
 *  NULL (migration 148). 6h — production time, not hours at the desk. */
export const DEFAULT_DAILY_TARGET_MINUTES = 360;
/** A running entry whose heartbeat is older than this is treated as abandoned. */
export const STALE_MS = 30 * 60_000;
/** Widget heartbeat cadence while running. */
export const HEARTBEAT_MS = 60_000;
/** Business timezone for month boundaries (Ironbooks HQ; no DST in Regina). */
export const BUSINESS_TZ = "America/Regina";

// ── Overhead categories ─────────────────────────────────────────────────────
// Work that belongs to no single client (migration 147). The rule: track against
// a CLIENT when the effort varies per client — answering one client's requests is
// their cost and counts against their budget, which is why the widget has a
// client picker for non-client-scoped pages like /inbox — and against a CATEGORY
// when it doesn't. Overhead is reported separately and NEVER counted against a
// client's monthly budget.
//
// One definition, so adding a bucket is this list + the CHECK in migration 147.

export const OVERHEAD_CATEGORIES = [
  {
    key: "client_comms",
    label: "Client comms & requests",
    hint: "Batch inbox/message work spanning several clients — when picking one would be arbitrary",
  },
  { key: "internal", label: "Meetings & training", hint: "Team calls, coaching, onboarding, SOP/handbook work" },
  { key: "fleet", label: "Fleet-wide production", hint: "Month-end sweeps, COA audit, bank-rule pushes — work across the whole fleet" },
  { key: "admin", label: "Admin & other", hint: "Firm admin, SNAP tooling, sales support" },
] as const;

export type OverheadCategory = (typeof OVERHEAD_CATEGORIES)[number]["key"];

/** Validate a category from a request body — never trust the raw value. */
export function isOverheadCategory(value: unknown): value is OverheadCategory {
  return typeof value === "string" && OVERHEAD_CATEGORIES.some((c) => c.key === value);
}

export function overheadLabel(key: string | null | undefined): string | null {
  return OVERHEAD_CATEGORIES.find((c) => c.key === key)?.label ?? null;
}

// ── Types ───────────────────────────────────────────────────────────────────

export type TimeEntryStatus = "running" | "paused" | "completed" | "discarded";

/** The fields the math needs — rows come from the untyped table, keep it loose. */
export interface TimerFields {
  status: TimeEntryStatus | string;
  last_resumed_at: string | null;
  accumulated_seconds: number;
  last_heartbeat_at: string | null;
}

export type PathContext =
  | { kind: "client"; clientLinkId: string }
  | { kind: "job"; table: JobTable; jobId: string }
  | null;

export type JobTable =
  | "reclass_jobs"
  | "coa_jobs"
  | "rule_discovery_jobs"
  | "stripe_recon_jobs"
  | "uf_ar_jobs";

// ── Elapsed / segment math ──────────────────────────────────────────────────

const ms = (iso: string | null | undefined): number => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

/** Seconds of active work as of `nowMs`. Never below the banked amount. */
export function elapsedSeconds(entry: TimerFields, nowMs: number): number {
  const banked = Math.max(0, entry.accumulated_seconds | 0);
  if (entry.status !== "running") return banked;
  const resumed = ms(entry.last_resumed_at);
  if (!Number.isFinite(resumed)) return banked;
  return banked + Math.max(0, Math.floor((nowMs - resumed) / 1000));
}

export interface SegmentFold {
  /** accumulated_seconds after folding the open segment (unchanged if none). */
  accumulatedSeconds: number;
  /** True when the segment was stale-capped at the last heartbeat. */
  autoPaused: boolean;
  /** The instant the segment effectively ended (for ended_at on complete). */
  effectiveEndMs: number;
}

/**
 * Fold a running entry's open segment. Fresh → cap at now; stale (heartbeat
 * older than STALE_MS) → cap at the last heartbeat, flag autoPaused. A
 * heartbeat that predates the resume (laptop died instantly) clamps to +0 —
 * a segment can never be negative. Non-running entries are a no-op.
 */
export function finalizeSegment(entry: TimerFields, nowMs: number, staleMs: number = STALE_MS): SegmentFold {
  const banked = Math.max(0, entry.accumulated_seconds | 0);
  const resumed = ms(entry.last_resumed_at);
  if (entry.status !== "running" || !Number.isFinite(resumed)) {
    return { accumulatedSeconds: banked, autoPaused: false, effectiveEndMs: nowMs };
  }
  const heartbeat = ms(entry.last_heartbeat_at);
  const stale = Number.isFinite(heartbeat) && nowMs - heartbeat > staleMs;
  // Stale → the last heartbeat is the last proof of life, but never before the
  // segment even began (negative-segment guard).
  const effectiveEndMs = stale ? Math.max(heartbeat, resumed) : nowMs;
  const delta = Math.max(0, Math.floor((effectiveEndMs - resumed) / 1000));
  return { accumulatedSeconds: banked + delta, autoPaused: stale, effectiveEndMs };
}

/** Fields to set on resume (and on start): fresh segment, fresh heartbeat,
 *  auto_paused cleared — a resume without the heartbeat bump can produce a
 *  NEGATIVE sweep segment (heartbeat < last_resumed_at). */
export function applyResume(nowMs: number): {
  status: "running";
  last_resumed_at: string;
  last_heartbeat_at: string;
  auto_paused: false;
} {
  const iso = new Date(nowMs).toISOString();
  return { status: "running", last_resumed_at: iso, last_heartbeat_at: iso, auto_paused: false };
}

// ── Month boundaries in the business timezone ───────────────────────────────

/** Offset (ms) between UTC and `tz` at the given instant. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const wallMs = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wallMs - utcMs;
}

/** UTC instant of local midnight (y, m 1-12, d) in `tz`. Double-probe handles DST edges. */
function wallMidnightUtcMs(y: number, m: number, d: number, tz: string): number {
  const wallMs = Date.UTC(y, m - 1, d);
  let utc = wallMs - tzOffsetMs(wallMs, tz);
  utc = wallMs - tzOffsetMs(utc, tz);
  return utc;
}

/** Half-open UTC range [startUtc, endUtc) covering month "YYYY-MM" in `tz`. */
export function monthRangeUtc(month: string, tz: string = BUSINESS_TZ): { startUtc: string; endUtc: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month || "");
  if (!m) throw new Error(`monthRangeUtc: bad month "${month}" (want YYYY-MM)`);
  const y = +m[1];
  const mo = +m[2];
  if (mo < 1 || mo > 12) throw new Error(`monthRangeUtc: bad month "${month}"`);
  const start = wallMidnightUtcMs(y, mo, 1, tz);
  const end = mo === 12 ? wallMidnightUtcMs(y + 1, 1, 1, tz) : wallMidnightUtcMs(y, mo + 1, 1, tz);
  return { startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString() };
}

/** "YYYY-MM" the instant belongs to, in `tz`. */
export function attributionMonth(endedAtIso: string, tz: string = BUSINESS_TZ): string {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(endedAtIso))) p[part.type] = part.value;
  return `${p.year}-${p.month}`;
}

/** Current month key ("YYYY-MM") in `tz`. */
export function currentMonth(nowMs: number, tz: string = BUSINESS_TZ): string {
  return attributionMonth(new Date(nowMs).toISOString(), tz);
}

/** "YYYY-MM-DD" the instant falls on, in `tz` — the per-day rollup key. Must use
 *  the same timezone as month attribution or a 7pm session would land on
 *  tomorrow (UTC) and the daily bars wouldn't match the calendar. */
export function attributionDay(endedAtIso: string, tz: string = BUSINESS_TZ): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(endedAtIso))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const dayKey = (y: number, m0: number, d: number) => {
  const dt = new Date(Date.UTC(y, m0, d));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
};

/**
 * The Monday-start week containing `nowMs`, in `tz`. Weeks are the unit people
 * actually plan in ("I'm behind for the week"), and a Monday start matches how
 * the team talks about it.
 */
export function weekRangeUtc(nowMs: number, tz: string = BUSINESS_TZ): {
  startUtc: string; endUtc: string; days: string[];
} {
  const today = attributionDay(new Date(nowMs).toISOString(), tz);
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  const backToMonday = (dow + 6) % 7;
  const days = Array.from({ length: 7 }, (_, i) => dayKey(y, m - 1, d - backToMonday + i));
  const first = days[0].split("-").map(Number);
  const afterLast = dayKey(y, m - 1, d - backToMonday + 7).split("-").map(Number);
  return {
    startUtc: new Date(wallMidnightUtcMs(first[0], first[1], first[2], tz)).toISOString(),
    endUtc: new Date(wallMidnightUtcMs(afterLast[0], afterLast[1], afterLast[2], tz)).toISOString(),
    days,
  };
}

/** Mon–Fri days in a month. Drives derived team goals: nobody should have to
 *  maintain a separate goal number that silently drifts from the per-person
 *  targets it's supposed to be the sum of. */
export function workingDaysInMonth(month: string): string[] {
  return daysInMonth(month).filter((iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return dow !== 0 && dow !== 6;
  });
}

/** Every "YYYY-MM-DD" in a month, in order — so a daily chart shows empty days
 *  as gaps rather than silently omitting them. */
export function daysInMonth(month: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month || "");
  if (!m) throw new Error(`daysInMonth: bad month "${month}" (want YYYY-MM)`);
  const y = +m[1];
  const mo = +m[2];
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${m[1]}-${m[2]}-${String(i + 1).padStart(2, "0")}`);
}

// ── Budget ──────────────────────────────────────────────────────────────────

/** NULL budget → default. `??` on purpose: 0 is a real budget, `||` would eat it. */
export function effectiveBudgetMinutes(budgetMinutes: number | null | undefined): number {
  return budgetMinutes ?? DEFAULT_TIME_BUDGET_MINUTES;
}

/** Over ⇔ month-to-date + this session STRICTLY exceeds the budget. */
export function isOverBudget(
  mtdSeconds: number,
  entrySeconds: number,
  budgetMinutes: number | null | undefined
): boolean {
  return mtdSeconds + entrySeconds > effectiveBudgetMinutes(budgetMinutes) * 60;
}

// ── Daily logging target (migration 148) ────────────────────────────────────

/** NULL target → default. `??` again: 0 is "no target", not "use the default". */
export function effectiveDailyTargetMinutes(targetMinutes: number | null | undefined): number {
  return targetMinutes ?? DEFAULT_DAILY_TARGET_MINUTES;
}

/**
 * Is a worked day short of the person's target?
 *
 * Only judges days with SOME logged time — a day with nothing is a day off, a
 * holiday or sick leave, and we can't tell which, so flagging it would make the
 * report noise. A 0 target means "not expected to log" and is never short.
 */
export function isBelowDailyTarget(
  daySeconds: number,
  targetMinutes: number | null | undefined
): boolean {
  const target = effectiveDailyTargetMinutes(targetMinutes);
  if (target <= 0) return false;
  if (daySeconds <= 0) return false;
  return daySeconds < target * 60;
}

// ── Cost to serve (migration 149) ───────────────────────────────────────────
// Hours only become a business number when they're priced. Cost to serve a
// client = tracked time × the loaded hourly cost of whoever did the work;
// compared against what the client pays, that's the real margin per client —
// the input for pricing and upgrade conversations.

/** Loaded hourly cost used when users.hourly_cost_cents is NULL. $45/h. */
export const DEFAULT_HOURLY_COST_CENTS = 4500;

/** `??` again — 0 is a valid rate (an owner not costed against production). */
export function effectiveHourlyCostCents(cents: number | null | undefined): number {
  return cents ?? DEFAULT_HOURLY_COST_CENTS;
}

/** Cost of a stretch of tracked time, in cents. */
export function costOfSecondsCents(seconds: number, hourlyCents: number | null | undefined): number {
  return Math.round((Math.max(0, seconds) / 3600) * effectiveHourlyCostCents(hourlyCents));
}

/**
 * Gross margin percent for a client-month. Null when there's no fee to compare
 * against — an unknown fee must read as "unknown", never as 0% margin (which
 * would look like a disaster and put the wrong client at the top of the list).
 */
export function marginPct(feeCents: number | null | undefined, costCents: number): number | null {
  if (feeCents == null || feeCents <= 0) return null;
  return Math.round(((feeCents - costCents) / feeCents) * 100);
}

// ── Route → client context resolution ───────────────────────────────────────
// Shared by the widget (prefilter: is this a client page at all?) and the
// /state endpoint (authoritative resolution; job rows are looked up there).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path prefixes that are client-scoped when followed by a client uuid. */
const CLIENT_PARAM_HEADS = new Set(["clients", "today", "balance-sheet", "revenue-check", "tax-audit"]);

/** Job-id route heads → the job table whose row carries client_link_id. */
const JOB_HEADS: Record<string, JobTable> = {
  reclass: "reclass_jobs",
  jobs: "coa_jobs",
  rules: "rule_discovery_jobs",
  "stripe-recon": "stripe_recon_jobs",
};

/** "new"-workflow pages that carry ?client=<uuid>. */
const QUERY_CLIENT_PATHS = new Set(["/jobs/new", "/reclass/new", "/rules/new", "/stripe-recon/new"]);

/**
 * Resolve a pathname(+search) to its client context.
 *   - client-param routes  → { kind: "client", clientLinkId }
 *   - job-id routes        → { kind: "job", table, jobId }  (server resolves the row)
 *   - ?client= workflow pages → { kind: "client", clientLinkId }
 *   - anything else → null
 * "new" and other non-uuid segments never match (uuid guard).
 */
export function resolvePathContext(path: string): PathContext {
  if (!path) return null;
  const qIdx = path.indexOf("?");
  const pathname = (qIdx >= 0 ? path.slice(0, qIdx) : path).replace(/\/+$/, "") || "/";
  const search = qIdx >= 0 ? path.slice(qIdx + 1) : "";
  const seg = pathname.split("/").filter(Boolean);

  // ?client=<uuid> workflow pages
  if (QUERY_CLIENT_PATHS.has(pathname) && search) {
    const client = new URLSearchParams(search).get("client") || "";
    if (UUID_RE.test(client)) return { kind: "client", clientLinkId: client };
  }

  if (seg.length < 2) return null;

  // /balance-sheet/uf-ar/[id]/... — a job route nested under a client head.
  if (seg[0] === "balance-sheet" && seg[1] === "uf-ar") {
    return seg[2] && UUID_RE.test(seg[2]) ? { kind: "job", table: "uf_ar_jobs", jobId: seg[2] } : null;
  }

  if (JOB_HEADS[seg[0]] && UUID_RE.test(seg[1])) {
    return { kind: "job", table: JOB_HEADS[seg[0]], jobId: seg[1] };
  }

  if (CLIENT_PARAM_HEADS.has(seg[0]) && UUID_RE.test(seg[1])) {
    return { kind: "client", clientLinkId: seg[1] };
  }

  return null;
}

/** Cheap client-side prefilter: could this path possibly be client-scoped?
 *  (Avoids hitting the /state resolver on every navigation.) */
export function isClientShapedPath(path: string): boolean {
  return resolvePathContext(path) !== null;
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Ticking clock: "12:34" under an hour, "1:04:09" over. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** Human duration for budgets/reports: "0m", "45m", "2h 10m", "3h". */
export function formatDuration(totalSeconds: number): string {
  const mins = Math.max(0, Math.round(totalSeconds / 60));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
