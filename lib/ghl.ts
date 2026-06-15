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

export interface GhlOpportunity {
  id: string;
  contactId: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactCompany: string | null;
  wonAt: string | null;
  createdAt: string | null;
}

/**
 * Pull Won opportunities from GHL, paginating until all results are fetched.
 * Used by the reconciliation backstop (/api/onboarding/reconcile) so missed
 * webhooks don't leave sales off the board.
 *
 * @param since  ISO date string — only return opportunities created/updated
 *               after this date (defaults to 90 days ago). For a first-time
 *               backfill, pass an earlier date.
 * @param maxPages  Safety cap — each page is 100 results (default 20 pages = 2000 ops).
 */
export async function fetchRecentWonOpportunities(
  since?: string,
  maxPages = 20
): Promise<GhlOpportunity[]> {
  if (!ghlConfigured()) return [];

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) return [];

  const startDate =
    since || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const results: GhlOpportunity[] = [];
  let page = 1;

  while (page <= maxPages) {
    const params = new URLSearchParams({
      location_id: locationId,
      status: "won",
      startDate,
      limit: "100",
      page: String(page),
    });

    let body: any;
    try {
      body = await ghlRequest<any>(`/opportunities/search?${params.toString()}`);
    } catch (err: any) {
      console.error(`[ghl] fetchRecentWonOpportunities page ${page} failed:`, err.message);
      break;
    }

    const ops: any[] = body?.opportunities || [];
    for (const op of ops) {
      const contact = op.contact || {};
      const name =
        contact.name ||
        [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
        null;
      results.push({
        id: op.id,
        contactId: contact.id || op.contactId || "",
        contactName: name || null,
        contactEmail: contact.email || null,
        contactPhone: contact.phone || null,
        contactCompany: contact.companyName || contact.company || null,
        wonAt: op.closedDate || op.updatedAt || op.createdAt || null,
        createdAt: op.createdAt || null,
      });
    }

    // GHL returns nextPageUrl in meta when there are more pages
    const hasMore = body?.meta?.nextPageUrl || ops.length === 100;
    if (!hasMore || ops.length === 0) break;
    page++;
  }

  return results;
}
