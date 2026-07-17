import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, qboErrorResponse } from "@/lib/qbo";
import { fetchPLDetailAll, type PLDetailRow } from "@/lib/qbo-reports";
import { PAYROLL_ACCOUNT_NAME_REGEX } from "@/lib/payroll-double-entry";
import { normalizeAccountName } from "@/lib/account-name";

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
    const payrollNorm = new Set(payroll.map((a) => normalizeAccountName(a.Name)));

    // ProfitAndLossDetail (both bases) is the report that sums to the P&L
    // lines and attributes each posting to its account — unlike TransactionList,
    // whose account filter QBO silently ignores. Accrual = every posting;
    // Cash = what the statements/portal show. Comparing the two is itself a
    // tell for the double-count (net-pay cash postings show on both).
    const [accrualRows, cashRows] = await Promise.all([
      fetchPLDetailAll((client as any).qbo_realm_id, token, start, end, "Accrual"),
      fetchPLDetailAll((client as any).qbo_realm_id, token, start, end, "Cash"),
    ]);
    const cashByAccount = new Map<string, PLDetailRow[]>();
    for (const r of cashRows) {
      const k = normalizeAccountName(r.account);
      if (payrollNorm.has(k)) (cashByAccount.get(k) || cashByAccount.set(k, []).get(k)!).push(r);
    }
    const accrualByAccount = new Map<string, PLDetailRow[]>();
    for (const r of accrualRows) {
      const k = normalizeAccountName(r.account);
      if (payrollNorm.has(k)) (accrualByAccount.get(k) || accrualByAccount.set(k, []).get(k)!).push(r);
    }

    const perAccount: any[] = [];
    for (const a of payroll) {
      const k = normalizeAccountName(a.Name);
      const rows = accrualByAccount.get(k) || [];
      const cashRowsAcct = cashByAccount.get(k) || [];

      const byType: Record<string, { n: number; sum: number }> = {};
      for (const t of rows) {
        const key = t.txn_type || "(none)";
        (byType[key] ||= { n: 0, sum: 0 });
        byType[key].n++; byType[key].sum += Math.abs(t.amount);
      }

      // gross+net signature: same day, 2+ postings, 2+ distinct amounts.
      const byDate: Record<string, PLDetailRow[]> = {};
      for (const t of rows) (byDate[t.date.slice(0, 10)] ||= []).push(t);
      const grossNetClusters = Object.entries(byDate)
        .filter(([, ts]) => ts.length >= 2 && new Set(ts.map((t) => Math.abs(t.amount).toFixed(2))).size >= 2)
        .map(([d, ts]) => ({ date: d, postings: ts.map((t) => ({ type: t.txn_type, amount: Math.abs(t.amount), memo: (t.memo || "").slice(0, 40), name: t.name })) }));

      perAccount.push({
        account_id: a.Id,
        account_name: a.Name,
        account_type: a.AccountType,
        account_subtype: a.AccountSubType,
        txn_count: rows.length,
        total_accrual: Math.round(rows.reduce((s, t) => s + t.amount, 0) * 100) / 100,
        total_cash: Math.round(cashRowsAcct.reduce((s, t) => s + t.amount, 0) * 100) / 100,
        by_type: byType,
        gross_net_clusters: grossNetClusters,
        transactions: rows.map((t) => ({
          id: t.txn_id, type: t.txn_type, date: t.date, doc: t.doc_number,
          name: t.name, memo: t.memo, amount: t.amount,
        })),
      });
    }

    // ─── Whole-P&L labor duplication scan ───────────────────────────────
    // The double-count isn't inside one account — it's the SAME people's pay
    // landing in a SECOND account (QBO Payroll paycheque booked to labor AND
    // the bank-feed net-pay deposit categorized to a different labor account).
    // 1) Learn the employee roster from every Paycheque posting anywhere on
    //    the P&L. 2) Report each account that carries those names, so the two
    //    (or more) labor lines are obvious.
    const norm = (s: string | null) => (s || "").toLowerCase().replace(/\s*\(\d+\)\s*$/, "").replace(/\s+/g, " ").trim();
    const employeeNames = new Set<string>();
    for (const r of accrualRows) {
      if (/paycheque|paycheck|payroll/i.test(r.txn_type) && r.name) employeeNames.add(norm(r.name));
    }
    const laborByAccount = new Map<string, { account: string; section: string; n: number; sum: number; people: Set<string>; byType: Record<string, { n: number; sum: number }>; txns: any[] }>();
    for (const r of accrualRows) {
      const person = norm(r.name);
      const isPayrollTxn = /paycheque|paycheck|payroll/i.test(r.txn_type);
      if (!person || (!employeeNames.has(person) && !isPayrollTxn)) continue;
      const key = normalizeAccountName(r.account);
      const e = laborByAccount.get(key) || { account: r.account, section: r.section, n: 0, sum: 0, people: new Set<string>(), byType: {}, txns: [] };
      e.n++; e.sum += r.amount; e.people.add(person);
      const tk = r.txn_type || "(none)";
      (e.byType[tk] ||= { n: 0, sum: 0 }); e.byType[tk].n++; e.byType[tk].sum += r.amount;
      e.txns.push({ date: r.date, type: r.txn_type, name: r.name, amount: r.amount, memo: (r.memo || "").slice(0, 40) });
      laborByAccount.set(key, e);
    }
    const laborLines = [...laborByAccount.values()]
      .map((e) => ({
        account: e.account, section: e.section, n: e.n,
        sum: Math.round(e.sum * 100) / 100, people: e.people.size,
        by_type: Object.fromEntries(Object.entries(e.byType).map(([k, v]) => [k, { n: v.n, sum: Math.round(v.sum * 100) / 100 }])),
        txns: e.txns.sort((a, b) => a.date.localeCompare(b.date)),
      }))
      .sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum));

    // Exact cross-account duplicates: same person + date + amount posted to 2+
    // distinct accounts (identical double-booking).
    const dupKey = new Map<string, Map<string, number>>(); // key -> account -> count
    for (const r of accrualRows) {
      const person = norm(r.name);
      if (!person || !employeeNames.has(person)) continue;
      const key = `${person}|${r.date}|${Math.abs(r.amount).toFixed(2)}`;
      const m = dupKey.get(key) || new Map<string, number>();
      m.set(r.account, (m.get(r.account) || 0) + 1);
      dupKey.set(key, m);
    }
    const exactCrossAccountDupes = [...dupKey.entries()]
      .filter(([, m]) => m.size >= 2)
      .map(([key, m]) => ({ key, accounts: [...m.keys()] }))
      .slice(0, 50);

    const result = {
      client_name: (client as any).client_name,
      realm_id: (client as any).qbo_realm_id,
      window: { start, end },
      payroll_accounts_matched: payroll.length,
      accounts: perAccount,
      // The headline: every account carrying employee pay + how much.
      labor_lines: laborLines,
      employee_count: employeeNames.size,
      exact_cross_account_dupes: exactCrossAccountDupes,
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
