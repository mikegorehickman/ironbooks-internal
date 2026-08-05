/** CRM-invoice remediation — the shared read-only planner.
 *
 *  Lives here rather than in the preview route because BOTH the preview and the
 *  apply route need it, and a Next.js route file may only export route handlers
 *  and route config (exporting a helper from route.ts fails the generated
 *  route-type constraint).
 */

import { qboRequest } from "@/lib/qbo";
import { fetchPLDetailAll } from "@/lib/qbo-reports";
import { planInvoice, attachDepositPairs, type RemediationPayment } from "@/lib/crm-invoice-remediation";
import { analyzeCrmInvoiceRevenue } from "@/lib/crm-invoice-revenue";

const q = (stmt: string) => `/query?query=${encodeURIComponent(stmt)}`;
const chunk = <T,>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

/**
 * Resolve the recognized CRM invoices + their payment safety from live QBO.
 * Read-only — shared by the preview and apply routes.
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
