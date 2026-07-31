import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { isOverheadCategory, overheadLabel, currentMonth } from "@/lib/time-tracking";
import { requireTimerActor, fetchEntry, tableMissing } from "@/lib/time-tracking-server";

/**
 * Admin correction of a time entry. Senior only (admin / lead).
 *
 * PATCH /api/time-tracking/entries/[entryId]
 *   { minutes?, clientLinkId?, category?, overBudgetNote? }
 *   Fix what the timer got wrong: someone forgot to pause and banked three
 *   hours of lunch, or tracked Dominion's work against the wrong client. Time
 *   data people can't correct is data they stop trusting — and stop using.
 *
 * DELETE /api/time-tracking/entries/[entryId]
 *   Take a junk session out of the numbers. Implemented as status='discarded'
 *   (never a row delete): discarded entries are excluded from every report and
 *   every budget check, but the row survives for the audit trail. This is the
 *   one path allowed to discard an ALREADY-COMPLETED entry — the per-user
 *   discard endpoint refuses that on purpose; an admin correcting the record is
 *   a different act from a bookkeeper abandoning a session.
 *
 * Every change is written to audit_log with before/after, because these edits
 * rewrite history someone else's report depends on.
 */
export const dynamic = "force-dynamic";

/** Admin/lead gate, shared by both verbs (house pattern: seniorOnly). */
async function requireSenior() {
  const supabase = await createServerSupabase();
  const service = createServiceSupabase();
  const auth = await requireTimerActor(supabase, service, { seniorOnly: true });
  if ("error" in auth) {
    return {
      error: NextResponse.json(
        { error: auth.error === "unauthorized" ? "Unauthorized" : "Forbidden — admin or lead only" },
        { status: auth.error === "unauthorized" ? 401 : 403 }
      ),
    };
  }
  return { service, actor: auth.actor };
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ entryId: string }> }
) {
  const { entryId } = await context.params;
  const gate = await requireSenior();
  if ("error" in gate) return gate.error;
  const { service, actor } = gate;

  const body = await request.json().catch(() => ({}));

  try {
    const row = await fetchEntry(service, entryId);
    if (!row) return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    if (row.status === "running") {
      return NextResponse.json(
        { error: "That timer is still running — pause or complete it before editing." },
        { status: 409 }
      );
    }

    const patch: Record<string, any> = { updated_at: new Date().toISOString() };
    const changed: string[] = [];

    // Minutes → seconds. 0 is legitimate (zero out a bogus session without
    // removing it), so check for presence, not truthiness.
    if (body.minutes !== undefined && body.minutes !== null && body.minutes !== "") {
      const mins = Number(body.minutes);
      if (!Number.isFinite(mins) || mins < 0 || mins > 24 * 60) {
        return NextResponse.json({ error: "minutes must be between 0 and 1440" }, { status: 400 });
      }
      patch.accumulated_seconds = Math.round(mins * 60);
      changed.push("minutes");
    }

    // Re-target: to a client, or to an overhead bucket. The DB enforces
    // client-XOR-category, so both sides are always set together.
    if (body.clientLinkId) {
      const { data: client } = await service
        .from("client_links")
        .select("id, client_name")
        .eq("id", String(body.clientLinkId))
        .single();
      if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
      patch.client_link_id = (client as any).id;
      patch.category = null;
      changed.push("client");
    } else if (body.category) {
      if (!isOverheadCategory(body.category)) {
        return NextResponse.json({ error: `Unknown category "${body.category}"` }, { status: 400 });
      }
      patch.category = body.category;
      patch.client_link_id = null;
      changed.push("category");
    }

    if (body.overBudgetNote !== undefined) {
      const note = String(body.overBudgetNote || "").slice(0, 2000).trim();
      patch.over_budget_note = note || null;
      changed.push("note");
    }

    if (changed.length === 0) {
      return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
    }

    const { data: updated, error } = await (service as any)
      .from("time_entries")
      .update(patch)
      .eq("id", entryId)
      .select("id, client_link_id, category, accumulated_seconds, over_budget_note, status, ended_at")
      .maybeSingle();
    if (error) throw error;

    // Before/after, so a wrong correction can be traced and undone.
    try {
      await (service as any).from("audit_log").insert({
        user_id: actor.userId,
        event_type: "time_entry_edited",
        request_payload: {
          entry_id: entryId,
          changed,
          before: {
            client_link_id: row.client_link_id,
            category: row.category,
            accumulated_seconds: row.accumulated_seconds,
            over_budget_note: row.over_budget_note,
          },
          after: {
            client_link_id: updated?.client_link_id ?? null,
            category: updated?.category ?? null,
            accumulated_seconds: updated?.accumulated_seconds ?? null,
            over_budget_note: updated?.over_budget_note ?? null,
          },
          by: actor.fullName,
          month: row.ended_at ? currentMonth(Date.parse(row.ended_at)) : null,
        } as any,
      } as any);
    } catch { /* non-critical */ }

    return NextResponse.json({ ok: true, changed, entry: updated });
  } catch (err: any) {
    if (tableMissing(err)) {
      return NextResponse.json({ error: "Time tracking isn't set up yet (migration 146)." }, { status: 503 });
    }
    console.error(`[time-entries] PATCH ${entryId}: ${err?.message}`);
    return NextResponse.json({ error: err?.message || "Failed to update entry" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ entryId: string }> }
) {
  const { entryId } = await context.params;
  const gate = await requireSenior();
  if ("error" in gate) return gate.error;
  const { service, actor } = gate;

  try {
    const row = await fetchEntry(service, entryId);
    if (!row) return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    if (row.status === "discarded") {
      return NextResponse.json({ ok: true, already_discarded: true });
    }

    const nowIso = new Date().toISOString();
    const { error } = await (service as any)
      .from("time_entries")
      .update({
        status: "discarded",
        // The XOR/terminal CHECKs require ended_at on a discarded row; a running
        // entry being discarded also needs its open segment closed out.
        ended_at: row.ended_at || nowIso,
        last_resumed_at: null,
        updated_at: nowIso,
      })
      .eq("id", entryId);
    if (error) throw error;

    try {
      await (service as any).from("audit_log").insert({
        user_id: actor.userId,
        event_type: "time_entry_removed",
        request_payload: {
          entry_id: entryId,
          client_link_id: row.client_link_id,
          category: row.category,
          removed_seconds: row.accumulated_seconds,
          was_status: row.status,
          entry_user_id: row.user_id,
          by: actor.fullName,
        } as any,
      } as any);
    } catch { /* non-critical */ }

    return NextResponse.json({ ok: true, removed: true });
  } catch (err: any) {
    if (tableMissing(err)) {
      return NextResponse.json({ error: "Time tracking isn't set up yet (migration 146)." }, { status: 503 });
    }
    console.error(`[time-entries] DELETE ${entryId}: ${err?.message}`);
    return NextResponse.json({ error: err?.message || "Failed to remove entry" }, { status: 500 });
  }
}
