/**
 * Turning a manager's reject note into a fix-list.
 *
 * WHY THIS EXISTS. Both Failed Review panels (production and cleanup) show the
 * manager's note as a checklist the bookkeeper ticks off, and Resend unlocks
 * only when every item is ticked. That mechanism is only as good as the split.
 *
 * The original split was `/\n+|;\s+/` — newlines and semicolons. Kedma's actual
 * notes, pulled from monthly_rec_runs on 2026-08-06, contain neither:
 *
 *   "Cash Income needs to be reviewed and reconciled. Concern that technician
 *    is not categorized in COGS. Please verify wages under expenses."
 *
 * That is three separate asks, and it rendered as ONE checkbox — so ticking it
 * asserted all three were done. Rather than ask the managers to change how they
 * write, split on sentence boundaries too.
 *
 * Deliberately conservative about what counts as a boundary: a period followed
 * by whitespace and a capital or a digit. That keeps "$26k", "1.5", "w/Maddie"
 * and "WA state taxes" intact (verified in the tests), and it does NOT try to
 * handle abbreviations like "Dr." — a stray extra checkbox costs one click,
 * whereas a missed boundary silently bundles two fixes into one.
 *
 * Pure and dependency-free.
 */

/** Bullets, dashes, and "1)" / "2." list markers a manager might type. */
const LEADING_MARKER = /^[-•*•\s]*(?:\d+[.)])?\s*/;

export function splitReviewNote(note: string | null | undefined): string[] {
  const raw = (note || "").trim();
  if (!raw) return [];
  return (
    raw
      // Explicit separators first — a manager who DID use them meant them.
      .split(/\n+|;\s+/)
      // Then sentence boundaries inside each chunk. The lookahead keeps the
      // capital/digit with the sentence it starts.
      .flatMap((chunk) => chunk.split(/(?<=\.)\s+(?=[A-Z0-9$])/))
      .map((line) => line.replace(LEADING_MARKER, "").trim())
      // Two characters or fewer is punctuation debris, not a fix.
      .filter((line) => line.length > 2)
  );
}
