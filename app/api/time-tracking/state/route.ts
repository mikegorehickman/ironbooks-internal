import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { currentMonth, resolvePathContext, type JobTable } from "@/lib/time-tracking";
import {
  requireTimerActor,
  sweepStaleEntries,
  fetchRunningEntry,
  fetchPausedEntries,
  clientMonthToDateSeconds,
  clientBudgetMinutes,
  toEntryView,
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

    // Name every client we're about to mention, in one query.
    const ids = new Set<string>();
    if (clientLinkId) ids.add(clientLinkId);
    if (running) ids.add(running.client_link_id);
    for (const p of paused) ids.add(p.client_link_id);
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

    return NextResponse.json({
      serverNow,
      context: clientLinkId
        ? { clientLinkId, clientName: names.get(clientLinkId) ?? null, mtdSeconds, budgetMinutes }
        : null,
      running: running ? toEntryView(running, nowMs, names.get(running.client_link_id)) : null,
      paused: paused.map((p) => toEntryView(p, nowMs, names.get(p.client_link_id))),
    });
  } catch (err: any) {
    if (tableMissing(err)) {
      // Migration 146 not applied yet — the widget stays quiet instead of erroring.
      return NextResponse.json({ serverNow, context: null, running: null, paused: [], setup_pending: true });
    }
    console.error("[time-tracking/state]", err?.message);
    return NextResponse.json({ error: "Failed to load timer state" }, { status: 500 });
  }
}
