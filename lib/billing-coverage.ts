import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Billing coverage — the cross-check that no client is serviced for free.
 *
 * Every active client in SNAP is compared against the billing state
 * (billing_subscriptions + billing_payments):
 *
 *   unbilled          — receiving service with NO billing at all: no active
 *                       Stripe subscription, no MRR set, no payment collected
 *                       in the trailing 90 days, nothing expected or comped
 *                       this month. Production clients are red; onboarding
 *                       clients (cleanup not finished) are amber ("set up
 *                       billing now").
 *   missedThisMonth   — billed clients (sub or MRR) with nothing collected,
 *                       expected, or comped for the current month once the
 *                       billing day + grace has passed. Catches manual payers
 *                       who quietly stop (Stripe failures already dun).
 *   payingInactive    — active Stripe subscription on a DEACTIVATED client:
 *                       we're charging someone we no longer serve.
 *
 * Pure reads; degrades to empty lists if billing migrations aren't applied.
 */

export interface CoverageGap {
  client_link_id: string;
  client_name: string;
  service: "production" | "onboarding";
  service_since: string | null;
  detail: string;
}

export interface MissedMonthGap {
  client_link_id: string;
  client_name: string;
  expected_cents: number;
  currency: string;
  billing_day: number | null;
  source: "stripe" | "manual";
  detail: string;
}

export interface PayingInactive {
  client_link_id: string;
  client_name: string;
  mrr_cents: number;
  currency: string;
}

export interface BillingCoverage {
  activeClients: number;
  unbilled: CoverageGap[];
  missedThisMonth: MissedMonthGap[];
  payingInactive: PayingInactive[];
}

const GRACE_DAYS = 5;
const LOOKBACK_MONTHS = 3; // current + 2 prior — "recently paid" window

const monthLabel = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export async function computeBillingCoverage(service: SupabaseClient): Promise<BillingCoverage> {
  const svc = service as any;
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const curMonth = now.getUTCMonth() + 1;
  const curDay = now.getUTCDate();

  // Trailing window of (year, month) pairs, current first.
  const window: Array<{ y: number; m: number }> = [];
  for (let i = 0; i < LOOKBACK_MONTHS; i++) {
    const d = new Date(Date.UTC(curYear, curMonth - 1 - i, 1));
    window.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
  }

  const [{ data: clients }, subsRes, paysRes] = await Promise.all([
    svc
      .from("client_links")
      .select("id, client_name, legal_business_name, is_active, daily_recon_enabled, daily_recon_enabled_at, cleanup_completed_at, billing_start_date, created_at, qbo_realm_id")
      .order("client_name"),
    svc.from("billing_subscriptions").select("*").then((r: any) => r).catch(() => ({ data: [] })),
    svc
      .from("billing_payments")
      .select("client_link_id, period_year, period_month, amount_cents, status, source, currency")
      .in("period_year", [...new Set(window.map((w) => w.y))])
      .then((r: any) => r)
      .catch(() => ({ data: [] })),
  ]);

  const all = ((clients as any[]) || []);
  // Demo/test accounts are never billed — same exclusion the dup-scan uses.
  const isTest = (c: any) =>
    c.qbo_realm_id === "DEMO" || /\btest\b/i.test(c.client_name || "") || /\btest\b/i.test(c.legal_business_name || "");
  const active = all.filter((c) => c.is_active && !isTest(c));
  const nameOf = (c: any) => c.legal_business_name || c.client_name || "(unnamed)";
  const subs = ((subsRes?.data as any[]) || []);
  const subByClient = new Map(subs.map((s) => [s.client_link_id, s]));
  const pays = ((paysRes?.data as any[]) || []).filter((p) =>
    window.some((w) => w.y === p.period_year && w.m === p.period_month)
  );

  type Agg = { collectedRecent: number; curCollected: number; curExpected: number; curComped: boolean };
  const aggByClient = new Map<string, Agg>();
  for (const p of pays) {
    const a = aggByClient.get(p.client_link_id) || { collectedRecent: 0, curCollected: 0, curExpected: 0, curComped: false };
    const isCur = p.period_year === curYear && p.period_month === curMonth;
    if (p.status === "collected") {
      a.collectedRecent += p.amount_cents;
      if (isCur) a.curCollected += p.amount_cents;
    } else if (p.status === "expected" && isCur) {
      a.curExpected += p.amount_cents;
    } else if (p.status === "comped" && isCur) {
      a.curComped = true;
    }
    aggByClient.set(p.client_link_id, a);
  }

  const unbilled: CoverageGap[] = [];
  const missedThisMonth: MissedMonthGap[] = [];

  for (const c of active) {
    const sub = subByClient.get(c.id);
    const agg = aggByClient.get(c.id) || { collectedRecent: 0, curCollected: 0, curExpected: 0, curComped: false };
    const hasActiveSub =
      !!sub?.stripe_subscription_id && ["active", "past_due", "trialing"].includes(sub?.subscription_status || "");
    const recurringCents = sub ? Number(sub.manual_mrr_cents ?? sub.mrr_cents ?? 0) : 0;

    // Agreed future start — not a gap yet.
    if (c.billing_start_date && new Date(c.billing_start_date).getTime() > now.getTime()) continue;

    const inProduction = !!c.daily_recon_enabled;
    const anyBilling =
      hasActiveSub || recurringCents > 0 || agg.collectedRecent > 0 || agg.curExpected > 0 || agg.curComped;

    if (!anyBilling) {
      const since = inProduction ? c.daily_recon_enabled_at || c.cleanup_completed_at : c.created_at;
      unbilled.push({
        client_link_id: c.id,
        client_name: nameOf(c),
        service: inProduction ? "production" : "onboarding",
        service_since: since || null,
        detail: inProduction
          ? `In production${since ? ` since ${new Date(since).toLocaleDateString()}` : ""} — no subscription, no MRR, and no payment in ${LOOKBACK_MONTHS} months`
          : "Onboarding — no billing set up yet (no subscription, MRR, or payments)",
      });
      continue;
    }

    // Billed client — did this month actually get paid (or excused)?
    if ((hasActiveSub || recurringCents > 0) && !agg.curCollected && !agg.curExpected && !agg.curComped) {
      // Only alarm once the expected billing day + grace has passed.
      let billingDay: number | null = sub?.billing_day ?? null;
      if (billingDay == null && c.billing_start_date) {
        const d = new Date(c.billing_start_date).getUTCDate();
        if (Number.isInteger(d) && d >= 1 && d <= 31) billingDay = d;
      }
      const dueBy = Math.min((billingDay ?? 1) + GRACE_DAYS, 28);
      if (curDay > dueBy) {
        missedThisMonth.push({
          client_link_id: c.id,
          client_name: nameOf(c),
          expected_cents: recurringCents,
          currency: (sub?.currency as string) || "usd",
          billing_day: billingDay,
          source: hasActiveSub ? "stripe" : "manual",
          detail: `Nothing collected for ${monthLabel(now)}${billingDay ? ` (bills day ${billingDay})` : ""} — ${hasActiveSub ? "check the Stripe subscription" : "manual payer, chase or record the payment"}`,
        });
      }
    }
  }

  // Active subscriptions pointing at deactivated clients.
  const activeIds = new Set(active.map((c) => c.id));
  const inactiveNameById = new Map(all.filter((c) => !c.is_active).map((c) => [c.id, nameOf(c)]));
  const payingInactive: PayingInactive[] = subs
    .filter(
      (s) =>
        !activeIds.has(s.client_link_id) &&
        !!s.stripe_subscription_id &&
        ["active", "past_due", "trialing"].includes(s.subscription_status || "")
    )
    .map((s) => ({
      client_link_id: s.client_link_id,
      client_name: inactiveNameById.get(s.client_link_id) || "(deactivated client)",
      mrr_cents: Number(s.manual_mrr_cents ?? s.mrr_cents ?? 0),
      currency: (s.currency as string) || "usd",
    }));

  // Worst first: production gaps before onboarding, then by how long they've been serviced.
  unbilled.sort((a, b) =>
    a.service !== b.service
      ? a.service === "production" ? -1 : 1
      : (a.service_since || "9999") < (b.service_since || "9999") ? -1 : 1
  );

  return {
    activeClients: active.length,
    unbilled,
    missedThisMonth,
    payingInactive,
  };
}
