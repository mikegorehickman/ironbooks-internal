import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Lightweight health check for a connected Stripe account.
 *
 * Hits /v1/payouts?limit=1 to determine whether the account has ever had
 * a payout, and if so when the most recent one arrived. Stores the
 * result on client_links so the new-recon form, clients page, and
 * Stripe Connect modal can warn the bookkeeper when an account looks
 * suspicious BEFORE they sink time into a recon.
 *
 * Why this exists: the James Painting LLC incident — bookkeeper sent a
 * Connect link, client authorized a brand-new empty Stripe account
 * instead of the one that had been receiving payouts. Connection looked
 * green. The recon ran, returned zero matches, and we spent an hour
 * chasing ghosts. With this check, "stripe_has_payouts=false" lights up
 * on the form immediately.
 *
 * Best-effort: any error is swallowed and logged. We never block on
 * this — connections can still be flagged as 'connected' even if the
 * health check fails (it's purely informational metadata).
 */
export async function checkStripeAccountHealth(opts: {
  accessToken: string;
  clientLinkId: string;
  service: SupabaseClient;
}): Promise<{
  hasPayouts: boolean | null;
  lastPayoutAt: string | null;
}> {
  let hasPayouts: boolean | null = null;
  let lastPayoutAt: string | null = null;

  try {
    const res = await fetch(
      "https://api.stripe.com/v1/payouts?limit=1",
      {
        headers: {
          Authorization: `Bearer ${opts.accessToken}`,
          "Stripe-Version": "2024-04-10",
        },
      }
    );
    if (res.ok) {
      const body = (await res.json()) as { data: Array<{ arrival_date: number }> };
      hasPayouts = body.data.length > 0;
      if (hasPayouts) {
        // arrival_date is unix seconds. Convert to ISO timestamptz.
        lastPayoutAt = new Date(body.data[0].arrival_date * 1000).toISOString();
      }
    } else {
      console.warn(
        `[stripe-health-check] /v1/payouts ${res.status} for client ${opts.clientLinkId}`
      );
    }
  } catch (err: any) {
    console.warn(
      `[stripe-health-check] Fetch failed for client ${opts.clientLinkId}:`,
      err?.message
    );
  }

  // Persist whatever we got (including null on error — so the UI knows
  // "we tried" vs "never checked").
  try {
    await opts.service
      .from("client_links")
      .update({
        stripe_has_payouts: hasPayouts,
        stripe_payouts_checked_at: new Date().toISOString(),
        stripe_last_payout_at: lastPayoutAt,
      } as any)
      .eq("id", opts.clientLinkId);
  } catch (err: any) {
    console.warn(
      `[stripe-health-check] Failed to persist for client ${opts.clientLinkId}:`,
      err?.message
    );
  }

  return { hasPayouts, lastPayoutAt };
}
