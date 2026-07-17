/**
 * Client communications — shared types + helpers for the portal Messages
 * feature (migration 58 + the private `client-uploads` Storage bucket).
 *
 * Surfaces:
 *   - /portal/messages           client thread + statement uploads
 *   - /clients/[id]/messages     bookkeeper side of the same thread
 *   - /today inbound widget      unread client uploads across clients
 *
 * The client_communications table is not in the generated database
 * types yet — callers use `(service as any).from("client_communications")`
 * like other recently-added tables.
 */

import { resolveFromEmail } from "./email-sender";

export const CLIENT_UPLOADS_BUCKET = "client-uploads";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // keep in sync with bucket fileSizeLimit

/**
 * Extension allowlist for client uploads. Covers what painting
 * contractors actually send (bank/CC statements, receipts, exports):
 * documents, spreadsheets, images, bank-export formats, archives.
 * Blocks active content (html/svg/js/exe).
 */
export const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  "pdf", "csv", "xls", "xlsx", "txt",
  "png", "jpg", "jpeg", "heic", "webp",
  "ofx", "qfx", "qbo",
  "doc", "docx", "zip",
]);

export interface CommAttachment {
  /** Storage path inside CLIENT_UPLOADS_BUCKET: `<client_link_id>/<yyyy-mm>/<ts>-<name>` */
  path: string;
  name: string;
  size: number;
  content_type: string;
}

export interface ClientCommunication {
  id: string;
  client_link_id: string;
  sender_user_id: string | null;
  direction: "to_client" | "from_client";
  kind: "message" | "notification";
  subject: string | null;
  body: string | null;
  attachments: CommAttachment[];
  read_at: string | null;
  read_by: string | null;
  created_at: string;
  /** Enriched server-side where useful — not a DB column */
  sender_name?: string | null;
}

/**
 * Strip path separators + control chars so a filename is safe to embed
 * in a storage key. Keeps the extension recognizable for the allowlist.
 */
export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[/\\]/g, "_")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140) || "file"
  );
}

export function fileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}

/**
 * Validate upload metadata before issuing a signed upload URL.
 * Returns an error string, or null when acceptable.
 */
export function validateUploadMeta(meta: { name?: string; size?: number }): string | null {
  if (!meta.name || typeof meta.name !== "string") return "File name is required";
  const ext = fileExtension(meta.name);
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    return `File type ".${ext || "?"}" isn't supported. Accepted: PDF, CSV, Excel, images, bank exports (OFX/QFX/QBO), Word, ZIP.`;
  }
  if (typeof meta.size !== "number" || !Number.isFinite(meta.size) || meta.size <= 0) {
    return "File size is required";
  }
  if (meta.size > MAX_UPLOAD_BYTES) {
    return `File is too large (max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`;
  }
  return null;
}

/**
 * Validate an attachments array submitted with a client message. Every
 * path must live under the client's own prefix — this is the ownership
 * boundary that stops a client referencing another client's files.
 */
export function validateAttachments(
  attachments: unknown,
  clientLinkId: string
): { ok: true; attachments: CommAttachment[] } | { ok: false; error: string } {
  if (!Array.isArray(attachments)) return { ok: false, error: "attachments must be an array" };
  if (attachments.length > 10) return { ok: false, error: "Max 10 attachments per message" };
  const clean: CommAttachment[] = [];
  for (const a of attachments) {
    if (!a || typeof a.path !== "string" || typeof a.name !== "string") {
      return { ok: false, error: "Malformed attachment entry" };
    }
    if (!a.path.startsWith(`${clientLinkId}/`) || a.path.includes("..")) {
      return { ok: false, error: "Attachment path is not yours" };
    }
    clean.push({
      path: a.path,
      name: sanitizeFilename(a.name),
      size: typeof a.size === "number" ? a.size : 0,
      content_type: typeof a.content_type === "string" ? a.content_type.slice(0, 100) : "",
    });
  }
  return { ok: true, attachments: clean };
}

/**
 * Best-effort email via Resend. Mirrors the /api/portal/support pattern
 * (raw fetch, no SDK). Returns true when Resend accepted the send; false
 * on any failure — callers treat email as a notification nicety, never
 * a delivery guarantee (the DB row is the source of truth).
 */
