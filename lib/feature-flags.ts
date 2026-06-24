/**
 * Feature flags for the SNAP V2 site-simplification rollout.
 *
 * V2 collapses ~23 sidebar destinations into Home / Workflow / Clients /
 * Oversight / Admin and archives unused tools. It ships DARK: off for
 * everyone by default, so V1 stays the safe fallback and rollback is a flag
 * flip. Turn it on per-user (the email allowlist below) for testing, or
 * fleet-wide via the NEXT_PUBLIC_SNAP_V2 env var.
 *
 * NOTE: client-safe — only reads NEXT_PUBLIC_* env + the passed-in email.
 * Later this can be backed by a `users.ui_v2` column without changing callers.
 */

/** Emails that see V2 regardless of the env flag (testing cohort). */
const V2_EMAILS = new Set<string>(["mike@paintergrowth.com"]);

export function isV2For(email?: string | null): boolean {
  if (process.env.NEXT_PUBLIC_SNAP_V2 === "true") return true;
  if (email && V2_EMAILS.has(email.trim().toLowerCase())) return true;
  return false;
}

/**
 * Tools archived in V2 (usage-driven prune — see the plan). The routes still
 * exist and their data is untouched; they're dropped from nav and, when V2 is
 * on, gated behind an "archived" notice (enforced in Phase 1). Matched by
 * prefix so per-client variants (e.g. /balance-sheet/<id>/uf-audit) are covered
 * via `isArchivedRoute`.
 */
export const ARCHIVED_TOOL_PATTERNS: string[] = [
  "uf-audit", // /balance-sheet/uf-audit + /balance-sheet/[id]/uf-audit
  "uf-ai",
  "uf-ar",
  "ar-recovery",
  "uncat-income-recovery",
  "hardcore-cleanup",
  "/tax-audit",
  "/month-end",
  "/support",
];

/** True if a pathname belongs to an archived tool (substring match on patterns). */
export function isArchivedRoute(pathname: string): boolean {
  return ARCHIVED_TOOL_PATTERNS.some((p) => pathname.includes(p));
}
