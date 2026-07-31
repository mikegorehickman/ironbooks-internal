import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { DEFAULT_TIME_BUDGET_MINUTES } from "@/lib/time-tracking";
import { requireTimerActor } from "@/lib/time-tracking-server";

/**
 * GET /api/time-tracking/budgets   (READ-ONLY, admin/lead)
 *
 * Every active client with its monthly time budget — including the ones nobody
 * has tracked time against yet. The report's "By client" table can only show
 * clients WITH activity, so on its own there'd be no way to set budgets before
 * the team starts tracking. This is the fleet setup view: sort by budget or
 * name, set the ones that differ from the default, done.
 *
 * Returns the default so the UI can label an unset budget as inherited rather
 * than pretending someone chose it.
 */
export const dynamic = "force-dynamic";
const MAX_BUDGET_MINUTES = 100_000;

/**
 * PATCH /api/time-tracking/budgets   { clientLinkIds: string[], timeBudgetMinutes: number|null }
 *
 * Set the same budget on many clients at once. Rolling out budgets one row at a
 * time across ~80 clients is the kind of chore people abandon half-finished,
 * which leaves the fleet on a default nobody chose. null clears back to the
 * app default; 0 means every session needs an explanation.
 */
export async function PATCH(request: Request) {
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
  const ids = Array.isArray(body.clientLinkIds)
    ? [...new Set(body.clientLinkIds.map((v: any) => String(v || "").trim()).filter(Boolean))]
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "clientLinkIds must be a non-empty array" }, { status: 400 });
  }
  if (ids.length > 500) {
    return NextResponse.json({ error: "Too many clients in one call (max 500)" }, { status: 400 });
  }

  const raw = body.timeBudgetMinutes;
  let minutes: number | null;
  if (raw === null || raw === "" || typeof raw === "undefined") {
    minutes = null;
  } else {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > MAX_BUDGET_MINUTES) {
      return NextResponse.json(
        { error: `timeBudgetMinutes must be null or a whole number between 0 and ${MAX_BUDGET_MINUTES}` },
        { status: 400 }
      );
    }
    minutes = n;
  }

  try {
    const { data, error } = await (service as any)
      .from("client_links")
      .update({ time_budget_minutes: minutes, updated_at: new Date().toISOString() })
      .in("id", ids)
      .select("id");
    if (error) throw error;
    const updated = (data || []).length;

    try {
      await (service as any).from("audit_log").insert({
        user_id: auth.actor.userId,
        event_type: "time_budgets_bulk_set",
        request_payload: {
          time_budget_minutes: minutes,
          requested: ids.length,
          updated,
          client_link_ids: ids.slice(0, 200),
          by: auth.actor.fullName,
        } as any,
      } as any);
    } catch { /* non-critical */ }

    return NextResponse.json({ ok: true, updated, timeBudgetMinutes: minutes });
  } catch (err: any) {
    if (/time_budget_minutes/.test(err?.message || "")) {
      return NextResponse.json({ error: "Time budgets aren't set up yet (migration 146)." }, { status: 503 });
    }
    console.error(`[time-budgets] bulk PATCH: ${err?.message}`);
    return NextResponse.json({ error: err?.message || "Failed to set budgets" }, { status: 500 });
  }
}

export async function GET() {
  const supabase = await createServerSupabase();
  const service = createServiceSupabase();
  const auth = await requireTimerActor(supabase, service, { seniorOnly: true });
  if ("error" in auth) {
    return NextResponse.json(
      { error: auth.error === "unauthorized" ? "Unauthorized" : "Forbidden — admin or lead only" },
      { status: auth.error === "unauthorized" ? 401 : 403 }
    );
  }

  const { data, error } = await service
    .from("client_links")
    .select("id, client_name, is_active, service_tier, assigned_bookkeeper_id, time_budget_minutes")
    .eq("is_active", true)
    .order("client_name");
  if (error) {
    // time_budget_minutes missing → migration 146 not applied yet. Degrade to a
    // plain client list so the page still renders and says what's wrong.
    if (/time_budget_minutes/.test(error.message || "")) {
      const { data: plain } = await service
        .from("client_links")
        .select("id, client_name, is_active, service_tier, assigned_bookkeeper_id")
        .eq("is_active", true)
        .order("client_name");
      return NextResponse.json({
        defaultBudgetMinutes: DEFAULT_TIME_BUDGET_MINUTES,
        setup_pending: true,
        clients: (plain || []).map((c: any) => ({
          clientLinkId: c.id,
          clientName: c.client_name,
          serviceTier: c.service_tier ?? null,
          assignedBookkeeperId: c.assigned_bookkeeper_id ?? null,
          budgetMinutes: DEFAULT_TIME_BUDGET_MINUTES,
          budgetIsDefault: true,
        })),
      });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Name the assigned bookkeepers so the table can be read by owner.
  const ownerIds = [...new Set((data || []).map((c: any) => c.assigned_bookkeeper_id).filter(Boolean))];
  const owners = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data: users } = await service.from("users").select("id, full_name").in("id", ownerIds as string[]);
    for (const u of users || []) owners.set((u as any).id, (u as any).full_name || "—");
  }

  return NextResponse.json({
    defaultBudgetMinutes: DEFAULT_TIME_BUDGET_MINUTES,
    clients: (data || []).map((c: any) => ({
      clientLinkId: c.id,
      clientName: c.client_name,
      serviceTier: c.service_tier ?? null,
      assignedBookkeeperId: c.assigned_bookkeeper_id ?? null,
      assignedBookkeeperName: c.assigned_bookkeeper_id ? owners.get(c.assigned_bookkeeper_id) ?? null : null,
      // NULL means "inherit the default" — surfaced, not silently substituted.
      budgetMinutes: c.time_budget_minutes ?? DEFAULT_TIME_BUDGET_MINUTES,
      budgetIsDefault: c.time_budget_minutes == null,
    })),
  });
}
