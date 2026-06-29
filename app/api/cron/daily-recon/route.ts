import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { runDailyRecon } from "@/lib/daily-recon";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // big tick — many clients × per-client pipeline

/**
 * GET/POST /api/cron/daily-recon
 *
 * Registered in vercel.json ("0 7 * * *", dryRun=false). Iterates every client
 * where daily_recon_enabled=true (and not paused), runs the reconciliation
 * pipeline, and returns a summary. Every tick writes an audit_log row so we can
 * confirm it actually fired (a missing tick = the cron isn't authenticating).
 *
 * Auth:
 *   1. Cron secret: `Authorization: Bearer ${CRON_SECRET}` — Vercel only attaches
 *      this header when the CRON_SECRET env var is set. IF IT IS UNSET, Vercel's
 *      cron call has no auth, this route 401s, and the engine never runs (this
 *      was the silent failure: 57 enabled clients, 0 runs). Set CRON_SECRET in
 *      the Vercel production env to fix.
 *   2. Admin/lead session — for manual "run now" from /admin/daily-recon.
 *
 * Query params: dryRun=true|false (default true).
 */
async function handleRequest(request: Request) {
  // ── AUTH ──
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") || "";
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCron) {
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const service = createServiceSupabase();
    const { data: actor } = await service
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!["admin", "lead"].includes((actor as any)?.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // ── PARAMS ──
  const url = new URL(request.url);
  const dryRunParam = url.searchParams.get("dryRun");
  // Default: dry-run TRUE. Flip to false in vercel.json by passing ?dryRun=false
  // on the cron's path when we go live.
  const dryRun = dryRunParam === null ? true : dryRunParam !== "false";

  const service = createServiceSupabase();

  // ── PICK CLIENTS ──
  const { data: clients, error } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("is_active", true)
    .eq("daily_recon_enabled" as any, true)
    .eq("daily_recon_paused" as any, false);

  if (error) {
    return NextResponse.json({ error: `client_links query: ${error.message}` }, { status: 500 });
  }

  const eligible = (clients || []) as Array<{ id: string; client_name: string }>;

  // ── RUN WITH BOUNDED CONCURRENCY ──
  // Process up to CONCURRENCY clients in parallel to scale to ~1000 clients
  // without exceeding Vercel timeout. QBO rate limits handled per-realm.
  const CONCURRENCY = 5;
  const results: any[] = [];

  async function runOne(c: { id: string; client_name: string }) {
    const t0 = Date.now();
    const res = await runDailyRecon(c.id, { dryRun });
    return {
      client_link_id: c.id,
      client_name: c.client_name,
      status: res.status,
      transactions_pulled: res.transactions_pulled,
      auto_executed: res.auto_executed,
      queued_for_review: res.queued_for_review,
      anomalies: res.anomalies_count,
      duration_ms: Date.now() - t0,
      error: res.error,
    };
  }

  for (let i = 0; i < eligible.length; i += CONCURRENCY) {
    const batch = eligible.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(runOne));
    results.push(...batchResults);
  }

  // Observability: one audit row per tick so we can SEE the cron fired and what
  // it did. (No tick rows showing up = the cron isn't authenticating/firing.)
  const totals = results.reduce(
    (a, r) => ({
      auto_executed: a.auto_executed + (r.auto_executed || 0),
      queued_for_review: a.queued_for_review + (r.queued_for_review || 0),
      errored: a.errored + (r.error ? 1 : 0),
    }),
    { auto_executed: 0, queued_for_review: 0, errored: 0 }
  );
  try {
    await service.from("audit_log").insert({
      event_type: "daily_recon_cron_tick",
      request_payload: {
        triggered_by: isCron ? "vercel_cron" : "admin_manual",
        dry_run: dryRun,
        eligible_clients: eligible.length,
        totals,
      } as any,
    });
  } catch {
    /* never fail the run on a log hiccup */
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    eligible_clients: eligible.length,
    ran_at: new Date().toISOString(),
    totals,
    results,
  });
}

export async function GET(request: Request) {
  return handleRequest(request);
}
export async function POST(request: Request) {
  return handleRequest(request);
}
