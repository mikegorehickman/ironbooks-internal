import { createServiceSupabase } from "@/lib/supabase";
import { verifyGhlWebhook } from "@/lib/ghl";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/ghl/coaching-call
 *
 * Fires from GHL when a paid coaching-call appointment is booked. Marks the
 * matching booking consumed (single-use lock) so the /book/[token] page can't
 * be reused. Auth via the shared SNAP webhook secret (verifyGhlWebhook).
 *
 * Matching (best-effort, since GHL doesn't echo our token):
 *   1. calendarId → coach (coaching_call_settings.ghl_calendar_id)
 *   2. most-recent paid + unconsumed booking for that coach (preferring a
 *      buyer_email match when the payload carries the contact email).
 */
export async function POST(request: Request) {
  if (!verifyGhlWebhook(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => ({} as any));
  // GHL payloads vary by version; pull the fields we need defensively.
  const calendarId: string | null =
    payload?.calendarId || payload?.calendar?.id || payload?.appointment?.calendarId || null;
  const appointmentId: string | null =
    payload?.appointmentId || payload?.id || payload?.appointment?.id || null;
  const startTime: string | null =
    payload?.startTime || payload?.appointment?.startTime || payload?.selectedSlot || null;
  const email: string | null = (
    payload?.email || payload?.contact?.email || payload?.appointment?.email || ""
  )?.toLowerCase() || null;

  const service = createServiceSupabase();

  // Resolve coach from the calendar id.
  let coachKey: string | null = null;
  if (calendarId) {
    const { data: coach } = await service
      .from("coaching_call_settings")
      .select("coach_key")
      .eq("ghl_calendar_id", calendarId)
      .maybeSingle();
    coachKey = (coach as any)?.coach_key || null;
  }

  // Find the booking to consume: paid + not yet consumed, scoped to the coach
  // and (if available) the buyer email, newest first.
  let q = service
    .from("coaching_call_bookings")
    .select("id, token, buyer_email")
    .eq("payment_status", "paid")
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (coachKey) q = q.eq("coach_key", coachKey);
  if (email) q = q.eq("buyer_email", email);

  let { data: match } = await q.maybeSingle();
  // Fallback: drop the email filter if nothing matched but we have a coach.
  if (!match && coachKey) {
    const { data: byCoach } = await service
      .from("coaching_call_bookings")
      .select("id, token")
      .eq("payment_status", "paid")
      .is("consumed_at", null)
      .eq("coach_key", coachKey)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    match = byCoach as any;
  }

  if (!match) {
    return NextResponse.json({ ok: true, no_match: true, calendarId, email });
  }

  const nowIso = new Date().toISOString();
  await service
    .from("coaching_call_bookings")
    .update({
      booked_at: startTime || nowIso,
      ghl_appointment_id: appointmentId,
      consumed_at: nowIso,
      updated_at: nowIso,
    } as any)
    .eq("id", (match as any).id);

  return NextResponse.json({ ok: true, consumed: (match as any).token });
}
