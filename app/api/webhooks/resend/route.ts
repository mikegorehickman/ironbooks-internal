import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/resend — Resend event webhook.
 *
 * Three jobs:
 *  1. Update the client_email_log row's delivery status (matched on the Resend
 *     message id) for email.delivered / .bounced / .complained.
 *  2. On a hard bounce or spam complaint, suppress that address so future bulk
 *     sends skip it.
 *  3. On email.opened, stamp last_email_opened_at — the inbox-vs-spam signal
 *     for the Admin → Users never-logged-in view.
 * Configure the endpoint in the Resend dashboard for email.delivered,
 * email.bounced, email.complained, email.opened, and enable open tracking on
 * the sending domain. (Note: this endpoint does not yet verify the Svix
 * signature — set RESEND_WEBHOOK_SECRET + add verification before relying on
 * it for anything security-sensitive.)
 */
export async function POST(request: Request) {
  const evt = await request.json().catch(() => ({} as any));
  const type = evt?.type as string | undefined;

  // 1. Reflect delivery status onto the email-log row (matched by message id).
  const LOG_STATUS: Record<string, string> = {
    "email.delivered": "delivered",
    "email.bounced": "bounced",
    "email.complained": "complained",
  };
  const logStatus = type ? LOG_STATUS[type] : undefined;
  const emailId = evt?.data?.email_id as string | undefined;
  if (logStatus && emailId) {
    try {
      const svc = createServiceSupabase();
      await svc
        .from("client_email_log")
        .update({
          status: logStatus,
          error: type === "email.bounced" ? evt?.data?.bounce?.message ?? "hard bounce" : null,
          updated_at: new Date().toISOString(),
        } as any)
        .eq("provider_message_id", emailId);
    } catch {
      /* log table may not exist yet (migration 93) — best-effort */
    }
  }

  if (!type || !/bounced|complained|opened/.test(type)) {
    return NextResponse.json({ ok: true, status_logged: logStatus || null, ignored: type || "unknown" });
  }
  // Resend payloads put the recipient(s) under data.to (array or string).
  const toRaw = evt?.data?.to;
  const emails: string[] = (Array.isArray(toRaw) ? toRaw : [toRaw])
    .filter(Boolean)
    .map((e: string) => String(e).toLowerCase());
  if (!emails.length) return NextResponse.json({ ok: true, no_recipients: true });

  const service = createServiceSupabase();

  // Opens: stamp the signal and stop — no suppression logic applies.
  if (/opened/.test(type)) {
    const stamp = { last_email_opened_at: new Date().toISOString() };
    try {
      await (service as any).from("client_links").update(stamp).in("client_email", emails);
      const { data: us } = await service.from("users").select("id").in("email", emails);
      const userIds = ((us as any[]) || []).map((u) => u.id);
      if (userIds.length) {
        const { data: cu } = await (service as any)
          .from("client_users")
          .select("client_link_id")
          .in("user_id", userIds);
        const linkIds = [...new Set(((cu as any[]) || []).map((m) => m.client_link_id))];
        if (linkIds.length) await (service as any).from("client_links").update(stamp).in("id", linkIds);
      }
    } catch {
      /* pre-migration-106 env — ignore */
    }
    return NextResponse.json({ ok: true, opened: emails.length });
  }

  const reason = type === "email.complained" ? "spam complaint" : "hard bounce";

  // Match by profile contact email directly...
  await service.from("client_links")
    .update({ email_hard_bounced: true, email_bounced_at: new Date().toISOString(), email_bounce_reason: reason } as any)
    .in("client_email", emails);

  // ...and by portal-user email (client_users → users.email).
  try {
    const { data: us } = await service.from("users").select("id").in("email", emails);
    const userIds = ((us as any[]) || []).map((u) => u.id);
    if (userIds.length) {
      const { data: cu } = await (service as any).from("client_users").select("client_link_id").in("user_id", userIds);
      const linkIds = [...new Set(((cu as any[]) || []).map((m) => m.client_link_id))];
      if (linkIds.length) {
        await service.from("client_links")
          .update({ email_hard_bounced: true, email_bounced_at: new Date().toISOString(), email_bounce_reason: reason } as any)
          .in("id", linkIds);
      }
    }
  } catch { /* portal match best-effort */ }

  return NextResponse.json({ ok: true, suppressed: emails.length });
}
