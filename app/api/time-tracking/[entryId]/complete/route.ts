import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  requireTimerActor,
  fetchEntry,
  completeEntry,
  toEntryView,
  tableMissing,
} from "@/lib/time-tracking-server";

/**
 * POST /api/time-tracking/[entryId]/complete   { overBudgetNote? }   (WRITES)
 *
 * Done with this client. Folds the final segment (stale-capped), stamps
 * ended_at — which is what files the session into a month — and snapshots the
 * budget + month-to-date so the note keeps its context if the budget is edited
 * later.
 *
 * THE RULE: if this client's month-to-date (all bookkeepers) plus this session
 * exceeds the client's monthly budget, a note explaining why is REQUIRED. The
 * server is the enforcement point; a 400 `over_budget_note_required` carries the
 * numbers so the widget can show the note modal and retry. Entry owner only.
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
  const overBudgetNote = body.overBudgetNote ? String(body.overBudgetNote).slice(0, 2000) : null;

  try {
    const row = await fetchEntry(service, entryId);
    if (!row) return NextResponse.json({ error: "Timer not found" }, { status: 404 });
    if (row.user_id !== auth.actor.userId) {
      return NextResponse.json({ error: "Forbidden — not your timer" }, { status: 403 });
    }

    const outcome = await completeEntry(service, row, nowMs, overBudgetNote);
    if (!outcome.ok && outcome.noteRequired) {
      const { data: client } = await service
        .from("client_links")
        .select("client_name")
        .eq("id", row.client_link_id)
        .single();
      return NextResponse.json(
        {
          error: "over_budget_note_required",
          message: "This client is over its monthly budget — add a note explaining the extra time.",
          clientName: (client as any)?.client_name ?? null,
          ...outcome.noteRequired,
          serverNow,
        },
        { status: 400 }
      );
    }

    try {
      await service.from("audit_log").insert({
        user_id: auth.actor.userId,
        event_type: "time_entry_completed",
        request_payload: {
          entry_id: row.id,
          client_link_id: row.client_link_id,
          seconds: outcome.entry?.accumulated_seconds ?? null,
          budget_minutes: outcome.entry?.budget_minutes_at_completion ?? null,
          mtd_seconds_before: outcome.entry?.mtd_seconds_at_completion ?? null,
          had_note: !!outcome.entry?.over_budget_note,
          auto_paused_before: !!row.auto_paused,
        } as any,
      } as any);
    } catch { /* non-critical */ }

    return NextResponse.json({
      serverNow,
      entry: outcome.entry ? toEntryView(outcome.entry, nowMs) : null,
      completed: true,
    });
  } catch (err: any) {
    if (tableMissing(err)) return NextResponse.json({ error: "setup_pending" }, { status: 503 });
    console.error("[time-tracking/complete]", err?.message);
    return NextResponse.json({ error: "Failed to complete the session" }, { status: 500 });
  }
}
