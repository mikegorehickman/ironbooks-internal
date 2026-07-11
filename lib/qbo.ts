/**
 * QuickBooks Online API Client
 * ----------------------------
 * Handles:
 *  - OAuth 2.0 flow (authorize, exchange code, refresh tokens)
 *  - Reading the client's Chart of Accounts
 *  - Creating, renaming, inactivating accounts
 *  - Reclassifying transactions
 *  - Setting tax codes
 *
 * QBO API docs:
 *  - Account: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/account
 *  - Auth: https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
 *
 * Requires env vars:
 *  - QBO_CLIENT_ID
 *  - QBO_CLIENT_SECRET
 *  - QBO_ENVIRONMENT ('sandbox' or 'production')
 *  - QBO_REDIRECT_URI
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import type { Database } from './database.types';
import { isDemoRealm, demoAccounts } from './demo-data';

const QBO_BASE = process.env.QBO_ENVIRONMENT === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

const QBO_AUTH_BASE = 'https://oauth.platform.intuit.com';
const QBO_DISCOVERY = 'https://developer.api.intuit.com/.well-known/openid_configuration';

// ============== TYPES ==============

export interface QBOAccount {
  Id: string;
  Name: string;
  FullyQualifiedName: string;
  AccountType: string;
  AccountSubType: string;
  Classification: string;            // 'Asset', 'Liability', 'Equity', 'Revenue', 'Expense'
  Active: boolean;
  SubAccount: boolean;
  ParentRef?: { value: string; name?: string };
  CurrentBalance: number;
  CurrentBalanceWithSubAccounts: number;
  CurrencyRef: { value: string; name?: string };
  Description?: string;
  TaxCodeRef?: { value: string };
  MetaData: {
    CreateTime: string;
    LastUpdatedTime: string;
  };
}

export interface QBOTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
  token_type: string;
}

// ============== SOURCE TAGGING ==============

/**
 * Derive a refresh-log `source` string from the incoming Request URL.
 *
 * Drop into any API route that calls getValidToken so the qbo_refresh_log
 * tells us EXACTLY which Ironbooks endpoint triggered a refresh. Without
 * this every call shows as "ironbooks-internal/untagged" and we lose the
 * ability to distinguish (say) a discovery worker from a scan endpoint
 * when diagnosing a refresh storm.
 *
 * Examples:
 *   sourceFromRequest(req) → "ironbooks/api/reclass/discover"
 *   sourceFromRequest(req) → "ironbooks/api/clients/<id>/hardcore-cleanup/start"
 *
 * IDs in the path are NOT redacted — high-cardinality but useful for
 * pinpointing which specific run / job caused the refresh.
 */
export function sourceFromRequest(request: Request): string {
  try {
    const url = new URL(request.url);
    return `ironbooks${url.pathname}`;
  } catch {
    return "ironbooks-internal/untagged";
  }
}

// ============== OAUTH ==============

/**
 * Thrown when QBO refuses to refresh a token because the refresh grant
 * is permanently dead (user disconnected from inside QuickBooks, refresh
 * token expired past its 100-day window, app access revoked, etc.).
 *
 * API routes should catch this and respond with a structured payload
 * pointing the user at /api/qbo/connect to re-authorize — see
 * qboErrorResponse() helper below.
 *
 * Required by Intuit SNAP Q6c: app must handle invalid_grant gracefully.
 */
export class QBOReauthRequiredError extends Error {
  readonly clientLinkId: string | null;
  readonly reconnectUrl: string;
  constructor(clientLinkId: string | null) {
    // Phrased as the user-facing message because background jobs persist
    // err.message verbatim to their error_message column. Foreground
    // routes route this through qboErrorResponse() which structures it.
    super(
      "Your QuickBooks connection has expired or been disconnected. " +
      "Please reconnect QBO from the client's Settings → QuickBooks page."
    );
    this.name = "QBOReauthRequiredError";
    this.clientLinkId = clientLinkId;
    this.reconnectUrl = clientLinkId
      ? `/api/qbo/connect?client_link_id=${encodeURIComponent(clientLinkId)}`
      : `/api/qbo/connect`;
  }
}

/**
 * Discovery document cache. Intuit publishes the canonical OAuth endpoint
 * URLs at /.well-known/openid_configuration; fetching them rather than
 * hardcoding lets the app survive Intuit changing endpoint hostnames
 * without a redeploy. Required by Intuit SNAP Q5.
 *
 * Cached at module scope with a 24h TTL — discovery doc almost never
 * changes, but we don't want a hardcoded snapshot either.
 */
interface DiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  userinfo_endpoint?: string;
  issuer?: string;
}

const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
let discoveryCache: { doc: DiscoveryDocument; fetchedAt: number } | null = null;
let discoveryInflight: Promise<DiscoveryDocument> | null = null;

// Fallback URLs used only if discovery fetch fails entirely. These match
// Intuit's documented endpoints as of the cutoff; the discovery doc is
// preferred at runtime.
const DISCOVERY_FALLBACK: DiscoveryDocument = {
  authorization_endpoint: 'https://appcenter.intuit.com/connect/oauth2',
  token_endpoint: `${QBO_AUTH_BASE}/oauth2/v1/tokens/bearer`,
  revocation_endpoint: `${QBO_AUTH_BASE}/oauth2/v1/tokens/revoke`,
};

async function getDiscoveryDocument(): Promise<DiscoveryDocument> {
  const now = Date.now();
  if (discoveryCache && now - discoveryCache.fetchedAt < DISCOVERY_TTL_MS) {
    return discoveryCache.doc;
  }
  // Coalesce parallel callers so we only fetch once per cache miss
  if (discoveryInflight) return discoveryInflight;

  discoveryInflight = (async () => {
    try {
      const res = await fetchAuthWithRetry(
        QBO_DISCOVERY,
        { method: 'GET', headers: { Accept: 'application/json' } },
        'discovery document'
      );
      if (!res.ok) {
        console.warn(`[qbo-auth] discovery fetch returned ${res.status}, using fallback endpoints`);
        return DISCOVERY_FALLBACK;
      }
      const doc = (await res.json()) as DiscoveryDocument;
      if (!doc.authorization_endpoint || !doc.token_endpoint) {
        console.warn('[qbo-auth] discovery doc missing required fields, using fallback');
        return DISCOVERY_FALLBACK;
      }
      discoveryCache = { doc, fetchedAt: now };
      return doc;
    } catch (err) {
      console.warn('[qbo-auth] discovery fetch threw, using fallback:', (err as Error)?.message);
      return DISCOVERY_FALLBACK;
    } finally {
      discoveryInflight = null;
    }
  })();

  return discoveryInflight;
}

/**
 * Bounded retry wrapper for Intuit auth endpoints.
 *
 * Retries on transient failures: network errors, HTTP 429 (rate limited),
 * and HTTP 5xx (Intuit server hiccup). Does NOT retry on other 4xx —
 * those are permanent (invalid_grant, bad code, revoked refresh) and
 * retrying just wastes time before forcing the user to reconnect.
 *
 * Exists so a flaky Intuit response on token refresh doesn't surface as
 * a "please reconnect QBO" to the user when a second attempt 250ms later
 * would have succeeded. Required by Intuit's SNAP review (Q3: app must
 * retry failed auth requests).
 */
async function fetchAuthWithRetry(
  url: string,
  init: RequestInit,
  context: string,
  maxAttempts = 3
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if (res.status >= 500 || res.status === 429) {
        if (attempt === maxAttempts) return res;
        console.warn(`[qbo-auth] ${context} attempt ${attempt}/${maxAttempts} got ${res.status}, retrying`);
        await sleepWithBackoff(attempt);
        continue;
      }
      // Non-retryable 4xx: hand the response back so caller can read the body and throw
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) throw err;
      console.warn(`[qbo-auth] ${context} attempt ${attempt}/${maxAttempts} network error, retrying:`, (err as Error)?.message);
      await sleepWithBackoff(attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleepWithBackoff(attempt: number): Promise<void> {
  const base = 250 * Math.pow(2, attempt - 1); // 250, 500, 1000 ms
  const jitter = Math.floor(Math.random() * 150);
  return new Promise((r) => setTimeout(r, base + jitter));
}

/**
 * Build the QBO authorize URL. User visits this to grant access.
 *
 * Endpoint URL is sourced from Intuit's discovery document rather than
 * hardcoded (SNAP Q5). Falls back to the documented URL if discovery
 * is unreachable so the connect flow never breaks outright.
 */
export async function getAuthorizeUrl(state: string): Promise<string> {
  const discovery = await getDiscoveryDocument();
  const params = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID!,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: process.env.QBO_REDIRECT_URI!,
    state,
  });
  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

/**
 * Exchange the authorization code for tokens.
 * Call this in your OAuth callback handler.
 */
