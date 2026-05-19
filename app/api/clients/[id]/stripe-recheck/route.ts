import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { checkStripeAccountHealth } from "@/lib/stripe-health-check";

/**
 * POST /api/clients/[id]/stripe-recheck
 *
 * Re-runs the Stripe-account health check (writes stripe_has_payouts,
 * stripe_last_payout_at, stripe_payouts_checked_at). Two use cases:
 *
 *  1. Backfill: existing connections from before migration 21 have
 *     null health columns. Click recheck once and the warning/health
 *     indicators populate.
 *  2. Refresh: if a client reconnects to the same Stripe account but
 *     starts receiving payouts after a quiet period, hitting recheck
 *     clears stale warnings.
 *
 * Returns the fresh values so the caller can update its UI without a
 * full page reload.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, stripe_access_token, stripe_connection_status")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if ((client as any).stripe_connection_status !== "connected") {
    return NextResponse.json(
      { error: "Client doesn't have Stripe connected." },
      { status: 400 }
    );
  }
  const token = (client as any).stripe_access_token;
  if (!token) {
    return NextResponse.json(
      { error: "No stripe_access_token saved for this client." },
      { status: 400 }
    );
  }

  const health = await checkStripeAccountHealth({
    accessToken: token,
    clientLinkId,
    service,
  });

  return NextResponse.json({
    ok: true,
    stripe_has_payouts: health.hasPayouts,
    stripe_last_payout_at: health.lastPayoutAt,
    stripe_payouts_checked_at: new Date().toISOString(),
  });
}
