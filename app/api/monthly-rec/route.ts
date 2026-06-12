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
    .select(
      "id, client_name, jurisdiction, state_province, assigned_bookkeeper_id, daily_recon_enabled, daily_recon_paused, cleanup_completed_at, last_synced_at"
    )
    .eq("is_active", true);
  if (!isSenior) clientsQ = clientsQ.eq("assigned_bookkeeper_id", user.id);
  const { data: clients } = await clientsQ.order("client_name");
  const all = (clients as any[]) || [];

  const production = all.filter((c) => c.daily_recon_enabled);
  const eligible = all.filter(
    (c) => !c.daily_recon_enabled && c.cleanup_completed_at
  );

  // Run rows for the period (table may predate migration 62 in some envs)
  let runsByClient = new Map<string, any>();
  try {
    const ids = production.map((c) => c.id);
    if (ids.length > 0) {
      const { data: runs } = await (service as any)
        .from("monthly_rec_runs")
        .select("client_link_id, status, has_concerns, concerns, checks, checks_ran_at, completed_at, sent_to_client_at, email_delivery")
        .eq("period", period)
        .in("client_link_id", ids);
      runsByClient = new Map(((runs as any[]) || []).map((r) => [r.client_link_id, r]));
    }
  } catch {
    /* pre-migration env — every client shows "not started" */
  }

  return NextResponse.json({
    period,
    is_senior: isSenior,
    production: production.map((c) => ({
      id: c.id,
      client_name: c.client_name,
      jurisdiction: c.jurisdiction,
      state_province: c.state_province,
      paused: !!c.daily_recon_paused,
      last_synced_at: c.last_synced_at,
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
