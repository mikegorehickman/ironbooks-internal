import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  requireTimerActor,
  fetchEntry,
  discardEntry,
  toEntryView,
  tableMissing,
} from "@/lib/time-tracking-server";

/**
 * POST /api/time-tracking/[entryId]/discard   (WRITES)
 *
 * "I started this on the wrong client" / "that was left running from yesterday
 * and the time isn't real." Marks the session discarded: the row stays for
 * audit but is excluded from every report and from the month-to-date the
 * over-budget rule uses — so junk time can never demand a note or distort a
 * client's month. Entry owner only.
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
    if (row.status === "completed") {
      return NextResponse.json(
        { error: "That session is already completed — it can't be discarded." },
        { status: 409 }
      );
    }
    const updated = await discardEntry(service, row, nowMs);
    try {
      await service.from("audit_log").insert({
        user_id: auth.actor.userId,
        event_type: "time_entry_discarded",
        request_payload: {
          entry_id: row.id,
          client_link_id: row.client_link_id,
          discarded_seconds: row.accumulated_seconds,
        } as any,
      } as any);
    } catch { /* non-critical */ }
    return NextResponse.json({
      serverNow: new Date(nowMs).toISOString(),
      entry: updated ? toEntryView(updated, nowMs) : null,
      discarded: true,
    });
  } catch (err: any) {
    if (tableMissing(err)) return NextResponse.json({ error: "setup_pending" }, { status: 503 });
    console.error("[time-tracking/discard]", err?.message);
    return NextResponse.json({ error: "Failed to discard" }, { status: 500 });
  }
}
