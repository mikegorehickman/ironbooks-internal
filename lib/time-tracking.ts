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
/** A running entry whose heartbeat is older than this is treated as abandoned. */
export const STALE_MS = 30 * 60_000;
/** Widget heartbeat cadence while running. */
export const HEARTBEAT_MS = 60_000;
/** Business timezone for month boundaries (Ironbooks HQ; no DST in Regina). */
export const BUSINESS_TZ = "America/Regina";

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
