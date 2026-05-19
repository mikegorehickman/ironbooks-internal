import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/stripe-oauth";
import { checkStripeAccountHealth } from "@/lib/stripe-health-check";

/**
 * GET /api/stripe/oauth/callback?code=...&state=...
 *
 * Stripe redirects the user here after they approve our OAuth request on
 * stripe.com. We exchange the code for access tokens, save them onto the
 * client_link, mark the connect token as used, and redirect the user to the
 * success view of the landing page.
 *
 * The state param is the one-time connect token we generated, which we use
 * to look up which client_link this is for.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // Where to redirect on success/failure — same landing page with status query
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;
  const redirect = (params: Record<string, string>) => {
    const target = state
      ? `${baseUrl}/stripe-connect/${state}?${new URLSearchParams(params).toString()}`
      : `${baseUrl}/stripe-connect/error?${new URLSearchParams(params).toString()}`;
    return NextResponse.redirect(target);
  };

  // Client denied access on Stripe's screen
  if (error) {
    return redirect({
      status: "denied",
      message: errorDescription || error,
    });
  }

  if (!code || !state) {
    return redirect({ status: "error", message: "Missing code or state parameter" });
  }

  const service = createServiceSupabase();

  // Look up the connect token
  const { data: connectToken } = await service
    .from("stripe_connect_tokens")
    .select("id, token, client_link_id, expires_at, used_at")
    .eq("token", state)
    .single();

  if (!connectToken) {
    return redirect({ status: "error", message: "Invalid or expired link" });
  }

  if (new Date(connectToken.expires_at).getTime() < Date.now()) {
    return redirect({ status: "expired", message: "This link has expired" });
  }

  if (connectToken.used_at) {
    return redirect({ status: "already_used", message: "This link has already been used" });
  }

  // Exchange code for tokens
  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (err: any) {
    console.error("[stripe/oauth/callback] Token exchange failed:", err.message);
    return redirect({ status: "error", message: "Could not complete Stripe authorization" });
  }

  // Save the tokens onto the client_link. We also persist `livemode` so the
  // recon path can detect "sandbox connection vs live cleanup" mismatches
  // and warn the bookkeeper before zero-payout confusion sets in.
  const { error: updErr } = await service
    .from("client_links")
    .update({
      stripe_account_id: tokens.stripe_user_id,
      stripe_access_token: tokens.access_token,
      stripe_refresh_token: tokens.refresh_token,
      stripe_connected_at: new Date().toISOString(),
      stripe_connection_status: "connected",
      stripe_livemode: tokens.livemode === true,
    } as any)
    .eq("id", connectToken.client_link_id);

  if (updErr) {
    console.error("[stripe/oauth/callback] Failed to save tokens:", updErr.message);
    return redirect({ status: "error", message: "Could not save your connection" });
  }

  // Mark connect token as used
  await service
    .from("stripe_connect_tokens")
    .update({ used_at: new Date().toISOString() } as any)
    .eq("id", connectToken.id);

  // FAILSAFE: immediately ping /v1/payouts so we know whether this
  // account has ever had a payout. Catches the "client connected the
  // wrong (empty) Stripe account" case at handshake time — the new-recon
  // form will surface a warning before a bookkeeper sinks time into a
  // doomed reconciliation. Best-effort; never blocks the connect flow.
  const health = await checkStripeAccountHealth({
    accessToken: tokens.access_token,
    clientLinkId: connectToken.client_link_id,
    service,
  });

  // Audit log
  await service.from("audit_log").insert({
    user_id: connectToken.created_by ?? null,
    event_type: "stripe_oauth_connected",
    request_payload: {
      message: `Stripe connected for client`,
      client_link_id: connectToken.client_link_id,
      stripe_account_id: tokens.stripe_user_id,
      livemode: tokens.livemode,
      has_payouts: health.hasPayouts,
      last_payout_at: health.lastPayoutAt,
    } as any,
  } as any);

  // Send the user to the success view
  return redirect({ status: "success" });
}
