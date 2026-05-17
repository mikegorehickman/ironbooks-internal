/**
 * Stripe OAuth Connect (read-only)
 * ─────────────────────────────────
 * Standard OAuth flow with read_only scope. Client clicks our branded landing
 * page, hits Stripe's auth screen, approves, redirects back to our callback
 * with a code we exchange for a long-lived access token.
 *
 * Required env vars (set in Vercel):
 *   STRIPE_CONNECT_CLIENT_ID  — platform Connect Client ID (ca_xxx)
 *   STRIPE_SECRET_KEY         — platform secret key (sk_xxx, restricted is fine)
 *   NEXT_PUBLIC_BASE_URL      — https://internal.ironbooks.com
 */

const STRIPE_OAUTH_AUTHORIZE = "https://connect.stripe.com/oauth/authorize";
const STRIPE_OAUTH_TOKEN = "https://connect.stripe.com/oauth/token";

export interface StripeOAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  stripe_user_id: string;     // acct_xxx — the connected account ID
  scope: string;
  token_type: string;
  livemode: boolean;
  stripe_publishable_key?: string;
}

/**
 * Build the URL the client gets sent to when they click "Connect with Stripe".
 * We pass `state` = the connect-token from our DB so the callback can identify
 * which client_link the connection belongs to.
 */
export function buildStripeAuthorizeUrl(params: {
  state: string;
  /** Pre-fill business name on Stripe's screen (optional, just for UX) */
  suggestedCompany?: string;
}): string {
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!clientId) {
    throw new Error("STRIPE_CONNECT_CLIENT_ID env var is not set");
  }
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://internal.ironbooks.com";
  const redirectUri = `${baseUrl}/api/stripe/oauth/callback`;

  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "read_only",
    redirect_uri: redirectUri,
    state: params.state,
    "stripe_user[email]": "",    // we don't have it; Stripe will prompt
  });
  if (params.suggestedCompany) {
    query.set("stripe_user[business_name]", params.suggestedCompany);
  }

  return `${STRIPE_OAUTH_AUTHORIZE}?${query.toString()}`;
}

/**
 * Exchange the authorization code (returned to our callback) for access tokens.
 * Called server-side from the OAuth callback handler.
 */
export async function exchangeCodeForTokens(code: string): Promise<StripeOAuthTokenResponse> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    throw new Error("STRIPE_SECRET_KEY env var is not set");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
  });

  const res = await fetch(STRIPE_OAUTH_TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe OAuth token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as StripeOAuthTokenResponse;
  if (!data.access_token || !data.stripe_user_id) {
    throw new Error("Stripe OAuth response missing access_token or stripe_user_id");
  }
  return data;
}

/**
 * Generate a cryptographically random URL-safe token string for the connect
 * token's URL slug. 32 bytes = ~43 base64url characters — plenty of entropy.
 */
export function generateConnectToken(): string {
  // Browser-safe in Node 18+ and runtime environments
  const bytes = new Uint8Array(32);
  // @ts-ignore — crypto is globally available in Node 18+ and the Edge runtime
  (globalThis.crypto || require("crypto")).getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