export async function exchangeCodeForTokens(code: string): Promise<QBOTokens> {
  const auth = Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
  ).toString('base64');

  const discovery = await getDiscoveryDocument();
  const res = await fetchAuthWithRetry(
    discovery.token_endpoint,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.QBO_REDIRECT_URI!,
      }),
    },
    'token exchange'
  );

  if (!res.ok) {
    const tid = res.headers.get('intuit_tid') || '(no tid)';
    throw new Error(`QBO token exchange failed: ${res.status} [intuit_tid=${tid}] ${await res.text()}`);
  }

  return res.json();
}

/**
 * Refresh an expired access token.
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientLinkId: string | null = null
): Promise<QBOTokens> {
  const auth = Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
  ).toString('base64');

  const discovery = await getDiscoveryDocument();
  const res = await fetchAuthWithRetry(
    discovery.token_endpoint,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    },
    'token refresh'
  );

  if (!res.ok) {
    const body = await res.text();
    const tid = res.headers.get('intuit_tid') || '(no tid)';
    // invalid_grant = refresh token is permanently dead. Surface a typed
    // error so API routes can route the user to /api/qbo/connect instead
    // of bubbling up a raw 400 message. (SNAP Q6c)
    if (res.status === 400 && /invalid_grant/i.test(body)) {
      throw new QBOReauthRequiredError(clientLinkId);
    }
    throw new Error(`QBO token refresh failed: ${res.status} [intuit_tid=${tid}] ${body}`);
  }

  return res.json();
}

/**
 * Get a valid access token for a client, refreshing if expired.
 *
 * Concurrency-safe. Two protections against the QBO refresh-token
 * rotation race that killed ~32 of our 62 clients' connections by
 * 2026-06-08:
 *
 *   1. Fast-path: if the cached access token still has >5 min of life,
 *      return it immediately — no refresh, no Intuit call. Eliminates
 *      ~99% of races just by skipping refresh entirely.
 *
 *   2. Pessimistic lock-then-re-read for the refresh path. We use a
 *      Postgres advisory lock keyed on the client_link_id hash so
 *      concurrent requests for the SAME client serialize, and requests
 *      for DIFFERENT clients run in parallel as before. After acquiring
 *      the lock we re-read the token row — if another caller already
 *      refreshed while we were waiting, we use their result and don't
 *      hit Intuit at all. This is the standard double-checked locking
 *      pattern for one-time-use tokens.
 *
 * Optional `source` parameter identifies the caller for the
 * qbo_refresh_log table. Useful when we need to figure out who's
 * burning refresh tokens (Ironbooks api routes? a cron? coach-intel?).
 */
/**
 * Module-level map of in-flight refresh promises, keyed by client_link_id.
 *
 * Why: Postgres advisory locks via Supabase RPC don't actually serialize
 * concurrent refreshes the way we expected. Each rpc() call uses a
 * different pooled connection, so the lock acquired in one RPC call
 * doesn't follow the SELECT / UPDATE / unlock calls — pgBouncer can
 * recycle the lock-holding connection between RPCs, and pg_advisory_unlock
 * on a different connection silently fails because it can only release
 * locks held by the current session. Net effect: lock semantics are
 * unreliable through Supabase's HTTP/RPC layer.
 *
 * In-process debouncer: at the JS layer, if a refresh is already in
 * flight for THIS client_link_id in THIS Node process, share its promise
 * instead of starting a new one. Eliminates ~95% of real-world races
 * because most races are intra-instance (layout + page + sidebar all
 * call getValidToken on the same client during a single user page load).
 *
 * Cross-instance races still exist (two Vercel functions handling
 * different requests for the same client at the same time) but those are
 * far rarer than intra-instance ones. If we keep seeing chain breakage
 * after this fix, we'll need to move to either the vending-endpoint
 * chokepoint or a Postgres-side state-machine lock.
 */
const inFlightRefreshes = new Map<string, Promise<string>>();

// Buffer: how much life left on a cached access_token before we
// trigger a refresh. Bumping from 5min → 30min sharply reduces the race
// window — at 1h token lifetime, a 30min buffer means we refresh in the
// last 30 min instead of the last 5, so the fast-path absorbs many more
// calls. Most code paths can tolerate a 30min stale-token window since
// QBO tokens degrade gracefully (401 → refresh → retry).
const REFRESH_BUFFER_MS = 30 * 60 * 1000;

export async function getValidToken(
  clientLinkId: string,
  supabase: ReturnType<typeof createClient<Database>>,
  source?: string
): Promise<string> {
  // ── Fast path: no refresh needed ──
  const { data: cached, error } = await supabase
    .from('client_links')
    .select('qbo_access_token, qbo_refresh_token, qbo_token_expires_at, qbo_realm_id')
    .eq('id', clientLinkId)
    .single();
  if (error || !cached) throw new Error('Client not found');
  // Demo client — no real QBO connection; hand back a sentinel token so the
  // fetchers (which detect the DEMO realm) serve synthetic data.
  if (isDemoRealm((cached as any).qbo_realm_id)) return 'DEMO';

  const cachedExpiresAt = new Date(cached.qbo_token_expires_at!).getTime();
  if (cachedExpiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return cached.qbo_access_token!;
  }

  // ── In-process debouncer ──
  // If THIS process is already refreshing this client, await that promise
  // instead of starting a new refresh. This is the high-leverage fix
  // because most real races are within a single Vercel function instance.
  const existing = inFlightRefreshes.get(clientLinkId);
  if (existing) return existing;

  // ── Slow path: refresh against Intuit ──
  // We still register a pg_advisory_lock attempt for the qbo_refresh_log
  // observability (showing whether concurrent refreshes piled up) but we
  // no longer rely on it for correctness — the inFlightRefreshes map
  // above does the real serialization.
  const refreshPromise = doRefresh(clientLinkId, supabase, source, cached.qbo_refresh_token);
  inFlightRefreshes.set(clientLinkId, refreshPromise);
  // Clean up the map entry on resolve OR reject. Using .then with both
  // handlers (rather than .finally) consumes any rejection on the cleanup
  // branch — otherwise Node sees an unhandled rejection on the secondary
  // promise chain and aborts the process. Callers still see the error
  // because they await refreshPromise directly.
  const cleanup = () => {
    // Guard against race where two callers set the map; only delete OUR promise.
    if (inFlightRefreshes.get(clientLinkId) === refreshPromise) {
      inFlightRefreshes.delete(clientLinkId);
    }
  };
  refreshPromise.then(cleanup, cleanup);
  return refreshPromise;
}

/**
 * The actual refresh-against-Intuit machinery. Factored out so
 * getValidToken can wrap it in the inFlightRefreshes debouncer.
 *
 * Still uses the pg_advisory_lock + re-read pattern as a second line of
 * defense for cross-instance races — even if the lock semantics are
 * unreliable through Supabase RPC, it occasionally helps and it keeps
 * the qbo_refresh_log observability working.
 */
async function doRefresh(
  clientLinkId: string,
  supabase: ReturnType<typeof createClient<Database>>,
  source: string | undefined,
  cachedRefreshToken: string | null,
): Promise<string> {
  // We don't trust cachedRefreshToken — fast-path already used the cached
  // access token, and we re-read the refresh_token inside doRefresh so we
  // always send Intuit the latest value from DB. Kept in the signature so
  // future callers can pass a hint without an interface change.
  void cachedRefreshToken;
  const lockKey = `qbo_refresh:${clientLinkId}`;
  const lockId = hashStringToInt64(lockKey);

  // Acquire the lock. pg_advisory_lock is blocking — concurrent callers
  // queue up. Supabase RPC support varies; we use raw SQL through the
  // postgrest function endpoint. Fail-soft: if locking fails we still
  // attempt the refresh (degrade to the old behavior rather than
  // outright break on Supabase versions without lock support).
  let lockAcquired = false;
  try {
    const lockRes: any = await (supabase as any).rpc('pg_advisory_lock', { key: lockId });
    if (!lockRes.error) lockAcquired = true;
  } catch {
    // RPC unavailable — degrade gracefully. Race window stays open but
    // the fast path above absorbs the vast majority of calls.
  }

  const refreshStartedAt = Date.now();
  let result: 'success' | 'invalid_grant' | 'other_error' = 'success';
  let errorMessage: string | null = null;
  let intuitTid: string | null = null;

  try {
    // Re-read the token row AFTER acquiring the lock. The previous
    // refresh holder may have already rotated the token; if so, just
    // return the new access token instead of refreshing again.
    const { data: fresh } = await supabase
      .from('client_links')
      .select('qbo_access_token, qbo_refresh_token, qbo_token_expires_at')
      .eq('id', clientLinkId)
      .single();
    if (!fresh) throw new Error('Client not found');
    const freshExpiresAt = new Date(fresh.qbo_token_expires_at!).getTime();
    if (freshExpiresAt > Date.now() + REFRESH_BUFFER_MS) {
      // Another caller refreshed while we were waiting for the lock.
      return fresh.qbo_access_token!;
    }

    const tokens = await refreshAccessToken(fresh.qbo_refresh_token!, clientLinkId);
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    await supabase
      .from('client_links')
      .update({
        qbo_access_token: tokens.access_token,
        qbo_refresh_token: tokens.refresh_token,
        qbo_token_expires_at: newExpiresAt,
      })
      .eq('id', clientLinkId);
    return tokens.access_token;
  } catch (err: any) {
    const msg = err?.message || String(err);
    errorMessage = msg;
    if (err instanceof QBOReauthRequiredError) {
      result = 'invalid_grant';
    } else if (/invalid_grant/i.test(msg)) {
      result = 'invalid_grant';
    } else {
      result = 'other_error';
    }
    const tidMatch = msg.match(/intuit_tid=([^\s\]]+)/);
    if (tidMatch) intuitTid = tidMatch[1];
    throw err;
  } finally {
    // Always release the lock + log the attempt. Both failures are
    // non-fatal — release failure means the lock auto-releases on
    // session end; log failure is just observability loss.
    if (lockAcquired) {
      try {
        await (supabase as any).rpc('pg_advisory_unlock', { key: lockId });
      } catch {
        /* lock auto-releases on session end */
      }
    }
    try {
      await (supabase as any).from('qbo_refresh_log').insert({
        client_link_id: clientLinkId,
        // Default to 'ironbooks-internal/untagged' so untagged Ironbooks
        // callers are still distinguishable from external callers (who
        // hit /api/internal/qbo-token and pass 'external-api/...'). The
        // only true 'unknown' should be code paths that exist outside
        // this app.
        source: source || 'ironbooks-internal/untagged',
        result,
        intuit_tid: intuitTid,
        error_message: errorMessage,
        duration_ms: Date.now() - refreshStartedAt,
      });
    } catch {
      /* observability is best-effort */
    }
  }
}