export async function sendResendEmail(params: {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** Override the From header (e.g. "Mike · Ironbooks <noreply@mail.ironbooks.com>").
   *  Must keep a verified-domain address — only vary the display name. */
  from?: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[client-comms] RESEND_API_KEY not set — skipped email "${params.subject}"`);
    return false;
  }
  const fromEmail = params.from || resolveFromEmail(process.env.SUPPORT_FROM_EMAIL);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: params.to,
        reply_to: params.replyTo,
        subject: params.subject,
        text: params.text,
        html: params.html,
      }),
    });
    if (!res.ok) {
      console.error(`[client-comms] Resend ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error(`[client-comms] Resend network error: ${err?.message}`);
    return false;
  }
}

/**
 * Same send as sendResendEmail, but RETURNS the Resend message id + error
 * instead of a bare boolean, so callers can log delivery status to
 * client_email_log and let the Resend webhook flip it to delivered/bounced
 * later (matched on the message id). Single recipient — callers that fan out
 * to multiple addresses call this per address so each gets its own log row.
 */
export async function sendResendEmailTracked(params: {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  from?: string;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY not set" };
  }
  const fromEmail = params.from || resolveFromEmail(process.env.SUPPORT_FROM_EMAIL);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: Array.isArray(params.to) ? params.to : [params.to],
        reply_to: params.replyTo,
        subject: params.subject,
        text: params.text,
        html: params.html,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `Resend ${res.status}: ${await res.text()}` };
    }
    const body = await res.json();
    return { ok: true, messageId: body?.id as string | undefined };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Resend network error" };
  }
}

/**
 * Branded portal-invite / magic-link email.
 *
 * The portal invite used to ride Supabase's built-in auth email (the bare
 * default "Invite user" / "Magic Link" template configured in the Supabase
 * dashboard). That's the first thing a brand-new client ever sees from us, and
 * it looked nothing like SNAP. Instead, the invite route now GENERATES the
 * sign-in link (admin.generateLink, which returns the link WITHOUT sending an
 * email) and hands it here so we wrap it in the SNAP brand and send it
 * ourselves via Resend — the same branded sender every other client email
 * already uses. Best-effort: returns sendResendEmail's boolean so the caller
 * can warn the admin if the link was generated but the email didn't go out.
 */
export async function sendPortalInviteEmail(params: {
  to: string;
  fullName: string;
  clientName: string;
  /** The Supabase action_link from admin.generateLink — clicking it signs the
   *  client in via /auth/callback. */
  actionLink: string;
  /** Resend of an existing client's link vs. a first-time invite — only changes
   *  the wording. */
  isResend?: boolean;
}): Promise<boolean> {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const firstName = (params.fullName || "").trim().split(/\s+/)[0] || "there";
  const heading = params.isResend
    ? "Here's your new sign-in link"
    : "You're invited to your Ironbooks portal";
  const introHtml = params.isResend
    ? `Here's a fresh, secure link to sign in to your Ironbooks portal for <strong>${esc(
        params.clientName
      )}</strong>.`
    : `Your Ironbooks bookkeeping team has set up a secure online portal for <strong>${esc(
        params.clientName
      )}</strong> — Advancing Financial Literacy In The Trades. Set up your access and take a look whenever you like.`;
  const cta = params.isResend ? "Sign in to your portal" : "Set up your access";

  const text = [
    `Hi ${firstName},`,
    ``,
    params.isResend
      ? `Here's a fresh link to sign in to your Ironbooks portal for ${params.clientName}.`
      : `Your Ironbooks bookkeeping team has set up a secure online portal for ${params.clientName} — Advancing Financial Literacy In The Trades.`,
    ``,
    `${cta}: ${params.actionLink}`,
    ``,
    `This link is personal to you — please don't forward it, and it expires after a little while for your security. If it stops working, ask your bookkeeper to re-send it.`,
  ].join("\n");

  const html = `
<div style="background:#F4F5F7;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E5E7EB;">
    <div style="background:#0F1F2E;padding:22px 28px;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;">Ironbooks</div>
      <div style="color:#8CD3CC;font-size:12px;margin-top:2px;">Advancing Financial Literacy In The Trades</div>
    </div>
    <div style="padding:28px;">
      <h2 style="margin:0 0 14px;color:#0F1F2E;font-size:18px;">${heading}</h2>
      <p style="color:#33414E;font-size:14px;line-height:1.6;margin:0 0 8px;">Hi ${esc(
        firstName
      )},</p>
      <p style="color:#33414E;font-size:14px;line-height:1.6;margin:0 0 22px;">${introHtml}</p>
      <a href="${params.actionLink}" style="display:inline-block;background:#1A9B8F;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:12px 26px;border-radius:8px;">${cta}</a>
      <p style="color:#8A94A0;font-size:12px;margin:24px 0 0;line-height:1.55;">
        This link is personal to you — please don't forward it, and it expires after a little while for your security.<br/>
        If the button doesn't work, copy and paste this into your browser:<br/>
        <a href="${params.actionLink}" style="color:#1A9B8F;word-break:break-all;">${params.actionLink}</a>
      </p>
    </div>
  </div>
  <div style="max-width:560px;margin:12px auto 0;text-align:center;color:#9AA3AD;font-size:11px;">
    Sent by your Ironbooks bookkeeping team for ${esc(params.clientName)}.
  </div>
</div>`;

  return sendResendEmail({
    to: [params.to],
    replyTo: process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com",
    subject: params.isResend
      ? "Your Ironbooks portal sign-in link"
      : "You're invited to your Ironbooks portal",
    text,
    html,
  });
}

