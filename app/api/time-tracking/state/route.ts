import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { OVERHEAD_CATEGORIES, currentMonth, monthRangeUtc, resolvePathContext, type JobTable } from "@/lib/time-tracking";
import {
  requireTimerActor,
  sweepStaleEntries,
  fetchRunningEntry,
  fetchPausedEntries,
  clientMonthToDateSeconds,
  clientBudgetMinutes,
  toEntryView,
  myProgress,
  tableMissing,
} from "@/lib/time-tracking-server";

/**
 * GET /api/time-tracking/state?path=<pathname+search>   (READ-ONLY)
 *
 * Everything the floating widget needs in ONE round-trip per navigation:
 *   - context:   the client this page is about (null on fleet/admin pages).
 *                Path-param and ?client= shapes resolve locally; job-id routes
 *                (/reclass/<id>/review etc.) are resolved here by reading the
 *                job row — that lookup is why this is a server endpoint.
 *   - running / paused[]: the caller's own entries, with server-computed elapsed
 *   - mtdSeconds / budgetMinutes: this client's month so far vs its budget, so
 *                the widget's warning uses the same numbers the complete check
 *                will enforce
 *   - serverNow: the clock the widget ticks against (kills client clock skew)
 *
 * Also lazily auto-pauses the caller's own abandoned timers (see
 * sweepStaleEntries) — the cheap alternative to a cron.
 *
 * admin / lead / bookkeeper only. Returns 200 with empty state (never 500) when
 * migration 146 hasn't been applied yet.
 */
export const dynamic = "force-dynamic";

/** Job table → the column holding the client id. */
const JOB_CLIENT_COL: Record<JobTable, string> = {
  reclass_jobs: "client_link_id",
  coa_jobs: "client_link_id",
  rule_discovery_jobs: "client_link_id",
  stripe_recon_jobs: "client_link_id",
  uf_ar_jobs: "client_link_id",
};

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
  const serverNow = new Date(nowMs).toISOString();

  // ── Resolve which client (if any) this page is about ──
  const path = new URL(request.url).searchParams.get("path") || "";
  let clientLinkId: string | null = null;
  const ctx = resolvePathContext(path);
  if (ctx?.kind === "client") {
    clientLinkId = ctx.clientLinkId;
  } else if (ctx?.kind === "job") {
    try {
      const { data: job } = await (service as any)
        .from(ctx.table)
        .select(JOB_CLIENT_COL[ctx.table])
        .eq("id", ctx.jobId)
        .maybeSingle();
      clientLinkId = (job as any)?.[JOB_CLIENT_COL[ctx.table]] ?? null;
    } catch {
      clientLinkId = null; // unknown job / missing table → just no context
    }
  }

  try {
    await sweepStaleEntries(service, { userId: actor.userId, nowMs });

    const [running, paused] = await Promise.all([
      fetchRunningEntry(service, actor.userId),
      fetchPausedEntries(service, actor.userId),
    ]);

    // Name every client we're about to mention, in one query. (Overhead entries
    // carry no client_link_id — their label comes from the category.)
    const ids = new Set<string>();
    if (clientLinkId) ids.add(clientLinkId);
    if (running?.client_link_id) ids.add(running.client_link_id);
    for (const p of paused) if (p.client_link_id) ids.add(p.client_link_id);
    const names = new Map<string, string>();
    if (ids.size > 0) {
      const { data: clients } = await service
        .from("client_links")
        .select("id, client_name")
        .in("id", [...ids]);
      for (const c of (clients || []) as any[]) names.set(c.id, c.client_name);
    }

    // Budget context for the page's client (what the widget's bar shows).
    let mtdSeconds = 0;
    let budgetMinutes: number | null = null;
    if (clientLinkId) {
      const month = currentMonth(nowMs);
      [mtdSeconds, budgetMinutes] = await Promise.all([
        clientMonthToDateSeconds(service, clientLinkId, month),
        clientBudgetMinutes(service, clientLinkId),
      ]);
    }

    // Own progress (the private nudge) + what to pick up next.
    const { data: profile } = await service
      .from("users")
      .select("daily_target_minutes")
      .eq("id", actor.userId)
      .maybeSingle();
    const me = await myProgress(service, actor.userId, nowMs, {
      targetMinutesRaw: (profile as any)?.daily_target_minutes ?? null,
    }).catch(() => null);
    const suggestions = await nextClientSuggestions(service, actor.userId, nowMs, {
      excludeClientLinkId: running?.client_link_id ?? clientLinkId ?? null,
    }).catch(() => []);

    return NextResponse.json({
      serverNow,
      context: clientLinkId
        ? { clientLinkId, clientName: names.get(clientLinkId) ?? null, mtdSeconds, budgetMinutes }
        : null,
      running: running ? toEntryView(running, nowMs, running.client_link_id ? names.get(running.client_link_id) : null) : null,
      paused: paused.map((p) => toEntryView(p, nowMs, p.client_link_id ? names.get(p.client_link_id) : null)),
      /** The caller's OWN day/week progress — private; never a teammate's. */
      me,
      /** Assigned clients to jump to next, least-tracked first, so finishing one
       *  session rolls into the next instead of hunting for it. */
      suggestions,
      /** For the widget's "what are you working on?" picker on non-client pages. */
      categories: OVERHEAD_CATEGORIES,
    });
  } catch (err: any) {
    if (tableMissing(err)) {
      // Migration 146 not applied yet — the widget stays quiet instead of erroring.
      return NextResponse.json({
        serverNow, context: null, running: null, paused: [],
        categories: OVERHEAD_CATEGORIES, me: null, suggestions: [], setup_pending: true,
      });
    }
    console.error("[time-tracking/state]", err?.message);
    return NextResponse.json({ error: "Failed to load timer state" }, { status: 500 });
  }
}

/**
 * Clients this person is assigned to, ordered by LEAST time logged this month.
 *
 * Rotation, not ranking: the client nobody has touched this month is the one
 * most likely to need attention, and offering it right after a Complete turns
 * "what next?" into one click. Excludes whatever is already running or already
 * on screen — suggesting the thing you're doing is noise.
 */
async function nextClientSuggestions(
  service: any,
  userId: string,
  nowMs: number,
  opts: { excludeClientLinkId?: string | null } = {}
): Promise<{ clientLinkId: string; clientName: string; loggedSeconds: number }[]> {
  const { data: mine } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("assigned_bookkeeper_id", userId)
    .eq("is_active", true)
    .order("client_name");
  const clients: any[] = mine || [];
  if (clients.length === 0) return [];

  const range = monthRangeUtc(currentMonth(nowMs));
  const { data: monthRows } = await (service as any)
    .from("time_entries")
    .select("client_link_id, accumulated_seconds")
    .eq("status", "completed")
    .gte("ended_at", range.startUtc)
    .lt("ended_at", range.endUtc);
  const logged = new Map<string, number>();
  for (const r of (monthRows || []) as any[]) {
    if (!r.client_link_id) continue;
    logged.set(r.client_link_id, (logged.get(r.client_link_id) || 0) + Math.max(0, r.accumulated_seconds | 0));
  }

  return clients
    .filter((c) => c.id !== opts.excludeClientLinkId)
    .map((c) => ({ clientLinkId: c.id, clientName: c.client_name, loggedSeconds: logged.get(c.id) || 0 }))
    .sort((a, b) => a.loggedSeconds - b.loggedSeconds || a.clientName.localeCompare(b.clientName))
    .slice(0, 3);
}