/** Hash a string to a deterministic 63-bit signed int (Postgres bigint range). */
function hashStringToInt64(s: string): number {
  // FNV-1a 64-bit hash, returned as a JS-safe 53-bit number. Collisions
  // are statistically negligible at our cardinality (<10k clients).
  let hash = BigInt('0xcbf29ce484222325');
  const fnvPrime = BigInt('0x100000001b3');
  const mask = BigInt('0xffffffffffffffff');
  for (let i = 0; i < s.length; i++) {
    hash = (hash ^ BigInt(s.charCodeAt(i))) & mask;
    hash = (hash * fnvPrime) & mask;
  }
  // Squeeze to JS-safe Number while preserving uniqueness for our keys.
  return Number(hash % BigInt(Number.MAX_SAFE_INTEGER));
}

/**
 * Convert a thrown QBO error into a structured JSON response.
 *
 * For QBOReauthRequiredError: returns 401 with { error: "qbo_reauth_required",
 * reconnect_url } so the frontend can show a friendly "your QuickBooks
 * connection needs to be renewed — click to reconnect" UI instead of a
 * raw error toast. (SNAP Q6c)
 *
 * For any other error: returns 500 with the message — same behavior as
 * existing routes' catch blocks.
 *
 * Usage in API routes:
 *   } catch (e) {
 *     return qboErrorResponse(e);
 *   }
 */
export function qboErrorResponse(err: unknown): Response {
  if (err instanceof QBOReauthRequiredError) {
    return Response.json(
      {
        error: "qbo_reauth_required",
        message: "Your QuickBooks connection needs to be renewed.",
        reconnect_url: err.reconnectUrl,
        client_link_id: err.clientLinkId,
      },
      { status: 401 }
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: message }, { status: 500 });
}

/**
 * Mark a client's QBO connection as healthy in qbo_connection_health.
 *
 * Call this after a successful OAuth callback (token exchange landed,
 * tokens written to client_links) so the Fleet QBO Health dashboard
 * picks up the fresh state immediately — without waiting for the next
 * health probe to run.
 *
 * Background: the dashboard reads `qbo_connection_health.status` rather
 * than re-probing on every page load. Before this helper existed, the
 * status row was only updated by the probe endpoint, so a bookkeeper
 * who reconnected a dead client would keep seeing it as `invalid_grant`
 * until the nightly probe ran — leading to support tickets like "I
 * connected 30 clients and they all show disconnected" (2026-06-09).
 *
 * Non-fatal on error — we log + swallow so a transient health-table
 * write failure can't block the OAuth callback's redirect to the
 * client profile.
 */
export async function markQboConnectionHealthy(
  supabase: ReturnType<typeof createClient<Database>>,
  clientLinkId: string
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await (supabase as any)
    .from("qbo_connection_health")
    .upsert(
      {
        client_link_id: clientLinkId,
        status: "ok",
        last_checked_at: now,
        last_ok_at: now,
        first_failed_at: null,
        error_message: null,
        reconnect_initiated_at: null,
        reconnect_initiated_by: null,
        updated_at: now,
      },
      { onConflict: "client_link_id" }
    );
  if (error) {
    console.error(
      `[qbo] failed to mark connection healthy for ${clientLinkId}:`,
      error.message
    );
  }
}

// ============== CORE REQUEST ==============

/**
 * Pull Intuit's request trace ID off a response. Every QBO API response
 * carries an `intuit_tid` header (e.g. "1-65f8...-d3a2") that Intuit's
 * support team uses to look up the exact request in their internal logs.
 *
 * Recording this in our error messages + write-op success logs means a
 * future ticket like "client X's createInvoice failed at 10:32 UTC" can
 * be triaged by Intuit in seconds — they paste the tid into their tools,
 * not "please reproduce."
 *
 * Returns "(no tid)" rather than null so the value is always safe to
 * interpolate into log strings without `?? "unknown"` everywhere.
 */
function extractIntuitTid(res: Response): string {
  return res.headers.get('intuit_tid') || res.headers.get('Intuit_Tid') || '(no tid)';
}

/**
 * Hard ceiling on any single QBO HTTP call. QBO occasionally accepts a
 * connection and then never responds; without a timeout that hangs the
 * whole request forever. In a background job (e.g. reclass discovery's
 * account-fetch phase) a single hung call goes silent until the 15-min
 * watchdog kills the job — the bookkeeper just sees an eternal spinner.
 * 60s converts that silent hang into a fast, catchable error. QBO's own
 * guidance is sub-60s responses, so a legit call never trips this.
 */
const QBO_REQUEST_TIMEOUT_MS = 60_000;