export type MessageEmailDelivery =
  | { sent: true; recipients: number; messageId?: string | null; logId?: string | null }
  | { sent: false; reason: "no_portal_user" | "no_active_email" | "send_failed" | "error" };

/**
 * Look up the active portal users for a client and email them that a new
 * message/notification is waiting. Best-effort — failures only log — but
 * the outcome is RETURNED so the sending bookkeeper can be warned
 * immediately when the client won't get an email (no portal login,
 * Resend failure).
 */
export async function emailPortalUsersAboutMessage(
  service: any,
  params: {
    clientLinkId: string;
    clientName: string;
    kind: "message" | "notification";
    subject: string | null;
    body: string;
    portalOrigin: string;
    /** How much of the body to include in the email (default 400 chars).
     *  Batched sends (e.g. ask-client transaction lists) pass a larger
     *  budget so the whole list survives into the email. */
    snippetChars?: number;
    /** Portal path the email's CTA links to (default /portal/messages). */
    portalPath?: string;
    /** CTA button label (default "Log in to reply"). */
    ctaLabel?: string;
    /**
     * When set, the send is TRACKED: it goes through the Resend id-returning
     * path and a client_email_log row is written (so the Resend webhook can
     * flip it to delivered/opened, and the UI can show sent status + pull the
     * actual email back from Resend). Off by default — every other caller is
     * unchanged.
     */
    track?: { emailType: string; createdBy?: string | null };
  }
): Promise<MessageEmailDelivery> {
  try {
    const { data: mappings } = await service
      .from("client_users")
      .select("user_id")
      .eq("client_link_id", params.clientLinkId)
      .eq("active", true);
    const userIds = ((mappings as any[]) || []).map((m) => m.user_id).filter(Boolean);
    if (userIds.length === 0) return { sent: false, reason: "no_portal_user" };

    const { data: portalUsers } = await service
      .from("users")
      .select("email")
      .in("id", userIds)
      .eq("is_active", true);
    const emails = ((portalUsers as any[]) || []).map((u) => u.email).filter(Boolean);
    if (emails.length === 0) return { sent: false, reason: "no_active_email" };

    const noun = params.kind === "notification" ? "notification" : "message";
    const snippetMax = params.snippetChars ?? 400;
    const snippet =
      params.body.length > snippetMax ? `${params.body.slice(0, snippetMax)}…` : params.body;
    const link = `${params.portalOrigin}${params.portalPath || "/portal/messages"}`;
    const cta = params.ctaLabel || "Log in to reply";

    // Plain-text fallback for clients whose mail app blocks HTML
    const text = [
      `Ironbooks has sent you a ${noun} in SNAP!`,
      ``,
      snippet,
      ``,
      `${cta}: ${link}`,
      ``,
      `Do not reply to this email — replies aren't monitored. Use the portal to respond.`,
    ].join("\n");

    // Branded HTML card — inline styles only (email clients strip <style>)
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>");
    const html = `
<div style="background:#F4F5F7;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E5E7EB;">
    <div style="background:#0F1F2E;padding:22px 28px;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;">Ironbooks</div>
      <div style="color:#8CD3CC;font-size:12px;margin-top:2px;">Advancing Financial Literacy In The Trades</div>
    </div>
    <div style="padding:28px;">
      <h2 style="margin:0 0 6px;color:#0F1F2E;font-size:18px;">Ironbooks has sent you a ${noun} in SNAP!</h2>
      ${params.subject ? `<div style="color:#0F1F2E;font-size:14px;font-weight:600;margin:0 0 12px;">${esc(params.subject)}</div>` : ""}
      <div style="background:#F8FAFA;border:1px solid #E5E7EB;border-left:3px solid #1A9B8F;border-radius:8px;padding:14px 16px;margin:14px 0 22px;color:#33414E;font-size:14px;line-height:1.55;">
        ${esc(snippet)}
      </div>
      <a href="${link}" style="display:inline-block;background:#1A9B8F;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:11px 22px;border-radius:8px;">${cta}</a>
      <p style="color:#8A94A0;font-size:12px;margin:24px 0 0;line-height:1.5;">
        Do not reply to this email — replies aren't monitored.<br/>
        Read and respond securely in your portal: <a href="${link}" style="color:#1A9B8F;">${link}</a>
      </p>
    </div>
  </div>
  <div style="max-width:560px;margin:12px auto 0;text-align:center;color:#9AA3AD;font-size:11px;">
    Sent to you by your Ironbooks bookkeeping team for ${esc(params.clientName)}.
  </div>
</div>`;

    const emailSubject = `Ironbooks sent you a ${noun} in SNAP${params.subject ? ` — ${params.subject}` : ""}`;
    const replyTo = process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com";

    // Tracked path: capture the Resend message id + write client_email_log so
    // the send is visible + syncable from Resend later.
    if (params.track) {
      const sent = await sendResendEmailTracked({ to: emails, replyTo, subject: emailSubject, text, html });
      let logId: string | null = null;
      try {
        const { data: logRow } = await service
          .from("client_email_log")
          .insert({
            client_link_id: params.clientLinkId,
            to_address: emails.join(", "),
            email_type: params.track.emailType,
            subject: emailSubject,
            status: sent.ok ? "sent" : "failed",
            provider_message_id: sent.messageId ?? null,
            error: sent.ok ? null : sent.error ?? null,
            created_by: params.track.createdBy ?? null,
          })
          .select("id")
          .single();
        logId = (logRow as any)?.id ?? null;
      } catch (e: any) {
        console.warn(`[client-comms] client_email_log insert failed: ${e?.message}`);
      }
      return sent.ok
        ? { sent: true, recipients: emails.length, messageId: sent.messageId ?? null, logId }
        : { sent: false, reason: "send_failed" };
    }

    const ok = await sendResendEmail({
      to: emails,
      // Safety net: the email says "do not reply", but if someone does
      // anyway it lands in the monitored support inbox instead of bouncing.
      replyTo,
      subject: emailSubject,
      text,
      html,
    });
    return ok ? { sent: true, recipients: emails.length } : { sent: false, reason: "send_failed" };
  } catch (err: any) {
    console.error(`[client-comms] emailPortalUsersAboutMessage failed: ${err?.message}`);
    return { sent: false, reason: "error" };
  }
}

