/**
 * The shared shell every client-facing Ironbooks email renders through.
 *
 * WHY THIS EXISTS. An audit of the email templates on 2026-07-28 found three
 * different navies (#0F1F2E ×11, #152F46 ×5, #0F2A43 ×2), three different teals
 * (#1A9B8F, #3E908D, #0FB5A6), two canvases, and a mix of Arial and system-ui.
 * A client who gets an invite, then a statements notice, then a walkthrough was
 * looking at three subtly different companies — none of which quite matched the
 * portal they landed in.
 *
 * So the header, footer, button and type live here once, keyed to the app's own
 * tokens. Each template supplies only its words. That also lifts the emails
 * whose BODY we don't write (the bookkeeper's ask-client note, a support reply):
 * they get a consistent, well-built wrapper without anyone editing their copy.
 *
 * Email-client constraints baked in:
 *   - inline styles only — <style> blocks are stripped by Outlook and Gmail
 *   - no remote images — blocked by default, so the brand can't depend on one
 *   - tables for anything that must hold its shape in Outlook
 *   - a preheader, or the inbox leaks whatever the markup starts with
 *   - one full-width tap target; these clients read on a phone, often mid-job
 */

/** App tokens, so email and product look like the same company. */
export const EMAIL_BRAND = {
  navy: "#152F46",
  teal: "#3E908D",
  tealDeep: "#2F6F6C",
  tealTint: "#E6F1F0",
  tealPale: "#8CD3CC",
  canvas: "#F5F7F9",
  panel: "#FFFFFF",
  hairline: "#E3E8ED",
  hairlineSoft: "#EDF1F4",
  ink: "#33414E",
  inkSoft: "#5A6875",
  inkFaint: "#8A94A0",
  gold: "#DAB461",
  goldTint: "#FBF6E9",
  goldDeep: "#7A5E1E",
  rust: "#954E44",
  white: "#FFFFFF",
} as const;

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** First name from a full name, falling back to something addressable. */
export function firstNameOf(fullName: string | null | undefined, fallback = "there"): string {
  return (fullName || "").trim().split(/\s+/)[0] || fallback;
}

export interface ShellOptions {
  /** Grey line after the subject in most inboxes. Always set it. */
  preheader: string;
  /** The <h1>. Plain text — escaped for you. */
  heading: string;
  /** Body HTML, built from the helpers below. */
  bodyHtml: string;
  /** Primary action. Rendered full-width; omit for a no-action notice. */
  cta?: { label: string; url: string };
  /** Small reassurance directly under the button (e.g. "no password to remember"). */
  ctaNote?: string;
  /** Line in rust under the note — for a deadline or expiry only. */
  ctaWarning?: string;
  /** Closing paragraph above the sign-off. */
  closingHtml?: string;
  /** Who it's from, e.g. "Lisa and the Ironbooks team". */
  signoff?: string;
  /** Fine print above the client-name line. */
  footerHtml?: string;
  /** Named in the very bottom line, so forwarded mail still has context. */
  clientName?: string;
}

/** Section heading inside the body. */
export function emailSubheading(text: string): string {
  return `<p style="margin:22px 0 8px;color:${EMAIL_BRAND.navy};font-size:15px;font-weight:700;line-height:1.4;">${escapeHtml(text)}</p>`;
}

export function emailParagraph(html: string): string {
  return `<p style="color:${EMAIL_BRAND.ink};font-size:15px;line-height:1.6;margin:0 0 16px;">${html}</p>`;
}

/**
 * Tick list. A table, not a <ul> — Outlook's list rendering is unreliable and
 * this is usually the part doing the persuading.
 */
