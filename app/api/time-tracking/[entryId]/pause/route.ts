import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  requireTimerActor,
  fetchEntry,
  pauseEntry,
  toEntryView,
  tableMissing,
} from "@/lib/time-tracking-server";

/**
 * POST /api/time-tracking/[entryId]/pause   (WRITES)
 *
 * Bathroom break. Banks the open segment (stale-capped at the last heartbeat,
 * so pausing a long-dead tab doesn't credit the gap) and clears the segment
 * marker. Idempotent — pausing an already-paused entry returns it as-is, which
 * is what a stale second tab needs. Entry owner only.
 */
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await context.params;
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

  try {
    const row = await fetchEntry(service, entryId);
    if (!row) return NextResponse.json({ error: "Timer not found" }, { status: 404 });
    if (row.user_id !== auth.actor.userId) {
      return NextResponse.json({ error: "Forbidden — not your timer" }, { status: 403 });
    }
    const updated = (await pauseEntry(service, row, nowMs)) ?? (await fetchEntry(service, entryId));
    return NextResponse.json({
      serverNow: new Date(nowMs).toISOString(),
      entry: updated ? toEntryView(updated, nowMs) : null,
    });
  } catch (err: any) {
    if (tableMissing(err)) return NextResponse.json({ error: "setup_pending" }, { status: 503 });
    console.error("[time-tracking/pause]", err?.message);
    return NextResponse.json({ error: "Failed to pause" }, { status: 500 });
  }
}
