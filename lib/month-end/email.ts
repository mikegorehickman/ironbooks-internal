import type { PeriodBounds } from "./types";
import { resolveFromEmail } from "@/lib/email-sender";

export interface MonthEndEmailParams {
  clientName: string;
  recipientEmail: string;
  recipientFirstName: string;
  period: PeriodBounds;
  portalUrl: string;
  /** Client is in the DRAFT statements stage — subject + body say DRAFT
   *  loudly and ask for the portal gut-check. */
  isDraft: boolean;
  /** A previous DRAFT month went out and the client never responded —
   *  add a gentle reminder line (Mike, 2026-07-15: stay draft + nudge). */
  nudge?: boolean;
}

/**
 * The statements-ready email. Deliberately contains NO financial numbers —
 * no summary, no revenue/profit lines (Mike, 2026-07-15: financials in an
 * email body are a security risk; clients must log in to see anything).
 * The body is just "your statements are ready" + a login button, with the
 * DRAFT framing when the client is still in the gut-check stage.
 */
export async function sendMonthEndEmail(
  params: MonthEndEmailParams
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = resolveFromEmail(
    process.env.MONTH_END_FROM_EMAIL,
    process.env.SUPPORT_FROM_EMAIL
  );

  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const subject = params.isDraft
    ? `Your DRAFT ${params.period.label} financial statements are ready — ${params.clientName}`
    : `Your ${params.period.label} financial statements are ready — ${params.clientName}`;

  const draftLine =
    "These are DRAFT statements — our best picture from the information we have so far. You know your business best: please take 2 minutes in your portal to confirm a few things (all revenue showing? every account, card, and loan listed?) so we can mark your books verified.";
  const nudgeLine =
    "P.S. We haven't heard back on last month's draft yet — your quick review is what lets us move your books from DRAFT to verified.";

  const text = [
    `Hi ${params.recipientFirstName},`,
    ``,
    params.isDraft
      ? `Your DRAFT statements for ${params.period.label} are ready to review.`
      : `Your books for ${params.period.label} are closed and reconciled, and your statements are ready.`,
    ``,
    ...(params.isDraft ? [draftLine, ``] : []),
    `For your security we don't include financial details in email — log in to view your statements:`,
    params.portalUrl,
    ``,
    ...(params.isDraft && params.nudge ? [nudgeLine, ``] : []),
    `Questions? Reply to this email or use Ask AI in your portal.`,
    ``,
    `— The Ironbooks team`,
  ].join("\n");

  // Branded HTML — inline styles only (email clients strip <style>). Mirrors
  // the navy/teal card used by the portal-notification emails so every client
  // email looks consistent. The plain-text above stays as the fallback.
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const draftBadge = params.isDraft
    ? `<div style="display:inline-block;background:#B45309;color:#ffffff;font-size:12px;font-weight:800;letter-spacing:1px;padding:4px 10px;border-radius:6px;margin:0 0 10px;">DRAFT</div>`
    : "";
  const draftBlock = params.isDraft
    ? `<div style="background:#FFFBEB;border:1px solid #FDE68A;border-left:3px solid #B45309;border-radius:8px;padding:14px 16px;margin:0 0 22px;color:#78350F;font-size:13px;line-height:1.6;">${esc(draftLine)}</div>`
    : "";
  const nudgeBlock =
    params.isDraft && params.nudge
      ? `<p style="margin:16px 0 0;color:#78350F;font-size:12px;line-height:1.5;">${esc(nudgeLine)}</p>`
      : "";
  const html = `
<div style="background:#F4F5F7;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E5E7EB;">
    <div style="background:#0F1F2E;padding:22px 28px;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;">Ironbooks</div>
      <div style="color:#8CD3CC;font-size:12px;margin-top:2px;">Advancing Financial Literacy In The Trades</div>
    </div>
    <div style="padding:28px;">
      ${draftBadge}
      <h2 style="margin:0 0 8px;color:#0F1F2E;font-size:18px;">Your ${params.isDraft ? "DRAFT " : ""}${esc(params.period.label)} statements are ready${params.isDraft ? "" : " ✅"}</h2>
      <p style="margin:0 0 14px;color:#33414E;font-size:14px;line-height:1.55;">Hi ${esc(params.recipientFirstName)}, ${
        params.isDraft
          ? `your draft statements for ${esc(params.period.label)} are ready to review.`
          : `your books for ${esc(params.period.label)} are closed and reconciled.`
      } For your security we don't include financial details in email — log in to view them.</p>
      ${draftBlock}
      <a href="${params.portalUrl}" style="display:inline-block;background:#1A9B8F;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:11px 22px;border-radius:8px;">${
        params.isDraft ? "Review your draft statements →" : "View your statements →"
      }</a>
      ${nudgeBlock}
      <div style="background:#FCFCFD;border:1px solid #EEF0F2;border-radius:8px;padding:12px 14px;margin:22px 0 0;color:#8A94A0;font-size:11px;line-height:1.6;">
        <strong style="color:#5B6770;">Notice to Reader:</strong> These statements are prepared on a cash basis from your QuickBooks data — they don't reflect accounts receivable, accounts payable, or your full cash-flow cycle, and haven't been audited or reviewed. For a true read on your business, look at trends over at least a 90-day period rather than any single month.
      </div>
      <p style="color:#8A94A0;font-size:12px;margin:18px 0 0;line-height:1.5;">
        Questions? Just reply to this email, or use <strong>Ask AI</strong> in your portal.
      </p>
    </div>
  </div>
  <div style="max-width:560px;margin:12px auto 0;text-align:center;color:#9AA3AD;font-size:11px;">
    Ironbooks · your painting-business bookkeeping team
  </div>
</div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [params.recipientEmail],
        reply_to: process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com",
        subject,
        text,
        html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `Resend ${res.status}: ${errText}` };
    }

    const body = await res.json();
    return { ok: true, messageId: body.id as string | undefined };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Resend network error" };
  }
}
