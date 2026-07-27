import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { verifyGhlWebhook } from "@/lib/ghl";
import {
  extractContactId,
  extractContactFields,
  upsertLeadFromWebhook,
  pick,
} from "@/lib/onboarding";
import { readOnboardingState } from "@/lib/portal-onboarding";

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

  // Also reflect the booking in the client's PORTAL onboarding wizard, so the
  // "Book your call" step ticks itself off from a real appointment rather than
  // relying on the client's self-confirmation. A cancellation clears it again,
  // matching the board behaviour — they need to rebook to finish onboarding.
  const portal = await syncPortalCallState(service, result.id, fields.email, status);

  return NextResponse.json({ ok: true, lead_id: result.id, portal });
}

/**
 * Mirror the appointment onto client_links.portal_onboarding.call_booked_at.
 * Resolves the client via the lead's link first, then by contact email.
 * Best-effort: never fails the webhook, since the board write already succeeded.
 */
async function syncPortalCallState(
  service: any,
  leadId: string | undefined,
  email: string | null | undefined,
  status: string
): Promise<string> {
  try {
    let clientLinkId: string | null = null;

    if (leadId) {
      const { data: lead } = await service
        .from("onboarding_leads")
        .select("client_link_id")
        .eq("id", leadId)
        .maybeSingle();
      clientLinkId = (lead as any)?.client_link_id ?? null;
    }
    if (!clientLinkId && email) {
      const { data: matches } = await service
        .from("client_links")
        .select("id")
        .ilike("client_email", String(email).trim())
        .eq("is_active", true)
        .limit(1);
      clientLinkId = ((matches as any[]) || [])[0]?.id ?? null;
    }
    if (!clientLinkId) return "no client matched";

    const { data: client } = await service
      .from("client_links")
      .select("id, client_name, portal_onboarding")
      .eq("id", clientLinkId)
      .single();
    if (!client) return "no client matched";

    const state = readOnboardingState(client);
    const cancelled = status === "cancelled";
    const next = cancelled ? null : state.call_booked_at || new Date().toISOString();
    if (next === state.call_booked_at) return "unchanged";

    await service
      .from("client_links")
      .update({ portal_onboarding: { ...state, call_booked_at: next } })
      .eq("id", clientLinkId);

    try {
      await service.from("audit_log").insert({
        event_type: cancelled ? "portal_onboarding_call_cancelled" : "portal_onboarding_call_booked",
        request_payload: {
          client_link_id: clientLinkId,
          client_name: (client as any).client_name,
          source: "ghl_webhook",
          status,
        } as any,
      } as any);
    } catch {
      /* audit is best-effort */
    }
    return cancelled ? "cleared" : "recorded";
  } catch (e: any) {
    console.warn("[ghl/ob-call] portal sync skipped:", e?.message);
    return "skipped";
  }
}
