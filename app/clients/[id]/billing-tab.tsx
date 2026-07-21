"use client";

import { useCallback, useEffect, useState } from "react";
import { CreditCard, Loader2, Download, ExternalLink, Calendar, Link2, Search } from "lucide-react";

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
  const [relink, setRelink] = useState(false);
  const [state, setState] = useState<{ configured: boolean; linked?: boolean; billing: Billing | null; invoices: Invoice[]; error?: string }>(
    { configured: true, billing: null, invoices: [] }
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/billing`);
      const data = await res.json();
      setState(data);
    } catch (e: any) {
      setState({ configured: true, billing: null, invoices: [], error: e.message });
    } finally {
      setLoading(false);
    }
  }, [clientLinkId]);

  useEffect(() => { load(); }, [load]);

  async function unlink() {
    if (!window.confirm("Unlink this Stripe customer? Billing will show empty until it's re-linked.")) return;
    try {
      await fetch(`/api/clients/${clientLinkId}/billing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unlink" }),
      });
      load();
    } catch { /* surfaced on next load */ }
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-ink-slate py-10 justify-center"><Loader2 size={16} className="animate-spin text-teal" /> Loading billing…</div>;
  }
  if (!state.configured) {
    return <p className="text-sm text-ink-slate italic py-6">Stripe isn't connected (no STRIPE_SECRET_KEY). Billing can't be shown.</p>;
  }
  if (state.linked === false) {
    return (
      <div className="max-w-xl py-2">
        <p className="text-sm text-ink-slate mb-3">
          No Stripe customer is linked to this client yet, so billing can't load.
          Search by name/email or paste their <code className="text-xs">cus_…</code> id to link it.
        </p>
        <LinkStripeCustomer clientLinkId={clientLinkId} onLinked={load} />
      </div>
    );
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
          <div className="flex items-center gap-3 mt-3">
            <button
              onClick={() => setRelink((r) => !r)}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal hover:text-teal-dark"
            >
              <Search size={11} /> Find / change payment profile
            </button>
            <button onClick={unlink} className="text-[11px] text-ink-light hover:text-red-600">
              Wrong customer? Unlink
            </button>
          </div>
          {relink && (
            <div className="mt-3">
              <p className="text-[11px] text-ink-slate mb-2">
                Search Stripe by name/email or paste a <code className="text-[10px]">cus_…</code> id to re-point this client.
              </p>
              <LinkStripeCustomer clientLinkId={clientLinkId} onLinked={() => { setRelink(false); load(); }} />
            </div>
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

interface Candidate { id: string; name: string | null; email: string | null }

/**
 * Manual Stripe-customer linker shown when email auto-match misses. Search by
 * name/email (Stripe customer search) or paste a `cus_…` id; on link the
 * parent re-fetches and the subscription + invoices appear.
 */
function LinkStripeCustomer({ clientLinkId, onLinked }: { clientLinkId: string; onLinked: () => void }) {
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isCus = /^cus_[A-Za-z0-9]+$/.test(q.trim());

  async function post(body: any) {
    const res = await fetch(`/api/clients/${clientLinkId}/billing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function search() {
    if (!q.trim()) return;
    setSearching(true); setError(null);
    try {
      const data = await post({ action: "search", query: q.trim() });
      setCandidates(data.candidates || []);
      setSearched(true);
    } catch (e: any) { setError(e.message); } finally { setSearching(false); }
  }

  async function link(cusId: string) {
    setBusyId(cusId); setError(null);
    try {
      await post({ action: "set", stripeCustomerId: cusId });
      onLinked();
    } catch (e: any) { setError(e.message); setBusyId(null); }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (isCus ? link(q.trim()) : search()); }}
          placeholder="Search name or email, or paste cus_…"
          className="flex-1 text-sm px-3 py-2 rounded-lg border border-slate-200 focus:border-teal focus:outline-none"
        />
        {isCus ? (
          <button onClick={() => link(q.trim())} disabled={!!busyId}
            className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-lg bg-teal text-white hover:bg-teal-dark disabled:opacity-50">
            <Link2 size={14} /> Link
          </button>
        ) : (
          <button onClick={search} disabled={searching || !q.trim()}
            className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-lg bg-teal text-white hover:bg-teal-dark disabled:opacity-50">
            {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Search
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {candidates.length > 0 && (
        <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
          {candidates.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-navy truncate">{c.name || "(no name)"}</div>
                <div className="text-[11px] text-ink-light truncate font-mono">{c.email || c.id}</div>
              </div>
              <button onClick={() => link(c.id)} disabled={busyId === c.id}
                className="flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg border border-teal text-teal hover:bg-teal/5 disabled:opacity-50">
                {busyId === c.id ? "Linking…" : "Link"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {searched && candidates.length === 0 && !searching && (
        <p className="text-xs text-ink-light italic">No Stripe customers matched “{q.trim()}”. Try the company name, billing email, or paste the cus_… id.</p>
      )}
    </div>
  );
}
