import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { finalizeSegment } from "@/lib/time-tracking";
import {
  requireTimerActor,
  fetchEntry,
  toEntryView,
  tableMissing,
  ENTRY_COLS,
} from "@/lib/time-tracking-server";

/**
 * POST /api/time-tracking/[entryId]/adjust   (WRITES)
 *
 * Owner self-correction: "the timer says 47 minutes but 20 of that was the
 * wrong account / a phone call / lunch — set it to 24." Body: { minutes }.
 *
 * REDUCE-ONLY, on purpose. Cutting your own recorded time is the honest
 * direction (you're giving time back); inflating it is how a timesheet stops
 * being evidence. Legitimate increases exist — a forgotten timer that should
 * have run — and go through an admin/lead on the time report, where the
 * correction is someone else's deliberate act.
 *
 * Running or paused sessions only, owner only. A running session keeps
 * running: the live segment is folded (stale-capped) into the banked total
 * first, the total is set, and a fresh segment opens at now. Audited with
 * before/after — a self-edit that leaves no trace isn't a correction, it's
 * an erasure.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ entryId: string }> }) {
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
  const serverNow = new Date(nowMs).toISOString();

  const body = await request.json().catch(() => ({}));
  const minutes = Number(body.minutes);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) {
    return NextResponse.json({ error: "minutes must be a number between 0 and 1440" }, { status: 400 });
  }
  const newSeconds = Math.round(minutes * 60);

  try {
    const row = await fetchEntry(service, entryId);
    if (!row) return NextResponse.json({ error: "Timer not found" }, { status: 404 });
    if (row.user_id !== auth.actor.userId) {
      return NextResponse.json({ error: "Forbidden — not your timer" }, { status: 403 });
    }
    if (row.status !== "running" && row.status !== "paused") {
      return NextResponse.json(
        { error: "Only a running or paused session can be self-adjusted — completed entries go through an admin." },
        { status: 409 }
      );
    }

    // What the session is genuinely worth right now, stale-cap applied — the
    // same fold every other write path uses.
    const fold = finalizeSegment(row, nowMs);
    const currentSeconds = fold.accumulatedSeconds;
    if (newSeconds > currentSeconds) {
      return NextResponse.json(
        {
          error: "reduce_only",
          message: `This session has ${Math.floor(currentSeconds / 60)}m recorded — you can only adjust it down. Adding time is an admin correction on the time report.`,
          currentSeconds,
        },
        { status: 400 }
      );
    }

    const wasRunning = row.status === "running";
    const { data, error } = await (service as any)
      .from("time_entries")
      .update({
        accumulated_seconds: newSeconds,
        // Running keeps running on a fresh segment; paused stays paused.
        last_resumed_at: wasRunning ? serverNow : null,
        last_heartbeat_at: wasRunning ? serverNow : row.last_heartbeat_at,
        auto_paused: false,
        updated_at: serverNow,
      })
      .eq("id", entryId)
      .eq("status", row.status) // CAS: another tab moving it loses quietly
      .select(ENTRY_COLS);
    const updated = (data as any[])?.[0] ?? null;
    if (error || !updated) {
      return NextResponse.json(
        { error: "The session changed under you — refresh and try again." },
        { status: 409 }
      );
    }

    try {
      await (service as any).from("audit_log").insert({
        event_type: "time_entry_self_adjust",
        user_id: auth.actor.userId,
        client_link_id: row.client_link_id ?? null,
        request_payload: {
          entry_id: entryId,
          before_seconds: currentSeconds,
          after_seconds: newSeconds,
          status: row.status,
        },
      });
    } catch { /* audit is nice-to-have (house pattern) */ }

    return NextResponse.json({ serverNow, entry: toEntryView(updated, nowMs) });
  } catch (err: any) {
    if (tableMissing(err)) return NextResponse.json({ error: "setup_pending" }, { status: 503 });
    console.error("[time-tracking/adjust]", err?.message);
    return NextResponse.json({ error: "Failed to adjust" }, { status: 500 });
  }
}
