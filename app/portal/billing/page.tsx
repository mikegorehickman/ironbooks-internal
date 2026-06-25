import { createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BillingClient } from "./billing-client";
import { PortalErrorState } from "../error-state";
import {
  getCustomerBillingInfo,
  getCustomerInvoices,
  findStripeCustomerIdByEmail,
  type StripeBillingInfo,
  type StripeInvoice,
} from "@/lib/stripe-billing";
import { tryResolvePortalContext } from "@/lib/portal-context";

export const dynamic = "force-dynamic";

// Tier constants/types now live in ./tiers (client-safe) so billing-client.tsx
// can import them without dragging this server page into the client bundle.
// Import directly from "./tiers" — a page module must not export extra symbols.

/**
 * Portal billing page — no QBO required. Resolves identity via session →
 * client_users, then pulls tier + invoices from Stripe using the customer's
 * stripe_customer_id. Tier is derived from the subscription price so it
 * never needs to be set manually.
 */
export default async function BillingPage() {
  // Resolve the portal client the SAME way the layout does (honors admin
  // impersonation). Doing our own cookie/mapping logic here is what made
  // billing diverge from the rest of the portal — e.g. showing "Portal access
  // not available" for a client the layout rendered fine.
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    if (ctxResult.code === "no_session") redirect("/auth/login");
    return <PortalErrorState code={ctxResult.code as any} />;
  }
  const { ctx } = ctxResult;
  const clientLinkId = ctx.clientLinkId;
  const impersonating = ctx.impersonating;
  const service = createServiceSupabase();

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, client_email, stripe_customer_id, billing_start_date, billing_cancel_request_at, billing_cancel_request_note")
    .eq("id", clientLinkId)
    .single();

  if (!clientLink) {
    return <PortalErrorState code="fetch_failed" message="Could not load billing info." />;
  }

  let stripeCustomerId = (clientLink as any).stripe_customer_id as string | null;

  // Auto-link: if we don't have a Stripe customer id on file yet, try to find
  // it by email (the client_link's billing email, falling back to the
  // signed-in user's email). On a hit, persist it back to client_links so the
  // lookup only ever runs once per client. Fail soft — a miss just leaves the
  // page in its "contact us" fallback state.
  if (!stripeCustomerId) {
    const candidateEmails = [
      (clientLink as any).client_email as string | null,
      ctx.userEmail || null,
    ].filter((e): e is string => !!e && e.trim().length > 0);

    for (const email of candidateEmails) {
      try {
        const found = await findStripeCustomerIdByEmail(email);
        if (found) {
          stripeCustomerId = found;
          await service
            .from("client_links")
            .update({ stripe_customer_id: found } as any)
            .eq("id", clientLinkId);
          break;
        }
      } catch (err: any) {
        console.warn("[billing] Stripe customer lookup failed:", err.message);
        break; // Stripe unreachable — don't hammer it on the next candidate
      }
    }
  }
  const billingStart = (clientLink as any).billing_start_date as string | null;
  const cancelRequestAt = (clientLink as any).billing_cancel_request_at as string | null;
  const cancelRequestNote = (clientLink as any).billing_cancel_request_note as string | null;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://app.ironbooks.com";

  // Pick the payment link that matches the client's billing currency.
  // CA clients pay in CAD, everyone else in USD. The links are separate
  // Stripe products so the client sees the right currency on checkout.
  const jurisdiction = ((clientLink as any).jurisdiction as string | null) || "US";
  const coachingCallLink = jurisdiction === "CA"
    ? (process.env.STRIPE_COACHING_CALL_PAYMENT_LINK_CAD || null)
    : (process.env.STRIPE_COACHING_CALL_PAYMENT_LINK_USD || null);

  // New: SNAP-native paid coaching-call booking (migration 95). Tolerant — if
  // the table isn't applied yet, fall back to the static link above.
  let coaches: { coach_key: string; coach_name: string }[] = [];
  try {
    const { data: coachesRaw } = await (service as any)
      .from("coaching_call_settings")
      .select("coach_key, coach_name")
      .eq("active", true)
      .order("sort_order");
    coaches = (coachesRaw as any[]) || [];
  } catch {
    coaches = [];
  }
  const coachingPriceConfigured = !!(jurisdiction === "CA"
    ? process.env.STRIPE_COACHING_PRICE_CAD
    : process.env.STRIPE_COACHING_PRICE_USD);
  const coachingCheckoutEnabled = coaches.length > 0 && coachingPriceConfigured;

  // Pull tier + invoices from Stripe. Fail soft — if no customer ID or Stripe
  // is unreachable, the page still renders with a "contact us" fallback.
  let billingInfo: StripeBillingInfo | null = null;
  let invoices: StripeInvoice[] = [];

  if (stripeCustomerId) {
    try {
      [billingInfo, invoices] = await Promise.all([
        getCustomerBillingInfo(stripeCustomerId),
        getCustomerInvoices(stripeCustomerId, 24),
      ]);
    } catch (err: any) {
      console.warn("[billing] Stripe fetch failed:", err.message);
    }
  }

  return (
    <BillingClient
      clientLinkId={clientLinkId}
      clientName={(clientLink as any).client_name}
      tier={billingInfo?.tier ?? null}
      monthlyAmountDollars={billingInfo?.monthlyAmountDollars ?? null}
      subscriptionStatus={billingInfo?.subscriptionStatus ?? null}
      currentPeriodEnd={billingInfo?.currentPeriodEnd ?? null}
      billingStart={billingStart}
      stripeCustomerId={stripeCustomerId}
      invoices={invoices}
      coachingCallLink={coachingCallLink}
      coaches={coaches}
      coachingCheckoutEnabled={coachingCheckoutEnabled}
      cancelRequestAt={cancelRequestAt}
      cancelRequestNote={cancelRequestNote}
      impersonating={impersonating}
      portalReturnUrl={`${baseUrl}/portal/billing`}
    />
  );
}