/**
 * Resolve the email address(es) to use when emailing a client DIRECTLY
 * (not the portal-notification path — this is for branded emails the
 * client answers by replying, e.g. the "questions about transactions"
 * cleanup email).
 *
 * Order of preference:
 *   1. Active portal-user emails (client_users → users) — the people who
 *      actually field questions.
 *   2. client_links.client_email — the business email captured from QBO
 *      CompanyInfo at connect time. Fallback for clients who don't have a
 *      portal login yet.
 *
 * Deduplicated, lowercased. Empty array = no address on file (caller
 * should fall back to the copy-paste-into-Double workflow).
 */
export async function resolveClientContactEmails(
  service: any,
  clientLinkId: string
): Promise<string[]> {
  const out = new Set<string>();
  try {
    const { data: mappings } = await service
      .from("client_users")
      .select("user_id")
      .eq("client_link_id", clientLinkId)
      .eq("active", true);
    const userIds = ((mappings as any[]) || []).map((m) => m.user_id).filter(Boolean);
    if (userIds.length > 0) {
      const { data: portalUsers } = await service
        .from("users")
        .select("email")
        .in("id", userIds)
        .eq("is_active", true);
      for (const u of (portalUsers as any[]) || []) {
        if (u.email) out.add(String(u.email).trim().toLowerCase());
      }
    }
  } catch (err: any) {
    console.warn(`[client-comms] portal-user email lookup failed: ${err?.message}`);
  }

  if (out.size === 0) {
    try {
      const { data: cl } = await service
        .from("client_links")
        .select("client_email")
        .eq("id", clientLinkId)
        .single();
      const e = (cl as any)?.client_email;
      if (e) out.add(String(e).trim().toLowerCase());
    } catch (err: any) {
      console.warn(`[client-comms] client_links email lookup failed: ${err?.message}`);
    }
  }

  return [...out];
}
