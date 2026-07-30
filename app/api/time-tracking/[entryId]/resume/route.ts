import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  requireTimerActor,
  fetchEntry,
  resumeEntry,
  toEntryView,
  tableMissing,
} from "@/lib/time-tracking-server";

/**
 * POST /api/time-tracking/[entryId]/resume   (WRITES)
 *
 * Back from the break. Opens a fresh segment, bumps the heartbeat (a resume
 * without that can make the sweep compute a NEGATIVE segment) and clears the
 * auto_paused flag. Any other timer of this user's is paused first, so the
 * one-running-per-user index can't be violated. Entry owner only.
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
    if (row.status === "completed" || row.status === "discarded") {
      return NextResponse.json({ error: "That session is already finished" }, { status: 409 });
    }
    const updated = (await resumeEntry(service, row, nowMs)) ?? (await fetchEntry(service, entryId));
    return NextResponse.json({
      serverNow: new Date(nowMs).toISOString(),
      entry: updated ? toEntryView(updated, nowMs) : null,
    });
  } catch (err: any) {
    if (tableMissing(err)) return NextResponse.json({ error: "setup_pending" }, { status: 503 });
    console.error("[time-tracking/resume]", err?.message);
    return NextResponse.json({ error: "Failed to resume" }, { status: 500 });
  }
}
