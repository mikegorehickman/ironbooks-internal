import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { previousMonthPeriod } from "@/lib/monthly-rec";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/production
 *
 * Flip a client's daily-recon enrollment.
 *
 * Body:
 *   { action: "enable" }     → daily_recon_enabled=true, paused=false
 *   { action: "pause", reason?: string }  → daily_recon_paused=true (won't run on cron)
 *   { action: "unpause" }    → daily_recon_paused=false
 *   { action: "disable" }    → daily_recon_enabled=false (full opt-out)
 *
 * Auth: admin/lead only. Audit-logged in both directions so the
 * Promote-to-production decision and any unpause has a paper trail.
 *
 * Why a separate endpoint instead of toggling from /admin/daily-recon:
 * Lisa lives in the client profile when she's deciding whether a client
 * is ready for prod. Forcing her to jump to a separate admin page makes
 * the action feel risky / hidden. This puts the lever exactly where the
 * decision happens.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (!["admin", "lead"].includes(role)) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  let body: { action?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = body.action;
  if (!["enable", "pause", "unpause", "disable", "bs_on", "bs_off", "promote_pl_only"].includes(action || "")) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  // Pull the client first so we have its current state for the audit log
  // (and so the response can echo it back).
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, qbo_refresh_token")
    .eq("id", id)
    .single();
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // Sanity: don't let someone enable daily recon on a client with no
  // QBO connection — the engine will throw on first run anyway and we'd
  // rather surface the issue here than in a cron failure log.
  if (action === "enable" || action === "promote_pl_only") {
    const c: any = client;
    if (!c.qbo_realm_id || !c.qbo_refresh_token) {
      return NextResponse.json(
        {
          error:
            "Can't move to production — client has no QuickBooks connection. Connect QBO first, then promote.",
        },
        { status: 422 }
      );
    }
  }

  // Build the update payload per action.
  const now = new Date().toISOString();
  const updates: Record<string, any> = {};
  switch (action) {
    case "enable":
      updates.daily_recon_enabled = true;
      updates.daily_recon_paused = false;
      updates.daily_recon_paused_reason = null;
      updates.daily_recon_enabled_at = now;
      break;
    case "pause":
      updates.daily_recon_paused = true;
      updates.daily_recon_paused_reason = body.reason || "Manually paused";
      break;
    case "unpause":
      updates.daily_recon_paused = false;
      updates.daily_recon_paused_reason = null;
      break;
    case "disable":
      updates.daily_recon_enabled = false;
      updates.daily_recon_paused = false;
      updates.daily_recon_paused_reason = null;
      break;
    // Balance Sheet toggle — bs_off puts the client on P&L-only monthly
    // service (BS checks + BS/CFS statements skipped) while their balance
    // sheet cleanup finishes; bs_on restores full service. Also sent by the
    // BS Cleanup wizard's Publish button (reveals portal BS + Cash Flow).
    case "bs_off":
      updates.bs_enabled = false;
      break;
    case "bs_on":
      updates.bs_enabled = true;
      break;
    // One-shot from the BS Cleanup wizard: "P&L ready, BS waiting on
    // client — move to production." Client goes live on P&L-only service
    // (portal BS/CFS show the friendly placeholder) AND lands on the
    // Production board as Waiting on Client / waiting for statements, so
    // nobody forgets the BS is unfinished.
    case "promote_pl_only":
      updates.daily_recon_enabled = true;
      updates.daily_recon_paused = false;
      updates.daily_recon_paused_reason = null;
      updates.daily_recon_enabled_at = now;
      updates.bs_enabled = false;
      break;
  }

  const { error: updateErr } = await service
    .from("client_links")
    .update(updates as any)
    .eq("id", id);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // promote_pl_only also stamps the Production board: Waiting on Client /
  // waiting for statements for the current rec period. Best-effort — board
  // state is bookkeeping convenience, never a reason to fail the promote.
  if (action === "promote_pl_only") {
    try {
      const p = previousMonthPeriod();
      await (service as any).from("monthly_rec_runs").upsert(
        {
          client_link_id: id,
          period: p.period,
          period_start: p.periodStart,
          period_end: p.periodEnd,
          board_status: "waiting_client",
          waiting_reasons: ["waiting_statements"],
          status_note: "P&L-only promote — balance sheet waiting on client docs",
          created_by: user.id,
        },
        { onConflict: "client_link_id,period" }
      );
    } catch (err: any) {
      console.warn(`[production] board stamp failed (non-fatal): ${err?.message}`);
    }
  }

  await service.from("audit_log").insert({
    event_type: "client_production_state_change",
    user_id: user.id,
    request_payload: {
      client_link_id: id,
      client_name: (client as any).client_name,
      action,
      reason: body.reason || null,
      actor_name: (actor as any).full_name || user.email,
    } as any,
  });

  return NextResponse.json({
    ok: true,
    action,
    client_link_id: id,
  });
}
