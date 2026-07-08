/**
 * Send a Stripe connection-request email to a client — the shared engine behind
 * the StripeConnectModal's "Send email" button (and, once v2 lands, the
 * reminder cron + Today-task "Resend connect link" button).
 *
 * Unlike the legacy generate-link route (which only mints a token for the
 * bookkeeper to copy/paste), this mints a fresh token AND emails the client
 * directly via Resend, logs the send to client_email_log, and stamps the
 * automated-reminder clock on client_links.
 *
 * Schema-tolerant on purpose: client_email_log and the stripe_connect_*
 * reminder-clock columns arrive with migration 93 — until it's applied those
 * writes fail silently (supabase-js returns the error, never throws) and the
 * send itself still goes out. client_links is read with select("*") so a
 * not-yet-migrated column can never 400 the whole request.
 */

import { generateConnectToken } from "@/lib/stripe-oauth";
import {
  resolveClientContactEmails,
  sendResendEmailTracked,
} from "@/lib/client-comms";
import { buildStripeConnectEmail } from "@/lib/stripe-connect-email";

export interface SendStripeRequestResult {
  ok: boolean;
  sent: boolean;
  /** number of addresses the email was accepted for */
  recipients: number;
  addresses: string[];
  /** true when there's no usable email on file — caller should prompt the
   *  bookkeeper to find/enter one (passed back as overrideEmail). */
  noAddress: boolean;
  url?: string;
  token?: string;
  expiresAt?: string;
  error?: string;
}

export async function sendStripeConnectionRequest(
  service: any,
  params: {
    clientLinkId: string;
    /** bookkeeper user id for the log + audit; null for the cron. */
    createdByUserId: string | null;
    /** softer follow-up wording + increments the reminder counter. */
    isReminder?: boolean;
    /** when the bookkeeper supplies an address (no email on file), send here AND
     *  persist it to client_links.client_email so the profile is updated. */
    overrideEmail?: string | null;
  }
): Promise<SendStripeRequestResult> {
  const { clientLinkId, createdByUserId, isReminder = false, overrideEmail } = params;

  const { data: cl } = await service
    .from("client_links")
    .select("*")
    .eq("id", clientLinkId)
    .single();

  if (!cl) return { ok: false, sent: false, recipients: 0, addresses: [], noAddress: false, error: "Client not found" };
  if (cl.stripe_connection_status === "connected") {
    return { ok: false, sent: false, recipients: 0, addresses: [], noAddress: false, error: "Stripe is already connected for this client." };
  }

  // Resolve where to send. An explicit override wins and is persisted back to
  // the client profile (the "find + add the address" path).
  let addresses: string[] = [];
  const override = (overrideEmail || "").trim().toLowerCase();
  if (override) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(override)) {
      return { ok: false, sent: false, recipients: 0, addresses: [], noAddress: true, error: "That doesn't look like a valid email address." };
    }
    addresses = [override];
    await service.from("client_links").update({ client_email: override } as any).eq("id", clientLinkId);
  } else {
    if (cl.email_hard_bounced) {
      // The address on file previously hard-bounced — don't keep emailing a dead box.
      return { ok: false, sent: false, recipients: 0, addresses: [], noAddress: true, error: "The email on file previously bounced — enter a new address." };
    }
    addresses = await resolveClientContactEmails(service, clientLinkId);
  }

  if (addresses.length === 0) {
    return { ok: false, sent: false, recipients: 0, addresses: [], noAddress: true };
  }

  // Mint a FRESH token every send — reminders run past the 7-day expiry, so an
  // old token would be dead by the time the client clicks.
  const token = generateConnectToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { error: tokErr } = await service
    .from("stripe_connect_tokens")
    .insert({ token, client_link_id: clientLinkId, created_by: createdByUserId, expires_at: expiresAt } as any);
  if (tokErr) {
    return { ok: false, sent: false, recipients: 0, addresses, noAddress: false, error: tokErr.message };
  }

  await service.from("client_links").update({ stripe_connection_status: "pending" } as any).eq("id", clientLinkId);

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://internal.ironbooks.com";
  const url = `${baseUrl}/stripe-connect/${token}`;
  // client_name is the BUSINESS name ("RocketPainter Kingston") — greet the
  // human. Prefer the contact's first name, fall back to the first token of the
  // business name only if we have nothing better.
  const firstName =
    (cl.contact_first_name || "").trim() ||
    (cl.client_name || "").split(" ")[0] ||
    "there";
  const { html, text } = buildStripeConnectEmail(firstName, url, cl.client_name, { isReminder });
  const subject = isReminder
    ? `Reminder: connect Stripe so we can finish your books — ${cl.client_name}`
    : `Connect Stripe so we can reconcile your books — ${cl.client_name}`;

  let okCount = 0;
  for (const addr of addresses) {
    const r = await sendResendEmailTracked({
      to: addr,
      subject,
      text,
      html,
      replyTo: process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com",
    });
    if (r.ok) okCount++;
    await service.from("client_email_log").insert({
      client_link_id: clientLinkId,
      to_address: addr,
      email_type: "stripe_connect",
      subject,
      status: r.ok ? "sent" : "failed",
      provider_message_id: r.messageId ?? null,
      error: r.ok ? null : r.error ?? null,
      created_by: createdByUserId,
    } as any);
  }

  // Also drop a notification into the client's portal inbox (only if the email
  // actually went out) so the ask shows up there too. No second email.
  if (okCount > 0) {
    try {
      await service.from("client_communications").insert({
        client_link_id: clientLinkId,
        sender_user_id: createdByUserId,
        direction: "to_client",
        kind: "notification",
        subject: `Connect Stripe for ${cl.client_name}`.slice(0, 200),
        body: `To finish reconciling your books, please connect your Stripe account using the secure link we just emailed you. It only takes about 30 seconds. If you can't find the email, just reply here and we'll resend it.`,
      } as any);
    } catch (e: any) {
      console.warn(`[stripe-connection-request] portal message insert failed: ${e?.message}`);
    }
  }

  // Stamp the automated-reminder clock. First send seeds requested_at; reminders
  // bump the counter. last_reminder_at always = now so the cron's 3-day cadence
  // counts from the most recent email.
  const nowIso = new Date().toISOString();
  await service
    .from("client_links")
    .update({
      stripe_connect_requested_at: cl.stripe_connect_requested_at || nowIso,
      stripe_connect_last_reminder_at: nowIso,
      stripe_connect_reminder_count: isReminder
        ? (cl.stripe_connect_reminder_count || 0) + 1
        : cl.stripe_connect_reminder_count || 0,
    } as any)
    .eq("id", clientLinkId);

  await service.from("audit_log").insert({
    user_id: createdByUserId,
    event_type: "stripe_connect_request_sent",
    request_payload: {
      message: `Stripe connect ${isReminder ? "reminder" : "request"} emailed for ${cl.client_name}`,
      client_link_id: clientLinkId,
      recipients: addresses,
      sent: okCount,
    } as any,
  });

  return {
    ok: okCount > 0,
    sent: okCount > 0,
    recipients: okCount,
    addresses,
    noAddress: false,
    url,
    token,
    expiresAt,
    error: okCount === 0 ? "Email could not be sent (Resend rejected the send)." : undefined,
  };
}
