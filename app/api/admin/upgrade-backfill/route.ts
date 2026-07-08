import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken } from "@/lib/qbo";
import { fetchProfitAndLossByMonth } from "@/lib/qbo-pl-by-month";

/**
 * POST /api/admin/upgrade-backfill
 *
 * Fills client_run_rate_cache from a live QBO trailing-12-month cash P&L, for
 * clients that don't have enough closed months in SNAP to judge run-rate.
 * Extracts per-month Total Income + Net Income and upserts one cache row per
 * month. Admin / lead / billing_admin only.
 *
 * Body: { client_link_id: string } OR { client_link_ids: string[] } (capped).
 *
 * MUST run on the deployed app — getValidToken does the advisory-locked token
 * refresh; ad-hoc local refreshes race and kill connections.
 */

const MAX_BATCH = 12;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Apr 2026" → "2026-04"; null if unparseable. */
function titleToPeriod(title: string): string | null {
  const parts = (title || "").trim().toLowerCase().split(/\s+/);
  if (parts.length < 2) return null;
  const mi = MONTHS.indexOf(parts[0].slice(0, 3));
  const year = Number(parts[1]);
  if (mi < 0 || !Number.isInteger(year)) return null;
  return `${year}-${String(mi + 1).padStart(2, "0")}`;
}

function trailing12Window(): { start: string; end: string } {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // last day of prev month
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "billing_admin"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* empty */ }
  const ids: string[] = body.client_link_id
    ? [body.client_link_id]
    : Array.isArray(body.client_link_ids)
    ? body.client_link_ids.slice(0, MAX_BATCH)
    : [];
  if (ids.length === 0) return NextResponse.json({ error: "client_link_id(s) required" }, { status: 400 });

  const { start, end } = trailing12Window();
  const results: Array<{ client_link_id: string; ok: boolean; months?: number; error?: string }> = [];

  for (const id of ids) {
    try {
      const { data: cl } = await service
        .from("client_links")
        .select("id, qbo_realm_id")
        .eq("id", id)
        .single();
      const realm = (cl as any)?.qbo_realm_id;
      if (!realm) { results.push({ client_link_id: id, ok: false, error: "No QBO connection" }); continue; }

      const token = await getValidToken(id, service as any);
      const report = await fetchProfitAndLossByMonth(realm, token, start, end);

      const periods = report.months.map((m) => titleToPeriod(m.title));
      const incomeBlock = report.blocks.find(
        (b) => b.kind === "section" && /^income$/i.test(b.title)
      ) as any;
      const netBlock = report.blocks.find(
        (b) => b.kind === "summary" && /net income/i.test(b.title)
      ) as any;

      const rows: any[] = [];
      periods.forEach((period, i) => {
        if (!period) return;
        const revenue = Number(incomeBlock?.totals?.[i] ?? 0);
        const net = Number(netBlock?.values?.[i] ?? 0);
        rows.push({
          client_link_id: id,
          period,
          revenue_cents: Math.round(revenue * 100),
          net_income_cents: Math.round(net * 100),
          source: "qbo",
          refreshed_at: new Date().toISOString(),
        });
      });

      if (rows.length) {
        const { error } = await (service as any)
          .from("client_run_rate_cache")
          .upsert(rows as any, { onConflict: "client_link_id,period" });
        if (error) { results.push({ client_link_id: id, ok: false, error: error.message }); continue; }
      }
      results.push({ client_link_id: id, ok: true, months: rows.length });
    } catch (e: any) {
      results.push({ client_link_id: id, ok: false, error: e?.message || "QBO pull failed" });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({ ok: okCount > 0, refreshed: okCount, window: { start, end }, results });
}
