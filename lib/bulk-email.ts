import { createHmac } from "crypto";
import { sendResendEmail } from "./client-comms";

/**
 * Bulk email — recipient resolution, consent tokens, branded wrapper, merge
 * fields, and the send loop. Two kinds:
 *   operational — must-receive, ignores unsubscribe, no footer
 *   normal      — marketing; respects unsubscribe + carries an unsub footer
 *   resubscribe — like normal but always sent (asks an opted-out client back)
 */

export type EmailKind = "operational" | "normal" | "resubscribe";

const SECRET =
  process.env.BULK_EMAIL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "ironbooks-bulk";

/** Stateless signed token for unsubscribe/resubscribe links (no login). */
export function makeConsentToken(clientLinkId: string): string {
  const sig = createHmac("sha256", SECRET).update(clientLinkId).digest("base64url").slice(0, 24);
  return `${clientLinkId}.${sig}`;
}
export function verifyConsentToken(token: string): string | null {
  const [id, sig] = (token || "").split(".");
  if (!id || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(id).digest("base64url").slice(0, 24);
  return sig === expected ? id : null;
}

/** First portal-user email, else the profile contact email. */
export function resolveRecipientEmail(c: {
  portal_email?: string | null;
  client_email?: string | null;
}): string | null {
  const e = (c.portal_email || c.client_email || "").trim();
  return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e.toLowerCase() : null;
}

/** Replace the supported merge fields in subject/body. */
export function applyMergeFields(
  text: string,
  vars: { firstName?: string | null; businessName?: string | null; loginEmail?: string | null }
): string {
  const first = (vars.firstName || "there").trim() || "there";
  const biz = (vars.businessName || "your business").trim() || "your business";
  // The client's portal login email. Never blank in a real send (the send loop
  // falls back to the address we're mailing); the literal fallback below only
  // guards a truly-empty value so the raw token never leaks to a client.
  const login = (vars.loginEmail || "").trim() || "your login email";
  return text
    // {{first_name}} / {{contact.first_name}}  and  #firstname# / #first_name#
    .replace(/\{\{\s*(contact\.)?first_?name\s*\}\}/gi, first)
    .replace(/#\s*first_?name\s*#/gi, first)
    // {{business_name}} / {{company_name}} / {{client_name}}  and  #businessname# etc.
    .replace(/\{\{\s*(client_?name|business_?name|company_?name)\s*\}\}/gi, biz)
    .replace(/#\s*(client_?name|business_?name|company_?name)\s*#/gi, biz)
    // {{login_email}} / {{portal_email}} / {{email}} / {{contact.email}} / {{login}}
    // and #loginemail# / #login_email# / #email# / #login#.
    // Function replacers so a "$" in the value is never treated as a backref.
    .replace(/\{\{\s*(contact\.)?(login_?email|portal_?email|email|login)\s*\}\}/gi, () => login)
    .replace(/#\s*(login_?email|portal_?email|email|login)\s*#/gi, () => login);
}

const LOGO = "https://internal.ironbooks.com/logo.png";
const ADDRESS = "Advancing Financial Literacy In The Trades";

/**
 * Wrap the composer's body HTML in the Ironbooks branded, email-safe shell
 * (table layout, inline styles). `unsubUrl` adds the unsubscribe footer for
 * normal/resubscribe sends; operational sends pass null and get no footer.
 */
export function wrapBrandedEmail(opts: { bodyHtml: string; footerHtml?: string | null }): string {
  const footer = opts.footerHtml
    ? `<tr><td style="padding:8px 8px 0;font-family:Arial,Helvetica,sans-serif;color:#94A3B8;font-size:12px;text-align:center;line-height:1.5;">${opts.footerHtml}</td></tr>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F9F8;margin:0;padding:0;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
      <tr><td align="center" style="padding:8px 0 20px 0;">
        <img src="${LOGO}" width="96" height="96" alt="Ironbooks" style="display:block;margin:0 auto;border:0;" />
      </td></tr>
      <tr><td style="background:#ffffff;border:1px solid #E2E8F0;border-radius:20px;padding:32px 32px;font-family:Arial,Helvetica,sans-serif;color:#0F1F2E;font-size:16px;line-height:1.6;">
        ${opts.bodyHtml}
      </td></tr>
      <tr><td align="center" style="padding:20px 8px 8px;font-family:Arial,Helvetica,sans-serif;color:#94A3B8;font-size:12px;">${ADDRESS}</td></tr>
      ${footer}
    </table>
  </td></tr>
</table>`;
}

/**
 * Server-side defense-in-depth for the rich-text body. The composer already
 * emits an allowlisted, safe HTML string (client serializer), but this endpoint
 * is HTML-in from an admin, so we independently strip the dangerous constructs:
 * script/style/iframe/etc. elements, inline event handlers, and js/data URIs.
 * Not a full sanitizer (email clients also strip aggressively) — a safety net.
 */
export function stripDangerousHtml(html: string): string {
  return (html || "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|title|head|body|html)\b[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|link|meta|base|title|head|body|html)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/((?:href|src)\s*=\s*["']?)\s*(?:javascript|vbscript|data)\s*:/gi, "$1#");
}

/** Strip HTML to a plain-text fallback. */
export function htmlToText(html: string): string {
  return html
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, url, txt) => `${String(txt).replace(/<[^>]+>/g, "")} (${url})`)
    .replace(/<\s*li\b[^>]*>/gi, "• ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface BulkRecipient {
  clientLinkId: string;
  email: string;
  firstName?: string | null;
  businessName?: string | null;
  /** Portal login email (their auth address). Null when no portal user exists. */
  loginEmail?: string | null;
  replyTo?: string | null;
}

/**
 * Send one personalized email per recipient (sequential + throttled to respect
 * Resend limits). Calls back per result so the caller can persist status.
 */
export async function sendBulkEmails(params: {
  recipients: BulkRecipient[];
  subject: string;
  bodyHtml: string;
  kind: EmailKind;
  appBaseUrl: string;
  /** From header override — "Sender Name · Ironbooks <verified@addr>". */
  from?: string;
  onResult: (r: { clientLinkId: string; email: string; ok: boolean; error?: string }) => Promise<void>;
}): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0;
  for (const r of params.recipients) {
    // Fall back to the address we're mailing so {{login_email}} is never blank.
    const vars = { firstName: r.firstName, businessName: r.businessName, loginEmail: r.loginEmail || r.email };
    const subject = applyMergeFields(params.subject, vars);
    const body = applyMergeFields(params.bodyHtml, vars);
    const token = makeConsentToken(r.clientLinkId);
    let footerHtml: string | null = null;
    if (params.kind === "normal") {
      footerHtml = `You're receiving this because you're an Ironbooks client. <a href="${params.appBaseUrl}/unsubscribe/${token}" style="color:#1F5D58;font-weight:600;">Unsubscribe</a> from updates like this.`;
    } else if (params.kind === "resubscribe") {
      footerHtml = `Want our updates again? <a href="${params.appBaseUrl}/resubscribe/${token}" style="color:#1F5D58;font-weight:700;">Yes, resubscribe me</a>.`;
    }
    const html = wrapBrandedEmail({ bodyHtml: body, footerHtml });
    let ok = false, error: string | undefined;
    try {
      ok = await sendResendEmail({
        to: [r.email],
        subject,
        text: htmlToText(body),
        html,
        replyTo: r.replyTo || undefined,
        from: params.from,
      });
      if (!ok) error = "Resend declined";
    } catch (e: any) {
      error = e?.message || "send error";
    }
    if (ok) sent++; else failed++;
    await params.onResult({ clientLinkId: r.clientLinkId, email: r.email, ok, error });
    await new Promise((res) => setTimeout(res, 120)); // ~8/sec, under Resend's cap
  }
  return { sent, failed };
}
