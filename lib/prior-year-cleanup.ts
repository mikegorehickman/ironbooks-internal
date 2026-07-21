/**
 * Prior-year cleanup — who needs their books cleaned back to their last filed
 * tax year, how many catch-up years that is, and the tracking/comms workflow.
 *
 * Doctrine (from the JP methodology work): a client's books must be clean for
 * every year AFTER the last year they filed taxes (their last closed year).
 * The current working year is the standard engagement; any earlier unfiled
 * years are a BILLABLE catch-up we have to see, track, and quote.
 *
 * The "needs it" signal is derived from py_taxes_filed_through_year; the manual
 * workflow (flagged → quoted → notified → done) is persisted in
 * client_links.prior_year_cleanup (migration 139).
 */

export type PriorYearStatus =
  | "flagged"
  | "quoted"
  | "notified"
  | "approved"
  | "in_progress"
  | "done"
  | "not_needed";

export interface PriorYearTracking {
  status?: PriorYearStatus;
  years?: number[];
  note?: string;
  notified_at?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
}

export interface PriorYearAssessmentInput {
  py_taxes_filed?: boolean | null;
  py_taxes_filed_through_year?: number | null;
  prior_year_cleanup?: any;
}

export interface PriorYearAssessment {
  /** null when we can't tell yet (no last-filed-year captured). */
  lastFiledYear: number | null;
  /** Catch-up years owed: (lastFiled+1) … (currentYear-1). Empty if up to date. */
  yearsNeeded: number[];
  /** Years beyond the most recent prior year — the clearly EXTRA billable ones. */
  billableExtraYears: number[];
  needsPriorYear: boolean;
  /** True when we lack the data to assess (prompt to capture last-filed year). */
  unknown: boolean;
  tracking: PriorYearTracking;
}

export function readPriorYearTracking(row: { prior_year_cleanup?: any } | null | undefined): PriorYearTracking {
  const t = (row?.prior_year_cleanup || {}) as PriorYearTracking;
  return {
    status: t.status,
    years: Array.isArray(t.years) ? t.years : undefined,
    note: typeof t.note === "string" ? t.note : undefined,
    notified_at: t.notified_at ?? null,
    updated_at: t.updated_at ?? null,
    updated_by: t.updated_by ?? null,
  };
}

/**
 * Assess a client's prior-year cleanup need. `currentYear` is passed in (the
 * caller stamps it) so this stays pure/testable.
 */
export function assessPriorYear(
  input: PriorYearAssessmentInput,
  currentYear: number
): PriorYearAssessment {
  const tracking = readPriorYearTracking(input);

  // Manual "not needed" wins — the manager cleared it.
  if (tracking.status === "not_needed") {
    return { lastFiledYear: input.py_taxes_filed_through_year ?? null, yearsNeeded: [], billableExtraYears: [], needsPriorYear: false, unknown: false, tracking };
  }

  const lastFiled =
    input.py_taxes_filed && typeof input.py_taxes_filed_through_year === "number"
      ? input.py_taxes_filed_through_year
      : typeof input.py_taxes_filed_through_year === "number"
      ? input.py_taxes_filed_through_year
      : null;

  if (lastFiled == null) {
    // Can't derive — but a manual flag still counts as "needs attention".
    const flagged = !!tracking.status && tracking.status !== "done";
    return {
      lastFiledYear: null,
      yearsNeeded: tracking.years || [],
      billableExtraYears: [],
      needsPriorYear: flagged,
      unknown: true,
      tracking,
    };
  }

  // Complete prior years not yet filed: (lastFiled+1) … (currentYear-1).
  const yearsNeeded: number[] = [];
  for (let y = lastFiled + 1; y <= currentYear - 1; y++) yearsNeeded.push(y);

  // The most recent prior year is the "normal" catch-up; anything older is the
  // clearly-extra billable scope.
  const billableExtraYears = yearsNeeded.length > 1 ? yearsNeeded.slice(0, -1) : [];

  const needsPriorYear = tracking.status === "done" ? false : yearsNeeded.length > 0;

  return { lastFiledYear: lastFiled, yearsNeeded, billableExtraYears, needsPriorYear, unknown: false, tracking };
}

export const PRIOR_YEAR_STATUS_META: Record<PriorYearStatus, { label: string; cls: string }> = {
  flagged:     { label: "Flagged",      cls: "bg-amber-50 text-amber-700" },
  quoted:      { label: "Quoted",       cls: "bg-blue-50 text-blue-700" },
  notified:    { label: "Client told",  cls: "bg-indigo-50 text-indigo-700" },
  approved:    { label: "Approved",     cls: "bg-teal-light/60 text-teal" },
  in_progress: { label: "In progress",  cls: "bg-cyan-50 text-cyan-700" },
  done:        { label: "Done",         cls: "bg-emerald-50 text-emerald-700" },
  not_needed:  { label: "Not needed",   cls: "bg-gray-100 text-gray-600" },
};
