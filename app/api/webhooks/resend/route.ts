import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/resend — Resend event webhook.
 *
 * Two jobs:
 *  1. Per-email delivery status on client_email_log (matched by Resend message
 *     id): sent → delivered → opened → clicked, plus bounced/complained. Drives
 *     the status column on the "Pending Stripe Invites" panel so bookkeepers
 *     know whether an invite was opened/clicked before resending.
 *  2. Recipient-level signals on client_links: hard bounce / spam complaint →
 *     suppress the address (future bulk sends skip it); opened/clicked → stamp
 *     last_email_opened_at (the inbox-vs-spam signal for the never-logged-in
 *     view).
 *
 * Configure the Resend dashboard endpoint for email.delivered + email.opened +
 * email.clicked + email.bounced + email.complained, and enable open + click
 * tracking on the sending domain.
 */
export async function POST(request: Request) {
  const evt = await request.json().catch(() => ({} as any));
  const type = evt?.type as string | undefined;
  if (!type || !/bounced|complained|opened|clicked|delivered/.test(type)) {
    return NextResponse.json({ ok: true, ignored: type || "unknown" });
  }

  const service = createServiceSupabase();

  // (1) Per-email status on client_email_log, by Resend message id. Forward-only
  // via status guards so a late 'delivered' never clobbers 'opened'/'clicked'.
  // Column-tolerant: opened_at/clicked_at/delivered_at land with migration 107.
  const messageId = evt?.data?.email_id as string | undefined;
  if (messageId) {
    const nowIso = new Date().toISOString();
    try {
      if (/delivered/.test(type)) {
        await (service as any).from("client_email_log")
          .update({ status: "delivered", delivered_at: nowIso, updated_at: nowIso })
          .eq("provider_message_id", messageId).in("status", ["pending", "sent"]);
      } else if (/opened/.test(type)) {
        await (service as any).from("client_email_log")
          .update({ status: "opened", opened_at: nowIso, updated_at: nowIso })
          .eq("provider_message_id", messageId).in("status", ["pending", "sent", "delivered"]);
      } else if (/clicked/.test(type)) {
        await (service as any).from("client_email_log")
          .update({ status: "clicked", clicked_at: nowIso, updated_at: nowIso })
          .eq("provider_message_id", messageId);
      } else if (/bounced|complained/.test(type)) {
        await (service as any).from("client_email_log")
          .update({ status: type === "email.complained" ? "complained" : "bounced", updated_at: nowIso })
          .eq("provider_message_id", messageId);
      }
    } catch {
      /* pre-migration-107 (new columns) or pre-93 (no table) — ignore */
    }
  }

  // Delivered carries no recipient-level work beyond the log update above.
  if (/delivered/.test(type)) return NextResponse.json({ ok: true, delivered: !!messageId });

  // (2) Recipient-based signals. Resend puts recipient(s) under data.to.
  const toRaw = evt?.data?.to;
  const emails: string[] = (Array.isArray(toRaw) ? toRaw : [toRaw])
    .filter(Boolean)
    .map((e: string) => String(e).toLowerCase());
  if (!emails.length) return NextResponse.json({ ok: true, no_recipients: true, logged: !!messageId });

  // Opens/clicks: stamp the inbox signal and stop — no suppression logic applies.
  if (/opened|clicked/.test(type)) {
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
    return NextResponse.json({ ok: true, engaged: emails.length });
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
