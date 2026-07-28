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
import {
  renderEmailShell,
  emailParagraph,
  emailTickList,
  emailQuote,
  escapeHtml,
  linkFooter,
  EMAIL_BRAND,
} from "./email-shell";

/**
 * Days we TELL the client the link lasts.
 *
 * Deliberately shorter than the real ACTIVATION_TTL_DAYS (7) in
 * lib/portal-invite.ts. Stating 3 creates a reason to act now, while the link
 * actually keeps working for 7 — so the urgency is real but nobody gets locked
 * out on day four. That direction is the safe one: the promise can only be
 * over-delivered, never broken.
 *
 * The invariant is STATED <= ACTUAL, and it must never invert. Telling someone
 * a link lasts longer than it does is the small lie that costs a login — which
 * matters doubly here, because this email exists to rescue clients who already
 * couldn't sign in. Enforced in scripts/test-portal-invite-email.ts, which can
 * import both numbers (the test isn't part of the import cycle that stops this
 * module reading ACTIVATION_TTL_DAYS directly).
 */
export const STATED_LINK_DAYS = 3;
const ACTIVATION_TTL_DAYS_TEXT = `${STATED_LINK_DAYS} days`;

/**
 * "Lisa at Ironbooks <noreply@mail.ironbooks.com>" — a From line that reads as a
 * note from their bookkeeper rather than a system notification.
 *
 * resolveFromEmail returns a FULL header ("Ironbooks <addr>"), not a bare
 * address, so the address has to be unwrapped first. Wrapping the whole thing
 * produced `Lisa at Ironbooks <Ironbooks <addr>>` — nested angle brackets, which
 * is a malformed header. Caught by rendering the email rather than reading it.
 *
 * Goes through resolveFromEmail rather than a hardcoded domain so its
 * sandbox-sender guard still applies.
 */
