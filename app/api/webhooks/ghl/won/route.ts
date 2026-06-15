import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { verifyGhlWebhook } from "@/lib/ghl";
import {
  extractContactId,
  extractContactFields,
  upsertLeadFromWebhook,
} from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/ghl/won
 *
 * Fired by the GHL workflow when an opportunity is marked WON. Creates (or
 * updates) the onboarding lead and stamps won_at — the start of the
 * onboarding clock.
 *
 * GHL setup: Workflow trigger "Opportunity Status Changed → Won" → Webhook
 * action → this URL, with header `x-snap-webhook-secret: <GHL_WEBHOOK_SECRET>`.
 *
 * Field mapping is best-effort (see lib/onboarding.ts `pick`/`extract*`); the
 * full raw payload is stored so we can finalize the mapping against a real
 * sample without losing anything.
 */
export async function POST(request: Request) {
  if (!verifyGhlWebhook(request)) {
    return NextResponse.json({ error: "Invalid webhook secret" }, { status: 401 });
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactId = extractContactId(payload);
  if (!contactId) {
    console.warn("[ghl/won] no contact id in payload", Object.keys(payload || {}));
    return NextResponse.json({ error: "Missing contact id" }, { status: 422 });
  }

  const service = createServiceSupabase();
  const result = await upsertLeadFromWebhook(service, "won", contactId, payload, {
    won_at: new Date().toISOString(),
    ...extractContactFields(payload),
  });

  if (!result.ok) {
    console.error("[ghl/won] upsert failed:", result.error);
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, lead_id: result.id });
}
