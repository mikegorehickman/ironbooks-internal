import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  OVERHEAD_CATEGORIES,
  isOverheadCategory,
  overheadLabel,
  type OverheadCategory,
} from "@/lib/time-tracking";
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
 *   clientLinkId?: string,      // client work — counts against their budget
 *   category?: OverheadCategory,// OR overhead: work belonging to no one client
 *   sourcePath?: string,
 *   completeActive?: boolean,   // one-click "Complete {A} & start {B}"
 *   overBudgetNote?: string,    // for that A completion, if it needs one
 * }
 *
 * Exactly one of clientLinkId / category. The client form is also how time on a
 * NON-client page gets attributed — the widget's picker lets a bookkeeper answer
 * Dominion's request from /inbox and still bill it to Dominion's month.
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
  const rawCategory = body.category ? String(body.category).trim() : "";
  const sourcePath = body.sourcePath ? String(body.sourcePath).slice(0, 500) : null;
  const completeActive = body.completeActive === true;
  const overBudgetNote = body.overBudgetNote ? String(body.overBudgetNote).slice(0, 2000) : null;

  if (!clientLinkId && !rawCategory) {
    return NextResponse.json({ error: "clientLinkId or category is required" }, { status: 400 });
  }
  if (clientLinkId && rawCategory) {
    return NextResponse.json(
      { error: "Pass either clientLinkId (client work) or category (overhead), not both" },
      { status: 400 }
    );
  }
  // Validate against the canonical list — never write a raw body value.
  if (rawCategory && !isOverheadCategory(rawCategory)) {
    return NextResponse.json(
      { error: `Unknown category "${rawCategory}"`, allowed: OVERHEAD_CATEGORIES.map((c) => c.key) },
      { status: 400 }
    );
  }
  const category = rawCategory ? (rawCategory as OverheadCategory) : null;

  // For client work the client must exist and be active — a timer on a dead
  // link is noise. Overhead has no client to check.
  let client: any = null;
  if (clientLinkId) {
    const { data } = await service
      .from("client_links")
      .select("id, client_name, is_active")
      .eq("id", clientLinkId)
      .single();
    if (!data) return NextResponse.json({ error: "Client not found" }, { status: 404 });
    if ((data as any).is_active === false) {
      return NextResponse.json({ error: "Client is inactive" }, { status: 400 });
    }
    client = data;
  }
  const startLabel = client ? (client as any).client_name : overheadLabel(category);

  try {
    const running = await fetchRunningEntry(service, actor.userId);

    // Already ticking on this exact target → hand it back untouched.
    const sameTarget = running
      ? clientLinkId
        ? running.client_link_id === clientLinkId
        : running.category === category
      : false;
    if (running && sameTarget) {
      return NextResponse.json({
        serverNow,
        entry: toEntryView(running, nowMs, client ? (client as any).client_name : null),
        already_running: true,
      });
    }

    // Something else is ticking → close it or park it.
    if (running) {
      if (completeActive) {
        const outcome = await completeEntry(service, running, nowMs, overBudgetNote);
        if (!outcome.ok && outcome.noteRequired) {
          // The widget shows the note modal, then retries with overBudgetNote.
          // (Only client entries can hit this — overhead has no budget.)
          const { data: prev } = running.client_link_id
            ? await service.from("client_links").select("client_name").eq("id", running.client_link_id).single()
            : { data: null as any };
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
          client_link_id: clientLinkId || null,
          category,
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
      const winnerIsSame = winner
        ? clientLinkId
          ? winner.client_link_id === clientLinkId
          : winner.category === category
        : false;
      if (winner && winnerIsSame) {
        return NextResponse.json({
          serverNow,
          entry: toEntryView(winner, nowMs, client ? (client as any).client_name : null),
          already_running: true,
        });
      }
      const { data: other } = winner?.client_link_id
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
      client_link_id: clientLinkId || null,
      category,
      label: startLabel,
      source_path: sourcePath,
    });

    return NextResponse.json({
      serverNow,
      entry: created ? toEntryView(created, nowMs, client ? (client as any).client_name : null) : null,
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
