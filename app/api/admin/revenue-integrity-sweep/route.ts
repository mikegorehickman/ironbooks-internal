import { NextResponse } from "next/server";
import { after } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts } from "@/lib/qbo";
import { fetchPLDetailAll } from "@/lib/qbo-reports";
import { analyzeDepositsToIncome } from "@/lib/revenue-integrity";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/revenue-integrity-sweep — fleet scan for deposits posted
 * straight into revenue accounts (the invoice+deposit double-count found on
 * Clean Your Carpets: ~$35K of overstated H1 revenue).
 *
 * Read-only against QBO. Per client: pull the YTD P&L detail (Cash — the
 * basis statements are built on), classify income accounts from the live
 * COA, and report every Deposit posting into ordinary income. Results land
 * in audit_log as revenue_integrity_finding rows (one per client with hits)
 * and render on /admin/revenue-integrity.
 *
 * SELF-CHAINING like dup-sweep: CHUNK clients per invocation, next chunk
 * fired at ?offset=N with the CRON_SECRET bearer; every chunk writes a
 * revenue_integrity_chunk audit row and the final chunk writes
 * revenue_integrity_completed.
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
  const year = new Date().getFullYear();
  const start = url.searchParams.get("start") || `${year}-01-01`;
  const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, cleanup_completed_at, daily_recon_enabled")
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

  const totals = { offset, scanned: 0, with_deposits: 0, flagged: 0, deposit_total: 0 };
  const errors: string[] = [];

  for (const c of chunk) {
    try {
      const token = await getValidToken(c.id, service as any);
      const [accounts, plDetail] = await Promise.all([
        fetchAllAccounts(c.qbo_realm_id, token),
        fetchPLDetailAll(c.qbo_realm_id, token, start, end, "Cash"),
      ]);
      const report = analyzeDepositsToIncome(
        plDetail,
        accounts
          .filter((a) => a.Active !== false)
          .map((a) => ({ name: String(a.Name || ""), accountType: String(a.AccountType || "") }))
      );
      totals.scanned++;
      if (report.depositCount > 0) {
        totals.with_deposits++;
        totals.deposit_total += report.depositTotal;
        if (report.flagged) totals.flagged++;
        await service.from("audit_log").insert({
          event_type: "revenue_integrity_finding",
          user_id: userId,
          request_payload: {
            client_link_id: c.id,
            client_name: c.client_name,
            window: { start, end },
            flagged: report.flagged,
            reason: report.reason,
            invoice_count: report.invoiceCount,
            invoice_total: report.invoiceTotal,
            deposit_count: report.depositCount,
            deposit_total: report.depositTotal,
            deposit_no_name_total: report.depositNoNameTotal,
            other_income_deposit_total: report.otherIncomeDepositTotal,
            // Cap stored rows — the biggest 40 carry the story.
            deposit_rows: report.depositRows.slice(0, 40),
          } as any,
        });
      }
    } catch (e: any) {
      errors.push(`${c.client_name}: ${String(e?.message || e).slice(0, 120)}`);
    }
    await new Promise((res) => setTimeout(res, 300)); // pace QBO API
  }

  totals.deposit_total = Math.round(totals.deposit_total * 100) / 100;
  const nextOffset = offset + CHUNK;
  const done = nextOffset >= targets.length;
  try {
    await service.from("audit_log").insert({
      event_type: done ? "revenue_integrity_completed" : "revenue_integrity_chunk",
      user_id: userId,
      request_payload: { ...totals, window: { start, end }, errors, remaining: Math.max(0, targets.length - nextOffset) } as any,
    });
  } catch {}

  if (!done && process.env.CRON_SECRET) {
    const next = `${url.origin}${url.pathname}?offset=${nextOffset}&start=${start}&end=${end}`;
    after(async () => {
      try {
        await fetch(next, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
        });
      } catch (e) {
        console.error("[revenue-integrity-sweep] chain failed:", e);
      }
    });
  }

  return NextResponse.json({
    started: true,
    targets: targets.length,
    window: { start, end },
    chunk: { offset, scanned: totals.scanned, with_deposits: totals.with_deposits, errors: errors.length },
    done,
  });
}

/** Vercel crons / manual curl call GET. */
export async function GET(request: Request) {
  return POST(request);
}
