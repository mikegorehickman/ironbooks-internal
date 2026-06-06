import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * /api/quickbooks/disconnect — Intuit disconnect notification webhook.
 *
 * Registered with Intuit as our official Disconnect URL (required for
 * production app approval). When a user disconnects the Ironbooks SNAP
 * app from inside QuickBooks (QBO → ⚙ → Apps → My Apps → Disconnect),
 * Intuit POSTs to this endpoint to let us know.
 *
 * Per Intuit's spec, the disconnect notification arrives as either:
 *   - POST with a signed JWT in the body (intuit_tid header present), OR
 *   - POST with simple JSON { realmId } body, OR
 *   - GET with ?realmId=<id> query (legacy fallback)
 *
 * Our response: identify the affected realm, null out the access/refresh
 * tokens on client_links, write an audit_log entry. Always respond 200
 * (Intuit retries on non-2xx and will eventually disable the app
 * registration if disconnects keep failing).
 *
 * Security: we do NOT verify the JWT signature in this version because
 * (a) the notification is informational — nulling our local tokens isn't
 * a destructive op an attacker would benefit from spoofing, and (b) any
 * subsequent QBO API call we'd make with the dead token would fail
 * anyway. JWT verification is a hardening TODO once we're past the
 * production-keys crunch (see `verifyIntuitDisconnectJWT` placeholder).
 *
 * Also supports a browser-direct GET for users who land here manually
 * (curiosity click, autocomplete) — shows a small HTML acknowledgement
 * rather than a raw JSON error.
 */

interface DisconnectPayload {
  realmId?: string;
  realm_id?: string;
}

async function resolveRealmId(request: Request): Promise<string | null> {
  // 1. Query string (GET path + some legacy POST variants)
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("realmId") || url.searchParams.get("realm_id");
  if (fromQuery) return fromQuery;

  // 2. JSON body — Intuit's modern notification format
  try {
    const body = (await request.clone().json()) as DisconnectPayload;
    if (body.realmId) return body.realmId;
    if (body.realm_id) return body.realm_id;
  } catch {
    // Body might be a JWT string or form-encoded — fall through
  }

  // 3. Form-encoded body (some older Intuit clients used this)
  try {
    const text = await request.clone().text();
    if (text && text.includes("realmId=")) {
      const match = text.match(/realmId=([^&\s]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    // 4. JWT body — pull realmid from payload claim without verifying
    //    signature (best-effort identification only; see note above).
    if (text && text.split(".").length === 3) {
      const payloadB64 = text.split(".")[1];
      try {
        const decoded = JSON.parse(
          Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
        );
        if (decoded?.realmid) return String(decoded.realmid);
        if (decoded?.realmId) return String(decoded.realmId);
      } catch {
        // Not a parseable JWT — give up
      }
    }
  } catch {
    // No body — nothing more we can do
  }

  return null;
}

async function processDisconnect(realmId: string, source: "POST" | "GET") {
  const service = createServiceSupabase();

  // Find the matching client_link. Realm IDs are globally unique within
  // Intuit, so this is safe to look up by realm alone.
  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("qbo_realm_id", realmId)
    .single();

  if (!clientLink) {
    // Unknown realm — log it but ack 200 so Intuit doesn't retry forever.
    // Could happen if a user disconnects then deletes the client_links row,
    // or if Intuit sends a notification for an unrelated realm by mistake.
    await service.from("audit_log").insert({
      event_type: "qbo_disconnect_notification",
      request_payload: {
        realm_id: realmId,
        source,
        status: "unknown_realm",
      } as any,
    });
    return { ok: true, status: "unknown_realm" };
  }

  // Null out the OAuth state so subsequent operations cleanly surface
  // "Token expired" instead of attempting to refresh a token we know is
  // dead. Keep qbo_realm_id intact so the reconnect flow can re-link.
  await service
    .from("client_links")
    .update({
      qbo_access_token: null,
      qbo_refresh_token: null,
      qbo_token_expires_at: null,
    } as any)
    .eq("id", (clientLink as any).id);

  await service.from("audit_log").insert({
    event_type: "qbo_disconnect_notification",
    request_payload: {
      realm_id: realmId,
      client_link_id: (clientLink as any).id,
      client_name: (clientLink as any).client_name,
      source,
      status: "tokens_cleared",
    } as any,
  });

  return {
    ok: true,
    status: "tokens_cleared",
    client_link_id: (clientLink as any).id,
    client_name: (clientLink as any).client_name,
  };
}

export async function POST(request: Request) {
  const realmId = await resolveRealmId(request);

  if (!realmId) {
    // Still 200 — Intuit retries on non-2xx and we don't want to spiral
    // on malformed-but-genuine notifications.
    return NextResponse.json(
      { ok: true, status: "no_realm_id_in_payload" },
      { status: 200 }
    );
  }

  const result = await processDisconnect(realmId, "POST");
  return NextResponse.json(result, { status: 200 });
}

export async function GET(request: Request) {
  const realmId = await resolveRealmId(request);

  // Browser-direct hit with no realm param → friendly HTML, not JSON.
  // Users sometimes click this URL out of curiosity from their QBO Apps
  // page; an error response makes SNAP look broken.
  if (!realmId) {
    return new NextResponse(
      `<!doctype html><meta charset="utf-8">
       <title>Ironbooks · QuickBooks Disconnect</title>
       <body style="font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:80px auto;padding:0 24px;color:#1f2937;line-height:1.55">
         <h1 style="margin:0 0 8px;font-size:22px">Ironbooks SNAP</h1>
         <p style="color:#6b7280;margin:0 0 24px">QuickBooks disconnect endpoint</p>
         <p>This URL is used by Intuit to notify Ironbooks when you disconnect the SNAP app from your QuickBooks Online company.</p>
         <p>If you'd like to disconnect, please go to QuickBooks Online → ⚙ Settings → Apps → My Apps → Ironbooks SNAP → Disconnect.</p>
         <p style="margin-top:32px"><a href="/" style="color:#2563eb">Return to Ironbooks</a></p>
       </body>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  const result = await processDisconnect(realmId, "GET");
  return NextResponse.json(result, { status: 200 });
}
