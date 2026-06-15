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
 * POST /api/webhooks/ghl/ob-form
 *
 * Fired when the client completes the onboarding form in GHL. Stamps
 * ob_form_submitted_at and stores the submission so the card can show the key
 * answers (business name, entity type, etc. — finalized once we see a real
 * payload). Creates the lead if the WON webhook hasn't arrived yet
 * (order-independent).
 *
 * GHL setup: Form submitted trigger → Webhook action → this URL with the
 * `x-snap-webhook-secret` header.
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
    console.warn("[ghl/ob-form] no contact id in payload", Object.keys(payload || {}));
    return NextResponse.json({ error: "Missing contact id" }, { status: 422 });
  }

  const service = createServiceSupabase();
  const result = await upsertLeadFromWebhook(service, "ob_form", contactId, payload, {
    ob_form_submitted_at: new Date().toISOString(),
    ob_form_payload: payload,
    ...extractContactFields(payload),
  });

  if (!result.ok) {
    console.error("[ghl/ob-form] upsert failed:", result.error);
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, lead_id: result.id });
}
