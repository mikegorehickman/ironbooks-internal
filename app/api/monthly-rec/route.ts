import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { previousMonthPeriod } from "@/lib/monthly-rec";

export const dynamic = "force-dynamic";

/**
 * GET /api/monthly-rec?period=YYYY-MM
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
    "client_link_id, period, kind, status, has_concerns, concerns, checks, checks_ran_at, completed_at, sent_to_client_at, email_delivery, ai_spot_check, submitted_by, submitted_at, board_status, waiting_reasons, status_note, verification, verification_score, verification_ran_at, verification_override";

  // Run rows for the period (table may predate migration 62 in some envs)
  let runsByClient = new Map<string, any>();
  // Cleanup sign-offs awaiting review/send — any period, scoped like the
  // roster. These are the 'cleanup complete' gates.
  let cleanupSignoffs: any[] = [];
  try {
    const ids = production.map((c) => c.id);
    if (ids.length > 0) {
      const { data: runs } = await (service as any)
        .from("monthly_rec_runs")
        .select(RUN_COLS)
        .eq("period", period)
        .eq("kind", "production_me")
        .in("client_link_id", ids);
      runsByClient = new Map(((runs as any[]) || []).map((r) => [r.client_link_id, r]));
    }

    const allIds = all.map((c) => c.id);
    if (allIds.length > 0) {
      const { data: signoffs } = await (service as any)
        .from("monthly_rec_runs")
        .select(RUN_COLS)
        .eq("kind", "cleanup")
        .neq("status", "complete")
        .in("client_link_id", allIds);
      const byId = new Map(all.map((c) => [c.id, c]));
      cleanupSignoffs = ((signoffs as any[]) || []).map((r) => {
        const c = byId.get(r.client_link_id);
        return {
          id: r.client_link_id,
          client_name: (c as any)?.client_name || "Unknown",
          jurisdiction: (c as any)?.jurisdiction || "",
          state_province: (c as any)?.state_province || null,
          paused: false,
          last_synced_at: (c as any)?.last_synced_at || null,
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
  if (isSenior) {
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
      jurisdiction: c.jurisdiction,
      state_province: c.state_province,
      paused: !!c.daily_recon_paused,
      last_synced_at: c.last_synced_at,
      bs_enabled: c.bs_enabled !== false,
      assigned_bookkeeper_id: c.assigned_bookkeeper_id ?? null,
      run: runsByClient.get(c.id) || null,
    })),
    eligible: eligible.map((c) => ({
      id: c.id,
      client_name: c.client_name,
      jurisdiction: c.jurisdiction,
      state_province: c.state_province,
      cleanup_completed_at: c.cleanup_completed_at,
    })),
  });
}
