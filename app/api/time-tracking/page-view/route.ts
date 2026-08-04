import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  requireTimerActor,
  fetchEntry,
  tableMissing,
  isUniqueViolation,
} from "@/lib/time-tracking-server";
import { PAGE_PING_MS, normalizeRoute } from "@/lib/time-tracking";

/**
 * POST /api/time-tracking/page-view   (WRITES — migration 155)
 *
 * Records which page a bookkeeper is sitting on WHILE A TIMER RUNS, so a
 * session can be broken down by route. Called three ways, all the same shape:
 *   - on navigation      → closes the open view, opens one for the new path
 *   - on the ~60s tick   → extends the open view
 *   - on unload/pause    → { close: true }, banks the open view and opens none
 *
 * Body: { entryId, path, close? }
 *
 * The timer must be RUNNING and owned by the caller. Paused, completed, or
 * somebody else's entry banks whatever was open and records nothing new — a
 * paused session is by definition not accruing, so neither is its breakdown.
 *
 * ACCRUAL. Time is added incrementally (now − last_seen_at), never as
 * now − entered_at, and each increment is capped at MAX_GAP_MS. A throttled or
 * sleeping tab therefore UNDER-counts rather than banking the gap; the report
 * shows the shortfall as "unattributed" instead of quietly inflating a page.
 * This is the same instinct as the timer's own stale cap, applied per page.
 */
export const dynamic = "force-dynamic";

/** Largest increment a single ping may add. Two ping intervals: tolerates one
 *  dropped tick, refuses to credit a tab that was asleep for an hour. */
const MAX_GAP_MS = 2 * PAGE_PING_MS;

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

  const body = await request.json().catch(() => ({}));
  const entryId = body.entryId ? String(body.entryId) : null;
  const rawPath = body.path ? String(body.path) : "";
  const close = body.close === true;
  if (!entryId) return NextResponse.json({ error: "entryId required" }, { status: 400 });

  // Pathname only — the query string is dropped before anything is stored.
  const qIdx = rawPath.indexOf("?");
  const path = ((qIdx >= 0 ? rawPath.slice(0, qIdx) : rawPath) || "/").slice(0, 300);
  const route = normalizeRoute(path).slice(0, 300);

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  try {
    // Ownership + liveness. Anything but a running entry of the caller's own
    // banks the open view and stops there.
    const entry = await fetchEntry(service, entryId);
    const live =
      !!entry && entry.user_id === auth.actor.userId && entry.status === "running";

    const { data: openRows } = await (service as any)
      .from("time_page_views")
      .select("id, path, entered_at, last_seen_at, seconds")
      .eq("entry_id", entryId)
      .is("exited_at", null)
      .limit(1);
    const open = ((openRows as any[]) || [])[0] || null;

    if (open) {
      const gapMs = Math.max(0, nowMs - Date.parse(open.last_seen_at));
      const addSeconds = Math.round(Math.min(gapMs, MAX_GAP_MS) / 1000);
      const seconds = (open.seconds || 0) + addSeconds;
      const samePage = open.path === path;

      if (live && samePage && !close) {
        await (service as any)
          .from("time_page_views")
          .update({ last_seen_at: now, seconds })
          .eq("id", open.id);
        return NextResponse.json({ ok: true, openId: open.id, seconds });
      }

      // Different page, closing, or the timer is no longer running: bank it.
      await (service as any)
        .from("time_page_views")
        .update({ last_seen_at: now, exited_at: now, seconds })
        .eq("id", open.id);
    }

    if (close || !live || !path) return NextResponse.json({ ok: true, openId: null });

    const { data: inserted, error: insErr } = await (service as any)
      .from("time_page_views")
      .insert({
        entry_id: entryId,
        user_id: auth.actor.userId,
        client_link_id: entry!.client_link_id ?? null,
        path,
        route,
        entered_at: now,
        last_seen_at: now,
        seconds: 0,
      })
      .select("id")
      .single();
    if (insErr) {
      // Lost a race with another tab on the same entry — the partial unique
      // index did its job. Their row is open; nothing to do.
      if (isUniqueViolation(insErr)) return NextResponse.json({ ok: true, raced: true });
      throw insErr;
    }

    return NextResponse.json({ ok: true, openId: (inserted as any)?.id ?? null });
  } catch (err: any) {
    // Pre-migration env, or anything else: page dwell is telemetry and must
    // never break a bookkeeper's timer.
    if (tableMissing(err)) return NextResponse.json({ ok: true, setup_pending: true });
    console.error("[time-tracking/page-view]", err?.message);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
