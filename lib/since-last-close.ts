/**
 * The "since last close" date window, shared by the COA-cleanup and reclass
 * setup forms.
 *
 * Both pages need the identical rule and had it copy-pasted, which is how two
 * copies of subtle month-boundary logic quietly drift apart. One place, one
 * behaviour, directly testable.
 *
 * The rule: start the day AFTER the last delivered close (never re-scope a
 * period already sent), and end at the last COMPLETE month. You close finished
 * months — running to "today" drags in a part-month nobody is closing, which
 * gets AI-classified now and re-touched by next month's close.
 *
 * When no whole month has elapsed since the close there's nothing closeable
 * yet, so we fall back to today and say so in the label; the bookkeeper can
 * still categorize the month in progress.
 */

export interface SinceCloseWindow {
  start: string;
  end: string;
  /** No complete month since the close — this is the month in progress. */
  partial: boolean;
  label: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar date as YYYY-MM-DD. NOT toISOString(), which is UTC and
 *  reads as "tomorrow" for anyone east of Greenwich late in the day. */
export function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * @param lastCloseEnd  end date of the last delivered close (YYYY-MM-DD)
 * @param source        "monthly_rec_run" | "cleanup_range" — drives the label
 * @param now           injectable for tests
 * @returns the window, or null when there's nothing to offer
 */
export function sinceLastCloseWindow(
  lastCloseEnd: string | null | undefined,
  source?: string | null,
  now: Date = new Date()
): SinceCloseWindow | null {
  if (!lastCloseEnd || !ISO_DATE.test(lastCloseEnd)) return null;

  // Day after the close. Parsed as UTC so the arithmetic can't be shifted by
  // the viewer's timezone; only the *comparison* against today is local.
  const next = new Date(`${lastCloseEnd}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const start = next.toISOString().slice(0, 10);

  const today = localDateString(now);
  // Day 0 of the current month = last day of the previous month.
  const lastFullMonthEnd = localDateString(
    new Date(now.getFullYear(), now.getMonth(), 0)
  );

  const partial = lastFullMonthEnd < start;
  const end = partial ? today : lastFullMonthEnd;
  if (start > end) return null; // closed through today — nothing to offer

  const base = source === "cleanup_range" ? "Since cleanup finished" : "Since last close";
  return {
    start,
    end,
    partial,
    label: partial ? `${base} (month in progress)` : base,
  };
}
