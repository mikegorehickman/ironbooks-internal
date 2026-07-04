import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { fetchProfitAndLoss } from "@/lib/qbo-reports";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // up to ~a dozen clients × 2 QBO report pulls

/**
 * POST /api/admin/pl-window   (admin/lead only)
 *   { client_link_ids: string[], start: "YYYY-MM-DD", end: "YYYY-MM-DD" }
 *
 * Live QBO P&L summary for a set of clients over an arbitrary window, in BOTH
 * accounting bases (Cash + Accrual). Built for spot-audits — e.g. checking
 * whether a weird single month is cash-timing (window smooths it out) or a
 * real data problem (both bases stay broken). Summary numbers only; uses the
 * app's lock-protected token machinery. Sequential with a small gap so a dozen
 * clients don't hammer Intuit.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const b = await request.json().catch(() => ({}));
  const ids: string[] = Array.isArray(b.client_link_ids) ? b.client_link_ids.slice(0, 25) : [];
  const start = /^\d{4}-\d{2}-\d{2}$/.test(b.start || "") ? b.start : null;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(b.end || "") ? b.end : null;
  if (!ids.length || !start || !end) {
    return NextResponse.json({ error: "client_link_ids[], start and end (YYYY-MM-DD) required" }, { status: 400 });
  }

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, legal_business_name, contact_first_name, contact_last_name, qbo_realm_id")
    .in("id", ids);
  const byId = new Map(((clients as any[]) || []).map((c) => [c.id, c]));

  const summarize = (pl: any) => {
    const li: any[] = pl.lineItems || [];
    const sum = (g: string) => Math.round(li.filter((x) => x.group === g).reduce((a, x) => a + x.amount, 0) * 100) / 100;
    const rev = sum("Income"), cogs = sum("COGS"), fx = sum("Expenses");
    const oi = sum("OtherIncome"), oe = sum("OtherExpenses");
    return { rev, cogs, gp: Math.round((rev - cogs) * 100) / 100, fx, other: Math.round((oi - oe) * 100) / 100, net: Math.round((rev - cogs - fx + oi - oe) * 100) / 100, qboNet: pl.netIncome ?? null };
  };

  const rows: any[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    const base = {
      client_link_id: id,
      company: c ? (c.legal_business_name || c.client_name) : id,
      contact: c ? [c.contact_first_name, c.contact_last_name].filter(Boolean).join(" ") : "",
    };
    if (!c) { rows.push({ ...base, error: "client not found" }); continue; }
    if (!c.qbo_realm_id) { rows.push({ ...base, error: "no QuickBooks connection" }); continue; }
    try {
      const token = await getValidToken(id, service as any);
      const cash = summarize(await fetchProfitAndLoss(c.qbo_realm_id, token, start, end, "Cash"));
      const accrual = summarize(await fetchProfitAndLoss(c.qbo_realm_id, token, start, end, "Accrual"));
      rows.push({ ...base, cash, accrual });
    } catch (e: any) {
      rows.push({ ...base, error: e?.message || "QBO pull failed" });
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return NextResponse.json({ start, end, rows });
}
