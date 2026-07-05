/**
 * Unified client lifecycle status — collapses the three SNAP surfaces
 * (onboarding board, cleanup kanban, production board) into one status the
 * manager dashboard uses. Derived entirely from existing flags + job state —
 * including bs_enabled (migration 66) for BS-deferral. No new columns.
 *
 * Mirrors the real SNAP phases so "In cleanup" isn't an opaque bucket — a
 * manager can see exactly where each client sits.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { previousMonthPeriod } from "./monthly-rec";

export type LifecycleStatus =
  | "onboarding"        // new sale, not yet connected / no cleanup work
  | "needs_cleanup"     // connected, cleanup not started
  | "coa_cleanup"       // COA cleanup in flight
  | "reclassify"        // reclassification in flight (or COA done, reclass not started)
  | "bs_cleanup"        // reclass done, balance-sheet cleanup outstanding
  | "manual_cleanup"    // flagged: needs manual fixes in QBO before sign-off
  | "ready_to_close"    // pipeline done (BS skipped/finished), not yet submitted for review
  | "ready_for_review"  // cleanup submitted, awaiting manager approval (cleanup_review_state='in_review')
  | "waiting_on_client" // blocked waiting on the client
  | "completed"         // cleanup signed off, not yet promoted to production
  | "in_production"     // signed off + daily recon on
  | "done";             // current month closed + statements sent

export interface LifecycleInput {
  status?: string | null;
  qbo_connected?: boolean | null;
  cleanup_completed_at?: string | null;
  cleanup_review_state?: string | null;     // 'in_review' when submitted
  manual_cleanup_needed?: boolean | null;    // flagged: needs manual fixes in QBO
  daily_recon_enabled?: boolean | null;
  /** BS cleanup deferred (client_links.bs_enabled === false / P&L-only). */
  bs_deferred?: boolean | null;
  has_active_coa?: boolean | null;
  has_active_reclass?: boolean | null;
  has_complete_coa?: boolean | null;
  has_complete_reclass?: boolean | null;
  open_ask_client?: boolean | null;
  month_done?: boolean | null;            // current monthly_rec_run complete (sent)
  month_review?: boolean | null;          // current run pending manager review
  month_waiting_client?: boolean | null;  // current run board_status = waiting_client
}

export const LIFECYCLE_META: Record<LifecycleStatus, { label: string; tone: string; order: number; group: "Pipeline" | "Review" | "Live" }> = {
  onboarding:        { label: "Onboarding",        tone: "bg-slate-100 text-slate-600",     order: 0,  group: "Pipeline" },
  needs_cleanup:     { label: "Needs cleanup",     tone: "bg-slate-100 text-slate-700",     order: 1,  group: "Pipeline" },
  coa_cleanup:       { label: "COA cleanup",       tone: "bg-blue-50 text-blue-700",        order: 2,  group: "Pipeline" },
  reclassify:        { label: "Reclassify",        tone: "bg-indigo-50 text-indigo-700",    order: 3,  group: "Pipeline" },
  bs_cleanup:        { label: "BS cleanup",        tone: "bg-cyan-50 text-cyan-700",        order: 4,  group: "Pipeline" },
  manual_cleanup:    { label: "Manual cleanup (QBO)", tone: "bg-orange-50 text-orange-700", order: 5,  group: "Pipeline" },
  ready_to_close:    { label: "Ready to close",    tone: "bg-fuchsia-50 text-fuchsia-700",  order: 6,  group: "Review" },
  waiting_on_client: { label: "Waiting on client", tone: "bg-amber-50 text-amber-700",      order: 7,  group: "Review" },
  ready_for_review:  { label: "Ready for review",  tone: "bg-violet-50 text-violet-700",    order: 8,  group: "Review" },
  completed:         { label: "Completed",         tone: "bg-emerald-50 text-emerald-700",  order: 9,  group: "Live" },
  in_production:     { label: "In production",     tone: "bg-teal/10 text-teal",            order: 10, group: "Live" },
  done:              { label: "Done",              tone: "bg-emerald-100 text-emerald-800", order: 11, group: "Live" },
};

/**
 * Derive the single lifecycle status. "Ready for review" / "waiting on client"
 * take precedence over raw pipeline position because they're the manager's
 * actionable states; otherwise the furthest-along pipeline phase wins.
 */
