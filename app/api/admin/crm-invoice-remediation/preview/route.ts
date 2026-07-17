import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboRequest } from "@/lib/qbo";
import { fetchPLDetailAll } from "@/lib/qbo-reports";
import { planInvoice, summarizeRemediation, attachDepositPairs, type RemediationPayment } from "@/lib/crm-invoice-remediation";
import { analyzeCrmInvoiceRevenue } from "@/lib/crm-invoice-revenue";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/admin/crm-invoice-remediation/preview  (READ-ONLY)
 *   { client_link_id, start?, end? }
 *
 * The full scope + safety check before any QBO write: every CRM invoice
 * RECOGNIZED as revenue on the cash P&L, each with its linked payment(s) and
 * where each payment sits — Undeposited-Funds phantom (safe to void) vs a real
 * bank deposit (review). Feeds the "Fix in QuickBooks" panel. No writes.
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

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "").trim();
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  const year = new Date().getFullYear();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(body.start || "") ? body.start : `${year}-01-01`;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(body.end || "") ? body.end : new Date().toISOString().slice(0, 10);

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id, revenue_recognition_mode")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id) return NextResponse.json({ error: "no QBO connection" }, { status: 404 });
  const realm = (client as any).qbo_realm_id as string;

  try {
    const token = await getValidToken(clientLinkId, service as any);
    const invoices = await buildRemediationPreview(realm, token, start, end);
    return NextResponse.json({
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      revenue_recognition_mode: (client as any).revenue_recognition_mode || "standard",
      window: { start, end },
      summary: summarizeRemediation(invoices),
      invoices,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "preview failed" }, { status: 502 });
  }
}

const q = (stmt: string) => `/query?query=${encodeURIComponent(stmt)}`;
const chunk = <T,>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

/**
 * Shared with the apply route: resolve the recognized CRM invoices + their
 * payment safety from live QBO. Read-only.
 */
export async function buildRemediationPreview(
  realm: string,
  token: string,
  start: string,
  end: string
) {
  // 1. Recognized-as-revenue invoices = Invoice-type rows on the cash P&L
  //    detail. Group by txn id; capture income accounts + recognized amount.
  const plDetail = await fetchPLDetailAll(realm, token, start, end, "Cash");
  const recognized = new Map<string, { total: number; accounts: Set<string> }>();
  for (const r of plDetail) {
    if (!/invoice/i.test(r.txn_type || "")) continue;
    const id = r.txn_id;
    if (!id) continue;
    const g = recognized.get(id) || { total: 0, accounts: new Set<string>() };
    g.total = Math.round((g.total + (Number(r.amount) || 0)) * 100) / 100;
    if (r.account) g.accounts.add(r.account);
    recognized.set(id, g);
  }
  const invoiceIds = [...recognized.keys()];
  if (invoiceIds.length === 0) return [];

  // 2. Fetch the Invoice entities (doc/customer/balance/LinkedTxn payments).
  const invEntities = new Map<string, any>();
  for (const ids of chunk(invoiceIds, 30)) {
    const list = ids.map((i) => `'${i}'`).join(",");
    const data = await qboRequest<any>(realm, token, q(`SELECT * FROM Invoice WHERE Id IN (${list})`));
    for (const inv of data?.QueryResponse?.Invoice || []) invEntities.set(String(inv.Id), inv);
  }

  // 3. Collect linked payment ids from those invoices, fetch the Payments
  //    (amount + where each deposited).
  const paymentIds = new Set<string>();
  for (const inv of invEntities.values()) {
    for (const lt of inv.LinkedTxn || []) {
      if (String(lt.TxnType) === "Payment") paymentIds.add(String(lt.TxnId));
    }
  }
  const payEntities = new Map<string, any>();
  for (const ids of chunk([...paymentIds], 30)) {
    const list = ids.map((i) => `'${i}'`).join(",");
    const data = await qboRequest<any>(realm, token, q(`SELECT * FROM Payment WHERE Id IN (${list})`));
    for (const p of data?.QueryResponse?.Payment || []) payEntities.set(String(p.Id), p);
  }

  // 4. Which payments were swept into a Deposit (→ real cash, not phantom) —
  //    and BY WHICH deposit(s), so the reviewer sees date/amount/bank account.
  //    Scan through TODAY (not just the window end): a payment inside the
  //    window is often swept by a deposit dated after it.
  const sweptBy = new Map<string, Array<{ date: string; amount: number; account: string | null }>>();
  {
    const today = new Date().toISOString().slice(0, 10);
    const scanEnd = end < today ? today : end;
    const data = await qboRequest<any>(
      realm,
      token,
      q(`SELECT * FROM Deposit WHERE TxnDate >= '${start}' AND TxnDate <= '${scanEnd}' MAXRESULTS 1000`)
    );
    for (const d of data?.QueryResponse?.Deposit || []) {
      for (const line of d.Line || []) {
        for (const lt of line.LinkedTxn || []) {
          if (!/payment/i.test(String(lt.TxnType))) continue;
          const pid = String(lt.TxnId);
          const list = sweptBy.get(pid) || [];
          list.push({
            date: String(d.TxnDate || ""),
            amount: Number(d.TotalAmt) || 0,
            account: d.DepositToAccountRef?.name ?? null,
          });
          sweptBy.set(pid, list);
        }
      }
    }
  }

  // 5. Plan each invoice — with full review detail per payment (date, method,
  //    ref#, unapplied, swept-by) and per invoice (gross total, job lines).
  const planned = invoiceIds.map((id) => {
    const rec = recognized.get(id)!;
    const inv = invEntities.get(id);
    const payments: RemediationPayment[] = [...(inv?.LinkedTxn || [])]
      .filter((lt: any) => String(lt.TxnType) === "Payment")
      .map((lt: any) => {
        const pid = String(lt.TxnId);
        const p = payEntities.get(pid);
        return {
          id: pid,
          amount: Number(p?.TotalAmt) || 0,
          depositAccount: p?.DepositToAccountRef?.name ?? null,
          linkedToDeposit: sweptBy.has(pid),
          date: p?.TxnDate ?? null,
          refNum: p?.PaymentRefNum ?? null,
          method: p?.PaymentMethodRef?.name ?? null,
          unappliedAmt: p?.UnappliedAmt != null ? Number(p.UnappliedAmt) : null,
          sweptBy: sweptBy.get(pid) || [],
        };
      });
    const lineSamples: string[] = ((inv?.Line || []) as any[])
      .filter((l) => l.DetailType === "SalesItemLineDetail" && l.Description)
      .slice(0, 3)
      .map((l) => String(l.Description));
    return planInvoice(
      {
        invoiceId: id,
        docNumber: inv?.DocNumber ?? null,
        customer: inv?.CustomerRef?.name ?? null,
        date: inv?.TxnDate ?? "",
        total: rec.total,
        balance: Number(inv?.Balance) || 0,
        incomeAccounts: [...rec.accounts],
        grossTotal: inv?.TotalAmt != null ? Number(inv.TotalAmt) : null,
        lineSamples,
        customerId: inv?.CustomerRef?.value != null ? String(inv.CustomerRef.value) : null,
      },
      payments
    );
  });

  // 6. Attach each invoice's best deposit pair (the same greedy 1:1 pairing
  //    the Revenue Check evidence table uses) — enables the KEEP-INVOICE
  //    remediation: apply the matched deposit to the invoice instead of
  //    voiding it (clients who actively use invoicing).
  const pairing = analyzeCrmInvoiceRevenue(plDetail);
  return attachDepositPairs(planned, pairing?.pairs || []);
}
