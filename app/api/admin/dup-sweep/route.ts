import { NextResponse } from "next/server";
import { after } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { scanClientForDuplicates } from "@/lib/dup-sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/dup-sweep — the one-time clean sweep + weekly cron target.
 *
 * Scans every active client with a completed cleanup OR on daily recon
 * (i.e., books we've already made accurate and must keep accurate).
 * Read-only against QBO; findings land in dup_findings and surface on the
 * /today Duplicates queue + reclass Duplicates stage.
 *
 * SELF-CHAINING: a full-fleet sweep exceeds Vercel's function ceiling, so
 * each invocation scans CHUNK clients (sorted by id, starting at ?offset=N)
 * and then fires the next chunk at itself with the CRON_SECRET bearer.
 * Every chunk writes a dup_sweep_chunk audit row (incl. per-client errors),
 * and the final chunk writes dup_sweep_completed — a silent death can lose
 * at most one chunk, and the audit trail shows exactly where.
 *
 * Auth: admin session OR Vercel cron / self-chain (Bearer CRON_SECRET).
 */
const CHUNK = 8;
export async function POST(request: Request) {
  const service = createServiceSupabase();

  const cronOk =
    !!process.env.CRON_SECRET &&
    request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  let userId: string | null = null;
  if (!cronOk) {
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
    if ((actor as any)?.role !== "admin") {
      return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
    }
    userId = user.id;
  }

  const url = new URL(request.url);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
  // Scan window: ?start=YYYY-MM-DD, default Jan 1 (YTD) — the old fixed 90-day
  // window silently missed older duplicates during historical cleanups.
  const year = new Date().getFullYear();
  const startParam = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("start") || "")
    ? (url.searchParams.get("start") as string)
    : `${year}-01-01`;
  const windowDays = Math.max(
    7,
    Math.ceil((Date.now() - new Date(startParam).getTime()) / 86400000)
  );

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, cleanup_completed_at, daily_recon_enabled")
    .eq("is_active", true)
    .not("qbo_realm_id", "is", null)
    .order("id");
  // Scan EVERY active client with a QBO connection — duplicate expenses are
  // most common DURING cleanup (Camellia's $2,226 Lowe's double was mid-cleanup),
  // so gating on production status hid exactly the clients that need it.
  const targets = ((clients as any[]) || []).filter(
    (c) => c.qbo_realm_id !== "DEMO" && !/\btest\b/i.test(c.client_name || "")
  );
  const chunk = targets.slice(offset, offset + CHUNK);

  const totals = { offset, scanned: 0, found: 0, certain: 0, likely: 0 };
  const errors: string[] = [];
  for (const c of chunk) {
    try {
      const r = await scanClientForDuplicates(service, c, { windowDays });
      totals.scanned++;
      totals.found += r.found;
      totals.certain += r.certain;
      totals.likely += r.likely;
    } catch (e: any) {
      errors.push(`${c.client_name}: ${String(e?.message || e).slice(0, 120)}`);
    }
    await new Promise((res) => setTimeout(res, 300)); // pace QBO API
  }

  const nextOffset = offset + CHUNK;
  const done = nextOffset >= targets.length;
  try {
    await service.from("audit_log").insert({
      event_type: done ? "dup_sweep_completed" : "dup_sweep_chunk",
      user_id: userId,
      request_payload: { ...totals, errors, remaining: Math.max(0, targets.length - nextOffset) } as any,
    });
  } catch {}

  // Self-chain ONLY for cron-triggered runs — a browser-initiated sweep must
  // drive every chunk itself via next_offset (the fire-and-forget after()
  // chain dies unreliably on Vercel; this stalled the CRM sweep at 8 clients).
  if (!done && cronOk) {
    const next = `${url.origin}${url.pathname}?offset=${nextOffset}`;
    after(async () => {
      try {
        await fetch(next, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
        });
      } catch (e) {
        console.error("[dup-sweep] chain failed:", e);
      }
    });
  }

  return NextResponse.json({
    started: true,
    targets: targets.length,
    window_start: startParam,
    chunk: { offset, scanned: totals.scanned, found: totals.found, errors: errors.length, error_samples: errors.slice(0, 6) },
    next_offset: done ? null : nextOffset,
    server_chained: !done && cronOk,
    done,
  });
}

/** Vercel crons call GET. */
export async function GET(request: Request) {
  return POST(request);
}
