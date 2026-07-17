import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, qboErrorResponse } from "@/lib/qbo";
import { fetchAccountTransactions } from "@/lib/qbo-balance-sheet";
import { PAYROLL_ACCOUNT_NAME_REGEX } from "@/lib/payroll-double-entry";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/payroll-inspect — READ-ONLY diagnostic for the payroll
 * double-count (Mike, 2026-07-16: BMD/Taro book BOTH gross and net pay to
 * wages). Local scripts can't reach production QBO (prod uses a different
 * Intuit app), so this runs the inspection inside the deployed app where the
 * prod token works.
 *
 * For every payroll-ish P&L account it returns, per account:
 *   - a txn_type breakdown (count + $ sum) — shows WHAT posts to wages;
 *   - the full transaction list;
 *   - same-day clusters with 2+ DIFFERENT amounts (the gross+net signature the
 *     existing equal-amount detector misses).
 * Makes NO QBO writes. Persists the full dump to audit_log (event
 * 'payroll_inspect') so it can be read back out-of-band.
 *
 * Body: { client_link_id: string, start_date?, end_date? }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Admin/lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const clientLinkId = String(body.client_link_id || "");
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  const start = /^\d{4}-\d{2}-\d{2}$/.test(body.start_date) ? body.start_date : "2026-01-01";
  const end = /^\d{4}-\d{2}-\d{2}$/.test(body.end_date) ? body.end_date : new Date().toISOString().slice(0, 10);

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json({ error: "Client not found / inactive / not QBO-connected" }, { status: 400 });
  }

  try {
    const token = await getValidToken(clientLinkId, service as any, "ironbooks/api/admin/payroll-inspect");
    const accounts = await fetchAllAccounts((client as any).qbo_realm_id, token);

    // Payroll-ish P&L accounts (broad on purpose — we want to SEE everything
    // that could carry double-booked labor).
    const payroll = accounts.filter((a) => {
      const t = String(a.AccountType || "").toLowerCase();
      const isPl = t.includes("expense") || t.includes("cost of goods") || t.includes("cogs");
      return isPl && a.Active !== false && PAYROLL_ACCOUNT_NAME_REGEX.test(a.Name || "");
    });

    const perAccount: any[] = [];
    for (const a of payroll) {
      const txns = await fetchAccountTransactions((client as any).qbo_realm_id, token, a.Id, start, end, a.Name);

      const byType: Record<string, { n: number; sum: number }> = {};
      for (const t of txns) {
        const k = t.txn_type || "(none)";
        (byType[k] ||= { n: 0, sum: 0 });
        byType[k].n++; byType[k].sum += Math.abs(t.amount);
      }

      // gross+net signature: same day, 2+ postings, 2+ distinct amounts
      const byDate: Record<string, typeof txns> = {};
      for (const t of txns) (byDate[t.date.slice(0, 10)] ||= []).push(t);
      const grossNetClusters = Object.entries(byDate)
        .filter(([, ts]) => ts.length >= 2 && new Set(ts.map((t) => Math.abs(t.amount).toFixed(2))).size >= 2)
        .map(([d, ts]) => ({ date: d, postings: ts.map((t) => ({ type: t.txn_type, amount: Math.abs(t.amount), memo: (t.memo || "").slice(0, 40), name: t.customer_or_vendor })) }));

      perAccount.push({
        account_id: a.Id,
        account_name: a.Name,
        account_type: a.AccountType,
        account_subtype: a.AccountSubType,
        txn_count: txns.length,
        total_abs: Math.round(txns.reduce((s, t) => s + Math.abs(t.amount), 0) * 100) / 100,
        by_type: byType,
        gross_net_clusters: grossNetClusters,
        transactions: txns.map((t) => ({
          id: t.txn_id, type: t.txn_type, date: t.date, doc: t.doc_number,
          name: t.customer_or_vendor, memo: t.memo, amount: t.amount,
        })),
      });
    }

    const result = {
      client_name: (client as any).client_name,
      realm_id: (client as any).qbo_realm_id,
      window: { start, end },
      payroll_accounts_matched: payroll.length,
      accounts: perAccount,
    };

    // Persist so it can be read back via the service key (local scripts can't
    // reach prod QBO, but they CAN read audit_log).
    await service.from("audit_log").insert({
      event_type: "payroll_inspect",
      user_id: user.id,
      request_payload: { client_link_id: clientLinkId, ...result } as any,
    } as any);

    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
