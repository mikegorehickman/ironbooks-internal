import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { requireTimerActor, tableMissing } from "@/lib/time-tracking-server";
import { currentMonth, describeRoute, monthRangeUtc } from "@/lib/time-tracking";

/**
 * GET /api/time-tracking/pages?month=YYYY-MM[&userId=][&clientLinkId=][&entryId=]
 *
 * "Where did the hours actually go" — page dwell (migration 155) rolled up by
 * route, by person, and by client. Admin/lead only, same gate as /time-report.
 *
 * Two shapes:
 *   entryId given → the breakdown for ONE session (the drill-down)
 *   otherwise     → the month, rolled up by route
 *
 * READING THIS HONESTLY. `attributedSeconds` will always be a little under the
 * tracked total: increments are capped server-side, so throttled background
 * tabs and short-lived pings lose a few seconds rather than inflating a page.
 * The gap is returned as `unattributedSeconds` instead of being hidden — if it
 * is large for someone, the answer is "they work outside SNAP" (QuickBooks,
 * spreadsheets, calls), not "they were idle".
 *
 * Also carries the 12-month retention sweep. There is no time-tracking cron;
 * this endpoint is senior-only and rarely hit, which makes it the right place
 * for a delete that is a no-op index scan on virtually every call.
 */
export const dynamic = "force-dynamic";

const RETENTION_DAYS = 365;

