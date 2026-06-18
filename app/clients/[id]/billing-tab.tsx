"use client";

import { useEffect, useState } from "react";
import { CreditCard, Loader2, Download, ExternalLink, Calendar } from "lucide-react";

interface Billing {
  tier: string | null;
  monthlyAmountDollars: number | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
}
interface Invoice {
  id: string;
  number: string | null;
  amountPaid: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  invoicePdfUrl: string | null;
  hostedInvoiceUrl: string | null;
  created: string;
}

const TIER_LABEL: Record<string, string> = {
  insight: "Tier 1 – Insight", discipline: "Tier 2 – Discipline",
  vision: "Tier 3 – Vision", scale: "Tier 4 – Scale",
};
const fmtMoney = (n: number, c = "USD") =>
  n.toLocaleString("en-US", { style: "currency", currency: c, minimumFractionDigits: 0 });
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

/**
 * Internal Billing tab on the client profile — the client's Stripe
 * subscription + paid-invoice history. Lazy-loads from /api/clients/[id]/billing.
 */
export function BillingTab({ clientLinkId }: { clientLinkId: string }) {
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<{ configured: boolean; linked?: boolean; billing: Billing | null; invoices: Invoice[]; error?: string }>(
    { configured: true, billing: null, invoices: [] }
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/clients/${clientLinkId}/billing`);
        const data = await res.json();
        if (!cancelled) setState(data);
      } catch (e: any) {
        if (!cancelled) setState({ configured: true, billing: null, invoices: [], error: e.message });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clientLinkId]);

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-ink-slate py-10 justify-center"><Loader2 size={16} className="animate-spin text-teal" /> Loading billing…</div>;
  }
  if (!state.configured) {
    return <p className="text-sm text-ink-slate italic py-6">Stripe isn't connected (no STRIPE_SECRET_KEY). Billing can't be shown.</p>;
  }
  if (state.linked === false) {
    return <p className="text-sm text-ink-slate italic py-6">No Stripe customer linked to this client yet (matched by email). Set their billing email or link a Stripe customer.</p>;
  }
  if (state.error) {
    return <p className="text-sm text-red-600 py-6">{state.error}</p>;
  }

  const b = state.billing;
  const statusTone = b?.subscriptionStatus === "active" ? "bg-emerald-50 text-emerald-700"
    : b?.subscriptionStatus === "past_due" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600";

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Subscription */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
          <CreditCard size={15} className="text-teal" />
          <h3 className="text-sm font-bold text-navy uppercase tracking-wider">Subscription</h3>
          {b?.subscriptionStatus && (
            <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full ${statusTone}`}>
              {b.subscriptionStatus}
            </span>
          )}
        </div>
        <div className="px-5 py-4">
          {b?.monthlyAmountDollars != null ? (
            <div className="flex items-end gap-2">
              <span className="text-2xl font-black text-navy">{fmtMoney(b.monthlyAmountDollars)}</span>
              <span className="text-sm text-ink-slate mb-0.5">/month</span>
              {b.tier && <span className="ml-2 mb-0.5 text-xs font-semibold text-ink-slate">{TIER_LABEL[b.tier] || b.tier}</span>}
            </div>
          ) : (
            <p className="text-sm text-ink-slate">No active subscription on file.</p>
          )}
          {b?.currentPeriodEnd && b.subscriptionStatus === "active" && (
            <div className="text-xs text-ink-slate mt-2">Next billing date: <strong className="text-navy">{fmtDate(b.currentPeriodEnd)}</strong></div>
          )}
        </div>
      </div>

      {/* Payment history */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
          <Calendar size={15} className="text-teal" />
          <h3 className="text-sm font-bold text-navy uppercase tracking-wider">Payment history</h3>
          <span className="ml-auto text-[11px] text-ink-light">{state.invoices.length} invoice{state.invoices.length === 1 ? "" : "s"}</span>
        </div>
        {state.invoices.length === 0 ? (
          <p className="px-5 py-5 text-sm text-ink-slate italic">No paid invoices yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {state.invoices.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-navy">{inv.number || fmtDate(inv.created)}</div>
                  <div className="text-[11px] text-ink-light">{fmtDate(inv.periodStart)} – {fmtDate(inv.periodEnd)}</div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-sm font-bold text-navy">{fmtMoney(inv.amountPaid, inv.currency)}</span>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">Paid</span>
                  {inv.invoicePdfUrl && (
                    <a href={inv.invoicePdfUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-ink-slate hover:text-navy" title="Download PDF receipt">
                      <Download size={12} /> PDF
                    </a>
                  )}
                  {!inv.invoicePdfUrl && inv.hostedInvoiceUrl && (
                    <a href={inv.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-ink-slate hover:text-navy">
                      <ExternalLink size={12} /> View
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
