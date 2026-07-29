/**
 * The monthly close — stage model and derived progress.
 *
 * One row per client per month (`client_months`, migration 142). Every stage is
 * a completion TIMESTAMP, never a status string: a timestamp answers "when",
 * which is what a month-end review needs, and it removes the whole class of bug
 * where a status claims done while the work underneath isn't. Progress is
 * therefore derived here, never stored.
 *
 * This file is the single definition of the stage list and its order. The board,
 * the 1st-of-month opener, the per-client detail page and each individual tool
 * all read it, so adding a stage is one edit rather than six.
 */

/**
 * The seven stages of a monthly close.
 *
 * RULE: every href here must land on a ONE-CLIENT tool. A monthly close is
 * work on a single client, so handing the bookkeeper a fleet dashboard is a
 * dead end — they have to find their client again in a list of 78, and
 * nothing they do there is scoped to the month they're closing. (Mike,
 * 2026-07-28: "Fleet tools don't belong ANYWHERE in monthly closes.")
 *
 * Several of these used to point at fleet pages or at client tabs that don't
 * exist (`?tab=duplicates`, `?tab=balance-sheet`, `?tab=messages` — the real
 * tab ids are `bs`, and there is no duplicates or messages tab), so the links
 * either dumped you on the wrong screen or silently opened Overview.
 */
export const MONTH_STAGES = [
  {
    key: "coa_confirmed_at",
    label: "Confirm COA",
    blurb: "Chart matches the current master COA",
    /** Some clients genuinely need no chart work in a given month. */
    skippable: true,
    // Per-client COA review/cleanup job — NOT /coa-audit, which is the fleet
    // drift dashboard and ignores ?client= entirely. `close=1` tells that page
    // we're here as step 1 of a monthly close, so it suppresses the
    // "already cleaned up — redo from scratch?" guard: re-confirming the chart
    // is the point of this step, not an accident to warn about.
    href: (clientId: string) => `/jobs/new?client=${clientId}&close=1`,
  },
  {
    key: "reclass_completed_at",
    label: "Transaction reclass",
    blurb: "The month's transactions categorized and pushed to QBO",
    skippable: false,
    href: (clientId: string, month: string) =>
      `/reclass/new?client=${clientId}&month=${month}&close=1`,
  },
  {
    key: "bank_rules_completed_at",
    label: "New bank rules",
    blurb: "Capture this month's vendor→account mappings as rules",
    skippable: true,
    href: (clientId: string) => `/rules/new?client=${clientId}`,
  },
  {
    key: "ask_client_at",
    label: "Ask client",
    blurb: "Send the client their open questions and get answers back",
    skippable: true,
    // The close flow opens the Ask-Client composer in place; this is the
    // fallback for surfaces that only have a link.
    href: (clientId: string) => `/clients/${clientId}`,
  },
  {
    key: "statements_requested_at",
    label: "BS / statement request",
    blurb: "Balance-sheet review and bank/CC statements requested",
    skippable: true,
    // Per-client balance-sheet workspace.
    href: (clientId: string) => `/balance-sheet/${clientId}`,
  },
  {
    key: "duplicates_checked_at",
    label: "Duplicates",
    blurb: "No duplicate transactions or invoices (incl. payroll double-counting)",
    skippable: false,
    // ?client= renders the single-client duplicate scan, not the fleet list.
    href: (clientId: string) => `/admin/duplicates?client=${clientId}`,
  },
  {
    key: "month_end_sent_at",
    label: "Send month-end",
    blurb: "Statements published and emailed with the notice to reader",
    skippable: false,
    // Opens THIS client's close card on the production board (?focus= deep
    // link) rather than the fleet month-end list.
    href: (clientId: string) => `/production?focus=${clientId}`,
  },
] as const;

export type MonthStageKey = (typeof MONTH_STAGES)[number]["key"];

export type MonthStatus =
  | "not_started"
  | "in_progress"
  | "waiting_client"
  | "ready_for_review"
  | "failed_review"
  | "complete";

export interface ClientMonth {
  id: string;
  client_link_id: string;
  /** First day of the month: "2026-06-01". */
  period_month: string;
  status: MonthStatus;
  assignee_id: string | null;
  reclass_job_id: string | null;
  coa_job_id: string | null;
  blocked_reason: string | null;
  notes: string | null;
  coa_confirmed_at: string | null;
  reclass_completed_at: string | null;
  bank_rules_completed_at: string | null;
  ask_client_at: string | null;
  statements_requested_at: string | null;
  duplicates_checked_at: string | null;
  month_end_sent_at: string | null;
  /** Stage keys deliberately not applicable this month. */
  skipped_stages: string[];
  /** Stage key → why it was skipped. */
  skip_reasons: Record<string, string>;
}