export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const service = createServiceSupabase();
  const auth = await requireTimerActor(supabase, service, { seniorOnly: true });
  if ("error" in auth) {
    return NextResponse.json(
      { error: auth.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: auth.error === "unauthorized" ? 401 : 403 }
    );
  }

  const nowMs = Date.now();
  const url = new URL(request.url);
  const monthParam = url.searchParams.get("month") || "";
  const month = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : currentMonth(nowMs);
  const userFilter = url.searchParams.get("userId") || null;
  const clientFilter = url.searchParams.get("clientLinkId") || null;
  const entryFilter = url.searchParams.get("entryId") || null;

  let range: { startUtc: string; endUtc: string };
  try {
    range = monthRangeUtc(month);
  } catch {
    return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 });
  }

  try {
    // Retention, best-effort — never let a failed purge break the report.
    try {
      const cutoff = new Date(nowMs - RETENTION_DAYS * 86400000).toISOString();
      await (service as any).from("time_page_views").delete().lt("entered_at", cutoff);
    } catch { /* ignore */ }

    // Paged fetch. A firm-month runs tens of thousands of rows, well past any
    // single-request cap — and a silently truncated total in an audit tool is
    // worse than no total, so we page to a hard ceiling and SAY when we hit it.
    const PAGE = 1000;
    const MAX_ROWS = 120_000;
    const COLS = "id, entry_id, user_id, client_link_id, path, route, entered_at, exited_at, seconds";
    const all: any[] = [];
    let truncated = false;
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      let q = (service as any).from("time_page_views").select(COLS);
      if (entryFilter) {
        // One session: no month window — a session started in the previous
        // month still belongs to whoever opened the drill-down.
        q = q.eq("entry_id", entryFilter).order("entered_at", { ascending: true });
      } else {
        q = q
          .gte("entered_at", range.startUtc)
          .lt("entered_at", range.endUtc)
          .order("entered_at", { ascending: false });
        if (userFilter) q = q.eq("user_id", userFilter);
        if (clientFilter) q = q.eq("client_link_id", clientFilter);
      }
      const { data: chunk, error } = await q.range(from, from + PAGE - 1);
      if (error) throw error;
      const got = (chunk as any[]) || [];
      all.push(...got);
      if (got.length < PAGE) break;
      if (from + PAGE >= MAX_ROWS) truncated = true;
    }
    if (truncated) {
      console.warn(`[time-tracking/pages] hit the ${MAX_ROWS}-row ceiling for ${month}`);
    }
    const views = all.filter((v) => (v.seconds || 0) > 0);

    // ── One session: ordered page-by-page walk ──
    if (entryFilter) {
      const attributed = views.reduce((s, v) => s + (v.seconds || 0), 0);
      const byRoute = new Map<string, { seconds: number; visits: number }>();
      for (const v of views) {
        const g = byRoute.get(v.route) || { seconds: 0, visits: 0 };
        g.seconds += v.seconds || 0;
        g.visits += 1;
        byRoute.set(v.route, g);
      }
      return NextResponse.json({
        entryId: entryFilter,
        attributedSeconds: attributed,
        routes: [...byRoute.entries()]
          .map(([route, g]) => ({ route, label: describeRoute(route), ...g }))
          .sort((a, b) => b.seconds - a.seconds),
        timeline: views.map((v) => ({
          id: v.id,
          path: v.path,
          route: v.route,
          label: describeRoute(v.route),
          seconds: v.seconds || 0,
          enteredAt: v.entered_at,
          exitedAt: v.exited_at,
        })),
      });
    }

    // ── Month rollup ──
    const userIds = [...new Set(views.map((v) => v.user_id).filter(Boolean))];
    const clientIds = [...new Set(views.map((v) => v.client_link_id).filter(Boolean))];
    const [{ data: users }, { data: clients }] = await Promise.all([
      userIds.length
        ? service.from("users").select("id, full_name, email").in("id", userIds)
        : Promise.resolve({ data: [] as any[] }),
      clientIds.length
        ? service.from("client_links").select("id, client_name").in("id", clientIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const userName = new Map(
      ((users as any[]) || []).map((u) => [u.id, u.full_name || u.email || "(unnamed)"])
    );
    const clientName = new Map(((clients as any[]) || []).map((c) => [c.id, c.client_name]));

    interface Roll { seconds: number; visits: number; users: Set<string>; clients: Set<string> }
    const byRoute = new Map<string, Roll>();
    const byUser = new Map<string, { seconds: number; routes: Map<string, number> }>();
    for (const v of views) {
      const secs = v.seconds || 0;
      const r = byRoute.get(v.route) || { seconds: 0, visits: 0, users: new Set(), clients: new Set() };
      r.seconds += secs;
      r.visits += 1;
      if (v.user_id) r.users.add(v.user_id);
      if (v.client_link_id) r.clients.add(v.client_link_id);
      byRoute.set(v.route, r);

      if (v.user_id) {
        const u = byUser.get(v.user_id) || { seconds: 0, routes: new Map<string, number>() };
        u.seconds += secs;
        u.routes.set(v.route, (u.routes.get(v.route) || 0) + secs);
        byUser.set(v.user_id, u);
      }
    }

    const attributedSeconds = views.reduce((s, v) => s + (v.seconds || 0), 0);

    // The denominator: sessions completed in this month, same filters. Lets the
    // UI state plainly how much of the tracked time this breakdown explains.
    let trackedQ = (service as any)
      .from("time_entries")
      .select("accumulated_seconds")
      .eq("status", "completed")
      .gte("ended_at", range.startUtc)
      .lt("ended_at", range.endUtc);
    if (userFilter) trackedQ = trackedQ.eq("user_id", userFilter);
    if (clientFilter) trackedQ = trackedQ.eq("client_link_id", clientFilter);
    const { data: tracked } = await trackedQ;
    const trackedSeconds = ((tracked as any[]) || []).reduce(
      (s, e) => s + (e.accumulated_seconds || 0),
      0
    );

    return NextResponse.json({
      month,
      truncated,
      trackedSeconds,
      attributedSeconds,
      unattributedSeconds: Math.max(0, trackedSeconds - attributedSeconds),
      routes: [...byRoute.entries()]
        .map(([route, r]) => ({
          route,
          label: describeRoute(route),
          seconds: r.seconds,
          visits: r.visits,
          people: r.users.size,
          clients: r.clients.size,
        }))
        .sort((a, b) => b.seconds - a.seconds),
      staff: [...byUser.entries()]
        .map(([userId, u]) => ({
          userId,
          name: userName.get(userId) || "(unknown)",
          seconds: u.seconds,
          topRoutes: [...u.routes.entries()]
            .map(([route, seconds]) => ({ route, label: describeRoute(route), seconds }))
            .sort((a, b) => b.seconds - a.seconds)
            .slice(0, 5),
        }))
        .sort((a, b) => b.seconds - a.seconds),
      clients: clientIds.length
        ? [...clientIds].map((id) => ({ clientLinkId: id, name: clientName.get(id) || "(unknown)" }))
        : [],
    });
  } catch (err: any) {
    if (tableMissing(err)) {
      return NextResponse.json({
        month, setup_pending: true,
        trackedSeconds: 0, attributedSeconds: 0, unattributedSeconds: 0,
        routes: [], staff: [], clients: [],
      });
    }
    console.error("[time-tracking/pages]", err?.message);
    return NextResponse.json({ error: "Failed to build the page breakdown" }, { status: 500 });
  }
}