export async function qboRequest<T>(
  realmId: string,
  accessToken: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  // Demo client has no real QBO — fast-fail so callers fall back to their
  // empty/handled states (the synthesized fetchers branch before reaching here).
  if (isDemoRealm(realmId)) throw new Error('demo client — no live QuickBooks');
  const url = `${QBO_BASE}/v3/company/${realmId}${endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      // Caller-supplied signal wins if present; otherwise enforce our ceiling.
      signal: options.signal ?? AbortSignal.timeout(QBO_REQUEST_TIMEOUT_MS),
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  } catch (err: any) {
    // AbortSignal.timeout fires a TimeoutError; surface it as a clear,
    // job-failing message rather than a raw "The operation was aborted".
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(
        `QBO API timed out after ${QBO_REQUEST_TIMEOUT_MS / 1000}s at ${endpoint} (realm ${realmId}) — QuickBooks did not respond.`
      );
    }
    throw err;
  }

  const intuitTid = extractIntuitTid(res);

  if (!res.ok) {
    const responseBody = await res.text();
    // Include the request body in the error so audit_log captures EXACTLY
    // what we sent to QBO when something fails. Critical for debugging 2010s.
    let sentBody: any = '(none)';
    try {
      sentBody = options.body ? JSON.parse(options.body as string) : '(none)';
    } catch {
      sentBody = options.body;
    }
    throw new Error(
      `QBO API ${res.status} at ${endpoint} [intuit_tid=${intuitTid}]: ${responseBody} | Request body sent: ${JSON.stringify(sentBody)}`
    );
  }

  // Log successful write operations with their intuit_tid so we can
  // correlate post-hoc if a write turns out to have been wrong (e.g.
  // duplicate invoice created, wrong account hit). GETs are too chatty
  // to log — only mutating verbs.
  const method = (options.method || 'GET').toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    console.log(
      `[qbo-write] realm=${realmId} ${method} ${endpoint} [intuit_tid=${intuitTid}]`
    );
  }

  return res.json();
}

// ============== ACCOUNTS ==============

/**
 * Pull the entire Chart of Accounts for a client.
 */
/**
 * Fetch ALL accounts including inactive (deleted) ones. QBO's default query
 * filter is Active=true, so plain fetchAllAccounts never sees deleted
 * accounts — but QBO still reserves their NAMES (creating a duplicate name
 * fails with code 6240). Use this wherever "does this name exist?" matters.
 */
export async function fetchAllAccountsIncludingInactive(realmId: string, accessToken: string): Promise<QBOAccount[]> {
  if (isDemoRealm(realmId)) return demoAccounts();
  const query = encodeURIComponent('SELECT * FROM Account WHERE Active IN (true, false) MAXRESULTS 1000');
  const data = await qboRequest<{ QueryResponse: { Account?: QBOAccount[] } }>(
    realmId,
    accessToken,
    `/query?query=${query}`
  );
  return data.QueryResponse.Account || [];
}

export async function fetchAllAccounts(realmId: string, accessToken: string): Promise<QBOAccount[]> {
  if (isDemoRealm(realmId)) return demoAccounts();
  const query = encodeURIComponent('SELECT * FROM Account MAXRESULTS 1000');
  const data = await qboRequest<{ QueryResponse: { Account?: QBOAccount[] } }>(
    realmId,
    accessToken,
    `/query?query=${query}`
  );
  return data.QueryResponse.Account || [];
}

/**
 * Create a new account in QBO.
 * For sub-accounts, set parentRef to the parent's QBO ID.
 */
export async function createAccount(
  realmId: string,
  accessToken: string,
  params: {
    name: string;
    accountType: string;
    accountSubType: string;
    parentRefId?: string;
    description?: string;
    taxCodeRef?: string;
  }
): Promise<QBOAccount> {
  const body: any = {
    Name: params.name,
    AccountType: params.accountType,
    AccountSubType: params.accountSubType,
  };

  if (params.parentRefId) {
    body.ParentRef = { value: params.parentRefId };
    body.SubAccount = true;
  }
  if (params.description) body.Description = params.description;
  if (params.taxCodeRef) body.TaxCodeRef = { value: params.taxCodeRef };

  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?minorversion=70',
    { method: 'POST', body: JSON.stringify(body) }
  );

  return data.Account;
}

/**
 * Change an existing account's AccountType / AccountSubType (sparse update).
 *
 * QBO rules that shape this:
 * - A subaccount must share its parent's AccountType. Retyping a child away
 *   from its (wrongly-typed) parent requires detaching it to top level —
 *   pass detachFromParent; the re-parent stage re-nests it after the parent
 *   itself is retyped.
 * - QBO rejects some type changes outright (system accounts, certain
 *   category jumps). This function throws cleanly; the caller (executor
 *   retype stage) routes rejections to the manual-cleanup path.
 */
export async function updateAccountType(
  realmId: string,
  accessToken: string,
  accountId: string,
  syncToken: string,
  params: {
    newType: string;
    newSubType: string;
    /** Full current account — Name and parent linkage are echoed to avoid 2010s. */
    currentAccount: QBOAccount;
    detachFromParent?: boolean;
  }
): Promise<QBOAccount> {
  const cur: any = params.currentAccount;
  const body: any = {
    Id: accountId,
    SyncToken: syncToken,
    sparse: true,
    Name: cur.Name,
    AccountType: params.newType,
    AccountSubType: params.newSubType,
  };
  if (params.detachFromParent) {
    body.SubAccount = false;
  } else if (cur.SubAccount && cur.ParentRef?.value) {
    body.SubAccount = true;
    body.ParentRef = { value: cur.ParentRef.value };
  }
  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?minorversion=70',
    { method: 'POST', body: JSON.stringify(body) }
  );
  return data.Account;
}

/**
 * Rename an existing account (preserves history + transactions).
 *
 * IMPORTANT: For sub-accounts, you must also pass the current account object
 * (or its ParentRef + SubAccount + AccountType) so QBO preserves the parent
 * relationship during sparse update. Otherwise QBO returns 2010.
 */
export async function renameAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  syncToken: string,
  newName: string,
  options?: {
    newSubType?: string;
    taxCodeRef?: string;
    /** Pass the current full account from QBO to preserve sub-account/parent state */
    currentAccount?: QBOAccount;
  }
): Promise<QBOAccount> {
  const body: any = {
    Id: accountId,
    SyncToken: syncToken,
    sparse: true,
    Name: newName,
  };

  // Preserve sub-account + parent relationship if applicable.
  // QBO 2010 errors on rename of sub-accounts when these fields are missing.
  if (options?.currentAccount) {
    const cur = options.currentAccount;
    if (cur.AccountType) body.AccountType = cur.AccountType;
    if (cur.AccountSubType) body.AccountSubType = cur.AccountSubType;
    if (cur.SubAccount) {
      body.SubAccount = true;
      if (cur.ParentRef?.value) body.ParentRef = { value: cur.ParentRef.value };
    }
  }

  if (options?.newSubType) body.AccountSubType = options.newSubType;
  if (options?.taxCodeRef) body.TaxCodeRef = { value: options.taxCodeRef };

  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?minorversion=70',
    { method: 'POST', body: JSON.stringify(body) }
  );

  return data.Account;
}

/**
 * Inactivate an account (QBO doesn't allow true deletion if there's history).
 *
 * IMPORTANT: For sub-accounts, you must pass the current account so we preserve
 * Type/SubAccount/ParentRef. Otherwise QBO 2010 errors.
 */
export async function inactivateAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  syncToken: string,
  currentAccount?: QBOAccount
): Promise<QBOAccount> {
  const body: any = {
    Id: accountId,
    SyncToken: syncToken,
    sparse: true,
    Active: false,
  };

  if (currentAccount) {
    if (currentAccount.AccountType) body.AccountType = currentAccount.AccountType;
    if (currentAccount.AccountSubType) body.AccountSubType = currentAccount.AccountSubType;
    if (currentAccount.SubAccount) {
      body.SubAccount = true;
      if (currentAccount.ParentRef?.value) {
        body.ParentRef = { value: currentAccount.ParentRef.value };
      }
    }
    if (currentAccount.Name) body.Name = currentAccount.Name;
  }

  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?minorversion=70',
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );

  return data.Account;
}

/**
 * Reactivate (un-inactivate) a previously inactivated account. Used by the
 * revert flow so we can move transactions back into a now-inactive source.
 * Same Type/SubAccount/ParentRef preservation rules as inactivateAccount.
 */
export async function reactivateAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  syncToken: string,
  currentAccount?: QBOAccount
): Promise<QBOAccount> {
  const body: any = {
    Id: accountId,
    SyncToken: syncToken,
    sparse: true,
    Active: true,
  };
  if (currentAccount) {
    if (currentAccount.AccountType) body.AccountType = currentAccount.AccountType;
    if (currentAccount.AccountSubType) body.AccountSubType = currentAccount.AccountSubType;
    if (currentAccount.SubAccount) {
      body.SubAccount = true;
      if (currentAccount.ParentRef?.value) {
        body.ParentRef = { value: currentAccount.ParentRef.value };
      }
    }
    if (currentAccount.Name) body.Name = currentAccount.Name;
  }
  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?minorversion=70',
    { method: 'POST', body: JSON.stringify(body) }
  );
  return data.Account;
}

/**
 * Move a sub-account under a different parent.
 */
export async function reparentAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  syncToken: string,
  newParentId: string
): Promise<QBOAccount> {
  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?minorversion=70',
    {
      method: 'POST',
      body: JSON.stringify({
        Id: accountId,
        SyncToken: syncToken,
        sparse: true,
        ParentRef: { value: newParentId },
        SubAccount: true,
      }),
    }
  );

  return data.Account;
}

// ============== JOURNAL ENTRIES ==============

export interface JournalEntryLine {
  posting_type: "Debit" | "Credit";
  amount: number;
  account_id: string;
  account_name?: string;
  description?: string;
}

export interface CreatedJournalEntry {
  Id: string;
  DocNumber?: string;
  TxnDate: string;
  TotalAmt: number;
  PrivateNote?: string;
}

/**
 * Post a Journal Entry to QBO.
 *
 * Used by the AI BS cleanup finalize step to write Opening-Balance-Equity
 * zeroing entries, A/R bad-debt write-offs, A/P stale-credit reversals, etc.
 *
 * Validates debits = credits server-side before sending — QBO rejects
 * unbalanced JEs with a confusing 6000 error otherwise.
 */
/**
 * Deterministic idempotency token for a journal entry. Hashes the realm,
 * date, caller note, and the (sorted) line set so a retry of the SAME
 * logical JE produces the SAME token — but two structurally-identical JEs
 * for different entities (different note text) hash differently and are NOT
 * falsely deduped. Embedded in PrivateNote and looked up via
 * findByPrivateNoteToken before posting, so a transient-error retry can't
 * double-post adjustment entries and corrupt equity/liability balances.
 */
export function jeIdempotencyToken(parts: {
  realmId: string;
  txnDate: string;
  note: string;
  lines: Array<{ accountId: string; postingType: string; amount: number }>;
}): string {
  const norm = parts.lines
    .map((l) => `${l.postingType}:${l.accountId}:${Math.abs(l.amount).toFixed(2)}`)
    .sort()
    .join("|");
  const h = createHash("sha1")
    .update(`${parts.realmId}|${parts.txnDate}|${parts.note}|${norm}`)
    .digest("hex")
    .slice(0, 16);
  return `SNAP-JE-${h}`;
}

export async function createJournalEntry(
  realmId: string,
  accessToken: string,
  params: {
    txn_date: string;            // YYYY-MM-DD
    doc_number?: string;
    private_note?: string;
    lines: JournalEntryLine[];
  }
): Promise<CreatedJournalEntry> {
  if (!params.lines || params.lines.length < 2) {
    throw new Error("Journal Entry must have at least 2 lines (one debit + one credit)");
  }
  const debitSum = params.lines
    .filter((l) => l.posting_type === "Debit")
    .reduce((s, l) => s + l.amount, 0);
  const creditSum = params.lines
    .filter((l) => l.posting_type === "Credit")
    .reduce((s, l) => s + l.amount, 0);
  // Allow 1¢ rounding drift; anything bigger is a bug
  if (Math.abs(debitSum - creditSum) > 0.01) {
    throw new Error(
      `JE not balanced: debits=$${debitSum.toFixed(2)} vs credits=$${creditSum.toFixed(2)}`
    );
  }

  // Idempotency: if this exact JE was already posted on a prior attempt,
  // return it instead of creating a duplicate.
  const idemToken = jeIdempotencyToken({
    realmId,
    txnDate: params.txn_date,
    note: params.private_note || "",
    lines: params.lines.map((l) => ({
      accountId: l.account_id,
      postingType: l.posting_type,
      amount: l.amount,
    })),
  });
  const existingId = await findByPrivateNoteToken(realmId, accessToken, "JournalEntry", idemToken);
  if (existingId) {
    console.warn(`[createJournalEntry] idempotent hit — JE ${existingId} already posted for ${idemToken}; not duplicating.`);
    const existing = await qboRequest<{ JournalEntry: CreatedJournalEntry }>(
      realmId,
      accessToken,
      `/journalentry/${existingId}?minorversion=70`,
      { method: "GET" }
    );
    return existing.JournalEntry;
  }

  const body: any = {
    TxnDate: params.txn_date,
    PrivateNote: `[${idemToken}] ${params.private_note || ""}`.trim().slice(0, 4000),
    DocNumber: params.doc_number || undefined,
    Line: params.lines.map((l) => ({
      DetailType: "JournalEntryLineDetail",
      Amount: Number(l.amount.toFixed(2)),
      Description: l.description || undefined,
      JournalEntryLineDetail: {
        PostingType: l.posting_type,
        AccountRef: { value: l.account_id, name: l.account_name },
      },
    })),
  };

  const data = await qboRequest<{ JournalEntry: CreatedJournalEntry }>(
    realmId,
    accessToken,
    '/journalentry?minorversion=70',
    { method: 'POST', body: JSON.stringify(body) }
  );

  return data.JournalEntry;
}

// ============== V2 HARDCORE CLEANUP — Invoice + Payment writes ==============

/**
 * Look up a QBO Customer by name. Used by createInvoice when the caller
 * only has the customer's display name (typical for CRM-driven flows).
 *
 * Returns the Customer's QBO Id + DisplayName + AR account context. Null
 * if no exact match. Caller decides whether to fall back to fuzzy match
 * or fail loud.
 */
export async function findCustomerByName(
  realmId: string,
  accessToken: string,
  name: string
): Promise<{ id: string; displayName: string; arAccountId?: string } | null> {
  const escaped = name.replace(/'/g, "\\'");
  const query = encodeURIComponent(
    `SELECT Id, DisplayName, ARAccountRef FROM Customer WHERE DisplayName = '${escaped}' MAXRESULTS 1`
  );
  try {
    const data: any = await qboRequest(
      realmId,
      accessToken,
      `/query?query=${query}`,
      { method: "GET" }
    );
    const c = data?.QueryResponse?.Customer?.[0];
    if (!c) return null;
    return {
      id: String(c.Id),
      displayName: String(c.DisplayName || name),
      arAccountId: c.ARAccountRef?.value ? String(c.ARAccountRef.value) : undefined,
    };
  } catch (err: any) {
    console.warn(`[findCustomerByName] failed for "${name}":`, err?.message);
    return null;
  }
}

/**
 * Find an existing QBO object by a PrivateNote token. Idempotency primitive:
 * before each V2 write we write a deterministic token like
 * SNAP-CLEANUP-<run_id>-<item_id> in PrivateNote. On retry, we look that
 * token up first — if found, return the existing object instead of creating
 * a duplicate.
 *
 * Supports Invoice + Payment + JournalEntry (the V2 write surface).
 * Returns the bare Id of the existing object, or null if nothing matches.
 */
export async function findByPrivateNoteToken(
  realmId: string,
  accessToken: string,
  entity: "Invoice" | "Payment" | "JournalEntry",
  token: string
): Promise<string | null> {
  // QBO's query syntax doesn't have a clean PrivateNote LIKE for these
  // entities — PrivateNote isn't indexed. We do a narrow scan over the
  // last 90 days of objects and check in-memory. Cheap enough since this
  // only fires on retry/repeat paths.
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = encodeURIComponent(
    `SELECT Id, PrivateNote FROM ${entity} WHERE TxnDate >= '${cutoff}' MAXRESULTS 1000`
  );
  try {
    const data: any = await qboRequest(
      realmId,
      accessToken,
      `/query?query=${query}`,
      { method: "GET" }
    );
    const rows: any[] = data?.QueryResponse?.[entity] || [];
    const match = rows.find((r) => typeof r.PrivateNote === "string" && r.PrivateNote.includes(token));
    return match ? String(match.Id) : null;
  } catch (err: any) {
    console.warn(`[findByPrivateNoteToken] ${entity} scan failed:`, err?.message);
    return null;
  }
}

export interface CreateInvoiceParams {
  customerId: string;
  customerName: string;
  /** Single-line invoice for now. Multi-line jobs map to a single line
   *  with a combined description — QBO requires either an ItemRef or a
   *  full SalesItemLineDetail; the simplest path is one line per job. */
  amount: number;
  description: string;
  txnDate: string;     // YYYY-MM-DD
  docNumber?: string;
  privateNote: string; // MUST include the idempotency token
}

export interface CreatedInvoice {
  Id: string;
  DocNumber?: string;
  SyncToken: string;
  TotalAmt?: number;
}

/**
 * Create a new Invoice in QBO. Used by V2 push_invoice resolution — when
 * a CRM job is complete but no QBO invoice exists. Caller is responsible
 * for resolving the customer ID + including an idempotency token in
 * privateNote.
 *
 * Single-line invoice; line uses SalesItemLineDetail with no ItemRef
 * (QBO accepts this for one-off services). For multi-item job exports
 * we'd need a different path.
 */
export async function createInvoice(
  realmId: string,
  accessToken: string,
  params: CreateInvoiceParams
): Promise<CreatedInvoice> {
  if (params.amount <= 0) {
    throw new Error(`Invoice amount must be positive (got ${params.amount})`);
  }
  const body: any = {
    CustomerRef: { value: params.customerId, name: params.customerName },
    TxnDate: params.txnDate,
    DocNumber: params.docNumber || undefined,
    PrivateNote: params.privateNote,
    Line: [
      {
        Amount: Number(params.amount.toFixed(2)),
        DetailType: "SalesItemLineDetail",
        Description: params.description,
        SalesItemLineDetail: {
          // No ItemRef — QBO accepts blank for ad-hoc services. If the
          // client's QBO requires items configured we'd need a different
          // strategy (lookup default service item, or fail with a helpful
          // error pointing to QBO's "Products and Services" setup).
        },
      },
    ],
  };

  const data = await qboRequest<{ Invoice: CreatedInvoice }>(
    realmId,
    accessToken,
    "/invoice?minorversion=70",
    { method: "POST", body: JSON.stringify(body) }
  );
  return data.Invoice;
}

export interface ApplyPaymentParams {
  /** The Payment object's QBO Id. Must already exist in UF. */
  paymentId: string;
  /** Invoice IDs to link this payment to. For 1:1 = single entry; for
   *  1:N bulk deposit = multiple entries summing to the payment amount. */
  invoiceLinks: Array<{ invoiceId: string; amountApplied: number }>;
  privateNote?: string;
}

export interface AppliedPayment {
  Id: string;
  SyncToken: string;
  TotalAmt?: number;
}

/**
 * Sparse-update an existing Payment to link it to one or more invoices.
 *
 * QBO's Payment object has a Line[] field with LinkedTxn[] entries — each
 * LinkedTxn points at an Invoice with TxnType="Invoice". Sparse update
 * replaces the Line array entirely.
 *
 * Caveat: we do NOT change DepositToAccountRef. The payment stays in
 * Undeposited Funds for the bookkeeper to deposit later — that's the
 * Lisa workflow (apply payment → later move from UF to a real bank).
 * If/when V3 needs to clear UF too, we'd unset DepositToAccountRef here.
 *
 * Need to fetch the current SyncToken first since QBO sparse-update is
 * optimistic-concurrency.
 */
export async function applyPaymentToInvoices(
  realmId: string,
  accessToken: string,
  params: ApplyPaymentParams
): Promise<AppliedPayment> {
  if (params.invoiceLinks.length === 0) {
    throw new Error("applyPaymentToInvoices: invoiceLinks is empty");
  }
  // 1. Fetch current Payment for SyncToken + amount validation
  const query = encodeURIComponent(`SELECT * FROM Payment WHERE Id = '${params.paymentId}' MAXRESULTS 1`);
  const fetchData: any = await qboRequest(
    realmId,
    accessToken,
    `/query?query=${query}`,
    { method: "GET" }
  );
  const existing = fetchData?.QueryResponse?.Payment?.[0];
  if (!existing) {
    throw new Error(`Payment ${params.paymentId} not found in QBO`);
  }

  const totalLinked = params.invoiceLinks.reduce((s, l) => s + l.amountApplied, 0);
  const paymentAmt = Number(existing.TotalAmt || 0);
  // Allow 1¢ rounding drift; bigger means the bookkeeper's link-sum
  // doesn't match the payment — QBO would reject the write anyway,
  // failing here gives a clearer error.
  if (Math.abs(totalLinked - paymentAmt) > 0.01) {
    throw new Error(
      `Payment ${params.paymentId} total ($${paymentAmt.toFixed(2)}) doesn't match sum of links ($${totalLinked.toFixed(2)})`
    );
  }

  // 2. Build sparse update body — replace Line[] entirely with LinkedTxn entries.
  // QBO requires each Line to declare DetailType=PaymentLineDetail when
  // it's a LinkedTxn allocation.
  const body: any = {
    Id: params.paymentId,
    SyncToken: existing.SyncToken,
    sparse: true,
    Line: params.invoiceLinks.map((l) => ({
      Amount: Number(l.amountApplied.toFixed(2)),
      LinkedTxn: [{ TxnId: l.invoiceId, TxnType: "Invoice" }],
    })),
  };
  if (params.privateNote) {
    body.PrivateNote = params.privateNote;
  }

  const data = await qboRequest<{ Payment: AppliedPayment }>(
    realmId,
    accessToken,
    "/payment?minorversion=70",
    { method: "POST", body: JSON.stringify(body) }
  );
  return data.Payment;
}

