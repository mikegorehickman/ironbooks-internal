"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Check, ArrowLeft } from "lucide-react";

type Item = {
  id: string; chargeId: string; customerId: string | null; who: string; displayEmail: string | null; displayName: string | null;
  amountCents: number; currency: string; year: number; month: number;
  suggestion: { clientLinkId: string; company: string; score: number; reason: string } | null;
};
type ClientOpt = { id: string; company: string };
const money = (c: number) => `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export function MatchClient({ items, clients }: { items: Item[]; clients: ClientOpt[] }) {
  const router = useRouter();
  const [done, setDone] = useState<Record<string, string>>({});   // item.id → matched company
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});   // item.id → chosen clientLinkId
  const [err, setErr] = useState<string | null>(null);

  async function confirm(it: Item, clientLinkId: string, company: string) {
    if (!it.customerId) { setErr("This charge has no Stripe customer id — it'll reconcile on the next pull."); return; }
    setBusy(it.id); setErr(null);
    try {
      const res = await fetch("/api/admin/billing/match", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId, stripe_customer_id: it.customerId, year: it.year }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "Match failed"); return; }
      setDone((d) => ({ ...d, [it.id]: company }));
    } catch (e: any) { setErr(e?.message || "Network error"); }
    finally { setBusy(null); }
  }

  // Create a NEW SNAP account (onboarding, assigned to Lisa) for a payer who
  // has no client yet, and map this Stripe customer to it.
  async function createAccount(it: Item) {
    setBusy(it.id); setErr(null);
    try {
      const res = await fetch("/api/admin/billing/create-client", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stripe_customer_id: it.customerId, email: it.displayEmail, name: it.displayName, currency: it.currency }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "Create failed"); return; }
      setDone((d) => ({ ...d, [it.id]: `${it.displayName || it.displayEmail || "new client"} (created → onboarding)` }));
    } catch (e: any) { setErr(e?.message || "Network error"); }
    finally { setBusy(null); }
  }

  const remaining = items.filter((it) => !done[it.id]);

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <Link href="/admin/billing" className="inline-flex items-center gap-1.5 text-sm text-ink-slate hover:text-navy mb-3"><ArrowLeft size={14} /> Back to billing</Link>
      <h1 className="text-2xl font-bold text-navy">Match unmatched charges</h1>
      <p className="text-sm text-ink-slate mt-1">
        {items.length} Stripe charge{items.length === 1 ? "" : "s"} didn't auto-map. Confirm each to the right client (or pick manually). Matching a charge maps its Stripe customer to the client and pulls their payments in.
      </p>
      {err && <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}
      {Object.keys(done).length > 0 && (
        <div className="mt-3 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          Matched {Object.keys(done).length}. <button onClick={() => router.refresh()} className="underline font-semibold">Refresh</button> to re-check, or re-pull on the billing page to finalize totals.
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {items.map((it) => {
          const matched = done[it.id];
          const sug = it.suggestion;
          const chosen = pick[it.id] || sug?.clientLinkId || "";
          const chosenCompany = clients.find((c) => c.id === chosen)?.company || sug?.company || "";
          return (
            <li key={it.id} className={`rounded-xl border px-3 py-2.5 ${matched ? "border-emerald-200 bg-emerald-50/50" : "border-gray-200 bg-white"}`}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-navy truncate">{it.displayEmail || it.who}</div>
                  <div className="text-xs text-ink-slate">{money(it.amountCents)} {it.currency.toUpperCase()} · {it.month}/{it.year}{it.customerId ? "" : " · no customer id"}</div>
                </div>
                {matched ? (
                  <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700 font-semibold"><Check size={15} /> Matched → {matched}</span>
                ) : (
                  <div className="flex items-center gap-2">
                    <select value={chosen} onChange={(e) => setPick((p) => ({ ...p, [it.id]: e.target.value }))}
                      className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white max-w-[220px]">
                      <option value="">Pick client…</option>
                      {clients.map((c) => <option key={c.id} value={c.id}>{c.company}</option>)}
                    </select>
                    <button
                      onClick={() => confirm(it, chosen, chosenCompany)}
                      disabled={!chosen || busy === it.id || !it.customerId}
                      className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50">
                      {busy === it.id ? <Loader2 size={13} className="animate-spin" /> : null} Match
                    </button>
                    <button
                      onClick={() => createAccount(it)}
                      disabled={busy === it.id}
                      title="No account for this payer? Create one in onboarding (assigned to Lisa) and map this customer."
                      className="inline-flex items-center gap-1.5 border border-gray-200 bg-white hover:border-teal text-ink-slate hover:text-teal-dark text-sm font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50">
                      + New account
                    </button>
                  </div>
                )}
              </div>
              {!matched && sug && (
                <div className="mt-1.5 text-xs text-teal-dark">
                  Suggested: <strong>{sug.company}</strong> <span className="text-ink-light">({sug.reason})</span>
                </div>
              )}
              {!matched && !sug && <div className="mt-1.5 text-xs text-ink-light">No confident match — pick the client above.</div>}
            </li>
          );
        })}
        {remaining.length === 0 && items.length > 0 && (
          <li className="text-sm text-emerald-700 py-4 text-center">All charges matched. Re-pull on the billing page to finalize the reconciliation.</li>
        )}
        {items.length === 0 && <li className="text-sm text-ink-slate py-4 text-center">Nothing unmatched — the latest pull reconciled fully. 🎉</li>}
      </ul>
    </div>
  );
}
