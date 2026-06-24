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

/**
 * Look up a Stripe customer id by email. Returns the most recently-created
 * matching customer's id, or null if none match. Used to auto-link a
 * client_link to its Stripe customer without anyone pasting `cus_xxx` by hand.
 *
 * Stripe's email filter is exact (case-insensitive). If a business has
 * multiple Stripe customers under the same email (rare — usually a duplicate),
 * we take the newest, which is almost always the live subscription.
 */
export async function findStripeCustomerIdByEmail(email: string): Promise<string | null> {
  const trimmed = (email || "").trim();
  if (!trimmed) return null;
  const data = await stripeGet<any>(
    `/customers?email=${encodeURIComponent(trimmed)}&limit=100`
  );
  const customers: any[] = data?.data ?? [];
  if (customers.length === 0) return null;
  // Newest first (Stripe returns by created desc already, but be explicit).
  customers.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return customers[0]?.id ?? null;
}

/**
 * Exact (case-insensitive) email lookup that returns FULL lite customers
 * (not just the top id) so callers can show/rank candidates. Uses the
 * immediate `/customers?email=` list endpoint (no search-index lag).
 */
export async function listCustomersByEmail(email: string): Promise<StripeCustomerLite[]> {
  const trimmed = (email || "").trim();
  if (!trimmed) return [];
  try {
    const data = await stripeGet<any>(
      `/customers?email=${encodeURIComponent(trimmed)}&limit=100`
    );
    return ((data?.data ?? []) as any[]).map((c) => ({
      id: c.id,
      name: c.name ?? null,
      email: c.email ?? null,
      created: c.created ?? null,
    }));
  } catch {
    return [];
  }
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

/**
 * Create a one-time Stripe Checkout Session (mode=payment) for a fixed price.
 * Attaching an existing `customerId` pre-fills the buyer's saved card so it's a
 * near-one-click purchase; otherwise we seed `customer_email`. Returns the
 * hosted Checkout URL + the session id (stored on the booking for verification).
 */
export async function createCheckoutSession(params: {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  customerId?: string | null;
  customerEmail?: string | null;
  metadata?: Record<string, string>;
}): Promise<{ id: string; url: string }> {
  const body: Record<string, string> = {
    mode: "payment",
    "line_items[0][price]": params.priceId,
    "line_items[0][quantity]": "1",
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    // Save the card so a repeat buyer is one-click next time.
    "payment_intent_data[setup_future_usage]": "on_session",
  };
  if (params.customerId) body.customer = params.customerId;
  else if (params.customerEmail) body.customer_email = params.customerEmail;
  for (const [k, v] of Object.entries(params.metadata || {})) {
    if (v != null) body[`metadata[${k}]`] = String(v);
  }
  const session = await stripePost<any>("/checkout/sessions", body);
  return { id: session.id as string, url: session.url as string };
}

/** Retrieve a Checkout Session to confirm payment server-side on the return page. */
export async function retrieveCheckoutSession(
  sessionId: string
): Promise<{ payment_status: string; status: string } | null> {
  try {
    const s = await stripeGet<any>(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
    return { payment_status: s?.payment_status ?? "unpaid", status: s?.status ?? "open" };
  } catch {
    return null;
  }
}

export interface StripeCustomerLite {
  id: string;
  name: string | null;
  email: string | null;
  created: number | null;
  phone?: string | null;
  address?: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    country: string | null;
  } | null;
}

/**
 * Fetch a single Stripe customer by id. Returns null if it doesn't exist or
 * has been deleted — so callers can validate a pasted `cus_...` before saving
 * it as a client's link.
 */
export async function getStripeCustomer(id: string): Promise<StripeCustomerLite | null> {
  const trimmed = (id || "").trim();
  if (!/^cus_[A-Za-z0-9]+$/.test(trimmed)) return null;
  try {
    const c = await stripeGet<any>(`/customers/${encodeURIComponent(trimmed)}`);
    if (!c || c.deleted) return null;
    return {
      id: c.id,
      name: c.name ?? null,
      email: c.email ?? null,
      created: c.created ?? null,
      phone: c.phone ?? null,
      address: c.address
        ? {
            line1: c.address.line1 ?? null,
            line2: c.address.line2 ?? null,
            city: c.address.city ?? null,
            state: c.address.state ?? null,
            postal_code: c.address.postal_code ?? null,
            country: c.address.country ?? null,
          }
        : null,
    };
  } catch (e: any) {
    if (/Stripe 404/.test(e?.message || "")) return null;
    throw e;
  }
}

/**
 * Search Stripe customers with the Stripe Search query language (e.g.
 * `name~"acme"` or `email~"@acme.com"`). `~` is a case-insensitive substring
 * match on name/email. Returns up to `limit` lite customers. Fail-soft: a
 * malformed/unsupported query resolves to [] rather than throwing, so a single
 * bad client never breaks a batch backfill.
 */
export async function searchStripeCustomers(query: string, limit = 20): Promise<StripeCustomerLite[]> {
  const q = (query || "").trim();
  if (!q) return [];
  try {
    const data = await stripeGet<any>(
      `/customers/search?query=${encodeURIComponent(q)}&limit=${Math.min(limit, 100)}`
    );
    return ((data?.data ?? []) as any[]).map((c) => ({
      id: c.id,
      name: c.name ?? null,
      email: c.email ?? null,
      created: c.created ?? null,
    }));
  } catch {
    return [];
  }
}
