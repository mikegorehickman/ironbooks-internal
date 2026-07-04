"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Plus, X } from "lucide-react";

type Cell = { collected: number; failed: number; manual: number; expected: number; comped: boolean; currency: string | null; note: string | null };
type Row = {
  clientLinkId: string;
  company: string;
  contact: string;
  billingDay: number | null;
  email: string | null;
  billingHold: boolean;
  pastDue: boolean;
  mrrCents: number;
  recurringCents: number;
  startMonth: number | null;
  hasSubscription: boolean;
  currency: string;
  subStatus: string;
  matchMethod: string | null;
  stripeCustomerId: string | null;
  months: Record<number, Cell>;
};

type Totals = { expectedUsdCents: number; expectedCadCents: number; collectedUsdCents: number; collectedCadCents: number };
type MonthProj = { usdCents: number; cadCents: number; combinedCadCents: number };
type Recon = {
  charge_count: number; matched_clients: number; matched_usd_cents: number; matched_cad_cents: number;
  unmatched_count: number; unmatched_usd_cents: number; unmatched_cad_cents: number; fx_usd_cad: number; ran_at: string;
} | null;
type Unmatched = { who: string; amountCents: number; currency: string; customerId: string | null };
type Coverage = {
  activeClients: number;
  unbilled: { client_link_id: string; client_name: string; service: "production" | "onboarding"; service_since: string | null; detail: string }[];
  missedThisMonth: { client_link_id: string; client_name: string; expected_cents: number; currency: string; billing_day: number | null; source: "stripe" | "manual"; detail: string }[];
  payingInactive: { client_link_id: string; client_name: string; mrr_cents: number; currency: string }[];
} | null;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
// Currency-aware: CAD amounts get a " CAD" tag; USD stays plain.
const fmtCur = (cents: number, currency: string) => money(cents) + (currency === "cad" ? " CAD" : "");