function personalFrom(firstName: string): string {
  const resolved = resolveFromEmail(process.env.SUPPORT_FROM_EMAIL);
  const address = resolved.match(/<([^>]+)>/)?.[1] || resolved;
  return `${firstName} at Ironbooks <${address}>`;
}

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
  /**
   * Inbound message handled — replied to, or explicitly dismissed as needing
   * no reply (migration 144). This, NOT read_at, is what every staff
   * attention surface filters on. Opening a thread marks rows read without
   * dismissing them, so "I glanced at it" no longer wipes it off Home.
   */
  dismissed_at: string | null;
  dismissed_by: string | null;
  created_at: string;
  /** Enriched server-side where useful — not a DB column */
  sender_name?: string | null;
  /** Enriched server-side: who dismissed it, for the thread's Dismissed tag */
  dismissed_by_name?: string | null;
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
  /** Resend of an existing client's link vs. a first-time invite. */
  isResend?: boolean;
  /** Bookkeeper's first name, when known — a note from a person outperforms a
   *  note from a system, and these clients know their bookkeeper by name. */
  bookkeeperName?: string | null;
}): Promise<boolean> {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const firstName = (params.fullName || "").trim().split(/\s+/)[0] || "there";
  const client = esc(params.clientName);
  const bk = (params.bookkeeperName || "").trim().split(/\s+/)[0];

  // ── What actually goes in the email ──────────────────────────────────────
  //
  // The old version was a link-delivery mechanism: "here's a fresh, secure link
  // to sign in". Accurate, and no reason on earth for a painting contractor to
  // stop what they're doing and click it. Every line below either tells them
  // what is waiting or removes a reason not to bother.
  //
  // The three items are real portal pages (Profit & Loss, Who owes you, Ask the
  // AI), not aspirational copy — promising a feature that isn't there is how you
  // teach someone to ignore your emails.
  // NOTE: deliberately makes NO claim about how current the books are. We can't
  // guarantee that at send time, and a client who logs in expecting a finished
  // month and finds work in progress trusts the next email less. The pull is the
  // value that IS always true: the tools, the learning, the ability to ask.
  const subject = params.isResend
    ? `${firstName}, a clearer picture of your numbers is waiting`
    : `${firstName}, your Ironbooks portal is open`;

  // Preheader: the grey line after the subject in most inboxes. Left unset it
  // leaks whatever the HTML starts with, which looks broken.
  const preheader = params.isResend
    ? `See where your money goes, what you're owed, and how to lift your margins. One tap, no password.`
    : `See where your money goes, what you're owed, and how to lift your margins. One tap, no password.`;

  const openingLine = params.isResend
    ? `Your last sign-in link expired, so here's a fresh one. There's a lot waiting for you inside &mdash; everything we track for <strong>${client}</strong>, plus the tools to make sense of it.`
    : `Your Ironbooks team has set up a home for everything we track for <strong>${client}</strong> &mdash; and the tools to help you read it, question it, and make more money from it.`;

  const cta = params.isResend ? "Open my books" : "Open my books";

  // Every line describes something that EXISTS in the portal and is true
  // regardless of where this month's bookkeeping has got to. No freshness claims.
  const BULLETS: Array<[string, string]> = [
    ["See where your money actually goes", "Profit and loss for any month, in plain language — not accountant-speak."],
    ["Know what you're owed", "Every unpaid invoice in one place, oldest first, so nothing slips."],
    ["Learn the numbers that move profit", "Short, practical lessons written for trades — margins, pricing, cash flow."],
    ["Ask us anything", "Type a question about your business and get a straight answer back."],
  ];

  const signoff = bk
    ? `${esc(bk)} and the Ironbooks team`
    : `Your Ironbooks team`;

  // ── Plain-text part ──────────────────────────────────────────────────────
  // Written to stand on its own. Some clients read text-only, and a text part
  // that's obviously a stripped-down HTML email reads like spam.
  const text = [
    `Hi ${firstName},`,
    ``,
    params.isResend
      ? `Your last sign-in link expired, so here's a fresh one. There's a lot waiting for you inside — everything we track for ${params.clientName}, plus the tools to make sense of it.`
      : `Your Ironbooks team has set up a home for everything we track for ${params.clientName} — and the tools to help you read it, question it, and make more money from it.`,
    ``,
    ...BULLETS.map(([t, d]) => `• ${t} — ${d}`),
    ``,
    `${cta}: ${params.actionLink}`,
    ``,
    `One tap and you're in — there's no password to remember. This link expires in ${ACTIVATION_TTL_DAYS_TEXT} and is just for you, so please don't forward it.`,
    ``,
    `If it's stopped working, reply to this email and we'll send another straight away.`,
    ``,
    `— ${bk ? `${bk} and the Ironbooks team` : "Your Ironbooks team"}`,
  ].join("\n");

  const bulletsHtml = BULLETS.map(
    ([t, d]) => `
        <tr>
          <td style="padding:0 0 14px;vertical-align:top;width:26px;">
            <div style="width:18px;height:18px;border-radius:50%;background:#E6F1F0;color:#2F6F6C;font-size:11px;font-weight:700;line-height:18px;text-align:center;">&#10003;</div>
          </td>
          <td style="padding:0 0 14px;vertical-align:top;">
            <div style="color:#152F46;font-size:14px;font-weight:700;line-height:1.4;">${t}</div>
            <div style="color:#5A6875;font-size:13px;line-height:1.5;margin-top:2px;">${d}</div>
          </td>
        </tr>`
  ).join("");

  const html = `
<div style="background:#F5F7F9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #E3E8ED;">

    <div style="background:#152F46;padding:24px 28px;">
      <div style="color:#ffffff;font-size:19px;font-weight:700;letter-spacing:-0.01em;">Ironbooks</div>
      <div style="color:#8CD3CC;font-size:12px;margin-top:3px;">Advancing Financial Literacy In The Trades</div>
    </div>

    <div style="padding:30px 28px 8px;">
      <h1 style="margin:0 0 16px;color:#152F46;font-size:21px;line-height:1.3;font-weight:700;">
        ${params.isResend ? "There's a lot waiting for you inside" : "Your numbers, and how to use them"}
      </h1>
      <p style="color:#33414E;font-size:15px;line-height:1.6;margin:0 0 6px;">Hi ${esc(firstName)},</p>
      <p style="color:#33414E;font-size:15px;line-height:1.6;margin:0 0 24px;">${openingLine}</p>

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 26px;">
        ${bulletsHtml}
      </table>

      <!-- Single full-width tap target: most of these clients open email on a
           phone with paint on their hands. -->
      <a href="${params.actionLink}"
         style="display:block;background:#3E908D;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:15px 20px;border-radius:10px;text-align:center;">
        ${cta}
      </a>
      <p style="color:#5A6875;font-size:13px;line-height:1.55;margin:14px 0 0;text-align:center;">
        One tap and you're in — <strong>no password to remember</strong>.<br/>
        <span style="color:#954E44;">This link expires in ${ACTIVATION_TTL_DAYS_TEXT}.</span>
      </p>
    </div>

    <div style="padding:20px 28px 26px;">
      <div style="border-top:1px solid #EDF1F4;padding-top:18px;">
        <p style="color:#33414E;font-size:14px;line-height:1.6;margin:0 0 4px;">Anything look off, or want something explained?</p>
        <p style="color:#5A6875;font-size:13px;line-height:1.6;margin:0;">
          Just reply to this email — it comes straight to us.
        </p>
        <p style="color:#152F46;font-size:14px;line-height:1.6;margin:16px 0 0;">&mdash; ${signoff}</p>
      </div>
    </div>

    <div style="background:#F9FAFB;padding:16px 28px;border-top:1px solid #EDF1F4;">
      <p style="color:#8A94A0;font-size:11px;line-height:1.6;margin:0;">
        This link is just for you and expires in ${ACTIVATION_TTL_DAYS_TEXT} — please don't forward it.
        If it's stopped working, reply and we'll send a new one.<br/>
        Button not working? Paste this into your browser:<br/>
        <a href="${params.actionLink}" style="color:#2F6F6C;word-break:break-all;">${params.actionLink}</a>
      </p>
    </div>
  </div>

  <div style="max-width:560px;margin:12px auto 0;text-align:center;color:#9AA3AD;font-size:11px;">
    Sent by your Ironbooks bookkeeping team for ${client}.
  </div>
</div>`;

  return sendResendEmail({
    to: [params.to],
    replyTo: process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com",
    // A person's name in the From line materially outperforms a brand alone,
    // and these clients know their bookkeeper. Falls back to the brand.
    // A person's name in the From line reads as a note from their bookkeeper
    // rather than a system notification. Built off the RESOLVED address so
    // resolveFromEmail's sandbox guard still applies — hardcoding a domain here
    // would quietly bypass it.
    from: bk ? personalFrom(bk) : undefined,
    subject,
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
    /** CTA button label (default "Read and reply"). */
    ctaLabel?: string;
    /** Replace the whole email subject entirely. */
    subjectOverride?: string;
    /** Who it's from — a bookkeeper's name outperforms the brand, because it
     *  tells a busy contractor whether this is worth opening. Falls back to
     *  "Your bookkeeper". */
    fromName?: string | null;
    /** Suppress the body preview in the EMAIL (security — e.g. financial
     *  statements). The portal copy still has the full body; the email only
     *  nudges them to log in. */
    hideBody?: boolean;
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
    const cta = params.ctaLabel || "Read and reply";
    const hideBody = params.hideBody === true;

    // Old heading was "Ironbooks has sent you a message in SNAP!" — house style,
    // an exclamation mark, and a product name the client doesn't think in. It
    // also buried WHO it's from, which is the only thing that decides whether a
    // busy contractor opens it. Lead with the person.
    const fromWho = params.fromName?.trim() || "Your bookkeeper";
    const heading = hideBody
      ? `${fromWho} has something for you`
      : `${fromWho} sent you a ${noun}`;

    const text = [
      `${heading}`,
      ``,
      params.subject ? `${params.subject}` : ``,
      hideBody
        ? `It's waiting in your portal — we keep it behind your login rather than in an inbox.`
        : snippet,
      ``,
      `${cta}: ${link}`,
      ``,
      `Replies to this address aren't monitored — use the portal so your answer reaches the right person and stays with the rest of your file.`,
    ]
      .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
      .join("\n");

    const nl2br = (t: string) => escapeHtml(t).replace(/\n/g, "<br/>");

    const html = renderEmailShell({
      preheader: hideBody
        ? `Waiting in your portal — one tap, no password.`
        : snippet.slice(0, 140).replace(/\s+/g, " "),
      heading,
      clientName: params.clientName,
      bodyHtml:
        (params.subject
          ? `<p style="margin:0 0 14px;color:${EMAIL_BRAND.navy};font-size:15px;font-weight:700;line-height:1.4;">${escapeHtml(params.subject)}</p>`
          : "") +
        (hideBody
          ? emailParagraph(
              `It's waiting in your portal. We keep these behind your own login rather than in an inbox.`
            )
          : emailQuote(nl2br(snippet))),
      cta: { label: cta, url: link },
      ctaNote: "One tap and you're in &mdash; <strong>no password to remember</strong>.",
      footerHtml:
        `Replies to this address aren't monitored. Answer in the portal so it reaches the right ` +
        `person and stays with the rest of your file.<br/>` +
        `Button not working? Paste this into your browser:<br/>` +
        `<a href="${link}" style="color:${EMAIL_BRAND.tealDeep};word-break:break-all;">${link}</a>`,
    });

    // Subject leads with the sender, then their own subject line if they wrote
    // one. "Ironbooks sent you a message in SNAP" told the client nothing about
    // whether it mattered.
    const emailSubject =
      params.subjectOverride ||
      (params.subject
        ? `${fromWho}: ${params.subject}`
        : `${fromWho} sent you a ${noun}`);
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