export function emailTickList(items: Array<[title: string, detail: string]>): string {
  const rows = items
    .map(
      ([t, d]) => `
        <tr>
          <td style="padding:0 0 14px;vertical-align:top;width:26px;">
            <div style="width:18px;height:18px;border-radius:50%;background:${EMAIL_BRAND.tealTint};color:${EMAIL_BRAND.tealDeep};font-size:11px;font-weight:700;line-height:18px;text-align:center;">&#10003;</div>
          </td>
          <td style="padding:0 0 14px;vertical-align:top;">
            <div style="color:${EMAIL_BRAND.navy};font-size:14px;font-weight:700;line-height:1.4;">${t}</div>
            <div style="color:${EMAIL_BRAND.inkSoft};font-size:13px;line-height:1.5;margin-top:2px;">${d}</div>
          </td>
        </tr>`
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:2px 0 24px;">${rows}</table>`;
}

/** Quiet panel for a quoted message or a detail block. */
export function emailQuote(html: string): string {
  return `<div style="margin:0 0 22px;padding:14px 16px;background:${EMAIL_BRAND.canvas};border-left:3px solid ${EMAIL_BRAND.teal};border-radius:0 8px 8px 0;color:${EMAIL_BRAND.ink};font-size:14px;line-height:1.6;">${html}</div>`;
}

/** Gold caution panel — for something the client must do, not for decoration. */
export function emailNotice(html: string): string {
  return `<div style="margin:0 0 22px;padding:13px 15px;background:${EMAIL_BRAND.goldTint};border:1px solid ${EMAIL_BRAND.gold};border-radius:8px;color:${EMAIL_BRAND.goldDeep};font-size:13.5px;line-height:1.55;">${html}</div>`;
}

/**
 * Wrap body content in the branded shell.
 *
 * Everything is inline-styled and image-free, so it survives Outlook and renders
 * identically whether or not images are blocked.
 */
export function renderEmailShell(o: ShellOptions): string {
  const B = EMAIL_BRAND;

  const ctaBlock = o.cta
    ? `
      <a href="${o.cta.url}" style="display:block;background:${B.teal};color:${B.white};text-decoration:none;font-size:16px;font-weight:700;padding:15px 20px;border-radius:10px;text-align:center;">${escapeHtml(o.cta.label)}</a>
      ${
        o.ctaNote || o.ctaWarning
          ? `<p style="color:${B.inkSoft};font-size:13px;line-height:1.55;margin:14px 0 0;text-align:center;">
               ${o.ctaNote || ""}${o.ctaNote && o.ctaWarning ? "<br/>" : ""}${o.ctaWarning ? `<span style="color:${B.rust};">${o.ctaWarning}</span>` : ""}
             </p>`
          : ""
      }`
    : "";

  const closing = o.closingHtml
    ? `<div style="border-top:1px solid ${B.hairlineSoft};padding-top:18px;margin-top:24px;">
         ${o.closingHtml}
         ${o.signoff ? `<p style="color:${B.navy};font-size:14px;line-height:1.6;margin:16px 0 0;">&mdash; ${escapeHtml(o.signoff)}</p>` : ""}
       </div>`
    : o.signoff
    ? `<p style="color:${B.navy};font-size:14px;line-height:1.6;margin:24px 0 0;">&mdash; ${escapeHtml(o.signoff)}</p>`
    : "";

  return `
<div style="background:${B.canvas};padding:32px 16px;font-family:${FONT};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(o.preheader)}</div>
  <div style="max-width:560px;margin:0 auto;background:${B.panel};border-radius:16px;overflow:hidden;border:1px solid ${B.hairline};">

    <div style="background:${B.navy};padding:24px 28px;">
      <div style="color:${B.white};font-size:19px;font-weight:700;letter-spacing:-0.01em;">Ironbooks</div>
      <div style="color:${B.tealPale};font-size:12px;margin-top:3px;">Advancing Financial Literacy In The Trades</div>
    </div>

    <div style="padding:30px 28px ${o.footerHtml ? "26px" : "30px"};">
      <h1 style="margin:0 0 16px;color:${B.navy};font-size:21px;line-height:1.3;font-weight:700;">${escapeHtml(o.heading)}</h1>
      ${o.bodyHtml}
      ${ctaBlock}
      ${closing}
    </div>

    ${
      o.footerHtml
        ? `<div style="background:#F9FAFB;padding:16px 28px;border-top:1px solid ${B.hairlineSoft};">
             <p style="color:${B.inkFaint};font-size:11px;line-height:1.6;margin:0;">${o.footerHtml}</p>
           </div>`
        : ""
    }
  </div>

  ${
    o.clientName
      ? `<div style="max-width:560px;margin:12px auto 0;text-align:center;color:#9AA3AD;font-size:11px;">
           Sent by your Ironbooks bookkeeping team for ${escapeHtml(o.clientName)}.
         </div>`
      : ""
  }
</div>`;
}

/**
 * Standard fine print for an email carrying a sign-in link.
 * `statedDays` must never exceed the real link TTL — see STATED_LINK_DAYS.
 */
export function linkFooter(url: string, statedDays: number): string {
  return (
    `This link is just for you and expires in ${statedDays} days &mdash; please don't forward it. ` +
    `If it's stopped working, reply and we'll send a new one.<br/>` +
    `Button not working? Paste this into your browser:<br/>` +
    `<a href="${url}" style="color:${EMAIL_BRAND.tealDeep};word-break:break-all;">${url}</a>`
  );
}
