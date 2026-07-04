import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { fetchProfitAndLoss, fetchPLDetailAll } from "@/lib/qbo-reports";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/admin/client-audit   (admin/lead only)
 *   { client_link_id, start: "YYYY-MM-DD", end: "YYYY-MM-DD" }
 *
 * Deep-audit pull for ONE client's period: the full P&L in both bases
 * (summary fields + line items — the same lens the statement snapshot uses)
 * plus the complete transaction-level detail with account context, aggregated
 * per account. Built to diagnose statement-vs-ledger discrepancies (e.g. line
 * items missing from a close snapshot). Read-only.
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
  const id = b.client_link_id;
  const start = /^\d{4}-\d{2}-\d{2}$/.test(b.start || "") ? b.start : null;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(b.end || "") ? b.end : null;
  if (!id || !start || !end) {
    return NextResponse.json({ error: "client_link_id, start, end required" }, { status: 400 });
  }

  const { data: c } = await service
    .from("client_links")
    .select("id, client_name, legal_business_name, qbo_realm_id")
    .eq("id", id)
    .single();
  if (!c || !(c as any).qbo_realm_id) {
    return NextResponse.json({ error: "Client not found or no QBO connection" }, { status: 404 });
  }

  try {
    const token = await getValidToken(id, service as any);
    const realm = (c as any).qbo_realm_id;
    const [plCash, plAccrual, detail] = [
      await fetchProfitAndLoss(realm, token, start, end, "Cash"),
      await fetchProfitAndLoss(realm, token, start, end, "Accrual"),
      await fetchPLDetailAll(realm, token, start, end, "Cash"),
    ];

    // Aggregate transaction detail per account (the ground truth).
    const byAccount = new Map<string, { section: string; total: number; count: number }>();
    for (const r of detail) {
      const k = r.account || "(no account)";
      const a = byAccount.get(k) || { section: r.section, total: 0, count: 0 };
      a.total = Math.round((a.total + r.amount) * 100) / 100;
      a.count++;
      byAccount.set(k, a);
    }

    return NextResponse.json({
      company: (c as any).legal_business_name || (c as any).client_name,
      start, end,
      plCash: { totalIncome: plCash.totalIncome, cogs: plCash.cogs, grossProfit: plCash.grossProfit, totalExpenses: plCash.totalExpenses, netIncome: plCash.netIncome, lineItems: plCash.lineItems },
      plAccrual: { totalIncome: plAccrual.totalIncome, cogs: plAccrual.cogs, grossProfit: plAccrual.grossProfit, totalExpenses: plAccrual.totalExpenses, netIncome: plAccrual.netIncome },
      accounts: [...byAccount.entries()].map(([account, a]) => ({ account, ...a })).sort((x, y) => Math.abs(y.total) - Math.abs(x.total)),
      transactions: detail.slice(0, 1500),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "QBO pull failed" }, { status: 502 });
  }
}
