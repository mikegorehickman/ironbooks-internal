/**
 * Unified client lifecycle status — collapses the three SNAP surfaces
 * (onboarding board, cleanup kanban, production board) into the single status
 * vocabulary the manager dashboard uses. Derived from existing client_links
 * flags + job state; no stored column.
 *
 * Vocabulary (matches what Lisa asked for on the manager dashboard):
 *   onboarding         — new sale, not yet in cleanup
 *   in_cleanup         — COA / reclass / BS cleanup work in flight
 *   ready_for_review   — cleanup submitted, awaiting manager approval
 *   waiting_on_client  — blocked waiting on the client (open ask / pending reply)
 *   in_production      — cleanup signed off + daily recon on (monthly cadence)
 *   completed          — cleanup signed off but NOT yet promoted to production
 *   done               — current month closed + statements sent
 */

export type LifecycleStatus =
  | "onboarding"
  | "in_cleanup"
  | "ready_for_review"
  | "waiting_on_client"
  | "in_production"
  | "completed"
  | "done";

export interface LifecycleInput {
  status?: string | null;                  // client_links.status (onboarding/active/…)
  qbo_connected?: boolean | null;
  cleanup_completed_at?: string | null;
  cleanup_review_state?: string | null;     // 'in_review' when submitted
  daily_recon_enabled?: boolean | null;
  bs_cleanup_skipped_at?: string | null;
  has_active_job?: boolean | null;          // any coa/reclass job in flight
  open_ask_client?: boolean | null;         // unanswered ask-client / pending reply
  month_done?: boolean | null;              // current monthly_rec_run complete
}

export const LIFECYCLE_META: Record<LifecycleStatus, { label: string; tone: string; order: number }> = {
  onboarding:        { label: "Onboarding",          tone: "bg-slate-100 text-slate-700",     order: 0 },
  in_cleanup:        { label: "In cleanup",           tone: "bg-blue-50 text-blue-700",        order: 1 },
  waiting_on_client: { label: "Waiting on client",    tone: "bg-amber-50 text-amber-700",      order: 2 },
  ready_for_review:  { label: "Ready for review",     tone: "bg-violet-50 text-violet-700",    order: 3 },
  completed:         { label: "Completed",            tone: "bg-emerald-50 text-emerald-700",  order: 4 },
  in_production:     { label: "In production",         tone: "bg-teal/10 text-teal",            order: 5 },
  done:              { label: "Done",                  tone: "bg-emerald-100 text-emerald-800", order: 6 },
};

/**
 * Derive the single lifecycle status. Order of checks is the priority — the
 * furthest-along / most-actionable state wins.
 */
export function deriveLifecycleStatus(c: LifecycleInput): LifecycleStatus {
  // Production cadence: signed off + daily recon on.
  if (c.daily_recon_enabled && c.cleanup_completed_at) {
    return c.month_done ? "done" : "in_production";
  }
  // Cleanup signed off but not promoted to production.
  if (c.cleanup_completed_at) return "completed";
  // Submitted for manager approval.
  if (c.cleanup_review_state === "in_review") return "ready_for_review";
  // Blocked on the client.
  if (c.open_ask_client) return "waiting_on_client";
  // New sale not yet in cleanup.
  if (c.status === "onboarding" && !c.has_active_job && !c.qbo_connected) return "onboarding";
  // Default working state.
  return "in_cleanup";
}

/**
 * Whether the client still owes a balance-sheet cleanup. False once a manager
 * has skipped it (bypass) — used to drop them from the BS kanban column.
 */
export function needsBsCleanup(c: { bs_cleanup_skipped_at?: string | null }): boolean {
  return !c.bs_cleanup_skipped_at;
}
