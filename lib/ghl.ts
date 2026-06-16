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

export interface GhlContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  address1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  /** Raw custom fields array (id/value pairs) — kept for downstream mapping. */
  customFields: any[];
}

/**
 * Look up a GHL contact by email within our location. Returns the first
 * exact-email match (case-insensitive), or null. Used by the profile
 * backfill to pull name / phone / address straight from GHL.
 */
export async function findGhlContactByEmail(email: string): Promise<GhlContact | null> {
  const locationId = process.env.GHL_LOCATION_ID;
  const trimmed = (email || "").trim();
  if (!locationId || !trimmed) return null;

  const params = new URLSearchParams({ locationId, query: trimmed, limit: "20" });
  let body: any;
  try {
    body = await ghlRequest<any>(`/contacts/?${params.toString()}`);
  } catch (err: any) {
    console.warn(`[ghl] contact search failed for ${trimmed}: ${err.message}`);
    return null;
  }

  const contacts: any[] = body?.contacts || [];
  const wanted = trimmed.toLowerCase();
  const match =
    contacts.find((c) => (c.email || "").toLowerCase() === wanted) || null;
  if (!match) return null;

  return {
    id: match.id,
    firstName: match.firstName ?? null,
    lastName: match.lastName ?? null,
    name: match.contactName ?? match.name ?? null,
    email: match.email ?? null,
    phone: match.phone ?? null,
    companyName: match.companyName ?? null,
    address1: match.address1 ?? null,
    city: match.city ?? null,
    state: match.state ?? null,
    postalCode: match.postalCode ?? null,
    country: match.country ?? null,
    customFields: match.customFields ?? match.customField ?? [],
  };
}

/** Normalize a business name for fuzzy comparison: drop legal suffixes,
 *  punctuation, and case so "Clean Cut Painters LLC" ≈ "clean cut painters". */
function normalizeCompany(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(llc|inc|incorporated|ltd|limited|corp|corporation|company|co|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Find a GHL contact by business name (when we have no email to match on).
 * Searches the location for the name, then keeps the candidate whose
 * companyName (or contact name) strongly matches — exact normalized equality
 * or a clear containment. Returns null when nothing matches confidently, so
 * we never attach the wrong person's details to a client.
 */
export async function findGhlContactByCompany(companyName: string): Promise<GhlContact | null> {
  const locationId = process.env.GHL_LOCATION_ID;
  const raw = (companyName || "").trim();
  if (!locationId || !raw) return null;

  // GHL's text search is literal — "Top Notch Painters LLC" matches nothing
  // while "Top Notch Painters" matches. Strip legal suffixes/punctuation for
  // the QUERY (better recall); we still strict-match on the normalized result.
  const query = raw
    .replace(/\b(llc|inc|incorporated|ltd|limited|corp|corporation|co)\b/gi, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || raw;

  const params = new URLSearchParams({ locationId, query, limit: "20" });
  let body: any;
  try {
    body = await ghlRequest<any>(`/contacts/?${params.toString()}`);
  } catch (err: any) {
    console.warn(`[ghl] company search failed for ${query}: ${err.message}`);
    return null;
  }

  const contacts: any[] = body?.contacts || [];
  if (contacts.length === 0) return null;

  const want = normalizeCompany(raw);
  const wantTokens = want.replace(/\s+/g, "");
  let best: any = null;
  let bestScore = 0;
  for (const c of contacts) {
    const candidates = [c.companyName, c.contactName, `${c.firstName || ""} ${c.lastName || ""}`]
      .map((x) => normalizeCompany(x || ""))
      .filter(Boolean);
    let score = 0;
    for (const cand of candidates) {
      if (cand === want) score = Math.max(score, 3);
      else if (cand.includes(want) || want.includes(cand)) score = Math.max(score, 2);
    }
    // Tie-break bonus: email domain echoes the business name
    // (e.g. business@topnotchpainters.com for "Top Notch Painters").
    const domain = (c.email || "").split("@")[1]?.toLowerCase() || "";
    const domainCore = domain.replace(/\.(com|ca|net|org|co|io|biz)$/g, "").replace(/[^a-z0-9]/g, "");
    if (score >= 2 && domainCore && wantTokens && (domainCore.includes(wantTokens) || wantTokens.includes(domainCore))) {
      score += 0.5;
    }
    if (score > bestScore) { bestScore = score; best = c; }
  }

  // Require at least a containment-level match (score ≥ 2) to accept.
  if (!best || bestScore < 2) return null;

  return {
    id: best.id,
    firstName: best.firstName ?? null,
    lastName: best.lastName ?? null,
    name: best.contactName ?? best.name ?? null,
    email: best.email ?? null,
    phone: best.phone ?? null,
    companyName: best.companyName ?? null,
    address1: best.address1 ?? null,
    city: best.city ?? null,
    state: best.state ?? null,
    postalCode: best.postalCode ?? null,
    country: best.country ?? null,
    customFields: best.customFields ?? best.customField ?? [],
  };
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
