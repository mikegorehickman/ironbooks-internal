/**
 * Unified client lifecycle status — collapses the three SNAP surfaces
 * (onboarding board, cleanup kanban, production board) into one status the
 * manager dashboard uses. Derived from existing flags + job state; the only
 * stored input is bs_cleanup_skipped_at (migration 76).
 *
 * Mirrors the real SNAP phases so "In cleanup" isn't an opaque bucket — a
 * manager can see exactly where each client sits.
 */

export type LifecycleStatus =
  | "onboarding"        // new sale, not yet connected / no cleanup work
  | "needs_cleanup"     // connected, cleanup not started
  | "coa_cleanup"       // COA cleanup in flight
  | "reclassify"        // reclassification in flight (or COA done, reclass not started)
  | "bs_cleanup"        // reclass done, balance-sheet cleanup outstanding
  | "ready_for_review"  // cleanup submitted, awaiting manager approval
  | "waiting_on_client" // blocked waiting on the client
  | "completed"         // cleanup signed off, not yet promoted to production
  | "in_production"     // signed off + daily recon on
  | "done";             // current month closed + statements sent

export interface LifecycleInput {
  status?: string | null;
  qbo_connected?: boolean | null;
  cleanup_completed_at?: string | null;
  cleanup_review_state?: string | null;     // 'in_review' when submitted
  daily_recon_enabled?: boolean | null;
  bs_cleanup_skipped_at?: string | null;
  has_active_coa?: boolean | null;
  has_active_reclass?: boolean | null;
  has_complete_coa?: boolean | null;
  has_complete_reclass?: boolean | null;
  open_ask_client?: boolean | null;
  month_done?: boolean | null;
}

export const LIFECYCLE_META: Record<LifecycleStatus, { label: string; tone: string; order: number; group: "Pipeline" | "Review" | "Live" }> = {
  onboarding:        { label: "Onboarding",        tone: "bg-slate-100 text-slate-600",     order: 0,  group: "Pipeline" },
  needs_cleanup:     { label: "Needs cleanup",     tone: "bg-slate-100 text-slate-700",     order: 1,  group: "Pipeline" },
  coa_cleanup:       { label: "COA cleanup",       tone: "bg-blue-50 text-blue-700",        order: 2,  group: "Pipeline" },
  reclassify:        { label: "Reclassify",        tone: "bg-indigo-50 text-indigo-700",    order: 3,  group: "Pipeline" },
  bs_cleanup:        { label: "BS cleanup",        tone: "bg-cyan-50 text-cyan-700",        order: 4,  group: "Pipeline" },
  waiting_on_client: { label: "Waiting on client", tone: "bg-amber-50 text-amber-700",      order: 5,  group: "Review" },
  ready_for_review:  { label: "Ready for review",  tone: "bg-violet-50 text-violet-700",    order: 6,  group: "Review" },
  completed:         { label: "Completed",         tone: "bg-emerald-50 text-emerald-700",  order: 7,  group: "Live" },
  in_production:     { label: "In production",     tone: "bg-teal/10 text-teal",            order: 8,  group: "Live" },
  done:              { label: "Done",              tone: "bg-emerald-100 text-emerald-800", order: 9,  group: "Live" },
};

/**
 * Derive the single lifecycle status. "Ready for review" / "waiting on client"
 * take precedence over raw pipeline position because they're the manager's
 * actionable states; otherwise the furthest-along pipeline phase wins.
 */
export function deriveLifecycleStatus(c: LifecycleInput): LifecycleStatus {
  // ── Live states ──
  if (c.daily_recon_enabled && c.cleanup_completed_at) {
    return c.month_done ? "done" : "in_production";
  }
  if (c.cleanup_completed_at) return "completed";

  // ── Manager-actionable ──
  if (c.cleanup_review_state === "in_review") return "ready_for_review";
  if (c.open_ask_client) return "waiting_on_client";

  // ── Pipeline (cleanup phases), furthest-along first ──
  if (c.has_active_reclass) return "reclassify";
  if (c.has_complete_reclass) {
    return c.bs_cleanup_skipped_at ? "ready_for_review" : "bs_cleanup";
  }
  if (c.has_active_coa) return "coa_cleanup";
  if (c.has_complete_coa) return "reclassify"; // COA done, reclass not started
  if (c.status === "onboarding" && !c.qbo_connected) return "onboarding";
  return "needs_cleanup";
}

/** Whether the client still owes a balance-sheet cleanup (false once skipped). */
export function needsBsCleanup(c: { bs_cleanup_skipped_at?: string | null }): boolean {
  return !c.bs_cleanup_skipped_at;
}
