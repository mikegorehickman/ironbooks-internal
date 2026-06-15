/**
 * GoHighLevel (GHL / LeadConnector) integration.
 *
 * Two roles:
 *   1. Webhook auth — verify inbound onboarding webhooks really came from our
 *      GHL workflows (shared secret; GHL custom webhooks let you add a header).
 *   2. Outbound API — resend the onboarding email, and (future) reconcile
 *      Won opportunities / form submissions / appointments as a backstop so
 *      nothing slips past a dropped webhook.
 *
 * Env vars (set in Vercel):
 *   GHL_WEBHOOK_SECRET   — shared secret; we compare it constant-time to the
 *                          `x-snap-webhook-secret` header (or ?secret= query).
 *   GHL_API_KEY          — LeadConnector API token (for outbound calls).
 *   GHL_LOCATION_ID      — the GHL location/sub-account id.
 *   GHL_API_BASE         — defaults to https://services.leadconnectorhq.com
 */
import crypto from "crypto";

const API_BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";

/** Constant-time check of the webhook shared secret. */
export function verifyGhlWebhook(request: Request): boolean {
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[ghl] GHL_WEBHOOK_SECRET not configured");
    return false;
  }
  const url = new URL(request.url);
  const provided =
    request.headers.get("x-snap-webhook-secret") ||
    request.headers.get("x-webhook-secret") ||
    url.searchParams.get("secret") ||
    "";
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function ghlConfigured(): boolean {
  return !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID);
}

async function ghlRequest<T>(
  path: string,
  options: { method?: string; body?: any } = {}
): Promise<T> {
  const key = process.env.GHL_API_KEY;
  if (!key) throw new Error("GHL_API_KEY not configured");
  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      Version: "2021-07-28", // LeadConnector API version header
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL API ${res.status} on ${path}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

/**
 * Re-send the onboarding email (form + booking link) to a contact.
 *
 * PLACEHOLDER — the resend is currently an automation in GHL. The cleanest
 * trigger is to fire that same workflow via the API for this contact. We need
 * from Mike: the GHL workflow id for the onboarding email (env GHL_ONBOARDING_WORKFLOW_ID),
 * then this becomes a POST to /contacts/{id}/workflow/{workflowId}. Until that's
 * wired, this throws a clear, actionable error rather than silently no-op'ing.
 */
export async function resendOnboardingEmail(contactId: string): Promise<void> {
  const workflowId = process.env.GHL_ONBOARDING_WORKFLOW_ID;
  if (!workflowId) {
    throw new Error(
      "Resend not wired yet — set GHL_ONBOARDING_WORKFLOW_ID to the onboarding-email workflow."
    );
  }
  await ghlRequest(`/contacts/${contactId}/workflow/${workflowId}`, { method: "POST" });
}

/**
 * Reconciliation backstop (future): pull recently-Won opportunities so the
 * board self-heals if a webhook was missed. PLACEHOLDER until we confirm the
 * pipeline/stage ids to query.
 */
export async function fetchRecentWonOpportunities(): Promise<any[]> {
  if (!ghlConfigured()) return [];
  // TODO: GET /opportunities/search?location_id=...&status=won&date>=...
  return [];
}
