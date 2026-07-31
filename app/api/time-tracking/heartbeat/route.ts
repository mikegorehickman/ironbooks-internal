import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  requireTimerActor,
  fetchRunningEntry,
  toEntryView,
  tableMissing,
} from "@/lib/time-tracking-server";

/**
 * POST /api/time-tracking/heartbeat   (WRITES — one timestamp)
 *
 * The widget pings every ~60s while a timer runs. Two jobs:
 *   1. Proof of life. The stale rule caps an abandoned session AT the last
 *      heartbeat, so this is what makes "laptop died at 5pm" credit the work
 *      done before 5pm rather than the whole night.
 *   2. Reconciliation. The response carries the caller's authoritative running
 *      entry, so a second tab or a second device that's ticking something stale
 *      corrects itself within a minute — no cross-tab messaging required.
 *
 * Guarded to status='running': a tab still beating an entry that was completed
 * elsewhere updates nothing and gets told the truth. Heartbeats deliberately
 * continue while the tab is hidden — bookkeepers work in QuickBooks with SNAP
 * in the background, and pausing on blur would stop timers mid-task.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const service = createServiceSupabase();
  const auth = await requireTimerActor(supabase, service);
  if ("error" in auth) {
    return NextResponse.json(
      { error: auth.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: auth.error === "unauthorized" ? 401 : 403 }
    );
  }
  const nowMs = Date.now();
  const serverNow = new Date(nowMs).toISOString();
  const body = await request.json().catch(() => ({}));
  const entryId = body.entryId ? String(body.entryId) : null;

  try {
    if (entryId) {
      await (service as any)
        .from("time_entries")
        .update({ last_heartbeat_at: serverNow, updated_at: serverNow })
        .eq("id", entryId)
        .eq("user_id", auth.actor.userId)
        .eq("status", "running");
    }
    // Always answer with the truth, whether or not the ping matched.
    const running = await fetchRunningEntry(service, auth.actor.userId);
    let clientName: string | null = null;
    if (running?.client_link_id) {
      const { data: client } = await service
        .from("client_links")
        .select("client_name")
        .eq("id", running.client_link_id)
        .single();
      clientName = (client as any)?.client_name ?? null;
    }
    return NextResponse.json({
      serverNow,
      running: running ? toEntryView(running, nowMs, clientName) : null,
    });
  } catch (err: any) {
    if (tableMissing(err)) return NextResponse.json({ serverNow, running: null, setup_pending: true });
    console.error("[time-tracking/heartbeat]", err?.message);
    return NextResponse.json({ error: "Heartbeat failed" }, { status: 500 });
  }
}
