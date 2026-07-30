import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { DEFAULT_TIME_BUDGET_MINUTES, effectiveBudgetMinutes } from "@/lib/time-tracking";
import { requireTimerActor } from "@/lib/time-tracking-server";

/**
 * PATCH /api/time-tracking/budgets/[clientLinkId]   { timeBudgetMinutes }
 *
 * Set (or clear) a client's monthly time budget in minutes — the number the
 * over-budget note rule is measured against. null clears the override, falling
 * back to the app default. 0 is legal and means "any time on this client needs
 * an explanation". Admin / lead only (it's a management dial, and it changes
 * whether the team gets prompted for notes).
 *
 * Editing a budget is not retroactive to notes already written: every completed
 * session snapshots the budget it was judged against.
 */
export const dynamic = "force-dynamic";
const MAX_BUDGET_MINUTES = 100_000; // ~69 days; anything larger is a typo

export async function PATCH(request: Request, context: { params: Promise<{ clientLinkId: string }> }) {
  const { clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const service = createServiceSupabase();
  const auth = await requireTimerActor(supabase, service, { seniorOnly: true });
  if ("error" in auth) {
    return NextResponse.json(
      { error: auth.error === "unauthorized" ? "Unauthorized" : "Forbidden — admin or lead only" },
      { status: auth.error === "unauthorized" ? 401 : 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const raw = body.timeBudgetMinutes;
  let minutes: number | null;
  if (raw === null || raw === "" || typeof raw === "undefined") {
    minutes = null;
  } else {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_BUDGET_MINUTES) {
      return NextResponse.json(
        { error: `timeBudgetMinutes must be null or a whole number between 0 and ${MAX_BUDGET_MINUTES}` },
        { status: 400 }
      );
    }
    minutes = n;
  }

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { error } = await (service as any)
    .from("client_links")
    .update({ time_budget_minutes: minutes, updated_at: new Date().toISOString() })
    .eq("id", clientLinkId);
  if (error) {
    const msg = String(error.message || "");
    if (/time_budget_minutes/.test(msg) && /column/i.test(msg)) {
      return NextResponse.json(
        { error: "setup_pending", message: "Time tracking isn't set up yet (migration 146 pending)." },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  try {
    await service.from("audit_log").insert({
      user_id: auth.actor.userId,
      event_type: "time_budget_updated",
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
        time_budget_minutes: minutes,
      } as any,
    } as any);
  } catch { /* non-critical */ }

  return NextResponse.json({
    clientLinkId,
    timeBudgetMinutes: minutes,
    effectiveMinutes: effectiveBudgetMinutes(minutes),
    defaultMinutes: DEFAULT_TIME_BUDGET_MINUTES,
  });
}