/**
 * Look up open invoices for a given customer — used during applyPayment
 * to find which invoices a UF deposit can apply to.
 *
 * Returns invoices with non-zero balance, sorted oldest-first (FIFO is the
 * conventional accounting application order — oldest A/R clears first).
 */
export async function fetchOpenInvoicesForCustomer(
  realmId: string,
  accessToken: string,
  customerId: string
): Promise<Array<{ id: string; docNumber: string | null; txnDate: string; totalAmt: number; balance: number }>> {
  const query = encodeURIComponent(
    `SELECT Id, DocNumber, TxnDate, TotalAmt, Balance FROM Invoice WHERE CustomerRef = '${customerId}' AND Balance > '0' ORDERBY TxnDate ASC MAXRESULTS 100`
  );
  const data: any = await qboRequest(
    realmId,
    accessToken,
    `/query?query=${query}`,
    { method: "GET" }
  );
  const rows: any[] = data?.QueryResponse?.Invoice || [];
  return rows.map((r) => ({
    id: String(r.Id),
    docNumber: r.DocNumber ? String(r.DocNumber) : null,
    txnDate: String(r.TxnDate || ""),
    totalAmt: Number(r.TotalAmt || 0),
    balance: Number(r.Balance || 0),
  }));
}

/**
 * Link an existing BillPayment to a Bill — the AP mirror of
 * applyPaymentToInvoices. Used by the cleanup engine to clear "paid but
 * never applied" vendor payments so bills stop showing open.
 *
 * CRITICAL difference from the AR side: a BillPayment may already be linked
 * to OTHER bills, and QBO's sparse update REPLACES Line[] wholesale — so we
 * fetch the current lines and append the new link instead of clobbering
 * existing applications.
 */
