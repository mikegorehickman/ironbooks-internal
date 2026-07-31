import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  currentMonth,
  monthRangeUtc,
  weekRangeUtc,
  workingDaysInMonth,
  attributionDay,
  effectiveBudgetMinutes,
  effectiveDailyTargetMinutes,
  formatDuration,
} from "@/lib/time-tracking";
import { requireTimerActor, myProgress, tableMissing } from "@/lib/time-tracking-server";

/**
 * GET /api/time-tracking/scoreboard?month=YYYY-MM   (READ-ONLY)
 *
 * The team scoreboard. Visible to every production person — which is exactly why
 * it is scored the way it is.
 *
 * HOURS ARE THE DENOMINATOR, NEVER THE SCORE. If the board ranked logged hours,
 * the rational play would be to leave the timer running, and the cost-to-serve
 * numbers this whole feature exists to produce would turn into fiction. So the
 * team is scored on OUTCOMES — how many clients came in at or under budget, how
 * many client-months got closed, how much of the team's time went to client work
 * rather than overhead — with hours only ever as the divisor.
 *
 * Visibility (Mike's call): TEAM totals are shared with everyone; per-person rows
 * are returned only to admins/leads, plus the caller's own row. Nobody sees a
 * teammate's hours. `you` is always the caller's own private progress.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
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
  const url = new URL(request.url);
  const monthParam = url.searchParams.get("month") || "";
  const month = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : currentMonth(nowMs);

  let range: { startUtc: string; endUtc: string };
  try {
    range = monthRangeUtc(month);
  } catch {
    return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 });
  }
  const week = weekRangeUtc(nowMs);

  try {
    // Production staff — the denominator population for team goals.
    const staffQ = await service
      .from("users")
      .select("id, full_name, role, is_active, daily_target_minutes")
      .in("role", ["admin", "lead", "bookkeeper"] as any)
      .eq("is_active", true);
    const staff: any[] = (staffQ.error ? [] : staffQ.data) || [];
    const staffById = new Map(staff.map((u) => [u.id, u]));

    // Completed client + overhead time for the month.
    const { data: rows, error } = await (service as any)
      .from("time_entries")
      .select("id, user_id, client_link_id, category, accumulated_seconds, ended_at")
      .eq("status", "completed")
      .gte("ended_at", range.startUtc)
      .lt("ended_at", range.endUtc);
    if (error) throw error;
    const entries: any[] = rows || [];

    const clientIds = [...new Set(entries.map((e) => e.client_link_id).filter(Boolean))];
    const { data: clients } = clientIds.length
      ? await service.from("client_links").select("id, client_name, time_budget_minutes").in("id", clientIds)
      : { data: [] as any[] };
    const clientById = new Map<string, any>(((clients || []) as any[]).map((c) => [c.id, c]));

    // ── Team totals ──
    let clientSeconds = 0;
    let overheadSeconds = 0;
    const perClient = new Map<string, number>();
    const perPerson = new Map<string, { client: number; overhead: number; days: Set<string> }>();
    for (const e of entries) {
      const secs = Math.max(0, e.accumulated_seconds | 0);
      const p = perPerson.get(e.user_id) || { client: 0, overhead: 0, days: new Set<string>() };
      if (e.ended_at) p.days.add(attributionDay(e.ended_at));
      if (e.client_link_id) {
        clientSeconds += secs;
        p.client += secs;
        perClient.set(e.client_link_id, (perClient.get(e.client_link_id) || 0) + secs);
      } else {
        overheadSeconds += secs;
        p.overhead += secs;
      }
      perPerson.set(e.user_id, p);
    }

    // Outcome #1: clients at or under budget. Under-budget is a WIN worth
    // showing — the only budget feedback today is being asked to explain an
    // overage, which makes the whole feature feel like a speed trap.
    const budgetRows = [...perClient.entries()].map(([id, secs]) => {
      const budgetMinutes = effectiveBudgetMinutes(clientById.get(id)?.time_budget_minutes);
      return {
        clientLinkId: id,
        clientName: clientById.get(id)?.client_name || "Unknown client",
        seconds: secs,
        budgetSeconds: budgetMinutes * 60,
        underBudget: secs <= budgetMinutes * 60,
      };
    });
    const onBudget = budgetRows.filter((r) => r.underBudget).length;
    const overBudget = budgetRows.length - onBudget;

    // Outcome #2: client-months closed. Read best-effort — the table may not be
    // readable in every environment, and a missing outcome should dim the tile,
    // not 500 the page.
    let closed: number | null = null;
    try {
      const { data: cm, error: cmErr } = await (service as any)
        .from("client_months")
        .select("id, period_month, status")
        .gte("period_month", `${month}-01`)
        .lte("period_month", `${month}-01`);
      if (!cmErr) {
        closed = (cm || []).filter((r: any) => /complete|closed|delivered/i.test(String(r.status || ""))).length;
      }
    } catch { /* outcome unavailable — tile shows as such */ }

    // Team goal, DERIVED from the per-person daily targets × working days. No
    // separate goal number to maintain and silently drift from the targets it's
    // supposed to be the sum of.
    const workingDays = workingDaysInMonth(month).length;
    const teamMonthGoalSeconds = staff.reduce(
      (sum, u) => sum + effectiveDailyTargetMinutes(u.daily_target_minutes) * 60 * workingDays,
      0
    );
    const weekWorkingDays = week.days.filter((d) => {
      const [y, m, dd] = d.split("-").map(Number);
      const dow = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
      return dow !== 0 && dow !== 6;
    }).length;
    const teamWeekGoalSeconds = staff.reduce(
      (sum, u) => sum + effectiveDailyTargetMinutes(u.daily_target_minutes) * 60 * weekWorkingDays,
      0
    );

    // This week's team total (its own query — the month range may not cover it).
    const { data: weekRows } = await (service as any)
      .from("time_entries")
      .select("user_id, client_link_id, accumulated_seconds")
      .eq("status", "completed")
      .gte("ended_at", week.startUtc)
      .lt("ended_at", week.endUtc);
    const weekSeconds = (weekRows || []).reduce((s: number, r: any) => s + Math.max(0, r.accumulated_seconds | 0), 0);

    const tracked = clientSeconds + overheadSeconds;
    const you = await myProgress(service, actor.userId, nowMs, {
      targetMinutesRaw: staffById.get(actor.userId)?.daily_target_minutes ?? null,
    }).catch(() => null);

    // Per-person rows: managers see the team; everyone else sees only themselves.
    const canSeeEveryone = actor.isSenior;
    const people = staff
      .filter((u) => canSeeEveryone || u.id === actor.userId)
      .map((u) => {
        const p = perPerson.get(u.id) || { client: 0, overhead: 0, days: new Set<string>() };
        const total = p.client + p.overhead;
        return {
          userId: u.id,
          userName: u.full_name || "—",
          role: u.role,
          isYou: u.id === actor.userId,
          clientSeconds: p.client,
          overheadSeconds: p.overhead,
          totalSeconds: total,
          daysWorked: p.days.size,
          // The efficiency lens: share of tracked time that went to client work.
          clientSharePct: total > 0 ? Math.round((p.client / total) * 100) : null,
        };
      })
      .sort((a, b) => b.totalSeconds - a.totalSeconds);

    return NextResponse.json({
      month,
      serverNow: new Date(nowMs).toISOString(),
      canSeeEveryone,
      /** Shared with the whole team. */
      team: {
        trackedSeconds: tracked,
        clientSeconds,
        overheadSeconds,
        clientSharePct: tracked > 0 ? Math.round((clientSeconds / tracked) * 100) : null,
        monthGoalSeconds: teamMonthGoalSeconds,
        monthGoalPct: teamMonthGoalSeconds > 0 ? Math.round((tracked / teamMonthGoalSeconds) * 100) : null,
        weekSeconds,
        weekGoalSeconds: teamWeekGoalSeconds,
        weekGoalPct: teamWeekGoalSeconds > 0 ? Math.round((weekSeconds / teamWeekGoalSeconds) * 100) : null,
        peopleLogging: [...perPerson.keys()].length,
        peopleTotal: staff.length,
        workingDays,
      },
      /** Outcomes — what the board is actually scored on. */
      outcomes: {
        clientsWorked: budgetRows.length,
        onBudget,
        overBudget,
        onBudgetPct: budgetRows.length > 0 ? Math.round((onBudget / budgetRows.length) * 100) : null,
        monthsClosed: closed,
        // Best under-budget results, to celebrate rather than only flag overages.
        wins: budgetRows
          .filter((r) => r.underBudget && r.budgetSeconds > 0)
          .map((r) => ({
            clientName: r.clientName,
            seconds: r.seconds,
            budgetSeconds: r.budgetSeconds,
            underByPct: Math.round(((r.budgetSeconds - r.seconds) / r.budgetSeconds) * 100),
            summary: `${formatDuration(r.seconds)} of ${formatDuration(r.budgetSeconds)}`,
          }))
          .sort((a, b) => b.underByPct - a.underByPct)
          .slice(0, 5),
      },
      /** Always the caller's own — private. */
      you,
      people,
    });
  } catch (err: any) {
    if (tableMissing(err)) {
      return NextResponse.json({ month, setup_pending: true, team: null, outcomes: null, you: null, people: [] });
    }
    console.error("[time-tracking/scoreboard]", err?.message);
    return NextResponse.json({ error: "Failed to load the scoreboard" }, { status: 500 });
  }
}
