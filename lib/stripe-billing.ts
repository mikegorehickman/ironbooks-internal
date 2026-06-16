/**
 * Ironbooks client billing helpers — Stripe subscription + invoice lookups.
 *
 * Uses raw fetch against the Stripe REST API (no SDK dependency) to match
 * the pattern already used in lib/stripe-oauth.ts and the recon routes.
 *
 * STRIPE_SECRET_KEY must be set (already required by stripe-oauth.ts).
 *
 * Tier derivation is based on the monthly subscription amount so we never
 * have to manually set service_tier on client_links — it comes straight
 * from what Stripe says they're actually paying:
 *   ≤ $300/mo  → insight     ($247)
 *   $301–$600  → discipline  ($497)
 *   $601–$900  → vision      ($797)
 *   > $900     → scale       (custom)
 */

import type { ServiceTier } from "@/app/portal/billing/tiers";

const BASE = "https://api.stripe.com/v1";

async function stripeGet<T>(path: string): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": "2024-06-20",
    },
    next: { revalidate: 0 },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe ${res.status} on ${path}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function stripePost<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": "2024-06-20",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe ${res.status} on ${path}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Derive tier from the monthly amount in dollars. */
export function tierFromAmountDollars(dollars: number): ServiceTier {
  if (dollars <= 300) return "insight";
  if (dollars <= 600) return "discipline";
  if (dollars <= 900) return "vision";
  return "scale";
}

export interface StripeBillingInfo {
  tier: ServiceTier | null;
  monthlyAmountDollars: number | null;
  subscriptionStatus: string | null; // active | past_due | canceled | null
  subscriptionId: string | null;
  currentPeriodEnd: string | null;   // ISO date of next billing date
}

/**
 * Pull the customer's active subscription and derive their tier from
 * the subscription price amount. Returns null amounts when no active
 * subscription exists (e.g. manual invoice clients).
 */
export async function getCustomerBillingInfo(stripeCustomerId: string): Promise<StripeBillingInfo> {
  const data = await stripeGet<any>(
    `/subscriptions?customer=${encodeURIComponent(stripeCustomerId)}&status=active&limit=1&expand[]=data.items.data.price`
  );
  const sub = data?.data?.[0] ?? null;

  if (!sub) {
    // Try canceled/past_due as a fallback so the page shows something
    const allData = await stripeGet<any>(
      `/subscriptions?customer=${encodeURIComponent(stripeCustomerId)}&limit=1&expand[]=data.items.data.price`
    );
    const anySub = allData?.data?.[0] ?? null;
    if (!anySub) {
      return { tier: null, monthlyAmountDollars: null, subscriptionStatus: null, subscriptionId: null, currentPeriodEnd: null };
    }
    const price = anySub.items?.data?.[0]?.price;
    const cents = price?.unit_amount ?? 0;
    const dollars = cents / 100;
    return {
      tier: tierFromAmountDollars(dollars),
      monthlyAmountDollars: dollars,
      subscriptionStatus: anySub.status,
      subscriptionId: anySub.id,
      currentPeriodEnd: anySub.current_period_end
        ? new Date(anySub.current_period_end * 1000).toISOString()
        : null,
    };
  }

  const price = sub.items?.data?.[0]?.price;
  const cents = price?.unit_amount ?? 0;
  const dollars = cents / 100;

  return {
    tier: tierFromAmountDollars(dollars),
    monthlyAmountDollars: dollars,
    subscriptionStatus: sub.status,
    subscriptionId: sub.id,
    currentPeriodEnd: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
  };
}

export interface StripeInvoice {
  id: string;
  number: string | null;
  status: string;            // paid | open | void | draft
  amountPaid: number;        // dollars
  amountDue: number;         // dollars
  currency: string;
  periodStart: string;       // ISO date
  periodEnd: string;         // ISO date
  invoicePdfUrl: string | null;
  hostedInvoiceUrl: string | null;
  created: string;           // ISO date
  description: string | null;
}

/**
 * Fetch the client's most recent invoices (up to 24 months of history).
 */
export async function getCustomerInvoices(stripeCustomerId: string, limit = 24): Promise<StripeInvoice[]> {
  const data = await stripeGet<any>(
    `/invoices?customer=${encodeURIComponent(stripeCustomerId)}&limit=${limit}&status=paid`
  );
  return ((data?.data ?? []) as any[]).map((inv: any) => ({
    id: inv.id,
    number: inv.number ?? null,
    status: inv.status,
    amountPaid: (inv.amount_paid ?? 0) / 100,
    amountDue: (inv.amount_due ?? 0) / 100,
    currency: (inv.currency ?? "usd").toUpperCase(),
    periodStart: new Date(inv.period_start * 1000).toISOString(),
    periodEnd: new Date(inv.period_end * 1000).toISOString(),
    invoicePdfUrl: inv.invoice_pdf ?? null,
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    created: new Date(inv.created * 1000).toISOString(),
    description: inv.description ?? null,
  }));
}

/**
 * Create a Stripe Billing Portal session so the client can update their
 * payment method, view full invoice history, or download receipts.
 *
 * `returnUrl` is where Stripe sends them back after they're done.
 */
export async function createCustomerPortalSession(
  stripeCustomerId: string,
  returnUrl: string
): Promise<string> {
  const session = await stripePost<any>("/billing_portal/sessions", {
    customer: stripeCustomerId,
    return_url: returnUrl,
  });
  return session.url as string;
}
