import { AppShell } from "@/components/AppShell";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BillingTable } from "./billing-table";
import { computeBillingCoverage, type BillingCoverage } from "@/lib/billing-coverage";

export const dynamic = "force-dynamic";

/**
 * /admin/billing — IronBooks' subscription revenue, month-by-month, per client.
 * Synced from Stripe (billing_subscriptions + billing_payments, migration 96)
 * with manual entry for non-Stripe methods. Admin/lead only.
 */
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "billing_admin"].includes((actor as any)?.role || "")) redirect("/dashboard");

  const sp = await searchParams;
  const year = Number(sp.year) || new Date().getUTCFullYear();

  const curMonth = new Date().getUTCMonth() + 1;
  // Core client list uses ONLY long-standing columns, so a not-yet-run billing
  // migration can never blank the table. Migration-dependent data (dunning
  // columns, recon, unmatched) is fetched defensively below and degrades to
  // empty/false if those migrations haven't been applied.
  const [{ data: clients }, { data: subs }, { data: pays }] = await Promise.all([
    service.from("client_links")
      .select("id, client_name, legal_business_name, contact_first_name, contact_last_name, client_email, billing_start_date")
      .eq("is_active", true)
      .order("client_name"),
    (service as any).from("billing_subscriptions").select("*"),
    (service as any).from("billing_payments").select("*").eq("period_year", year),
  ]);

  const safe = async (p: any, fallback: any) => {
    try { const { data } = await p; return data ?? fallback; } catch { return fallback; }
  };
  const holdRows = await safe(
    (service as any).from("client_links").select("id, portal_billing_hold, billing_past_due_since").eq("is_active", true), []
  );
  const holdByClient = new Map<string, any>((holdRows || []).map((h: any) => [h.id, h]));
  const reconRows = await safe(
    (service as any).from("billing_recon_runs").select("*").eq("period_year", year).eq("period_month", curMonth).order("ran_at", { ascending: false }).limit(1), []
  );
  const unmatchedRows = await safe(
    (service as any).from("billing_unmatched_charges").select("*").eq("period_year", year).eq("period_month", curMonth).order("amount_cents", { ascending: false }), []
  );
  const recon = (reconRows as any[])?.[0] || null;
  const unmatched = (unmatchedRows as any[]) || [];

  // Per-cell notes (collection notes shown on hover) for this year.
  const noteRows = await safe(
    (service as any).from("billing_cell_notes").select("client_link_id, period_month, note").eq("period_year", year), []
  );
  const noteByCell = new Map<string, string>();
  for (const n of (noteRows as any[]) || []) if (n.note) noteByCell.set(`${n.client_link_id}-${n.period_month}`, n.note);

  // Earliest payment YEAR per client — tells us whether a client was already
  // billing before the displayed year (so Jan counts) vs started mid-year.
  const earliestYearRows = await safe(
    (service as any).from("billing_payments").select("client_link_id, period_year"), []
  );
  const earliestYearByClient = new Map<string, number>();
  for (const p of (earliestYearRows as any[]) || []) {
    const cur = earliestYearByClient.get(p.client_link_id);
    if (cur === undefined || p.period_year < cur) earliestYearByClient.set(p.client_link_id, p.period_year);
  }

  const subByClient = new Map<string, any>(((subs as any[]) || []).map((s) => [s.client_link_id, s]));
  // Aggregate payments → per client, per month.
  type CellAgg = { collected: number; failed: number; manual: number; expected: number; comped: boolean; currency: string | null };
  const payAgg = new Map<string, Map<number, CellAgg>>();
  for (const p of ((pays as any[]) || [])) {
    if (!payAgg.has(p.client_link_id)) payAgg.set(p.client_link_id, new Map());
    const m = payAgg.get(p.client_link_id)!;
    const cell = m.get(p.period_month) || { collected: 0, failed: 0, manual: 0, expected: 0, comped: false, currency: null };
    if (p.status === "failed") cell.failed += p.amount_cents;
    else if (p.status === "expected") cell.expected += p.amount_cents; // manually-entered upcoming payment (e-transfer etc.)
    else if (p.status === "comped") cell.comped = true; // month waived (retention incentive) — not a missed payment
    else if (p.status === "collected") { cell.collected += p.amount_cents; if (p.source === "manual") cell.manual += p.amount_cents; }
    if (p.currency && !cell.currency) cell.currency = p.currency; // per-payment currency overrides row currency for this cell
    m.set(p.period_month, cell);
  }

  type Cell = CellAgg & { note: string | null };
  const rows = ((clients as any[]) || []).map((c) => {
    const sub = subByClient.get(c.id);
    const mrrCents = sub ? (sub.manual_mrr_cents ?? sub.mrr_cents ?? 0) : 0;
    // Expected payment day of month: explicit billing_day, else seeded from
    // the billing_start_date's day-of-month, else blank.
    let billingDay: number | null = sub?.billing_day ?? null;
    if (billingDay == null && c.billing_start_date) {
      const d = new Date(c.billing_start_date).getUTCDate();
      if (Number.isInteger(d) && d >= 1 && d <= 31) billingDay = d;
    }
    const m = payAgg.get(c.id);
    const months: Record<number, Cell> = {};
    for (let i = 1; i <= 12; i++) {
      const base = m?.get(i) || { collected: 0, failed: 0, manual: 0, expected: 0, comped: false, currency: null };
      months[i] = { ...base, note: noteByCell.get(`${c.id}-${i}`) || null };
    }

    // ── Start month: the first month this client is "live" for billing in the
    //    displayed year. Before it there were no expected charges → no red, no
    //    projection. Derived from billing_start_date and actual activity; a
    //    client already billing in a prior year counts from January.
    const activeMonths = Object.keys(months).map(Number).filter((k) => months[k].collected > 0 || months[k].expected > 0);
    const earliestActivity = activeMonths.length ? Math.min(...activeMonths) : Infinity;
    const startCandidates: number[] = [];
    if (c.billing_start_date) {
      const d = new Date(c.billing_start_date);
      const sy = d.getUTCFullYear();
      startCandidates.push(sy < year ? 1 : sy === year ? d.getUTCMonth() + 1 : 99);
    }
    const earliestYear = earliestYearByClient.get(c.id);
    if (earliestYear !== undefined && earliestYear < year) startCandidates.push(1);
    if (Number.isFinite(earliestActivity)) startCandidates.push(earliestActivity);
    let startMonth: number | null = startCandidates.length ? Math.min(...startCandidates) : null;
    if (startMonth === 99) startMonth = null; // billing_start_date is a future year, no activity → not started

    // ── Recurring (projected) monthly: the set MRR if any, else inferred from a
    //    collected month AFTER the start month — the FIRST month is usually a
    //    larger setup fee, so we don't treat it as the recurring amount.
    let recurringCents = mrrCents;
    if (!recurringCents) {
      const ongoing = activeMonths
        .filter((k) => startMonth == null || k > startMonth)
        .map((k) => months[k].collected)
        .filter((v) => v > 0);
      if (ongoing.length) recurringCents = ongoing[ongoing.length - 1]; // most recent non-setup month
    }

    const hasSubscription =
      !!sub?.stripe_subscription_id && ["active", "past_due", "trialing"].includes(sub?.subscription_status || "");

    return {
      clientLinkId: c.id,
      company: c.legal_business_name || c.client_name || "—",
      contact: [c.contact_first_name, c.contact_last_name].filter(Boolean).join(" ") || "—",
      billingDay,
      email: c.client_email || null,
      billingHold: !!holdByClient.get(c.id)?.portal_billing_hold,
      pastDue: !!holdByClient.get(c.id)?.billing_past_due_since,
      mrrCents,
      recurringCents,
      startMonth,
      hasSubscription,
      currency: (sub?.currency as string) || "usd",
      subStatus: sub?.subscription_status || "none",
      matchMethod: sub?.match_method || null,
      stripeCustomerId: sub?.stripe_customer_id || null,
      months,
    };
  });

  // Billing coverage: every serviced client cross-checked against billing
  // state, so nobody gets bookkeeping for free. Degrades to empty on error.
  let coverage: BillingCoverage | null = null;
  try {
    coverage = await computeBillingCoverage(service as any);
  } catch {
    coverage = null;
  }

  // Current USD→CAD spot rate (server-side fetch; safe fallback if it fails).
  let fxUsdToCad = 1.37;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD", { next: { revalidate: 3600 } });
    const j = await r.json();
    if (j?.rates?.CAD && Number.isFinite(j.rates.CAD)) fxUsdToCad = j.rates.CAD;
  } catch { /* keep fallback */ }

  const sum = (pred: (r: typeof rows[number]) => boolean, val: (r: typeof rows[number]) => number) =>
    rows.filter(pred).reduce((s, r) => s + val(r), 0);
  const collectedOf = (r: typeof rows[number]) => Object.values(r.months).reduce((a, c) => a + c.collected, 0);
  const totals = {
    expectedUsdCents: sum((r) => r.currency !== "cad", (r) => r.recurringCents),
    expectedCadCents: sum((r) => r.currency === "cad", (r) => r.recurringCents),
    collectedUsdCents: sum((r) => r.currency !== "cad", collectedOf),
    collectedCadCents: sum((r) => r.currency === "cad", collectedOf),
  };

  // Per-month projected revenue: a client only contributes from its start month
  // onward (so the projection RAMPS as clients onboard — not a flat line). Each
  // month sums recurring MRR by currency + a combined CAD figure at spot FX.
  const monthlyProjected = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    let usd = 0, cad = 0;
    for (const r of rows) {
      if (r.startMonth == null || r.startMonth > m || !r.recurringCents) continue;
      if (r.currency === "cad") cad += r.recurringCents; else usd += r.recurringCents;
    }
    return { usdCents: usd, cadCents: cad, combinedCadCents: cad + Math.round(usd * fxUsdToCad) };
  });

  return (
    <AppShell>
      <BillingTable
        year={year}
        rows={rows}
        fxUsdToCad={fxUsdToCad}
        totals={totals}
        monthlyProjected={monthlyProjected}
        recon={recon}
        unmatched={unmatched.map((u) => ({
          who: u.who, amountCents: u.amount_cents, currency: u.currency, customerId: u.stripe_customer_id,
        }))}
        coverage={coverage}
      />
    </AppShell>
  );
}