export function deriveLifecycleStatus(c: LifecycleInput): LifecycleStatus {
  // ── Live states (production) — reflect the month-end board for the period ──
  if (c.daily_recon_enabled && c.cleanup_completed_at) {
    if (c.month_done) return "done";
    if (c.month_review) return "ready_for_review";
    if (c.month_waiting_client) return "waiting_on_client";
    return "in_production";
  }
  if (c.cleanup_completed_at) return "completed";

  // ── Manager-actionable ──
  if (c.cleanup_review_state === "in_review") return "ready_for_review";
  if (c.open_ask_client) return "waiting_on_client";
  // Flagged for manual QBO work — blocking hand-work before sign-off, so it
  // surfaces as its own stage rather than hiding in a pipeline phase.
  if (c.manual_cleanup_needed) return "manual_cleanup";

  // ── Pipeline (cleanup phases), furthest-along first ──
  if (c.has_active_reclass) return "reclassify";
  if (c.has_complete_reclass) {
    // Reclass done → still in the BS-cleanup queue unless BS was DEFERRED
    // (bs_enabled=false / P&L-only). Deferred ⇒ pre-production pipeline is
    // finished, awaiting sign-off ('ready_to_close'); the "BS owed" badge
    // rides alongside (orthogonal — driven by bs_enabled === false).
    return c.bs_deferred ? "ready_to_close" : "bs_cleanup";
  }
  if (c.has_active_coa) return "coa_cleanup";
  if (c.has_complete_coa) return "reclassify"; // COA done, reclass not started
  if (c.status === "onboarding" && !c.qbo_connected) return "onboarding";
  return "needs_cleanup";
}

const ACTIVE_JOB_STATUSES = ["pending", "executing", "in_review", "failed"];

/**
 * Derive the lifecycle status for ONE client (profile header, etc.). Mirrors the
 * batch derivation in app/clients/page.tsx but self-contained. Best-effort —
 * each signal query is guarded so a missing table never breaks the caller.
 * Pass the already-loaded client_links row; only job/month/message signals are
 * fetched here.
 */
export async function deriveLifecycleForClient(
  service: SupabaseClient,
  client: {
    id: string;
    status?: string | null;
    qbo_realm_id?: string | null;
    cleanup_completed_at?: string | null;
    cleanup_review_state?: string | null;
    daily_recon_enabled?: boolean | null;
    bs_enabled?: boolean | null;
  }
): Promise<LifecycleStatus> {
  const id = client.id;
  const jobRows = async (table: string): Promise<{ status: string }[]> => {
    try {
      const { data } = await (service as any).from(table).select("status").eq("client_link_id", id);
      return (data as { status: string }[]) || [];
    } catch {
      return [];
    }
  };
  const [coa, reclass] = await Promise.all([jobRows("coa_jobs"), jobRows("reclass_jobs")]);
  const anyActive = (rows: { status: string }[]) => rows.some((r) => ACTIVE_JOB_STATUSES.includes(r.status));
  const anyComplete = (rows: { status: string }[]) => rows.some((r) => r.status === "complete");

  let month_done = false;
  let month_review = false;
  let month_waiting = false;
  if (client.daily_recon_enabled && client.cleanup_completed_at) {
    try {
      const { data } = await (service as any)
        .from("monthly_rec_runs")
        .select("status, board_status")
        .eq("client_link_id", id)
        .eq("kind", "production_me")
        .eq("period", previousMonthPeriod().period)
        .maybeSingle();
      if ((data as any)?.status === "complete") month_done = true;
      else if ((data as any)?.status === "pending_review") month_review = true;
      else if ((data as any)?.board_status === "waiting_client") month_waiting = true;
    } catch {
      /* pre-migration env */
    }
  }

  let open_ask_client = false;
  try {
    const { count } = await (service as any)
      .from("client_communications")
      .select("id", { count: "exact", head: true })
      .eq("client_link_id", id)
      .eq("direction", "from_client")
      .is("read_at", null);
    open_ask_client = (count || 0) > 0;
  } catch {
    /* ignore */
  }

  return deriveLifecycleStatus({
    status: client.status,
    qbo_connected: !!client.qbo_realm_id,
    cleanup_completed_at: client.cleanup_completed_at,
    cleanup_review_state: client.cleanup_review_state,
    daily_recon_enabled: client.daily_recon_enabled,
    bs_deferred: client.bs_enabled === false,
    has_active_coa: anyActive(coa),
    has_active_reclass: anyActive(reclass),
    has_complete_coa: anyComplete(coa),
    has_complete_reclass: anyComplete(reclass),
    open_ask_client,
    month_done,
    month_review,
    month_waiting_client: month_waiting,
  });
}
