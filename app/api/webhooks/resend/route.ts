import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/resend — Resend event webhook.
 *
 * On a hard bounce or spam complaint we suppress that address: flag the
 * matching client so future bulk sends skip it. On email.opened we stamp
 * last_email_opened_at — the inbox-vs-spam signal for the Admin → Users
 * never-logged-in view (an address that never opens anything is probably
 * landing in spam). Configure the endpoint in the Resend dashboard for
 * email.bounced + email.complained + email.opened, and enable open
 * tracking on the sending domain.
 */
export async function POST(request: Request) {
  const evt = await request.json().catch(() => ({} as any));
  const type = evt?.type as string | undefined;
  if (!type || !/bounced|complained|opened/.test(type)) {
    return NextResponse.json({ ok: true, ignored: type || "unknown" });
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
