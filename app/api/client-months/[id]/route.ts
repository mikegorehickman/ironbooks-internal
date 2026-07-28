import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { MONTH_STAGES, type MonthStatus } from "@/lib/client-months";

export const dynamic = "force-dynamic";

const VALID_STATUS: MonthStatus[] = [
  "not_started", "in_progress", "waiting_client", "ready_for_review", "failed_review", "complete",
];
const STAGE_KEYS = new Set(MONTH_STAGES.map((s) => s.key as string));
const SKIPPABLE = new Set(MONTH_STAGES.filter((s) => s.skippable).map((s) => s.key as string));

/**
 * PATCH /api/client-months/[id]
 *
 * Records progress on one client's month. Three shapes:
 *   { stage, done }             → tick / un-tick a stage
 *   { stage, skip, reason? }    → mark a stage not-applicable this month
 *   { status, blocked_reason? } → move the board lane (waiting on client, etc.)
 *
 * The stage list is validated against MONTH_STAGES rather than accepting an
 * arbitrary column name — this endpoint writes to a table by key, so an
 * unvalidated key is a write-anywhere primitive.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { data: row, error: readErr } = await (service as any)
    .from("client_months")
    .select("*")
    .eq("id", id)
    .single();
  if (readErr || !row) return NextResponse.json({ error: "Month not found" }, { status: 404 });

  const updates: Record<string, any> = {};
  const now = new Date().toISOString();

  // ── Stage tick / un-tick ──────────────────────────────────────────────────
  if (typeof body.stage === "string" && body.skip === undefined) {
    if (!STAGE_KEYS.has(body.stage)) {
      return NextResponse.json({ error: `Unknown stage "${body.stage}"` }, { status: 400 });
    }
    updates[body.stage] = body.done === false ? null : now;
    // Ticking a stage clears any skip on it — the two states are mutually
    // exclusive and leaving both set would make progress ambiguous.
    if (body.done !== false) {
      updates.skipped_stages = (row.skipped_stages || []).filter((k: string) => k !== body.stage);
      const reasons = { ...(row.skip_reasons || {}) };
      delete reasons[body.stage];
      updates.skip_reasons = reasons;
    }
  }

  // ── Stage skip / un-skip ──────────────────────────────────────────────────
  if (typeof body.stage === "string" && body.skip !== undefined) {
    if (!STAGE_KEYS.has(body.stage)) {
      return NextResponse.json({ error: `Unknown stage "${body.stage}"` }, { status: 400 });
    }
    if (body.skip === true && !SKIPPABLE.has(body.stage)) {
      // Reclass, duplicates and sending month-end are the substance of the
      // close. If one genuinely doesn't apply, that is a conversation, not a
      // checkbox.
      return NextResponse.json(
        { error: `"${body.stage}" can't be skipped — it's a required step of the close.` },
        { status: 400 }
      );
    }
    const current: string[] = row.skipped_stages || [];
    const reasons = { ...(row.skip_reasons || {}) };
    if (body.skip === true) {
      updates.skipped_stages = current.includes(body.stage) ? current : [...current, body.stage];
      reasons[body.stage] = String(body.reason || "Not applicable this month").slice(0, 500);
      updates.skip_reasons = reasons;
      updates[body.stage] = null; // a skip is not a completion
    } else {
      updates.skipped_stages = current.filter((k) => k !== body.stage);
      delete reasons[body.stage];
      updates.skip_reasons = reasons;
    }
  }

  // ── Board lane ────────────────────────────────────────────────────────────
  if (typeof body.status === "string") {
    if (!VALID_STATUS.includes(body.status)) {
      return NextResponse.json({ error: `Invalid status "${body.status}"` }, { status: 400 });
    }
    updates.status = body.status;
    if (body.status !== "waiting_client" && body.status !== "failed_review") {
      updates.blocked_reason = null;
    }
  }
  if (body.blocked_reason !== undefined) {
    updates.blocked_reason = body.blocked_reason ? String(body.blocked_reason).slice(0, 500) : null;
  }
  if (body.notes !== undefined) {
    updates.notes = body.notes ? String(body.notes).slice(0, 4000) : null;
  }
  if (body.assignee_id !== undefined) updates.assignee_id = body.assignee_id || null;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: updated, error } = await (service as any)
    .from("client_months")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit so a month's history is reconstructable — who ticked what, and when.
  try {
    await (service as any).from("audit_log").insert({
      event_type: "client_month_updated",
      request_payload: {
        client_month_id: id,
        client_link_id: row.client_link_id,
        period_month: row.period_month,
        changed: Object.keys(updates),
        stage: body.stage ?? null,
        skip: body.skip ?? null,
        status: body.status ?? null,
        by: user.email || user.id,
      } as any,
    } as any);
  } catch {
    /* non-critical */
  }

  return NextResponse.json({ ok: true, month: updated });
}
