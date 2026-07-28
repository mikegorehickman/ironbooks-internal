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

export const MONTH_STAGES = [
  {
    key: "coa_confirmed_at",
    label: "COA confirmed",
    blurb: "Chart matches the current master COA",
    href: (clientId: string) => `/coa-audit?client=${clientId}`,
  },
  {
    key: "reclass_completed_at",
    label: "Reclass",
    blurb: "Month's transactions categorized and pushed",
    href: (clientId: string, month: string) => `/reclass/new?client=${clientId}&month=${month}`,
  },
  {
    key: "bank_rules_completed_at",
    label: "Bank rules",
    blurb: "New vendor→account rules captured from this month",
    href: (clientId: string) => `/rules/new?client=${clientId}`,
  },
  {
    key: "uf_ar_completed_at",
    label: "UF / A-R",
    blurb: "Undeposited funds cleared, A/R reconciled, statements requested",
    href: (clientId: string) => `/clients/${clientId}?tab=ar`,
  },
  {
    key: "payroll_dup_checked_at",
    label: "Payroll dupes",
    blurb: "No gross-plus-net double counting",
    href: (clientId: string) => `/admin/payroll-double-scan?client=${clientId}`,
  },
  {
    key: "txn_dup_checked_at",
    label: "Txn dupes",
    blurb: "No duplicate expenses or revenue",
    href: (clientId: string) => `/clients/${clientId}?tab=duplicates`,
  },
  {
    key: "closed_at",
    label: "Closed",
    blurb: "Books closed for the month",
    href: (clientId: string) => `/month-end?client=${clientId}`,
  },
  {
    key: "statements_sent_at",
    label: "Statements sent",
    blurb: "Published to the portal and emailed, with the notice to reader",
    href: (clientId: string) => `/month-end?client=${clientId}`,
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
  uf_ar_completed_at: string | null;
  statements_requested_at: string | null;
  payroll_dup_checked_at: string | null;
  txn_dup_checked_at: string | null;
  closed_at: string | null;
  statements_sent_at: string | null;
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

export interface MonthProgress {
  done: number;
  total: number;
  /** 0–100, for a bar. */
  pct: number;
  /** The first incomplete stage — what the bookkeeper should do next. */
  nextStage: (typeof MONTH_STAGES)[number] | null;
  /** True when every stage carries a timestamp. */
  allDone: boolean;
}

/**
 * Derive progress from the timestamps.
 *
 * Note it counts COMPLETED stages rather than "position in the list": stages get
 * done out of order in practice (a bookkeeper may clear UF before finishing bank
 * rules), and a position-based bar would lie about how much is left.
 */
export function monthProgress(row: Partial<ClientMonth> | null | undefined): MonthProgress {
  const total = MONTH_STAGES.length;
  if (!row) return { done: 0, total, pct: 0, nextStage: MONTH_STAGES[0], allDone: false };

  let done = 0;
  let nextStage: (typeof MONTH_STAGES)[number] | null = null;
  for (const stage of MONTH_STAGES) {
    if ((row as any)[stage.key]) done++;
    else if (!nextStage) nextStage = stage;
  }
  return {
    done,
    total,
    pct: Math.round((done / total) * 100),
    nextStage,
    allDone: done === total,
  };
}

/**
 * Is this client eligible to have months opened at all?
 *
 * Mirrors "a client whose books we actually run": active, and either signed off
 * on cleanup or on the daily engine. An onboarding client has no month to close
 * yet, and opening empty buckets for them just pads the board.
 */
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
  const { allDone, done } = monthProgress(row);
  if (row.status === "waiting_client" || row.status === "failed_review") return row.status;
  if (allDone) return "complete";
  if (row.status === "ready_for_review") return "ready_for_review";
  if (done > 0) return "in_progress";
  return row.status === "complete" ? "in_progress" : row.status || "not_started";
}
