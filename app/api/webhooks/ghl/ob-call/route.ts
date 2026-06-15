import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { verifyGhlWebhook } from "@/lib/ghl";
import {
  extractContactId,
  extractContactFields,
  upsertLeadFromWebhook,
  pick,
} from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/ghl/ob-call
 *
 * Fired when the onboarding call is booked (and, if GHL sends them, when it's
 * rescheduled or cancelled). Stamps the appointment time + status so a
 * cancelled call correctly drops the card back to "needs to rebook".
 * Attendance is NOT set here — that's a manager click on the board or a Grain
 * sync.
 *
 * GHL setup: Appointment status trigger(s) → Webhook action → this URL with
 * the `x-snap-webhook-secret` header.
 */

// PLACEHOLDER mapping — finalized against a real payload. Normalizes whatever
// GHL sends into our small status vocabulary.
function normalizeCallStatus(payload: any): string {
  const raw = String(
    pick(payload, [
      "appointment_status",
      "appointmentStatus",
      "status",
      "calendar.status",
      "event",
      "type",
    ]) || ""
  ).toLowerCase();
  if (raw.includes("cancel")) return "cancelled";
  if (raw.includes("reschedul")) return "rescheduled";
  if (raw.includes("noshow") || raw.includes("no_show") || raw.includes("no-show")) return "no_show";
  if (raw.includes("showed") || raw.includes("attend") || raw.includes("complete")) return "attended";
  return "scheduled";
}

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
    console.warn("[ghl/ob-call] no contact id in payload", Object.keys(payload || {}));
    return NextResponse.json({ error: "Missing contact id" }, { status: 422 });
  }

  const callTime = pick(payload, [
    "start_time",
    "startTime",
    "appointment.startTime",
    "calendar.startTime",
    "selected_slot",
    "appointmentStartTime",
  ]);
  const status = normalizeCallStatus(payload);

  const fields: Record<string, any> = {
    ob_call_scheduled_at: new Date().toISOString(),
    ob_call_status: status,
    ...extractContactFields(payload),
  };
  // A cancellation clears the booked time so the card reads "rebook needed".
  fields.ob_call_time = status === "cancelled" ? null : callTime ? new Date(callTime).toISOString() : null;
  if (status === "attended") fields.ob_call_attended_at = new Date().toISOString();

  const service = createServiceSupabase();
  const result = await upsertLeadFromWebhook(service, "ob_call", contactId, payload, fields);

  if (!result.ok) {
    console.error("[ghl/ob-call] upsert failed:", result.error);
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, lead_id: result.id });
}
