import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse, after } from "next/server";
import { loadBulkRecipients } from "@/lib/bulk-email-recipients";
import {
  sendBulkEmails, wrapBrandedEmail, applyMergeFields, htmlToText,
  type EmailKind, type BulkRecipient,
} from "@/lib/bulk-email";
import { sendResendEmail } from "@/lib/client-comms";
import { renderUserSignature } from "@/lib/user-signature";
import { resolveFromEmail } from "@/lib/email-sender";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SUPPORT_REPLY = "admin@ironbooks.com";

/**
 * POST /api/admin/bulk-email/send  — admin/lead.
 *
 * Body: { subject, body_html, kind, client_ids[], test_email?, also_portal?,
 *         reply_to_mode? }
 *  - test_email  → sends ONE preview to that address (sample merge fields), no campaign.
 *  - otherwise   → creates a campaign, sends one personalized email per chosen
 *                  client in the background, records per-recipient status.
 *
 * Consent: bounced clients are always dropped; for kind 'normal', unsubscribed
 * clients are dropped too. 'operational' + 'resubscribe' reach everyone chosen.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users")
    .select("role, full_name, email, title, phone, booking_url, avatar_url")
    .eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Senior access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const subject = (body.subject || "").trim();
  const rawBody = (body.body_html || "").trim();
  const kind = (body.kind || "normal") as EmailKind;
  const replyMode = body.reply_to_mode === "support" ? "support" : "bookkeeper";
  const alsoPortal = body.also_portal === true;
  if (!subject || !rawBody) {
    return NextResponse.json({ error: "Subject and body are required" }, { status: 400 });
  }
  const appBaseUrl = new URL(request.url).origin;

  // Append the sender's branded signature when requested. The composer toggle
  // is authoritative for this send, so render even if their default is off.
  const a = (actor as any) || {};
  const signature = body.include_signature
    ? renderUserSignature({ full_name: a.full_name, email: a.email, title: a.title, phone: a.phone, booking_url: a.booking_url, avatar_url: a.avatar_url, signature_enabled: true })
    : "";
  const bodyHtml = rawBody + signature;

  // From header: show the sender's name, e.g. "Mike Gore-Hickman · Ironbooks
  // <noreply@mail.ironbooks.com>" — keeps the verified address, varies the
  // display name so the client sees a person, not a bare inbox.
  const baseFrom = resolveFromEmail(process.env.SUPPORT_FROM_EMAIL);
  const fromAddr = baseFrom.match(/<([^>]+)>/)?.[1] || baseFrom;
  const fromDisplay = `${(a.full_name || "Ironbooks").replace(/[<>]/g, "")} · Ironbooks <${fromAddr}>`;

  // Test send — single email, no campaign, no consent logic.
  if (body.test_email) {
    const sampleVars = { firstName: "Sample", businessName: "Sample Painting Co", loginEmail: "client@theircompany.com" };
    const html = wrapBrandedEmail({
      bodyHtml: applyMergeFields(bodyHtml, sampleVars),
      footerHtml: kind === "normal" ? "Unsubscribe link appears here in the real send." : null,
    });
    const ok = await sendResendEmail({
      to: [body.test_email],
      subject: `[TEST] ${applyMergeFields(subject, sampleVars)}`,
      text: htmlToText(bodyHtml),
      html,
      from: fromDisplay,
    });
    return NextResponse.json({ test: true, ok });
  }

  const clientIds: string[] = Array.isArray(body.client_ids) ? body.client_ids : [];
  if (!clientIds.length) return NextResponse.json({ error: "No recipients selected" }, { status: 400 });

  // Re-derive recipients server-side from the chosen ids (don't trust the client
  // for consent). Drop bounced always; drop unsubscribed for 'normal'.
  const all = await loadBulkRecipients(service);
  const chosen = new Set(clientIds);
  let recips = all.filter((r) => chosen.has(r.client_link_id) && r.email && !r.bounced);
  if (kind === "normal") recips = recips.filter((r) => r.subscribed);
  if (!recips.length) return NextResponse.json({ error: "No sendable recipients after consent/bounce checks" }, { status: 400 });

  // Reply-to: the assigned bookkeeper's email (so replies reach them), else support.
  const bkEmailById = new Map<string, string>();
  if (replyMode === "bookkeeper") {
    const bkIds = [...new Set(recips.map((r) => r.bookkeeper_id).filter(Boolean))] as string[];
    if (bkIds.length) {
      const { data: bks } = await service.from("users").select("id, email").in("id", bkIds);
      for (const b of ((bks as any[]) || [])) bkEmailById.set(b.id, b.email);
    }
  }

  // Create the campaign + pending recipient rows.
  const { data: campaign, error: cErr } = await service
    .from("bulk_email_campaigns")
    .insert({
      subject, body_html: rawBody, kind, reply_to_mode: replyMode,
      created_by: user.id, status: "sending", recipient_count: recips.length,
    } as any)
    .select("id")
    .single();
  if (cErr || !campaign) return NextResponse.json({ error: cErr?.message || "Campaign create failed" }, { status: 500 });
  const campaignId = (campaign as any).id as string;

  await service.from("bulk_email_recipients").insert(
    recips.map((r) => ({ campaign_id: campaignId, client_link_id: r.client_link_id, email: r.email, status: "pending" })) as any
  );

  const senderName = (actor as any)?.full_name || "Ironbooks";
  const recipients: BulkRecipient[] = recips.map((r) => ({
    clientLinkId: r.client_link_id,
    email: r.email!,
    firstName: r.first_name,
    businessName: r.client_name,
    loginEmail: r.login_email,
    replyTo: replyMode === "bookkeeper" ? (r.bookkeeper_id ? bkEmailById.get(r.bookkeeper_id) || SUPPORT_REPLY : SUPPORT_REPLY) : SUPPORT_REPLY,
  }));

  // Send in the background so the request returns immediately.
  after(async () => {
    const svc = createServiceSupabase();
    const { sent, failed } = await sendBulkEmails({
      recipients, subject, bodyHtml, kind, appBaseUrl, from: fromDisplay,
      onResult: async ({ clientLinkId, email, ok, error }) => {
        await svc.from("bulk_email_recipients")
          .update({ status: ok ? "sent" : "failed", error: error || null, sent_at: ok ? new Date().toISOString() : null } as any)
          .eq("campaign_id", campaignId).eq("client_link_id", clientLinkId);
        if (ok) {
          await svc.from("client_links").update({ last_bulk_emailed_at: new Date().toISOString() } as any).eq("id", clientLinkId);
          if (alsoPortal) {
            // Mirror as a one-way portal notification so it shows in their portal
            // (and a portal reply lands in the bookkeeper's Today inbox).
            try {
              await (svc as any).from("client_communications").insert({
                client_link_id: clientLinkId, direction: "to_client", kind: "notification",
                subject, body: htmlToText(applyMergeFields(rawBody, { firstName: null, businessName: null, loginEmail: email })),
                sender_user_id: user.id,
              });
            } catch { /* portal mirror best-effort */ }
          }
        }
      },
    });
    await svc.from("bulk_email_campaigns")
      .update({ status: "sent", sent_count: sent, failed_count: failed, sent_at: new Date().toISOString() } as any)
      .eq("id", campaignId);
  });

  return NextResponse.json({ campaign_id: campaignId, recipient_count: recips.length });
}
