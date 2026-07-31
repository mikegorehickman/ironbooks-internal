import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { DEFAULT_DAILY_TARGET_MINUTES } from "@/lib/time-tracking";
import { requireTimerActor } from "@/lib/time-tracking-server";

/**
 * Daily logging targets — how many minutes a day we expect each person to log
 * (migration 148). Admin / lead only.
 *
 * GET  → every active production person + their effective target.
 * PATCH { userIds: string[], dailyTargetMinutes: number|null }
 *        Set one person or the whole team in a call. null inherits the app
 *        default; 0 means "no target" (someone not doing production work) and is
 *        preserved as 0, never coalesced back to the default.
 */
export const dynamic = "force-dynamic";
const PRODUCTION_ROLES = ["admin", "lead", "bookkeeper"] as any;

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
    .from("users")
    .select("id, full_name, role, daily_target_minutes")
    .in("role", PRODUCTION_ROLES)
    .eq("is_active", true)
    .order("full_name");
  if (error) {
    if (/daily_target_minutes/.test(error.message || "")) {
      return NextResponse.json(
        { error: "Daily targets aren't set up yet (migration 148).", setup_pending: true },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    defaultDailyTargetMinutes: DEFAULT_DAILY_TARGET_MINUTES,
    users: (data || []).map((u: any) => ({
      userId: u.id,
      userName: u.full_name || "—",
      role: u.role,
      dailyTargetMinutes: u.daily_target_minutes ?? DEFAULT_DAILY_TARGET_MINUTES,
      targetIsDefault: u.daily_target_minutes == null,
    })),
  });
}

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
  const ids = Array.isArray(body.userIds)
    ? [...new Set(body.userIds.map((v: any) => String(v || "").trim()).filter(Boolean))]
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "userIds must be a non-empty array" }, { status: 400 });
  }

  const raw = body.dailyTargetMinutes;
  let minutes: number | null;
  if (raw === null || raw === "" || typeof raw === "undefined") {
    minutes = null;
  } else {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 1440) {
      return NextResponse.json(
        { error: "dailyTargetMinutes must be null or a whole number of minutes between 0 and 1440" },
        { status: 400 }
      );
    }
    minutes = n;
  }

  try {
    // Scoped to production roles so this can never touch a client or
    // billing-only account.
    const { data, error } = await (service as any)
      .from("users")
      .update({ daily_target_minutes: minutes })
      .in("id", ids)
      .in("role", PRODUCTION_ROLES)
      .select("id");
    if (error) throw error;

    try {
      await (service as any).from("audit_log").insert({
        user_id: auth.actor.userId,
        event_type: "time_daily_targets_set",
        request_payload: {
          daily_target_minutes: minutes,
          requested: ids.length,
          updated: (data || []).length,
          user_ids: ids,
          by: auth.actor.fullName,
        } as any,
      } as any);
    } catch { /* non-critical */ }

    return NextResponse.json({ ok: true, updated: (data || []).length, dailyTargetMinutes: minutes });
  } catch (err: any) {
    if (/daily_target_minutes/.test(err?.message || "")) {
      return NextResponse.json({ error: "Daily targets aren't set up yet (migration 148)." }, { status: 503 });
    }
    console.error(`[time-targets] PATCH: ${err?.message}`);
    return NextResponse.json({ error: err?.message || "Failed to set targets" }, { status: 500 });
  }
}