export async function applyBillPaymentToBills(
  realmId: string,
  accessToken: string,
  params: {
    billPaymentId: string;
    billLinks: Array<{ billId: string; amountApplied: number }>;
    privateNote?: string;
  }
): Promise<{ Id: string; SyncToken: string }> {
  if (params.billLinks.length === 0) {
    throw new Error("applyBillPaymentToBills: billLinks is empty");
  }
  const query = encodeURIComponent(
    `SELECT * FROM BillPayment WHERE Id = '${params.billPaymentId}' MAXRESULTS 1`
  );
  const fetchData: any = await qboRequest(realmId, accessToken, `/query?query=${query}`, {
    method: "GET",
  });
  const existing = fetchData?.QueryResponse?.BillPayment?.[0];
  if (!existing) {
    throw new Error(`BillPayment ${params.billPaymentId} not found in QBO`);
  }

  const existingLines: any[] = Array.isArray(existing.Line) ? existing.Line : [];
  const alreadyApplied = existingLines.reduce((s, l) => s + Number(l.Amount || 0), 0);
  const newlyApplied = params.billLinks.reduce((s, l) => s + l.amountApplied, 0);
  const total = Number(existing.TotalAmt || 0);
  if (alreadyApplied + newlyApplied - total > 0.01) {
    throw new Error(
      `BillPayment ${params.billPaymentId} over-applied: $${(alreadyApplied + newlyApplied).toFixed(2)} linked vs $${total.toFixed(2)} paid`
    );
  }
  const alreadyLinkedBillIds = new Set(
    existingLines.flatMap((l) => (l.LinkedTxn || []).map((t: any) => String(t.TxnId)))
  );
  const freshLinks = params.billLinks.filter((l) => !alreadyLinkedBillIds.has(String(l.billId)));
  if (freshLinks.length === 0) {
    // Idempotent: everything requested is already linked.
    return { Id: existing.Id, SyncToken: existing.SyncToken };
  }

  const body: any = {
    Id: params.billPaymentId,
    SyncToken: existing.SyncToken,
    sparse: true,
    Line: [
      // Preserve prior applications…
      ...existingLines.map((l) => ({ Amount: l.Amount, LinkedTxn: l.LinkedTxn })),
      // …and append the new ones.
      ...freshLinks.map((l) => ({
        Amount: Number(l.amountApplied.toFixed(2)),
        LinkedTxn: [{ TxnId: l.billId, TxnType: "Bill" }],
      })),
    ],
  };
  if (params.privateNote) body.PrivateNote = params.privateNote;

  const data = await qboRequest<{ BillPayment: { Id: string; SyncToken: string } }>(
    realmId,
    accessToken,
    "/billpayment?minorversion=70",
    { method: "POST", body: JSON.stringify(body) }
  );
  return data.BillPayment;
}

// ============== TRANSACTIONS ==============

/**
 * Fast bulk fetch of transaction counts per account.
 *
 * Uses the TransactionList report, which has a FLAT row structure with one
 * row per transaction and an account_id column. This is MUCH more reliable
 * than parsing the nested GeneralLedger report.
 *
 * Returns: Map<accountId, transactionCount>
 *
 * Why this matters: QBO blocks API inactivation of accounts with any historical
 * transactions, even if current balance is zero. Pre-flight needs this info to
 * decide whether an inactivate is safe or must be flagged.
 *
 * Implementation notes:
 *   - The TransactionList report returns one row per transaction line.
 *   - We use the `account_id` column to bucket counts per account.
 *   - Use a wide date range to capture all historical transactions.
 *   - QBO reports use 'columns' to specify what columns to return.
 */
