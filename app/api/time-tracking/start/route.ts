import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  requireTimerActor,
  fetchRunningEntry,
  pauseEntry,
  completeEntry,
  toEntryView,
  tableMissing,
  isUniqueViolation,
  ENTRY_COLS,
  type TimeEntryRow,
} from "@/lib/time-tracking-server";

/**
 * POST /api/time-tracking/start   (WRITES)
 *
 * Body: {
 *   clientLinkId: string,
 *   sourcePath?: string,
 *   completeActive?: boolean,   // one-click "Complete {A} & start {B}"
 *   overBudgetNote?: string,    // for that A completion, if it needs one
 * }
 *
 * Starting while another timer runs is normal (the bookkeeper moved on), so:
 *   - completeActive:true  → complete the old one first (enforcing its
 *     over-budget note; 400 `over_budget_note_required` if missing) — this is
 *     the single click that closes A and opens B.
 *   - otherwise            → auto-PAUSE the old one and keep it (nothing is
 *     ever silently completed; a paused entry still owes its note later).
 * Already running on this same client → returns that entry (idempotent, so a
 * double-click or a second tab can't create two).
 *
 * The one-running-per-user unique index is the real lock: on 23505 we re-read
 * and return the winner (200 same client / 409 different) rather than 500.
 *
 * admin / lead / bookkeeper. Any of them may track any client — cross-coverage
 * is real, and the report shows who did the work.
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
  const { actor } = auth;
  const nowMs = Date.now();
  const serverNow = new Date(nowMs).toISOString();

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.clientLinkId || "").trim();
  const sourcePath = body.sourcePath ? String(body.sourcePath).slice(0, 500) : null;
  const completeActive = body.completeActive === true;
  const overBudgetNote = body.overBudgetNote ? String(body.overBudgetNote).slice(0, 2000) : null;
  if (!clientLinkId) {
    return NextResponse.json({ error: "clientLinkId is required" }, { status: 400 });
  }

  // The client must exist and be active — a timer on a dead link is noise.
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if ((client as any).is_active === false) {
    return NextResponse.json({ error: "Client is inactive" }, { status: 400 });
  }

  try {
    const running = await fetchRunningEntry(service, actor.userId);

    // Same client already ticking → hand it back untouched.
    if (running && running.client_link_id === clientLinkId) {
      return NextResponse.json({
        serverNow,
        entry: toEntryView(running, nowMs, (client as any).client_name),
        already_running: true,
      });
    }

    // A different client is ticking → close it or park it.
    if (running) {
      if (completeActive) {
        const outcome = await completeEntry(service, running, nowMs, overBudgetNote);
        if (!outcome.ok && outcome.noteRequired) {
          // The widget shows the note modal, then retries with overBudgetNote.
          const { data: prev } = await service
            .from("client_links")
            .select("client_name")
            .eq("id", running.client_link_id)
            .single();
          return NextResponse.json(
            {
              error: "over_budget_note_required",
              message: "That client is over its monthly budget — a note is required to complete the session.",
              previous: {
                entryId: running.id,
                clientLinkId: running.client_link_id,
                clientName: (prev as any)?.client_name ?? null,
                ...outcome.noteRequired,
              },
              serverNow,
            },
            { status: 400 }
          );
        }
        await auditSafe(service, actor.userId, "time_entry_completed", {
          entry_id: running.id,
          client_link_id: running.client_link_id,
          seconds: outcome.entry?.accumulated_seconds ?? null,
          via: "start_next_client",
          had_note: !!overBudgetNote,
        });
      } else {
        await pauseEntry(service, running, nowMs);
      }
    }

    // Insert the new entry. started_at/last_resumed_at/last_heartbeat_at all
    // stamp now so the very first sweep can't see a negative segment.
    let created: TimeEntryRow | null = null;
    try {
      const { data, error } = await (service as any)
        .from("time_entries")
        .insert({
          client_link_id: clientLinkId,
          user_id: actor.userId,
          status: "running",
          started_at: serverNow,
          last_resumed_at: serverNow,
          last_heartbeat_at: serverNow,
          accumulated_seconds: 0,
          source_path: sourcePath,
        })
        .select(ENTRY_COLS);
      if (error) throw error;
      created = (data as TimeEntryRow[])?.[0] ?? null;
    } catch (err: any) {
      if (!isUniqueViolation(err)) throw err;
      // Another tab/device won the race — return the winner, don't 500.
      const winner = await fetchRunningEntry(service, actor.userId);
      if (winner && winner.client_link_id === clientLinkId) {
        return NextResponse.json({
          serverNow,
          entry: toEntryView(winner, nowMs, (client as any).client_name),
          already_running: true,
        });
      }
      const { data: other } = winner
        ? await service.from("client_links").select("client_name").eq("id", winner.client_link_id).single()
        : { data: null as any };
      return NextResponse.json(
        {
          error: "another_timer_running",
          message: "Another timer started somewhere else — refresh to pick it up.",
          conflict: winner ? toEntryView(winner, nowMs, (other as any)?.client_name) : null,
          serverNow,
        },
        { status: 409 }
      );
    }

    await auditSafe(service, actor.userId, "time_entry_started", {
      entry_id: created?.id,
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      source_path: sourcePath,
    });

    return NextResponse.json({
      serverNow,
      entry: created ? toEntryView(created, nowMs, (client as any).client_name) : null,
    });
  } catch (err: any) {
    if (tableMissing(err)) {
      return NextResponse.json(
        { error: "setup_pending", message: "Time tracking isn't set up yet (migration 146 pending)." },
        { status: 503 }
      );
    }
    console.error("[time-tracking/start]", err?.message);
    return NextResponse.json({ error: "Failed to start the timer" }, { status: 500 });
  }
}

/** Audit is nice-to-have; never fail the action over it (house pattern). */
async function auditSafe(service: any, userId: string, eventType: string, payload: any) {
  try {
    await service.from("audit_log").insert({ user_id: userId, event_type: eventType, request_payload: payload });
  } catch { /* non-critical */ }
}