/** "2026-06-01" → "June 2026". Deliberately parsed as parts, not `new Date()`:
 *  a bare date string is treated as UTC midnight, which renders as the previous
 *  month for anyone west of Greenwich. */
export function formatMonth(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${names[(m || 1) - 1]} ${y}`;
}

/** "2026-06-01" → { start: "2026-06-01", end: "2026-06-30" }, for scoping a job. */
export function monthBounds(periodMonth: string): { start: string; end: string } {
  const [y, m] = periodMonth.split("-").map(Number);
  // Day 0 of the next month is the last day of this one, and it handles leap
  // years without a table.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay)}` };
}

/** The month a given date falls in, as a period_month string. */
export function periodMonthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** The month immediately before the one containing `date` — what you close on
 *  the 1st. Opening a bucket on 1 July means closing June. */
export function priorPeriodMonth(date: Date): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0-based, so this is already "previous month"
  return m === 0 ? `${y - 1}-12-01` : `${y}-${String(m).padStart(2, "0")}-01`;
}

export type StageState = "done" | "skipped" | "todo";

/** Three states, not two. "We checked the chart and it's fine" and "this client
 *  needs no chart work this month" are different facts, and collapsing them is
 *  how a checklist becomes theatre. */
export function stageState(row: Partial<ClientMonth> | null | undefined, key: string): StageState {
  if (!row) return "todo";
  if ((row as any)[key]) return "done";
  if ((row.skipped_stages || []).includes(key)) return "skipped";
  return "todo";
}

export interface MonthProgress {
  /** Stages actually completed. */
  done: number;
  /** Stages deliberately skipped — resolved, but not done. */
  skipped: number;
  /** done + skipped: how much no longer needs attention. */
  resolved: number;
  total: number;
  /** 0–100, based on RESOLVED, since a skip genuinely needs no more work. */
  pct: number;
  /** The first unresolved stage — what to do next. */
  nextStage: (typeof MONTH_STAGES)[number] | null;
  /** Every stage resolved: the month can close. */
  allResolved: boolean;
}

/**
 * Derive progress from the timestamps and the skip list.
 *
 * Counts RESOLVED stages rather than "position in the list": stages get done out
 * of order in practice (statements requested before bank rules are finished), and
 * a position-based bar would misreport what's left.
 */
export function monthProgress(row: Partial<ClientMonth> | null | undefined): MonthProgress {
  const total = MONTH_STAGES.length;
  if (!row) {
    return { done: 0, skipped: 0, resolved: 0, total, pct: 0, nextStage: MONTH_STAGES[0], allResolved: false };
  }

  let done = 0;
  let skipped = 0;
  let nextStage: (typeof MONTH_STAGES)[number] | null = null;
  for (const stage of MONTH_STAGES) {
    const st = stageState(row, stage.key);
    if (st === "done") done++;
    else if (st === "skipped") skipped++;
    else if (!nextStage) nextStage = stage;
  }
  const resolved = done + skipped;
  return {
    done,
    skipped,
    resolved,
    total,
    pct: Math.round((resolved / total) * 100),
    nextStage,
    allResolved: resolved === total,
  };
}

export function eligibleForMonthlyClose(client: {
  is_active?: boolean | null;
  cleanup_completed_at?: string | null;
  daily_recon_enabled?: boolean | null;
}): boolean {
  if (client.is_active === false) return false;
  return !!client.cleanup_completed_at || !!client.daily_recon_enabled;
}

/** Board lane for a row, honouring explicit human overrides over derived state.
 *  A month is only `complete` when every stage is actually stamped — the status
 *  column can't be used to declare victory early. */
export function effectiveStatus(row: Partial<ClientMonth>): MonthStatus {
  const { allResolved, resolved } = monthProgress(row);
  if (row.status === "waiting_client" || row.status === "failed_review") return row.status;
  if (allResolved) return "complete";
  if (row.status === "ready_for_review") return "ready_for_review";
  if (resolved > 0) return "in_progress";
  // A status of `complete` with unresolved stages is not honoured — the whole
  // point is that the checklist, not a dropdown, decides when a month is done.
  return row.status === "complete" ? "in_progress" : row.status || "not_started";
}
