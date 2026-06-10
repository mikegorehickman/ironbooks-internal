import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { fetchOpenInvoices } from "@/lib/qbo-balance-sheet";
import { fetchAllCustomers } from "@/lib/qbo-stripe-recon";
import {
  ageInvoices,
  fetchRecentPayments,
  computeDSO,
  summarizeCustomersForAR,
} from "@/lib/portal-data";
import { PortalErrorState } from "../error-state";
import { WhosPayingClient } from "./whos-paying-client";

export const dynamic = "force-dynamic";

/**
 * "Who owes you" — A/R aging by customer with contact info, last-payment
 * date, current/overdue split, and one-click AI-drafted follow-up emails.
 *
 * Heavy server-side: pulls open invoices + all customers + last 180 days
 * of payments in parallel. Builds a per-customer summary blob and ships
 * it to the client component for rendering + interaction.
 */
export default async function WhosPayingPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const service = createServiceSupabase();
  const [allInvoices, customers, payments, dismissalRows] = await Promise.all([
    fetchOpenInvoices(ctx.qboRealmId, ctx.accessToken).catch(() => []),
    fetchAllCustomers(ctx.qboRealmId, ctx.accessToken).catch(() => []),
    fetchRecentPayments(ctx.qboRealmId, ctx.accessToken, 180).catch(() => []),
    (service as any)
      .from("portal_ar_dismissals")
      .select("qbo_invoice_id, doc_number, customer_name, amount, created_at")
      .eq("client_link_id", ctx.clientLinkId)
      .then((r: any) => (r.data as any[]) || [])
      .catch(() => []),
  ]);

  // Client-dismissed invoices ("not actually owed") are filtered out of every
  // number on this page — persistently, even though QBO still shows them open.
  // The bookkeeper got a /today message when each was dismissed and clears
  // them in QBO for real; until then this view stays clean.
  const dismissedIds = new Set(dismissalRows.map((d: any) => String(d.qbo_invoice_id)));
  const invoices = allInvoices.filter((inv) => !dismissedIds.has(String(inv.qbo_invoice_id)));

  const aging = ageInvoices(invoices);
  const dso = computeDSO(payments);
  const customerSummaries = summarizeCustomersForAR(customers, payments);

  // Group open invoices by customer with current/overdue split + contact info
  const today = new Date();
  const byCustomer = new Map<string, {
    customer_id: string | null;
    name: string;
    email: string | null;
    phone: string | null;
    last_payment_date: string | null;
    last_payment_amount: number | null;
    current_total: number;
    overdue_total: number;
    total: number;
    oldest_days: number;
    invoices: { num: string; doc_id: string; date: string; due_date: string | null; amount: number; days_overdue: number }[];
  }>();

  for (const inv of invoices) {
    const key = inv.customer_id || `__name:${inv.customer_name || "(no customer)"}`;
    if (!byCustomer.has(key)) {
      const summary = inv.customer_id ? customerSummaries.get(inv.customer_id) : undefined;
      byCustomer.set(key, {
        customer_id: inv.customer_id,
        name: inv.customer_name || "(no customer name)",
        email: summary?.email || null,
        phone: summary?.phone || null,
        last_payment_date: summary?.last_payment_date || null,
        last_payment_amount: summary?.last_payment_amount || null,
        current_total: 0,
        overdue_total: 0,
        total: 0,
        oldest_days: 0,
        invoices: [],
      });
    }
    const dueDate = new Date(inv.due_date || inv.txn_date);
    const daysOverdue = Math.max(
      0,
      Math.floor((today.getTime() - dueDate.getTime()) / 86_400_000)
    );
    const g = byCustomer.get(key)!;
    g.total += inv.balance;
    if (daysOverdue > 0) g.overdue_total += inv.balance;
    else g.current_total += inv.balance;
    g.oldest_days = Math.max(g.oldest_days, daysOverdue);
    g.invoices.push({
      num: inv.doc_number || inv.qbo_invoice_id,
      doc_id: inv.qbo_invoice_id,
      date: inv.txn_date,
      due_date: inv.due_date,
      amount: inv.balance,
      days_overdue: daysOverdue,
    });
  }

  const customerCards = Array.from(byCustomer.values()).sort((a, b) => {
    // Urgency-first: overdue customers ahead of current. Within overdue, by
    // oldest days desc. Within current, by total desc.
    if (a.oldest_days !== b.oldest_days) return b.oldest_days - a.oldest_days;
    return b.total - a.total;
  });

  // Customer concentration: what % of total A/R is the biggest customer?
  const totalAR = aging.totalAmount;
  const topCustomerShare = customerCards[0]?.total && totalAR > 0
    ? Math.round((customerCards[0].total / totalAR) * 100)
    : 0;

  return (
    <WhosPayingClient
      aging={{
        totalAmount: aging.totalAmount,
        totalCount: aging.totalCount,
        buckets: {
          current: { total: aging.buckets.current.total, count: aging.buckets.current.count },
          "1-30": { total: aging.buckets["1-30"].total, count: aging.buckets["1-30"].count },
          "31-60": { total: aging.buckets["31-60"].total, count: aging.buckets["31-60"].count },
          "61-90": { total: aging.buckets["61-90"].total, count: aging.buckets["61-90"].count },
          "90+": { total: aging.buckets["90+"].total, count: aging.buckets["90+"].count },
        },
      }}
      dso={dso}
      paymentsInWindowCount={payments.filter((p) => p.days_to_pay != null).length}
      customers={customerCards}
      topCustomerShare={topCustomerShare}
      dismissed={dismissalRows.map((d: any) => ({
        qbo_invoice_id: String(d.qbo_invoice_id),
        doc_number: d.doc_number || null,
        customer_name: d.customer_name || null,
        amount: d.amount != null ? Number(d.amount) : null,
      }))}
    />
  );
}