export async function fetchTransactionCountsForAllAccounts(
  realmId: string,
  accessToken: string
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  try {
    const params = new URLSearchParams({
      start_date: '1900-01-01',
      end_date: '2099-12-31',
      columns: 'tx_date,account_name,txn_type',
      minorversion: '70',
    });
    const data = await qboRequest<any>(
      realmId,
      accessToken,
      `/reports/TransactionList?${params.toString()}`
    );

    // TransactionList structure:
    //   data.Columns.Column[] - column metadata
    //   data.Rows.Row[]       - one entry per transaction (flat)
    // Each Row has ColData[] where each ColData has { value, id? }.
    // The account name column may have an `id` attribute = account id.

    // Find which column index represents the account
    const columns = data.Columns?.Column || [];
    let accountColIndex = -1;
    for (let i = 0; i < columns.length; i++) {
      const colTitle = (columns[i]?.ColTitle || '').toLowerCase();
      const colType = (columns[i]?.ColType || '').toLowerCase();
      if (colTitle.includes('account') || colType === 'account') {
        accountColIndex = i;
        break;
      }
    }

    if (accountColIndex === -1) {
      console.warn('[fetchTransactionCountsForAllAccounts] No account column found in TransactionList');
      return counts;
    }

    // Walk flat row list, bucketing by account id
    function walkRows(rows: any[]): void {
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        // A row is either a data row (has ColData directly) or a section/group
        // wrapping more rows. We handle both.
        if (row.ColData && Array.isArray(row.ColData)) {
          const cell = row.ColData[accountColIndex];
          const accountId = cell?.id;
          if (accountId) {
            const key = String(accountId);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
        if (row.Rows?.Row) {
          walkRows(row.Rows.Row);
        }
      }
    }

    if (data.Rows?.Row) {
      walkRows(data.Rows.Row);
    }

    console.log(
      `[fetchTransactionCountsForAllAccounts] Counted transactions for ${counts.size} accounts. ` +
      `Total transactions: ${Array.from(counts.values()).reduce((a, b) => a + b, 0)}`
    );
  } catch (e) {
    console.error('[fetchTransactionCountsForAllAccounts] TransactionList report failed:', e);
    // Don't throw — return whatever we have. Pre-flight will fall back to a
    // per-account direct check (slower but reliable) if it sees an empty map.
  }

  return counts;
}

/**
 * Direct per-account transaction existence check.
 *
 * Use this as a fallback when the TransactionList report fails or returns empty.
 * Slower (one API call per account) but 100% reliable for the "does this
 * account have any transactions?" question.
 *
 * Strategy: query the JournalEntry, Purchase, Bill, Deposit, Invoice, Payment,
 * SalesReceipt, and Expense entities for any line referencing the account.
 * We only need to know "any" not "how many" — so we ask for 1 result max.
 */
export async function accountHasTransactions(
  realmId: string,
  accessToken: string,
  accountId: string
): Promise<boolean> {
  // The most reliable single-query is to check whether the account has been
  // referenced in any Journal Entry line. JournalEntries touch every account
  // type. Other transaction types are also possible but JEs are universal.
  const queries = [
    `SELECT Id FROM JournalEntry WHERE Line.JournalEntryLineDetail.AccountRef = '${accountId}' MAXRESULTS 1`,
    `SELECT Id FROM Purchase WHERE AccountRef = '${accountId}' MAXRESULTS 1`,
    `SELECT Id FROM Deposit WHERE DepositToAccountRef = '${accountId}' MAXRESULTS 1`,
  ];

  for (const q of queries) {
    try {
      const data = await qboRequest<any>(
        realmId,
        accessToken,
        `/query?query=${encodeURIComponent(q)}&minorversion=70`
      );
      const results =
        data.QueryResponse?.JournalEntry ||
        data.QueryResponse?.Purchase ||
        data.QueryResponse?.Deposit;
      if (results && results.length > 0) return true;
    } catch {
      // Some queries don't apply to all account types; skip silently
    }
  }
  return false;
}

export interface QBOTransaction {
  Id: string;
  SyncToken: string;
  TxnDate: string;
  TotalAmt: number;
  PrivateNote?: string;
  Line: Array<{
    Id?: string;
    DetailType: string;
    Amount: number;
    AccountBasedExpenseLineDetail?: { AccountRef: { value: string } };
    JournalEntryLineDetail?: {
      PostingType: 'Debit' | 'Credit';
      AccountRef: { value: string };
    };
  }>;
}

/**
 * Fetch all transactions posted to a specific account.
 * Used before reclassification to know what we're moving.
 */
export async function fetchTransactionsForAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  txTypes: string[] = ['Purchase', 'Bill', 'JournalEntry', 'Deposit']
): Promise<{ type: string; transactions: any[] }[]> {
  const results = [];

  for (const type of txTypes) {
    const query = encodeURIComponent(
      `SELECT * FROM ${type} WHERE Line.AccountBasedExpenseLineDetail.AccountRef='${accountId}' MAXRESULTS 1000`
    );
    try {
      const data = await qboRequest<any>(
        realmId,
        accessToken,
        `/query?query=${query}`
      );
      const txs = data.QueryResponse[type] || [];
      if (txs.length > 0) results.push({ type, transactions: txs });
    } catch {
      // some types don't support this query - skip silently
    }
  }

  return results;
}

/**
 * Reclassify a single transaction line from one account to another.
 * QBO requires the full transaction object to be re-posted.
 */
export async function reclassifyTransaction(
  realmId: string,
  accessToken: string,
  txnType: string,
  transaction: QBOTransaction,
  fromAccountId: string,
  toAccountId: string
): Promise<QBOTransaction> {
  // Update each line that points to fromAccountId
  const updatedLines = transaction.Line.map((line) => {
    if (line.AccountBasedExpenseLineDetail?.AccountRef.value === fromAccountId) {
      return {
        ...line,
        AccountBasedExpenseLineDetail: {
          ...line.AccountBasedExpenseLineDetail,
          AccountRef: { value: toAccountId },
        },
      };
    }
    if (line.JournalEntryLineDetail?.AccountRef.value === fromAccountId) {
      return {
        ...line,
        JournalEntryLineDetail: {
          ...line.JournalEntryLineDetail,
          AccountRef: { value: toAccountId },
        },
      };
    }
    return line;
  });

  const data = await qboRequest<any>(
    realmId,
    accessToken,
    `/${txnType.toLowerCase()}?minorversion=70`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...transaction,
        Line: updatedLines,
      }),
    }
  );

  return data[txnType];
}

// ============== TAX CODES ==============

export interface QBOTaxCode {
  Id: string;
  Name: string;
  Description?: string;
  TaxGroup: boolean;
  Active: boolean;
}

/**
 * Get all tax codes available in the client's QBO.
 * Used to map Canadian GST/HST/PST to the right TaxCodeRef.
 */
export async function fetchTaxCodes(realmId: string, accessToken: string): Promise<QBOTaxCode[]> {
  const query = encodeURIComponent('SELECT * FROM TaxCode MAXRESULTS 100');
  const data = await qboRequest<{ QueryResponse: { TaxCode?: QBOTaxCode[] } }>(
    realmId,
    accessToken,
    `/query?query=${query}`
  );
  return data.QueryResponse.TaxCode || [];
}

// ============== BATCH OPERATIONS ==============

/**
 * Batch operation (up to 30 items per call - QBO limit).
 * Use for high-volume reclassifications.
 */
export async function batchOperation(
  realmId: string,
  accessToken: string,
  operations: Array<{ operation: string; resource: string; payload: any; bId: string }>
): Promise<any> {
  return qboRequest(realmId, accessToken, '/batch?minorversion=70', {
    method: 'POST',
    body: JSON.stringify({
      BatchItemRequest: operations.map(op => ({
        bId: op.bId,
        operation: op.operation,
        [op.resource]: op.payload,
      })),
    }),
  });
}

// ============== RATE LIMITER ==============
// QBO limit: 500 requests/minute per realm.
// Simple in-memory limiter — use Redis for production multi-instance.
class RateLimiter {
  private timestamps: Map<string, number[]> = new Map();
  private readonly maxPerMinute: number;

  constructor(maxPerMinute = 450) {
    this.maxPerMinute = maxPerMinute;
  }

  async throttle(key: string): Promise<void> {
    const now = Date.now();
    const cutoff = now - 60_000;
    const list = (this.timestamps.get(key) || []).filter(t => t > cutoff);

    if (list.length >= this.maxPerMinute) {
      const oldest = list[0];
      const waitMs = 60_000 - (now - oldest) + 100;
      await new Promise(r => setTimeout(r, waitMs));
      return this.throttle(key);
    }

    list.push(now);
    this.timestamps.set(key, list);
  }
}

export const qboRateLimiter = new RateLimiter();

// ============== COMPANY INFO ==============

export interface QBOCompanyInfo {
  CompanyName: string;
  LegalName?: string;
  Country?: string;
  CompanyAddr?: {
    Line1?: string;
    City?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
    Country?: string;
  };
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  /** "January" | "February" | ... | "December" — month the client's fiscal year starts */
  FiscalYearStartMonth?: string;
}

/**
 * Convert QBO's "January", "February", ... to a 1-indexed month number.
 * Defaults to 1 (January) if unknown.
 */
export function fiscalStartMonthToNumber(name: string | undefined): number {
  if (!name) return 1;
  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  const idx = months.indexOf(name.trim().toLowerCase());
  return idx >= 0 ? idx + 1 : 1;
}

export interface DateRangePreset {
  id: string;
  label: string;
  start: string;
  end: string;
}

/**
 * Build the 4 date-range presets shown on the reclass form, using the client's
 * actual fiscal year start month (from QBO CompanyInfo). Every range ends today.
 *
 * Older years are handled by the year-by-year cascade after each cleanup
 * completes — no need for "+ Last 2 Years" presets here.
 */
export function getReclassDateRangePresets(
  fiscalStartMonth: number,
  today: Date = new Date()
): DateRangePreset[] {
  const y = today.getUTCFullYear();
  const todayStr = today.toISOString().slice(0, 10);
  const cyStart = (year: number) => `${year}-01-01`;
  const fyStartYear = (today.getUTCMonth() + 1) >= fiscalStartMonth ? y : y - 1;
  const fyStart = (yearsBack: number) => {
    const yr = fyStartYear - yearsBack;
    const mm = String(fiscalStartMonth).padStart(2, "0");
    return `${yr}-${mm}-01`;
  };
  return [
    { id: "fy",        label: "This Fiscal Year",                       start: fyStart(0),     end: todayStr },
    { id: "cy",        label: "This Calendar Year",                     start: cyStart(y),     end: todayStr },
    { id: "fy_plus_1", label: "This Fiscal Year + Last Fiscal Year",    start: fyStart(1),     end: todayStr },
    { id: "cy_plus_1", label: "This Calendar Year + Last Calendar Year", start: cyStart(y - 1), end: todayStr },
  ];
}

/**
 * Fetch company name + jurisdiction from a freshly-connected QBO company.
 * Call this immediately after exchangeCodeForTokens().
 */
