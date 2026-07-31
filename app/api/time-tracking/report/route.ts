import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  DEFAULT_TIME_BUDGET_MINUTES,
  currentMonth,
  monthRangeUtc,
  effectiveBudgetMinutes,
  elapsedSeconds,
  overheadLabel,
  attributionDay,
  daysInMonth,
  effectiveDailyTargetMinutes,
  isBelowDailyTarget,
} from "@/lib/time-tracking";
import { requireTimerActor, sweepStaleEntries, tableMissing, ENTRY_COLS } from "@/lib/time-tracking-server";

/**
 * GET /api/time-tracking/report?month=YYYY-MM&userId=&clientLinkId=   (READ-ONLY)
 *
 * The management view: for one month, how much time each client actually took
 * versus its budget, who spent it, and — where a client went over — the notes
 * explaining why.
 *
 * Rules that make the numbers trustworthy:
 *   - A session belongs to the month it was COMPLETED in (ended_at), measured in
 *     the business timezone. So a closed month never changes retroactively.
 *   - Discarded sessions are excluded entirely; in-flight (running/paused) time
 *     is reported SEPARATELY as "open" so it can't quietly inflate actuals.
 *   - Budgets shown are today's; each over-budget note also carries the budget
 *     it was judged against at completion time.
 *   - Sweeps abandoned timers fleet-wide first, so "open" isn't full of zombies.
 *
 * Admin / lead only.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;
/** Paused this long with no activity is a forgotten timer, not a break. */
const ZOMBIE_PAUSE_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const service = createServiceSupabase();
  const auth = await requireTimerActor(supabase, service, { seniorOnly: true });
  if ("error" in auth) {
    return NextResponse.json(
      { error: auth.error === "unauthorized" ? "Unauthorized" : "Forbidden — admin or lead only" },
      { status: auth.error === "unauthorized" ? 401 : 403 }
    );
  }

  const nowMs = Date.now();
  const url = new URL(request.url);
  const monthParam = url.searchParams.get("month") || "";
  const month = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : currentMonth(nowMs);
  const userFilter = url.searchParams.get("userId") || null;
  const clientFilter = url.searchParams.get("clientLinkId") || null;

  let range: { startUtc: string; endUtc: string };
  try {
    range = monthRangeUtc(month);
  } catch {
    return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 });
  }

  try {
    await sweepStaleEntries(service, { nowMs });

    // Completed sessions in the month + everything still open (any month).
    let completedQ = (service as any)
      .from("time_entries")
      .select(ENTRY_COLS)
      .eq("status", "completed")
      .gte("ended_at", range.startUtc)
      .lt("ended_at", range.endUtc)
      .order("ended_at", { ascending: false });
    if (userFilter) completedQ = completedQ.eq("user_id", userFilter);
    if (clientFilter) completedQ = completedQ.eq("client_link_id", clientFilter);

    let openQ = (service as any)
      .from("time_entries")
      .select(ENTRY_COLS)
      .in("status", ["running", "paused"])
      .order("started_at", { ascending: false });
    if (userFilter) openQ = openQ.eq("user_id", userFilter);
    if (clientFilter) openQ = openQ.eq("client_link_id", clientFilter);

    const [{ data: completedRows, error: cErr }, { data: openRows }] = await Promise.all([completedQ, openQ]);
    if (cErr) throw cErr;
    const allCompleted: any[] = completedRows || [];
    const allOpen: any[] = openRows || [];
    // Client work drives the budget comparison; overhead (migration 147) is
    // reported on its own and must never touch a client's numbers.
    const completed = allCompleted.filter((r) => r.client_link_id);
    const open = allOpen.filter((r) => r.client_link_id);
    const overheadCompleted = allCompleted.filter((r) => !r.client_link_id && r.category);
    const overheadOpen = allOpen.filter((r) => !r.client_link_id && r.category);

    // Name the clients and the people, in two queries.
    const clientIds = [...new Set([...completed, ...open].map((r) => r.client_link_id))];
    const userIds = [...new Set([...allCompleted, ...allOpen].map((r) => r.user_id))];
    const [{ data: clients }, { data: users }] = await Promise.all([
      clientIds.length
        ? service.from("client_links").select("id, client_name, time_budget_minutes, is_active").in("id", clientIds)
        : Promise.resolve({ data: [] as any[] }),
      userIds.length
        ? service.from("users").select("id, full_name, role").in("id", userIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const clientById = new Map<string, any>(((clients || []) as any[]).map((c) => [c.id, c]));
    const userById = new Map<string, any>(((users || []) as any[]).map((u) => [u.id, u]));
    const userName = (id: string) => (userById.get(id)?.full_name as string) || "Unknown";

    // ── Per-client rollup ──
    type Row = {
      clientLinkId: string;
      clientName: string;
      isActive: boolean;
      budgetMinutes: number;
      budgetIsDefault: boolean;
      actualSeconds: number;
      openSeconds: number;
      sessions: number;
      overBudget: boolean;
      overBySeconds: number;
      byUser: { userId: string; userName: string; seconds: number; sessions: number }[];
      notes: {
        entryId: string;
        userName: string;
        endedAt: string | null;
        seconds: number;
        note: string;
        budgetMinutesAtCompletion: number | null;
        mtdSecondsAtCompletion: number | null;
      }[];
    };
    const rows = new Map<string, Row>();
    const rowFor = (clientLinkId: string): Row => {
      let r = rows.get(clientLinkId);
      if (!r) {
        const c = clientById.get(clientLinkId);
        const raw = c?.time_budget_minutes;
        r = {
          clientLinkId,
          clientName: c?.client_name || "Unknown client",
          isActive: c?.is_active !== false,
          budgetMinutes: effectiveBudgetMinutes(raw),
          budgetIsDefault: raw === null || typeof raw === "undefined",
          actualSeconds: 0,
          openSeconds: 0,
          sessions: 0,
          overBudget: false,
          overBySeconds: 0,
          byUser: [],
          notes: [],
        };
        rows.set(clientLinkId, r);
      }
      return r;
    };

    const perUser = new Map<string, Map<string, { seconds: number; sessions: number }>>();
    for (const e of completed) {
      const r = rowFor(e.client_link_id);
      const secs = Math.max(0, e.accumulated_seconds | 0);
      r.actualSeconds += secs;
      r.sessions += 1;
      const byUser = perUser.get(e.client_link_id) || new Map();
      const cur = byUser.get(e.user_id) || { seconds: 0, sessions: 0 };
      byUser.set(e.user_id, { seconds: cur.seconds + secs, sessions: cur.sessions + 1 });
      perUser.set(e.client_link_id, byUser);
      if (e.over_budget_note) {
        r.notes.push({
          entryId: e.id,
          userName: userName(e.user_id),
          endedAt: e.ended_at,
          seconds: secs,
          note: e.over_budget_note,
          budgetMinutesAtCompletion: e.budget_minutes_at_completion ?? null,
          mtdSecondsAtCompletion: e.mtd_seconds_at_completion ?? null,
        });
      }
    }
    for (const e of open) {
      const r = rowFor(e.client_link_id);
      r.openSeconds += elapsedSeconds(e, nowMs);
    }
    for (const r of rows.values()) {
      const byUser = perUser.get(r.clientLinkId);
      r.byUser = byUser
        ? [...byUser.entries()]
            .map(([userId, v]) => ({ userId, userName: userName(userId), seconds: v.seconds, sessions: v.sessions }))
            .sort((a, b) => b.seconds - a.seconds)
        : [];
      const budgetSeconds = r.budgetMinutes * 60;
      r.overBudget = r.actualSeconds > budgetSeconds;
      r.overBySeconds = Math.max(0, r.actualSeconds - budgetSeconds);
    }

    // ── Overhead rollup — work belonging to no single client ──
    const overheadByCategory = new Map<string, { category: string; label: string; seconds: number; sessions: number }>();
    for (const e of overheadCompleted) {
      const cur = overheadByCategory.get(e.category) || {
        category: e.category,
        label: overheadLabel(e.category) || e.category,
        seconds: 0,
        sessions: 0,
      };
      cur.seconds += Math.max(0, e.accumulated_seconds | 0);
      cur.sessions += 1;
      overheadByCategory.set(e.category, cur);
    }
    const overheadSeconds = [...overheadByCategory.values()].reduce((s, c) => s + c.seconds, 0);

    // ── Per-bookkeeper rollup ──
    // The question this answers isn't just "who logged the most" — it's how a
    // person's month is actually shaped: which days they worked, how long, how
    // many clients they touched in a day, and how much of it was client work vs
    // overhead. Days are keyed in the business timezone (same rule as the month)
    // so an evening session lands on the day the bookkeeper thinks it did.
    type DayBucket = {
      date: string;
      seconds: number;
      clientSeconds: number;
      overheadSeconds: number;
      sessions: number;
      clients: Set<string>;
    };
    type Staff = {
      userId: string; userName: string; role: string | null;
      seconds: number; overheadSeconds: number; sessions: number;
      clients: Set<string>;
      days: Map<string, DayBucket>;
      perClient: Map<string, number>;
    };
    const staff = new Map<string, Staff>();
    const staffFor = (userId: string): Staff => {
      let s = staff.get(userId);
      if (!s) {
        s = {
          userId,
          userName: userName(userId),
          role: userById.get(userId)?.role ?? null,
          seconds: 0, overheadSeconds: 0, sessions: 0,
          clients: new Set<string>(),
          days: new Map<string, DayBucket>(),
          perClient: new Map<string, number>(),
        };
        staff.set(userId, s);
      }
      return s;
    };
    const dayFor = (s: Staff, iso: string | null): DayBucket | null => {
      if (!iso) return null;
      const date = attributionDay(iso);
      let d = s.days.get(date);
      if (!d) {
        d = { date, seconds: 0, clientSeconds: 0, overheadSeconds: 0, sessions: 0, clients: new Set<string>() };
        s.days.set(date, d);
      }
      return d;
    };

    for (const e of completed) {
      const secs = Math.max(0, e.accumulated_seconds | 0);
      const s = staffFor(e.user_id);
      s.seconds += secs;
      s.sessions += 1;
      s.clients.add(e.client_link_id);
      s.perClient.set(e.client_link_id, (s.perClient.get(e.client_link_id) || 0) + secs);
      const d = dayFor(s, e.ended_at);
      if (d) { d.seconds += secs; d.clientSeconds += secs; d.sessions += 1; d.clients.add(e.client_link_id); }
    }
    for (const e of overheadCompleted) {
      const secs = Math.max(0, e.accumulated_seconds | 0);
      const s = staffFor(e.user_id);
      s.overheadSeconds += secs;
      s.sessions += 1;
      const d = dayFor(s, e.ended_at);
      if (d) { d.seconds += secs; d.overheadSeconds += secs; d.sessions += 1; }
    }

    // Include every production person even at zero — "who ISN'T logging" is the
    // adoption signal a rollup built only from existing rows can never show.
    // Managers (lead) do production too, so they're in scope; billing_admin,
    // viewer and client are not.
    // Daily targets come from the same read (migration 148); if the column
    // isn't there yet, fall back so the report still renders.
    let productionStaff: any[] | null = null;
    {
      const withTarget = await service
        .from("users")
        .select("id, full_name, role, is_active, daily_target_minutes")
        .in("role", ["admin", "lead", "bookkeeper"])
        .eq("is_active", true);
      if (withTarget.error && /daily_target_minutes/.test(withTarget.error.message || "")) {
        const plain = await service
          .from("users")
          .select("id, full_name, role, is_active")
          .in("role", ["admin", "lead", "bookkeeper"])
          .eq("is_active", true);
        productionStaff = plain.data as any[] | null;
      } else {
        productionStaff = withTarget.data as any[] | null;
      }
    }
    for (const u of (productionStaff || []) as any[]) {
      if (!userById.has(u.id)) userById.set(u.id, u);
      staffFor(u.id); // creates a zero row if they logged nothing
    }

    // ── Forgotten timers (paused for a week+, or auto-paused) ──
    const zombies = [...open, ...overheadOpen]
      .filter((e) => e.auto_paused || (e.status === "paused" && nowMs - Date.parse(e.updated_at) > ZOMBIE_PAUSE_MS))
      .map((e) => ({
        entryId: e.id,
        clientName: e.client_link_id
          ? clientById.get(e.client_link_id)?.client_name || "Unknown client"
          : overheadLabel(e.category) || "Overhead",
        userName: userName(e.user_id),
        status: e.status,
        autoPaused: !!e.auto_paused,
        seconds: elapsedSeconds(e, nowMs),
        startedAt: e.started_at,
        updatedAt: e.updated_at,
      }));

    const clientRows = [...rows.values()].sort((a, b) => b.actualSeconds - a.actualSeconds);
    const clientSeconds = clientRows.reduce((s, r) => s + r.actualSeconds, 0);
    return NextResponse.json({
      month,
      range,
      serverNow: new Date(nowMs).toISOString(),
      defaultBudgetMinutes: DEFAULT_TIME_BUDGET_MINUTES,
      totals: {
        trackedSeconds: clientSeconds,
        overheadSeconds,
        // Client work as a share of all tracked time — the utilization figure.
        clientSharePct: clientSeconds + overheadSeconds > 0
          ? Math.round((clientSeconds / (clientSeconds + overheadSeconds)) * 100)
          : null,
        openSeconds: clientRows.reduce((s, r) => s + r.openSeconds, 0),
        sessions: completed.length,
        overheadSessions: overheadCompleted.length,
        clients: clientRows.length,
        overBudgetClients: clientRows.filter((r) => r.overBudget).length,
      },
      clients: clientRows,
      /** Work belonging to no single client — never counted against a budget. */
      overhead: [...overheadByCategory.values()].sort((a, b) => b.seconds - a.seconds),
      /** Calendar days of the month, so the daily chart can show empty days. */
      monthDays: daysInMonth(month),
      staff: [...staff.values()]
        .map((s) => {
          const byDay = [...s.days.values()].sort((a, b) => a.date.localeCompare(b.date));
          const total = s.seconds + s.overheadSeconds;
          const activeDays = byDay.filter((d) => d.seconds > 0).length;
          const busiest = byDay.reduce<{ date: string; seconds: number } | null>(
            (best, d) => (!best || d.seconds > best.seconds ? { date: d.date, seconds: d.seconds } : best),
            null
          );
          const targetMinutes = effectiveDailyTargetMinutes(userById.get(s.userId)?.daily_target_minutes);
          const daysBelowTarget = byDay.filter((d) => isBelowDailyTarget(d.seconds, targetMinutes)).length;
          return {
            userId: s.userId,
            userName: s.userName,
            role: s.role,
            targetMinutes,
            targetIsDefault: userById.get(s.userId)?.daily_target_minutes == null,
            daysBelowTarget,
            seconds: s.seconds,               // client work
            overheadSeconds: s.overheadSeconds,
            totalSeconds: total,
            sessions: s.sessions,
            clients: s.clients.size,
            activeDays,
            // Averaged over days actually worked, not calendar days — otherwise
            // part-timers and mid-month starters look idle.
            avgSecondsPerActiveDay: activeDays > 0 ? Math.round(total / activeDays) : 0,
            busiestDay: busiest,
            byDay: byDay.map((d) => ({
              date: d.date,
              belowTarget: isBelowDailyTarget(d.seconds, targetMinutes),
              seconds: d.seconds,
              clientSeconds: d.clientSeconds,
              overheadSeconds: d.overheadSeconds,
              sessions: d.sessions,
              clients: d.clients.size,
              clientNames: [...d.clients]
                .map((id) => clientById.get(id)?.client_name || "Unknown client")
                .sort(),
            })),
            topClients: [...s.perClient.entries()]
              .map(([id, secs]) => ({
                clientLinkId: id,
                clientName: clientById.get(id)?.client_name || "Unknown client",
                seconds: secs,
              }))
              .sort((a, b) => b.seconds - a.seconds),
          };
        })
        // Anyone who logged nothing sinks to the bottom, but stays visible.
        .sort((a, b) => b.totalSeconds - a.totalSeconds || a.userName.localeCompare(b.userName)),
      zombies,
      entries: allCompleted.map((e) => ({
        id: e.id,
        clientLinkId: e.client_link_id,
        clientName: e.client_link_id
          ? clientById.get(e.client_link_id)?.client_name || "Unknown client"
          : overheadLabel(e.category) || "Overhead",
        category: e.category,
        userId: e.user_id,
        userName: userName(e.user_id),
        startedAt: e.started_at,
        endedAt: e.ended_at,
        seconds: Math.max(0, e.accumulated_seconds | 0),
        sourcePath: e.source_path,
        note: e.over_budget_note,
      })),
    });
  } catch (err: any) {
    if (tableMissing(err)) {
      return NextResponse.json({
        month,
        setup_pending: true,
        serverNow: new Date(nowMs).toISOString(),
        defaultBudgetMinutes: DEFAULT_TIME_BUDGET_MINUTES,
        totals: {
          trackedSeconds: 0, overheadSeconds: 0, clientSharePct: null, openSeconds: 0,
          sessions: 0, overheadSessions: 0, clients: 0, overBudgetClients: 0,
        },
        clients: [], overhead: [], staff: [], zombies: [], entries: [], monthDays: [],
      });
    }
    console.error("[time-tracking/report]", err?.message);
    return NextResponse.json({ error: "Failed to build the time report" }, { status: 500 });
  }
}
