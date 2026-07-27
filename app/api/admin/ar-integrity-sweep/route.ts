import { NextResponse } from "next/server";
import { after } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { scanClientArIntegrity } from "@/lib/ar-integrity-server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/ar-integrity-sweep — fleet scan for phantom A/R.
 *
 * The A/R twin of the revenue-integrity sweep. Finds clients whose open
 * invoices were collected but never matched to their deposits, so QBO reports
 * receivables that don't exist (All Inspired Painting: $1.55M across 110
 * invoices, oldest 1,638 days). Read-only against QBO — sizing, not fixing.
 *
 * SELF-CHAINING like the revenue + dup sweeps: CHUNK clients per invocation,
 * the next chunk fired at ?offset=N with the CRON_SECRET bearer. Every chunk
 * writes an ar_integrity_chunk audit row; the last writes
 * ar_integrity_completed. Findings render on /admin/revenue-integrity.
 *
 * Auth: admin session OR self-chain/cron (Bearer CRON_SECRET).
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

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, fiscal_year_end, revenue_recognition_mode, cleanup_completed_at, daily_recon_enabled")
    .eq("is_active", true)
    .not("qbo_realm_id", "is", null)
    .order("id");
  const targets = ((clients as any[]) || []).filter(
    (c) =>
      (c.cleanup_completed_at || c.daily_recon_enabled) &&
      c.qbo_realm_id !== "DEMO" &&
      !/\btest\b/i.test(c.client_name || "")
  );
  const chunk = targets.slice(offset, offset + CHUNK);

  const totals = {
    offset,
    scanned: 0,
    with_ar: 0,
    flagged: 0,
    unreliable: 0,
    ar_total: 0,
    prior_year_total: 0,
  };
  const errors: string[] = [];

  for (const c of chunk) {
    try {
      const report = await scanClientArIntegrity(service, c as any);
      totals.scanned++;
      if (report.totalCount > 0) {
        totals.with_ar++;
        totals.ar_total += report.totalOpen;
        totals.prior_year_total += report.priorYearTotal;
        if (report.flagged) totals.flagged++;
        if (report.verdict === "unreliable") totals.unreliable++;

        await service.from("audit_log").insert({
          event_type: "ar_integrity_finding",
          user_id: userId,
          request_payload: {
            client_link_id: c.id,
            client_name: c.client_name,
            verdict: report.verdict,
            flagged: report.flagged,
            reason: report.reason,
            total_open: report.totalOpen,
            total_count: report.totalCount,
            prior_year_total: report.priorYearTotal,
            prior_year_count: report.priorYearCount,
            stale_total: report.staleTotal,
            stale_count: report.staleCount,
            recent_total: report.recentTotal,
            recent_count: report.recentCount,
            oldest_days: report.oldestDays,
            oldest_date: report.oldestDate,
            pct_over_90: report.pctOver90,
            monthly_revenue: report.monthlyRevenue,
            ar_to_monthly_revenue: report.arToMonthlyRevenue,
            deposits_only: report.depositsOnly,
            fiscal_year_start: report.fiscalYearStart,
            top_customers: report.topCustomers.slice(0, 10),
          } as any,
        });
      }
    } catch (e: any) {
      errors.push(`${c.client_name}: ${String(e?.message || e).slice(0, 120)}`);
    }
    await new Promise((res) => setTimeout(res, 300)); // pace QBO API
  }

  totals.ar_total = Math.round(totals.ar_total * 100) / 100;
  totals.prior_year_total = Math.round(totals.prior_year_total * 100) / 100;
  const nextOffset = offset + CHUNK;
  const done = nextOffset >= targets.length;
  try {
    await service.from("audit_log").insert({
      event_type: done ? "ar_integrity_completed" : "ar_integrity_chunk",
      user_id: userId,
      request_payload: { ...totals, errors, remaining: Math.max(0, targets.length - nextOffset) } as any,
    });
  } catch {}

  if (!done && process.env.CRON_SECRET) {
    const next = `${url.origin}${url.pathname}?offset=${nextOffset}`;
    after(async () => {
      try {
        await fetch(next, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
        });
      } catch (e) {
        console.error("[ar-integrity-sweep] chain failed:", e);
      }
    });
  }

  return NextResponse.json({
    started: true,
    targets: targets.length,
    chunk: { offset, scanned: totals.scanned, with_ar: totals.with_ar, flagged: totals.flagged, errors: errors.length },
    done,
  });
}

/** Vercel crons / manual curl call GET. */
export async function GET(request: Request) {
  return POST(request);
}