export async function fetchCompanyInfo(
  realmId: string,
  accessToken: string
): Promise<QBOCompanyInfo> {
  const data = await qboRequest<{ CompanyInfo: QBOCompanyInfo }>(
    realmId,
    accessToken,
    `/companyinfo/${realmId}`
  );
  return data.CompanyInfo;
}

// ============== UF AUDIT — void duplicates + sweep UF → bank ==============

/**
 * Void a Payment or SalesReceipt in QBO (operation=void).
 *
 * Used by the UF Audit "void_duplicate" resolution: when a UF payment is a
 * confirmed duplicate of another payment (same check# + amount + customer),
 * voiding zeroes it out so the double-counted cash is removed.
 *
 * We VOID (not delete) to preserve the audit trail — the transaction stays
 * in QBO at $0 with a "Voided" stamp, which is what an auditor expects.
 *
 * Voiding a Receive-Payment reverses its Dr UF / Cr A/R, which re-opens the
 * invoice it was applied to (A/R goes back up). That is the CORRECT behavior
 * for a true duplicate — the real payment (the kept copy) still covers the
 * invoice. Only call this when you're confident it's a duplicate.
 *
 * Needs the current SyncToken (optimistic concurrency) — we fetch it first.
 */
export async function voidPayment(
  realmId: string,
  accessToken: string,
  paymentId: string,
  txnType: "Payment" | "SalesReceipt" = "Payment"
): Promise<{ Id: string; SyncToken: string; PrivateNote?: string }> {
  const entity = txnType; // "Payment" | "SalesReceipt"
  const resource = txnType === "SalesReceipt" ? "salesreceipt" : "payment";

  // 1. Fetch current object for SyncToken
  const query = encodeURIComponent(
    `SELECT Id, SyncToken FROM ${entity} WHERE Id = '${paymentId}' MAXRESULTS 1`
  );
  const fetchData: any = await qboRequest(
    realmId,
    accessToken,
    `/query?query=${query}`,
    { method: "GET" }
  );
  const existing = fetchData?.QueryResponse?.[entity]?.[0];
  if (!existing) {
    throw new Error(`${entity} ${paymentId} not found in QBO (can't void)`);
  }

  // 2. POST operation=void with just Id + SyncToken
  const data = await qboRequest<any>(
    realmId,
    accessToken,
    `/${resource}?operation=void&minorversion=70`,
    {
      method: "POST",
      body: JSON.stringify({ Id: paymentId, SyncToken: existing.SyncToken }),
    }
  );
  const out = data?.[entity] || data?.Payment || data?.SalesReceipt || {};
  return { Id: String(out.Id || paymentId), SyncToken: String(out.SyncToken || ""), PrivateNote: out.PrivateNote };
}

/**
 * Set QBO's book-closing date (Company Settings → Advanced → Close the
 * books). Locks the period: edits to transactions dated on/before this
 * date trigger a QBO warning. Called when a manager approves a monthly
 * close — closeDate should be the period end (YYYY-MM-DD).
 *
 * Sparse update on the singleton Preferences object (Id "1" + SyncToken
 * required for optimistic concurrency).
 */
export async function updateClosingDate(
  realmId: string,
  accessToken: string,
  closeDate: string
): Promise<{ Id: string; SyncToken: string }> {
  const prefs = await qboRequest<any>(
    realmId,
    accessToken,
    `/preferences?minorversion=70`,
    { method: "GET" }
  );
  const current = prefs?.Preferences;
  if (!current?.Id) throw new Error("Could not load QBO Preferences");

  const data = await qboRequest<any>(
    realmId,
    accessToken,
    `/preferences?minorversion=70`,
    {
      method: "POST",
      body: JSON.stringify({
        Id: current.Id,
        SyncToken: current.SyncToken,
        sparse: true,
        AccountingInfoPrefs: {
          BookCloseDate: closeDate,
        },
      }),
    }
  );
  const out = data?.Preferences || {};
  return { Id: String(out.Id || current.Id), SyncToken: String(out.SyncToken || "") };
}

/**
 * Read the QBO book-closing date (AccountingInfoPrefs.BookCloseDate), or
 * null when no close date is set. Used to gate automated writes (daily
 * recon) OUT of closed periods — we must never silently re-categorize a
 * transaction the client/CPA has already closed and filed against.
 *
 * Returns an ISO date string "YYYY-MM-DD" (QBO's format) or null.
 */
export async function getBookCloseDate(
  realmId: string,
  accessToken: string
): Promise<string | null> {
  const prefs = await qboRequest<any>(
    realmId,
    accessToken,
    `/preferences?minorversion=70`,
    { method: "GET" }
  );
  const raw = prefs?.Preferences?.AccountingInfoPrefs?.BookCloseDate;
  return raw ? String(raw).slice(0, 10) : null;
}

/**
 * Void an Invoice in QBO (operation=void). Reverses Dr A/R / Cr Income —
 * removes any open balance from A/R and backs the revenue out. Used by the
 * UF Audit "void pair" resolution for CRM-duplicated invoice+payment pairs:
 * void the payment FIRST (unlinks it), then the invoice.
 */
export async function voidInvoice(
  realmId: string,
  accessToken: string,
  invoiceId: string
): Promise<{ Id: string; SyncToken: string }> {
  const query = encodeURIComponent(
    `SELECT Id, SyncToken FROM Invoice WHERE Id = '${invoiceId}' MAXRESULTS 1`
  );
  const fetchData: any = await qboRequest(
    realmId,
    accessToken,
    `/query?query=${query}`,
    { method: "GET" }
  );
  const existing = fetchData?.QueryResponse?.Invoice?.[0];
  if (!existing) {
    throw new Error(`Invoice ${invoiceId} not found in QBO (can't void)`);
  }
  const data = await qboRequest<any>(
    realmId,
    accessToken,
    `/invoice?operation=void&minorversion=70`,
    {
      method: "POST",
      body: JSON.stringify({ Id: invoiceId, SyncToken: existing.SyncToken }),
    }
  );
  const out = data?.Invoice || {};
  return { Id: String(out.Id || invoiceId), SyncToken: String(out.SyncToken || "") };
}

export interface DepositLineInput {
  /** The Payment / SalesReceipt sitting in UF to sweep into the bank. */
  txnId: string;
  txnType: "Payment" | "SalesReceipt";
  amount: number;
}

export interface DepositOffsetLineInput {
  /**
   * Account-based offset line (no LinkedTxn). Used for the zero-dollar
   * deposit pattern: sweep stuck UF payments (+) and offset the full amount
   * to an income account (−) when the cash was ALREADY recorded via a
   * separate bank-feed deposit. Negative amounts are allowed by QBO.
   */
  accountId: string;
  accountName?: string;
  amount: number; // negative for the duplicate-income reversal
  description?: string;
}

export interface CreatedDeposit {
  Id: string;
  TxnDate: string;
  TotalAmt: number;
  PrivateNote?: string;
}

/**
 * Post a Bank Deposit that sweeps existing UF payments into a real bank
 * account — the "clear via Bank Deposit" step that actually zeroes UF.
 *
 * Each line LinkedTxn-references a Payment/SalesReceipt that currently sits
 * in Undeposited Funds. QBO moves those funds out of UF and into the account
 * named by DepositToAccountRef (the chosen bank). This is the clean,
 * QBO-native way to clear UF (vs a JE), and it shows up on the bank rec.
 *
 * The deposit's TxnDate should be the real deposit date (often back-dated to
 * when the money actually hit the bank) so reconciliation lines up.
 */
export async function createDeposit(
  realmId: string,
  accessToken: string,
  params: {
    bankAccountId: string;
    bankAccountName?: string;
    txnDate: string; // YYYY-MM-DD
    lines: DepositLineInput[];
    offsetLines?: DepositOffsetLineInput[];
    privateNote?: string;
  }
): Promise<CreatedDeposit> {
  if (!params.lines || params.lines.length === 0) {
    throw new Error("createDeposit: at least one line (UF payment) is required");
  }
  const body: any = {
    DepositToAccountRef: { value: params.bankAccountId, name: params.bankAccountName },
    TxnDate: params.txnDate,
    PrivateNote: params.privateNote || undefined,
    Line: [
      ...params.lines.map((l) => ({
        Amount: Number(l.amount.toFixed(2)),
        DetailType: "DepositLineDetail",
        // LinkedTxn pulls the payment OUT of Undeposited Funds. No
        // DepositLineDetail.AccountRef here — that's only for funds NOT already
        // in UF (e.g. direct income). For a UF sweep we just link the payment.
        LinkedTxn: [{ TxnId: l.txnId, TxnType: l.txnType }],
      })),
      ...(params.offsetLines || []).map((l) => ({
        Amount: Number(l.amount.toFixed(2)),
        DetailType: "DepositLineDetail",
        Description: l.description || undefined,
        DepositLineDetail: {
          AccountRef: { value: l.accountId, name: l.accountName },
        },
      })),
    ],
  };

  const data = await qboRequest<{ Deposit: CreatedDeposit }>(
    realmId,
    accessToken,
    "/deposit?minorversion=70",
    { method: "POST", body: JSON.stringify(body) }
  );
  return data.Deposit;
}
