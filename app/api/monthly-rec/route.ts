import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { previousMonthPeriod } from "@/lib/monthly-rec";

export const dynamic = "force-dynamic";

/**
 * GET /api/monthly-rec?period=YYYY-MM&scope=production|signoffs
 *
 * scope=production (the /production board) skips the cleanup-signoff scan;
 * scope=signoffs (the /cleanup board) skips period runs + the bookkeeper
 * list. No scope = full payload (back-compat).
 *
 * The Monthly Rec roster:
 *   production: clients on daily recon (promoted to production) + their
 *               run status for the requested period
 *   eligible:   clients with a completed cleanup who HAVEN'T been promoted
 *               yet — shown with a "promote" affordance (admin/lead)
 *
 * Bookkeepers see their assigned clients; admin/lead see everyone.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper", "viewer"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const isSenior = ["admin", "lead"].includes(role);

  const url = new URL(request.url);
  const period = url.searchParams.get("period") || previousMonthPeriod().period;
  const scope = url.searchParams.get("scope"); // "production" | "signoffs" | null

  let clientsQ = service
    .from("client_links")
    .select("*")
    .eq("is_active", true);
  if (!isSenior) clientsQ = clientsQ.eq("assigned_bookkeeper_id", user.id);
  const { data: clients } = await clientsQ.order("client_name");
  const all = (clients as any[]) || [];

  const production = all.filter((c) => c.daily_recon_enabled);
  const eligible = all.filter(
    (c) => !c.daily_recon_enabled && c.cleanup_completed_at
  );

  const RUN_COLS =
    "client_link_id, period, kind, status, has_concerns, concerns, checks, checks_ran_at, completed_at, sent_to_client_at, email_delivery, ai_spot_check, submitted_by, submitted_at, board_status, waiting_reasons, status_note, verification, verification_score, verification_ran_at, verification_override, manager_reviewed_at, manager_review_override";

  // Named-column selects 400 when a column's migration hasn't been applied
  // yet — and supabase-js doesn't throw, it returns {error} with null data,
  // which silently blanked the whole production board to "Not started" when
  // migration 113 was pending (2026-07-10; same class as the migration-21
  // stripe picker incident). Fall back to * so a pending migration degrades
  // to missing NEW fields, never missing ROWS.
  const selectRuns = async (build: (q: any) => any): Promise<any[]> => {
    const named = await build((service as any).from("monthly_rec_runs").select(RUN_COLS));
    if (!named.error) return (named.data as any[]) || [];
    console.warn("[monthly-rec] named-column select failed (pending migration?) — falling back to *:", named.error.message);
    const star = await build((service as any).from("monthly_rec_runs").select("*"));
    return ((star.data as any[]) || []);
  };

  // Run rows for the period (table may predate migration 62 in some envs)
  let runsByClient = new Map<string, any>();
  // Cleanup sign-offs awaiting review/send — any period, scoped like the
  // roster. These are the 'cleanup complete' gates.
  let cleanupSignoffs: any[] = [];
  try {
    const ids = scope === "signoffs" ? [] : production.map((c) => c.id);
    if (ids.length > 0) {
      // Don't filter kind='production_me' — (client, period) is unique in
      // monthly_rec_runs, so a cleanup-graduation month is a kind='cleanup'
      // row that still represents this period's real close/waiting/review
      // state. Over-filtering left graduated clients showing "Not started"
      // on the board even after their first month was delivered.
      const runs = await selectRuns((q: any) =>
        q.eq("period", period).in("client_link_id", ids)
      );
      runsByClient = new Map(runs.map((r) => [r.client_link_id, r]));
    }

    const allIds = scope === "production" ? [] : all.map((c) => c.id);
    if (allIds.length > 0) {
      const signoffs = await selectRuns((q: any) =>
        q.eq("kind", "cleanup").neq("status", "complete").in("client_link_id", allIds)
      );
      const byId = new Map(all.map((c) => [c.id, c]));
      cleanupSignoffs = ((signoffs as any[]) || []).map((r) => {
        const c = byId.get(r.client_link_id);
        return {
          id: r.client_link_id,
          client_name: (c as any)?.client_name || "Unknown",
          contact_name:
            [(c as any)?.contact_first_name, (c as any)?.contact_last_name].filter(Boolean).join(" ") || null,
          paused: false,
          run: r,
        };
      });
    }
  } catch {
    /* pre-migration env — every client shows "not started" */
  }

  // Assignable bookkeepers for the board's per-client assign dropdown.
  // Senior-only (only admin/lead can reassign — matches /api/clients/[id]/assign).
  let bookkeepers: Array<{ id: string; full_name: string }> = [];
  if (isSenior && scope !== "signoffs") {
    const { data: bks } = await service
      .from("users")
      .select("id, full_name")
      .in("role", ["admin", "lead", "bookkeeper"])
      .eq("is_active", true)
      .order("full_name");
    bookkeepers = ((bks as any[]) || []).map((u) => ({ id: u.id, full_name: u.full_name }));
  }

  return NextResponse.json({
    cleanup_signoffs: cleanupSignoffs,
    period,
    is_senior: isSenior,
    bookkeepers,
    production: production.map((c) => ({
      id: c.id,
      client_name: c.client_name,
      urgent: !!(c as any).urgent_flag,
      urgent_note: (c as any).urgent_flag_note || null,
      contact_name: [c.contact_first_name, c.contact_last_name].filter(Boolean).join(" ") || null,
      paused: !!c.daily_recon_paused,
      bs_enabled: c.bs_enabled !== false,
      assigned_bookkeeper_id: c.assigned_bookkeeper_id ?? null,
      run: runsByClient.get(c.id) || null,
    })),
    eligible: eligible.map((c) => ({
      id: c.id,
      client_name: c.client_name,
      cleanup_completed_at: c.cleanup_completed_at,
    })),
  });
}
