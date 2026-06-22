/**
 * Branded, email-safe per-user signature block. Appended to emails a team
 * member sends (e.g. bulk email). Table layout + inline styles so it survives
 * every email client. Falls back gracefully when optional fields are empty.
 */

export interface SignatureUser {
  full_name?: string | null;
  email?: string | null;
  title?: string | null;
  phone?: string | null;
  booking_url?: string | null;
  avatar_url?: string | null;
  signature_enabled?: boolean | null;
}

const TEAL = "#2D7A75";
const NAVY = "#0F1F2E";
const SLATE = "#475569";
const LIGHT = "#94A3B8";
const LOGO = "https://app.ironbooks.com/logo.png";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Initials avatar fallback when there's no photo. */
function avatarCell(u: SignatureUser): string {
  if (u.avatar_url) {
    return `<img src="${esc(u.avatar_url)}" width="56" height="56" alt="" style="display:block;border-radius:50%;object-fit:cover;" />`;
  }
  const initials = (u.full_name || "?").split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  return `<div style="width:56px;height:56px;border-radius:50%;background:${TEAL};color:#fff;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;text-align:center;line-height:56px;">${esc(initials)}</div>`;
}

/** The HTML signature block (returns "" when the user has it disabled). */
export function renderUserSignature(u: SignatureUser): string {
  if (u.signature_enabled === false) return "";
  const name = esc(u.full_name || "The Ironbooks Team");
  const titleLine = u.title ? `<div style="font-size:13px;color:${SLATE};">${esc(u.title)} · Ironbooks</div>` : `<div style="font-size:13px;color:${SLATE};">Ironbooks</div>`;
  const contactBits: string[] = [];
  if (u.phone) contactBits.push(`<a href="tel:${esc(u.phone.replace(/[^\d+]/g, ""))}" style="color:${SLATE};text-decoration:none;">${esc(u.phone)}</a>`);
  if (u.email) contactBits.push(`<a href="mailto:${esc(u.email)}" style="color:${TEAL};text-decoration:none;">${esc(u.email)}</a>`);
  const contactLine = contactBits.length ? `<div style="font-size:12px;color:${LIGHT};margin-top:3px;">${contactBits.join(' &nbsp;·&nbsp; ')}</div>` : "";
  const booking = u.booking_url
    ? `<div style="margin-top:8px;"><a href="${esc(u.booking_url)}" style="display:inline-block;background:${TEAL};color:#fff;text-decoration:none;font-size:12px;font-weight:bold;padding:7px 14px;border-radius:8px;">Book a call</a></div>`
    : "";

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;border-top:1px solid #E2E8F0;padding-top:18px;font-family:Arial,Helvetica,sans-serif;">
  <tr>
    <td valign="top" style="padding-right:14px;">${avatarCell(u)}</td>
    <td valign="top">
      <div style="font-size:15px;font-weight:bold;color:${NAVY};">${name}</div>
      ${titleLine}
      ${contactLine}
      ${booking}
      <div style="margin-top:10px;">
        <img src="${LOGO}" width="22" height="22" alt="" style="vertical-align:middle;border:0;" />
        <span style="font-size:12px;font-weight:bold;color:${NAVY};vertical-align:middle;padding-left:6px;">Ironbooks</span>
        <span style="font-size:11px;color:${LIGHT};padding-left:6px;">Advancing financial literacy in the trades</span>
      </div>
    </td>
  </tr>
</table>`;
}

/** Plain-text signature for the text/plain part. */
export function renderUserSignatureText(u: SignatureUser): string {
  if (u.signature_enabled === false) return "";
  const lines = ["", "—", u.full_name || "The Ironbooks Team"];
  lines.push(u.title ? `${u.title} · Ironbooks` : "Ironbooks");
  const c = [u.phone, u.email].filter(Boolean).join("  ·  ");
  if (c) lines.push(c);
  if (u.booking_url) lines.push(`Book a call: ${u.booking_url}`);
  lines.push("Advancing financial literacy in the trades");
  return lines.join("\n");
}