export function BillingTable({ year, rows, fxUsdToCad, totals, monthlyProjected, recon, unmatched, coverage }: { year: number; rows: Row[]; fxUsdToCad: number; totals: Totals; monthlyProjected: MonthProj[]; recon: Recon; unmatched: Unmatched[]; coverage?: Coverage }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<any | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "unmapped" | "failed">("all");
  const [modal, setModal] = useState<{ row: Row; month: number } | null>(null);
  const [matchRow, setMatchRow] = useState<Row | null>(null);
  const [expectedRow, setExpectedRow] = useState<Row | null>(null);

  const now = new Date();
  const curYear = now.getUTCFullYear();
  const curMonth = now.getUTCMonth() + 1;

  async function sync() {
    setSyncing(true); setSyncMsg(null);
    try {
      const res = await fetch("/api/admin/billing/sync", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ year }),
      });
      const j = await res.json();
      if (!res.ok) { setSyncMsg(j.error || "Sync failed"); return; }
      setSyncMsg(`Matched ${j.matched}/${j.scanned} clients · ${j.paymentsWritten} payments · ${j.unmatched?.length || 0} unmatched`);
      router.refresh();
    } catch (e: any) { setSyncMsg(e?.message || "Network error"); }
    finally { setSyncing(false); }
  }

  async function runDunning() {
    if (!confirm("Run billing dunning now? Sends a past-due reminder (email + portal) to clients with a confirmed failed payment, and applies/clears holds. Auto-suspend only acts if it's enabled server-side.")) return;
    setSyncMsg(null);
    try {
      const res = await fetch("/api/admin/billing/dunning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const j = await res.json();
      if (!res.ok) { setSyncMsg(j.error || "Dunning failed"); return; }
      setSyncMsg(`Dunning: ${j.pastDue} past due · ${j.remindersSent} reminders sent · ${j.suspended} suspended · ${j.cleared} cleared · auto-suspend ${j.autoSuspendOn ? "ON" : "OFF"}`);
      router.refresh();
    } catch (e: any) { setSyncMsg(e?.message || "Network error"); }
  }

  async function toggleHold(r: Row) {
    const place = !r.billingHold;
    if (!confirm(`${place ? "PLACE a billing hold on" : "RELEASE the billing hold for"} ${r.company}? ${place ? "This suspends their portal access until released." : "This restores their portal access."}`)) return;
    try {
      const res = await fetch("/api/admin/billing/dunning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_link_id: r.clientLinkId, hold: place }) });
      if (res.ok) router.refresh();
    } catch { /* ignore */ }
  }

  async function pullCharges() {
    setPulling(true); setPullResult(null);
    try {
      const res = await fetch("/api/admin/billing/pull-charges", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ year: curYear, month: curMonth }),
      });
      const j = await res.json();
      if (!res.ok) { setPullResult({ error: j.error || "Pull failed" }); return; }
      setPullResult(j); router.refresh();
    } catch (e: any) { setPullResult({ error: e?.message || "Network error" }); }
    finally { setPulling(false); }
  }

  // Cell color per the spec: grey expected, green collected, red failed/missed,
  // dark green when more than MRR came in (setup fee / coaching call / extra).
  function cellStyle(row: Row, m: number): { bg: string; fg: string; label: string } {
    const c = row.months[m];
    const recurring = row.recurringCents;
    const isPast = year < curYear || (year === curYear && m < curMonth);
    const collected = c.collected;
    // Per-payment currency (manual/expected entry) wins over the row currency.
    const cur = c.currency || row.currency;
    // Before the client's first billing month there were no expected charges —
    // never render red (or an expectation) for those months.
    const beforeStart = row.startMonth == null || m < row.startMonth;
    if (collected > 0) {
      if (recurring > 0 && collected > recurring + 50) return { bg: "#0F5132", fg: "#fff", label: fmtCur(collected, cur) };  // dark green: extra (setup fee / add-on)
      return { bg: "#D1E7DD", fg: "#0F5132", label: fmtCur(collected, cur) };                                    // green: collected
    }
    if (c.failed > 0) return { bg: "#F8D7DA", fg: "#842029", label: fmtCur(c.failed, cur) };                      // red: failed
    // Comped month (retention incentive) — waived on purpose, NOT a missed payment.
    if (c.comped) return { bg: "#E0E7FF", fg: "#3730A3", label: "comped" };                                       // indigo: comped
    // Manually-entered upcoming/expected payment (e-transfer etc.) — show as expected.
    if (c.expected > 0) return { bg: "#F1F3F5", fg: "#6B7682", label: fmtCur(c.expected, cur) };                  // grey: expected (manual)
    if (beforeStart) return { bg: "#FFFFFF", fg: "#D1D5DB", label: "" };                                          // pre-start: blank, never red
    if (isPast && recurring > 0 && ["active", "past_due"].includes(row.subStatus)) {
      return { bg: "#F8D7DA", fg: "#842029", label: "missed" };                                                  // red: missed (only on/after start)
    }
    return { bg: "#F1F3F5", fg: "#9AA3AD", label: recurring > 0 ? fmtCur(recurring, cur) : "" };                 // grey: projected recurring
  }

  const cad = (cents: number) => money(cents);
  const expectedCombinedCad = totals.expectedCadCents + Math.round(totals.expectedUsdCents * fxUsdToCad);
  const collectedCombinedCad = totals.collectedCadCents + Math.round(totals.collectedUsdCents * fxUsdToCad);

  // Search + filter (client-side; server-side pagination is the scale follow-up).
  const ql = q.trim().toLowerCase();
  const filteredRows = rows.filter((r) => {
    if (ql && !`${r.company} ${r.contact} ${r.email || ""}`.toLowerCase().includes(ql)) return false;
    if (filter === "unmapped" && r.stripeCustomerId) return false;
    if (filter === "failed" && !Object.values(r.months).some((c) => c.failed > 0)) return false;
    return true;
  });

  // Reconciliation: Stripe gross (this month) vs what we recorded vs unmatched.
  const reconCombined = recon
    ? {
        grossCad: recon.matched_cad_cents + recon.unmatched_cad_cents + Math.round((recon.matched_usd_cents + recon.unmatched_usd_cents) * (recon.fx_usd_cad || fxUsdToCad)),
        recordedCad: recon.matched_cad_cents + Math.round(recon.matched_usd_cents * (recon.fx_usd_cad || fxUsdToCad)),
        unmatchedCad: recon.unmatched_cad_cents + Math.round(recon.unmatched_usd_cents * (recon.fx_usd_cad || fxUsdToCad)),
      }
    : null;
  const unmatchedTotalCents = unmatched.reduce((s, u) => s + (u.currency === "cad" ? u.amountCents : Math.round(u.amountCents * fxUsdToCad)), 0);

  return (
    <div className="px-4 py-6 max-w-[1700px] mx-auto">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-bold text-navy">Billing</h1>
          <div className="text-sm text-ink-slate mt-1 space-y-0.5">
            <div>
              <span className="text-ink-light">Expected MRR:</span>{" "}
              <strong className="text-navy">{cad(expectedCombinedCad)} CAD</strong>{" "}
              <span className="text-ink-light">(USD {money(totals.expectedUsdCents)} + CAD {money(totals.expectedCadCents)}, USD→CAD {fxUsdToCad.toFixed(3)})</span>
            </div>
            <div>
              <span className="text-ink-light">Collected {year}:</span>{" "}
              <strong className="text-navy">{cad(collectedCombinedCad)} CAD</strong>{" "}
              <span className="text-ink-light">(USD {money(totals.collectedUsdCents)} + CAD {money(totals.collectedCadCents)})</span>
            </div>
            <div className="text-ink-light">{rows.length} clients</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a href={`/admin/billing?year=${year - 1}`} className="px-2.5 py-1.5 rounded-lg border border-gray-200 text-sm">←</a>
          <span className="text-sm font-bold text-navy">{year}</span>
          <a href={`/admin/billing?year=${year + 1}`} className="px-2.5 py-1.5 rounded-lg border border-gray-200 text-sm">→</a>
          <button onClick={pullCharges} disabled={pulling} className="inline-flex items-center gap-1.5 bg-navy hover:bg-navy/90 text-white text-sm font-semibold px-3 py-2 rounded-lg disabled:opacity-60" title="Pull every Stripe charge for the current month and match to clients">
            {pulling ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Pull this month's charges
          </button>
          <button onClick={sync} disabled={syncing} className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-3 py-2 rounded-lg disabled:opacity-60" title="Map clients to Stripe customers + pull the year's invoices">
            {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sync mapping
          </button>
          <button onClick={runDunning} className="inline-flex items-center gap-1.5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold px-3 py-2 rounded-lg" title="Send past-due reminders + apply/clear holds">
            Run dunning
          </button>
        </div>
      </div>
      {syncMsg && <div className="mb-3 text-xs text-ink-slate bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">{syncMsg}</div>}
      {pullResult?.error && <div className="mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{pullResult.error}</div>}

      {/* ── BILLING COVERAGE ── every serviced client cross-checked against
          billing state, so nobody gets bookkeeping for free. Clicking a name
          filters the grid to that client. Green when fully covered. */}
      {coverage && (coverage.unbilled.length > 0 || coverage.missedThisMonth.length > 0 || coverage.payingInactive.length > 0 ? (
        <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-sm space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong className="text-red-900">⚠ Billing coverage</strong>
            <span className="text-ink-slate">
              {coverage.unbilled.length > 0 && <><strong className="text-red-800">{coverage.unbilled.length}</strong> serviced with no billing</>}
              {coverage.missedThisMonth.length > 0 && <>{coverage.unbilled.length > 0 ? " · " : ""}<strong className="text-amber-800">{coverage.missedThisMonth.length}</strong> billed but nothing collected this month</>}
              {coverage.payingInactive.length > 0 && <> · <strong className="text-red-800">{coverage.payingInactive.length}</strong> paying while deactivated</>}
              {" "}(of {coverage.activeClients} active clients)
            </span>
          </div>
          {coverage.unbilled.length > 0 && (
            <ul className="space-y-1">
              {coverage.unbilled.map((g) => (
                <li key={g.client_link_id} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`font-bold px-1.5 py-0.5 rounded text-[10px] ${g.service === "production" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}`}>
                    {g.service === "production" ? "IN PRODUCTION" : "ONBOARDING"}
                  </span>
                  <button onClick={() => setQ(g.client_name)} className="font-semibold text-navy hover:underline">
                    {g.client_name}
                  </button>
                  <span className="text-ink-slate">{g.detail}</span>
                </li>
              ))}
            </ul>
          )}
          {coverage.missedThisMonth.length > 0 && (
            <ul className="space-y-1 pt-1 border-t border-red-200/60">
              {coverage.missedThisMonth.map((g) => (
                <li key={g.client_link_id} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800">NO PAYMENT YET</span>
                  <button onClick={() => setQ(g.client_name)} className="font-semibold text-navy hover:underline">
                    {g.client_name}
                  </button>
                  <span className="text-ink-slate">
                    {g.expected_cents > 0 ? `expects ${fmtCur(g.expected_cents, g.currency)}/mo · ` : ""}{g.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {coverage.payingInactive.length > 0 && (
            <ul className="space-y-1 pt-1 border-t border-red-200/60">
              {coverage.payingInactive.map((g) => (
                <li key={g.client_link_id} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold px-1.5 py-0.5 rounded text-[10px] bg-red-100 text-red-800">STILL CHARGING</span>
                  <span className="font-semibold text-navy">{g.client_name}</span>
                  <span className="text-ink-slate">
                    deactivated client with an active subscription{g.mrr_cents > 0 ? ` (${fmtCur(g.mrr_cents, g.currency)}/mo)` : ""} — cancel in Stripe or reactivate the client
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm">
          <strong className="text-emerald-900">✓ Billing coverage</strong>{" "}
          <span className="text-ink-slate">
            all {coverage.activeClients} active clients have a subscription, MRR, recent payment, or comped month — nobody is being serviced for free.
          </span>
        </div>
      ))}

      {/* Single reconciliation banner — the critical number. Stripe gross this
          month = recorded + unmatched; the gap is shown loudly with a direct
          link to resolve it (no duplicate sections). */}
      {reconCombined && (
        <div className={`mb-3 rounded-lg border px-3 py-2.5 text-sm ${reconCombined.unmatchedCad > 0 ? "bg-amber-50 border-amber-300" : "bg-emerald-50 border-emerald-200"}`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong className={reconCombined.unmatchedCad > 0 ? "text-amber-900" : "text-emerald-900"}>
              {reconCombined.unmatchedCad > 0 ? "⚠ Reconciliation" : "✓ Reconciled"}
            </strong>
            <span className="text-ink-slate">
              {MONTHS[curMonth - 1]} Stripe gross <strong>{cad(reconCombined.grossCad)} CAD</strong> = recorded {cad(reconCombined.recordedCad)} +{" "}
              <strong className={reconCombined.unmatchedCad > 0 ? "text-amber-800" : ""}>{cad(reconCombined.unmatchedCad)} unmatched</strong>
              {" "}({recon!.unmatched_count} charge{recon!.unmatched_count === 1 ? "" : "s"})
            </span>
            {recon!.unmatched_count > 0 && (
              <a href="/admin/billing/match" className="font-semibold text-amber-900 underline underline-offset-2">Review &amp; match →</a>
            )}
            <span className="text-ink-light text-xs">· pulled {new Date(recon!.ran_at).toLocaleString()}</span>
          </div>
        </div>
      )}

      {/* No recon snapshot yet, but a worklist exists → still offer the matcher. */}
      {!reconCombined && unmatched.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm">
          <strong className="text-amber-900">{unmatched.length} unmatched Stripe charge{unmatched.length === 1 ? "" : "s"}</strong> · {cad(unmatchedTotalCents)} CAD —{" "}
          <a href="/admin/billing/match" className="font-semibold text-amber-900 underline underline-offset-2">Review &amp; match →</a>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company / contact / email…"
          className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg w-64" />
        <select value={filter} onChange={(e) => setFilter(e.target.value as any)} className="px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg bg-white">
          <option value="all">All clients</option>
          <option value="unmapped">Not mapped to Stripe</option>
          <option value="failed">Has a failed payment</option>
        </select>
        <span className="text-xs text-ink-light">{filteredRows.length} of {rows.length}</span>
      </div>

      <div className="flex flex-wrap gap-3 mb-3 text-[11px] text-ink-slate">
        <Legend bg="#D1E7DD" t="collected (= MRR)" /><Legend bg="#0F5132" t="extra (setup/coaching)" />
        <Legend bg="#F8D7DA" t="failed / missed" /><Legend bg="#E0E7FF" t="comped" /><Legend bg="#F1F3F5" t="expected" />
        <span className="text-ink-light">· click any cell to log a manual (e-transfer) payment</span>
      </div>

      <div className="overflow-x-auto border border-gray-200 rounded-xl">
        <table className="text-sm border-collapse w-full">
          <thead>
            <tr className="bg-gray-50">
              <th className="sticky left-0 bg-gray-50 text-left font-semibold text-navy px-3 py-2 border-b border-gray-200 min-w-[180px]">Company</th>
              <th className="text-left font-semibold text-navy px-3 py-2 border-b border-gray-200 min-w-[140px]">Contact</th>
              <th className="text-center font-semibold text-navy px-2 py-2 border-b border-gray-200" title="Day of the month the payment is expected (e.g. 5 = the 5th)">Day</th>
              <th className="text-right font-semibold text-navy px-3 py-2 border-b border-gray-200">MRR</th>
              {MONTHS.map((mm) => <th key={mm} className="text-center font-semibold text-ink-slate px-2 py-2 border-b border-gray-200">{mm}</th>)}
            </tr>
            {/* Projected revenue per month: recurring MRR split by currency
                (CAD / USD) + combined total in CAD. RAMPS as clients onboard —
                a client only counts from its first billing month onward. */}
            <tr className="bg-gray-50">
              <th colSpan={4} className="sticky left-0 bg-gray-50 text-right align-bottom text-[10px] font-semibold text-ink-slate px-3 py-1 border-b border-gray-200">
                Projected / mo →<div className="font-normal text-ink-light">CAD · USD · total CAD</div>
              </th>
              {MONTHS.map((mm, i) => {
                const p = monthlyProjected[i] || { usdCents: 0, cadCents: 0, combinedCadCents: 0 };
                return (
                  <th key={mm} className="text-center align-top px-1 py-1 border-b border-l border-gray-200 font-normal">
                    <div className="text-[10px] leading-tight">
                      <div className="text-ink-slate">{money(p.cadCents)} CAD</div>
                      <div className="text-ink-slate">{money(p.usdCents)} USD</div>
                      <div className="font-semibold text-navy border-t border-gray-200 mt-0.5 pt-0.5">{cad(p.combinedCadCents)}</div>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <tr key={r.clientLinkId} className="hover:bg-gray-50/50">
                <td className="sticky left-0 bg-white px-3 py-1.5 border-b border-gray-100 max-w-[240px]">
                  <div className="font-medium text-navy truncate flex items-center gap-1.5" title={r.company}>
                    {r.billingHold && <span className="text-[9px] font-bold bg-red-100 text-red-700 px-1 py-0.5 rounded" title="Portal access suspended">HOLD</span>}
                    {!r.billingHold && r.pastDue && <span className="text-[9px] font-bold bg-amber-100 text-amber-800 px-1 py-0.5 rounded" title="Past due — reminders sending">PAST DUE</span>}
                    <span className="truncate">{r.company}</span>
                    <span
                      className={`text-[9px] font-bold px-1 py-0.5 rounded flex-shrink-0 ${r.hasSubscription ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}
                      title={r.hasSubscription ? "Active Stripe subscription" : "No Stripe subscription — manual / e-transfer"}>
                      {r.hasSubscription ? "SUB" : "MANUAL"}
                    </span>
                    <button onClick={() => toggleHold(r)} title={r.billingHold ? "Release hold (restore access)" : "Place hold (suspend access)"}
                      className="ml-auto flex-shrink-0 text-[10px] text-ink-light hover:text-navy">{r.billingHold ? "release" : "hold"}</button>
                  </div>
                  <button
                    onClick={() => setMatchRow(r)}
                    className="text-[11px] text-teal-dark hover:underline truncate max-w-[220px] block"
                    title="Click to match a Stripe customer"
                  >
                    {r.stripeCustomerId
                      ? <span className="text-emerald-600">✓ Stripe matched{r.matchMethod ? ` (${r.matchMethod})` : ""} — change</span>
                      : (r.email || "no email — match Stripe")}
                  </button>
                </td>
                <td className="px-3 py-1.5 border-b border-gray-100 text-ink-slate truncate max-w-[160px]">{r.contact}</td>
                <td className="px-2 py-1.5 border-b border-gray-100 text-center">
                  <DayCell row={r} onSaved={() => router.refresh()} />
                </td>
                <td className="px-3 py-1.5 border-b border-gray-100 text-right">
                  <button onClick={() => setExpectedRow(r)} title="Set expected monthly (subscription + payroll + …)"
                    className="text-navy font-semibold hover:text-teal-dark hover:underline">
                    {r.mrrCents > 0 ? fmtCur(r.mrrCents, r.currency) : <span className="text-ink-light font-normal">set…</span>}
                  </button>
                </td>
                {MONTHS.map((_, i) => {
                  const m = i + 1;
                  const st = cellStyle(r, m);
                  const note = r.months[m].note;
                  return (
                    <td key={m} className="border-b border-l border-gray-100 p-0">
                      <button onClick={() => setModal({ row: r, month: m })}
                        title={note || "Click to log a payment or add a note"}
                        className="relative w-full h-full px-1 py-1.5 text-center text-[11px] font-medium hover:opacity-80"
                        style={{ background: st.bg, color: st.fg }}>
                        {st.label || " "}
                        {note && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-500" title={note} />}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && <ManualModal row={modal.row} month={modal.month} year={year} onClose={() => setModal(null)} onSaved={() => { setModal(null); router.refresh(); }} />}
      {matchRow && <StripeMatchModal row={matchRow} year={year} onClose={() => setMatchRow(null)} onSaved={() => { setMatchRow(null); router.refresh(); }} />}
      {expectedRow && <ExpectedModal row={expectedRow} onClose={() => setExpectedRow(null)} onSaved={() => { setExpectedRow(null); router.refresh(); }} />}
    </div>
  );
}

function StripeMatchModal({ row, year, onClose, onSaved }: { row: Row; year: number; onClose: () => void; onSaved: () => void }) {
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<{ id: string; name: string | null; email: string | null; matched_on: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/admin/billing/stripe-candidates?client_link_id=${row.clientLinkId}`)
      .then((r) => r.json())
      .then((j) => { if (j.error) setErr(j.error); else setCandidates(j.candidates || []); })
      .catch((e) => setErr(e?.message || "Couldn't load candidates"))
      .finally(() => setLoading(false));
  }, [row.clientLinkId]);

  async function assign(stripeCustomerId: string) {
    setAssigning(stripeCustomerId); setErr(null);
    try {
      const res = await fetch("/api/admin/billing/match", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: row.clientLinkId, stripe_customer_id: stripeCustomerId, year }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "Match failed"); return; }
      onSaved();
    } catch (e: any) { setErr(e?.message || "Network error"); }
    finally { setAssigning(null); }
  }

  return (
    <div style={{ minHeight: "100vh" }} className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold text-navy">Match Stripe customer</h3>
          <button onClick={onClose} className="p-1 text-ink-light hover:text-navy"><X size={16} /></button>
        </div>
        <p className="text-xs text-ink-slate mb-3">{row.company}{row.email ? ` · ${row.email}` : ""}</p>
        {loading && <div className="flex items-center gap-2 text-sm text-ink-light py-4"><Loader2 size={14} className="animate-spin" /> Searching Stripe…</div>}
        {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2">{err}</div>}
        {!loading && candidates.length === 0 && !err && (
          <p className="text-sm text-ink-slate py-2">No close Stripe customers found by email or name. Try the Sync, or this client may pay off-Stripe (use a manual payment on a cell).</p>
        )}
        <ul className="space-y-2 max-h-[50vh] overflow-y-auto">
          {candidates.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-navy truncate">{c.name || "(no name)"}</div>
                <div className="text-xs text-ink-slate truncate">{c.email || "(no email)"} · matched on {c.matched_on}</div>
              </div>
              <button
                onClick={() => assign(c.id)}
                disabled={!!assigning}
                className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-60 flex-shrink-0"
              >
                {assigning === c.id ? <Loader2 size={12} className="animate-spin" /> : null} Match
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Ordinal day label: 5 → "5th", 1 → "1st", 22 → "22nd".
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Inline-editable "expected payment day of month" cell (3rd column). Click to
// type a day (1-31); saves to billing_subscriptions.billing_day via the
// expected endpoint. Blank clears it.
function DayCell({ row, onSaved }: { row: Row; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(row.billingDay != null ? String(row.billingDay) : "");
  const [saving, setSaving] = useState(false);

  async function save() {
    const trimmed = val.trim();
    const current = row.billingDay != null ? String(row.billingDay) : "";
    if (trimmed === current) { setEditing(false); return; }
    if (trimmed !== "") {
      const d = Number(trimmed);
      if (!Number.isInteger(d) || d < 1 || d > 31) { setVal(current); setEditing(false); return; }
    }
    setSaving(true);
    try {
      await fetch("/api/admin/billing/expected", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: row.clientLinkId, billing_day: trimmed === "" ? null : Number(trimmed) }),
      });
      setEditing(false); onSaved();
    } finally { setSaving(false); }
  }

  if (editing) {
    return (
      <input autoFocus type="number" min={1} max={31} value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
        disabled={saving}
        className="w-12 text-center border border-teal rounded px-1 py-0.5 text-sm" />
    );
  }
  return (
    <button onClick={() => setEditing(true)} title="Set the day of the month the payment is expected"
      className={row.billingDay != null ? "text-navy font-medium hover:text-teal-dark hover:underline" : "text-ink-light hover:text-teal-dark"}>
      {row.billingDay != null ? ordinal(row.billingDay) : "—"}
    </button>
  );
}

function ExpectedModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState((row.mrrCents / 100 || 0).toString());
  const [currency, setCurrency] = useState(row.currency || "usd");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true); setErr(null);
    try {
      const res = await fetch("/api/admin/billing/expected", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: row.clientLinkId, mrr: Number(amount), currency }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "Save failed"); return; }
      onSaved();
    } catch (e: any) { setErr(e?.message || "Network error"); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ minHeight: "100vh" }} className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold text-navy">Expected monthly</h3>
          <button onClick={onClose} className="p-1 text-ink-light hover:text-navy"><X size={16} /></button>
        </div>
        <p className="text-xs text-ink-slate mb-3">{row.company} — the full expected amount each month (subscription + payroll + any add-ons).</p>
        <div className="flex gap-2">
          <label className="flex-1"><span className="text-xs font-semibold text-ink-slate">Amount</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" autoFocus className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" /></label>
          <label><span className="text-xs font-semibold text-ink-slate">Currency</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="mt-1 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white">
              <option value="usd">USD</option><option value="cad">CAD</option></select></label>
        </div>
        {err && <div className="mt-2 text-xs text-red-700">{err}</div>}
        <button onClick={save} disabled={saving} className="mt-3 w-full inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2.5 rounded-lg disabled:opacity-60">
          {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save expected
        </button>
      </div>
    </div>
  );
}

function Legend({ bg, t }: { bg: string; t: string }) {
  return <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded" style={{ background: bg }} />{t}</span>;
}

function ManualModal({ row, month, year, onClose, onSaved }: { row: Row; month: number; year: number; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(row.currency || "usd");
  const [method, setMethod] = useState("etransfer");
  const [kind, setKind] = useState("subscription");
  const [status, setStatus] = useState("collected");
  const originalNote = row.months[month].note || "";
  const [cellNote, setCellNote] = useState(originalNote);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Save logs a payment (if an amount is entered) AND/OR saves the cell's
  // collection note (if changed) — so you can add a note without a payment.
  async function save() {
    const amt = Number(amount) || 0;
    // A comped (waived) month is a $0 marker, so it logs even with no amount.
    const hasPayment = (amount.trim() !== "" && Number.isFinite(Number(amount)) && amt > 0) || status === "comped";
    const noteChanged = cellNote.trim() !== originalNote.trim();
    if (!hasPayment && !noteChanged) { onClose(); return; }
    setSaving(true); setErr(null);
    try {
      if (hasPayment) {
        const res = await fetch("/api/admin/billing/payment", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_link_id: row.clientLinkId, year, month, amount: status === "comped" ? 0 : amt, currency, method, kind, status, note: cellNote }),
        });
        const j = await res.json();
        if (!res.ok) { setErr(j.error || "Save failed"); setSaving(false); return; }
      }
      if (noteChanged) {
        const res2 = await fetch("/api/admin/billing/cell-note", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_link_id: row.clientLinkId, year, month, note: cellNote }),
        });
        const j2 = await res2.json();
        if (!res2.ok) { setErr(j2.error || "Note save failed"); setSaving(false); return; }
      }
      onSaved();
    } catch (e: any) { setErr(e?.message || "Network error"); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ minHeight: "100vh" }} className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold text-navy">Log payment / note</h3>
          <button onClick={onClose} className="p-1 text-ink-light hover:text-navy"><X size={16} /></button>
        </div>
        <p className="text-xs text-ink-slate mb-3">{row.company} · {MONTHS[month - 1]} {year}</p>
        <div className="space-y-2.5">
          <div className="flex gap-2">
            <label className="flex-1"><span className="text-xs font-semibold text-ink-slate">Amount <span className="font-normal text-ink-light">(leave blank for note-only)</span></span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" placeholder="0" className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" /></label>
            <label><span className="text-xs font-semibold text-ink-slate">Currency</span>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="mt-1 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white">
                <option value="usd">USD</option><option value="cad">CAD</option></select></label>
          </div>
          <label className="block"><span className="text-xs font-semibold text-ink-slate">Method</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white">
              <option value="etransfer">E-transfer</option><option value="cheque">Cheque</option><option value="cash">Cash</option><option value="other">Other</option></select></label>
          <label className="block"><span className="text-xs font-semibold text-ink-slate">Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white">
              <option value="subscription">Subscription</option><option value="setup_fee">Setup fee</option><option value="coaching_call">Coaching call</option><option value="other">Other</option></select></label>
          <label className="block"><span className="text-xs font-semibold text-ink-slate">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white">
              <option value="collected">Collected (paid)</option><option value="expected">Expected (upcoming)</option><option value="comped">Comped (waived)</option><option value="failed">Failed</option></select></label>
          <label className="block"><span className="text-xs font-semibold text-ink-slate">Collection note <span className="font-normal text-ink-light">(shown on hover)</span></span>
            <textarea value={cellNote} onChange={(e) => setCellNote(e.target.value)} rows={2} placeholder="e.g. promised to pay by the 15th; card declined, following up…" className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" /></label>
        </div>
        {err && <div className="mt-2 text-xs text-red-700">{err}</div>}
        <button onClick={save} disabled={saving} className="mt-3 w-full inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2.5 rounded-lg disabled:opacity-60">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save
        </button>
      </div>
    </div>
  );
}
