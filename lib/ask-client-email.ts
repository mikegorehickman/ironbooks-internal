import { resolveClientContactEmails, sendResendEmailTracked } from "@/lib/client-comms";

/**
 * The single client-email delivery path.
 *
 * SNAP grew several near-identical "ask the client" senders (reclass questions,
 * P&L drill questions, statement/doc requests) that each re-implemented the same
 * four steps — resolve recipients → send via Resend (tracked) → log every
 * attempt to client_email_log → write an audit_log row. They drifted (different
 * error copy, different log columns). This helper is the one implementation;
 * every ask-client route delegates here so branding, logging, delivery proof and
 * audit are identical, and the unified email history (client_email_log) is
 * complete no matter which surface sent the mail.
 *
 * Returns a ready-to-serialize { status, body } so routes stay one-liners:
 *   const r = await deliverClientEmail({...}); return NextResponse.json(r.body, { status: r.status });
 */
export interface DeliverClientEmailParams {
  /** service-role Supabase client (createServiceSupabase()). */
  service: any;
  clientLinkId: string;
  clientName?: string | null;
  /** auth user id of the sender (client_email_log.created_by, audit user_id). */
  userId: string;
  actor: { email?: string | null; full_name?: string | null } | null;
  subject: string;
  html?: string;
  text?: string;
  /** client_email_log.email_type discriminator, e.g. "ask_client_txns". */
  emailType: string;
  /** audit_log.event_type; omit to skip the audit row. */
  auditEventType?: string;
  /** extra fields merged into the audit_log request_payload. */
  auditExtra?: Record<string, any>;
  /** override the 422 "no email on file" copy to preserve a surface's wording. */
  noRecipientMessage?: string;
  /** override the 502 "didn't send" prefix copy. */
  sendFailedMessage?: (resendError: string) => string;
}

export interface DeliverClientEmailResult {
  ok: boolean;
  status: number;
  body: any;
}

export async function deliverClientEmail(
  p: DeliverClientEmailParams
): Promise<DeliverClientEmailResult> {
  const subject = (p.subject || "").trim().slice(0, 300);
  const html = (p.html || "").trim();
  const text = (p.text || "").trim();
  if (!subject || (!html && !text)) {
    return {
      ok: false,
      status: 400,
      body: { error: "Subject and email body are required" },
    };
  }

  const recipients = await resolveClientContactEmails(p.service, p.clientLinkId);
  if (recipients.length === 0) {
    return {
      ok: false,
      status: 422,
      body: {
        error:
          p.noRecipientMessage ||
          "No email on file for this client — add a portal user or a contact email first, or copy the draft and send it manually.",
        reason: "no_recipient",
      },
    };
  }

  const replyTo = p.actor?.email || "admin@ironbooks.com";
  const result = await sendResendEmailTracked({ to: recipients, subject, html, text, replyTo });

  // Log every attempt (the Resend webhook later flips status to
  // delivered/opened/bounced by matching provider_message_id).
  const nowIso = new Date().toISOString();
  try {
    await p.service.from("client_email_log").insert(
      recipients.map((addr: string) => ({
        client_link_id: p.clientLinkId,
        to_address: addr,
        subject,
        email_type: p.emailType,
        status: result.ok ? "sent" : "failed",
        provider_message_id: result.messageId || null,
        error: result.ok ? null : result.error || "unknown",
        created_by: p.userId,
        ts: nowIso,
      }))
    );
  } catch (e: any) {
    console.warn(`[ask-client-email:${p.emailType}] client_email_log insert failed: ${e?.message}`);
  }

  if (!result.ok) {
    const msg = p.sendFailedMessage
      ? p.sendFailedMessage(result.error || "Resend rejected the request")
      : `Email didn't send — ${result.error || "Resend rejected the request"}. Fix the issue or copy the draft and send it manually.`;
    return { ok: false, status: 502, body: { error: msg, reason: "send_failed" } };
  }

  if (p.auditEventType) {
    await p.service.from("audit_log").insert({
      event_type: p.auditEventType,
      user_id: p.userId,
      request_payload: {
        client_link_id: p.clientLinkId,
        client_name: p.clientName || null,
        sent_by: p.actor?.full_name || p.actor?.email || p.userId,
        recipients,
        subject,
        provider_message_id: result.messageId || null,
        sent_at: nowIso,
        ...(p.auditExtra || {}),
      } as any,
    });
  }

  return {
    ok: true,
    status: 200,
    body: { ok: true, sent: true, recipients, message_id: result.messageId || null },
  };
}
