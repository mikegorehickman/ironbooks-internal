import { createServiceSupabase } from "@/lib/supabase";
import { buildStripeAuthorizeUrl } from "@/lib/stripe-oauth";
import { LandingClient } from "./landing-client";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ status?: string; message?: string }>;
}

/**
 * /stripe-connect/[token] — branded public landing page.
 *
 * Public route (no auth). Validates the token, looks up the linked client name
 * for personalization, renders a clean trust-building page explaining what's
 * about to happen, and provides the "Connect with Stripe" button that kicks
 * off OAuth.
 *
 * After OAuth callback redirects back here with ?status=success (or other),
 * the client sees the appropriate state — success, error, expired, etc.
 */
export default async function StripeConnectLandingPage({ params, searchParams }: PageProps) {
  const { token } = await params;
  const { status, message } = await searchParams;

  const service = createServiceSupabase();

  // Validate token + look up client
  const { data: connectToken } = await service
    .from("stripe_connect_tokens")
    .select("token, client_link_id, expires_at, used_at")
    .eq("token", token)
    .maybeSingle();

  let validity:
    | { state: "valid"; clientName: string; expiresAt: string }
    | { state: "expired" }
    | { state: "used" }
    | { state: "not_found" };

  if (!connectToken) {
    validity = { state: "not_found" };
  } else if (connectToken.used_at && status !== "success") {
    validity = { state: "used" };
  } else if (new Date(connectToken.expires_at).getTime() < Date.now()) {
    validity = { state: "expired" };
  } else {
    const { data: clientLink } = await service
      .from("client_links")
      .select("client_name")
      .eq("id", connectToken.client_link_id)
      .single();
    validity = {
      state: "valid",
      clientName: clientLink?.client_name || "your business",
      expiresAt: connectToken.expires_at,
    };
  }

  // Pre-compute the Stripe authorize URL (token = state param)
  let authorizeUrl: string | null = null;
  if (validity.state === "valid") {
    try {
      authorizeUrl = buildStripeAuthorizeUrl({
        state: token,
        suggestedCompany: validity.clientName,
      });
    } catch {
      // STRIPE_CONNECT_CLIENT_ID not configured — landing page will show error
      authorizeUrl = null;
    }
  }

  return (
    <LandingClient
      validity={validity}
      authorizeUrl={authorizeUrl}
      status={status}
      message={message}
    />
  );
}
