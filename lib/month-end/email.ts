import type { PeriodBounds } from "./types";
import { resolveFromEmail } from "@/lib/email-sender";
import {
  renderEmailShell,
  emailParagraph,
  emailTickList,
  escapeHtml,
} from "@/lib/email-shell";

export interface MonthEndEmailParams {
  clientName: string;
  recipientEmail: string;
  recipientFirstName: string;
  period: PeriodBounds;
  aiSummaryExcerpt: string;
  portalUrl: string;
}

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

  // Short, branded subject. No financial figures in the email itself — the
  // numbers live behind the portal login (security); the email is just the
  // "ready, come see" nudge.
  // Subject names the PERIOD, never the state of the books. "Closed and
  // reconciled" was the old wording; it's a freshness claim, and Mike's rule
  // (2026-07-28) is that we don't make those — a client who reads more into it
  // than we meant trusts the next email less. The period is a fact.
  const subject = `${params.recipientFirstName}, your ${params.period.label} statements are ready`;

  const text = [
    `Hi ${params.recipientFirstName},`,
    ``,
    `Your financial statements for ${params.period.label} are ready to look at.`,
    ``,
    `They're in your portal rather than attached to this email — that keeps your numbers behind your own login instead of sitting in an inbox.`,
    ``,
    `View your ${params.period.label} statements: ${params.portalUrl}`,
    ``,
    `What you'll find:`,
    `• Profit and loss for ${params.period.label} — what came in, what went out, what's left`,
    `• Balance sheet — what the business owns and owes`,
    `• A plain-English summary of what changed and why`,
    ``,
    `Not sure what a number means? Reply to this email, or ask in the portal — that's what it's there for.`,
    ``,
    `— Your Ironbooks team`,
  ].join("\n");

  const html = renderEmailShell({
    preheader: `Profit and loss, balance sheet, and a plain-English summary for ${params.period.label}.`,
    heading: `Your ${params.period.label} statements are ready`,
    clientName: params.clientName,
    bodyHtml:
      emailParagraph(`Hi ${escapeHtml(params.recipientFirstName)},`) +
      emailParagraph(
        `Your financial statements for <strong>${escapeHtml(params.period.label)}</strong> are ready to look at.`
      ) +
      emailTickList([
        [
          `Profit and loss for ${escapeHtml(params.period.label)}`,
          "What came in, what went out, and what's left — in plain language.",
        ],
        ["Balance sheet", "What the business owns and what it owes, side by side."],
        ["A summary of what changed", "Written out, so you don't have to interpret the numbers yourself."],
      ]) +
      emailParagraph(
        `They live in your portal rather than attached here &mdash; that keeps your numbers behind your own login instead of sitting in an inbox.`
      ),
    cta: { label: `View my ${params.period.label} statements`, url: params.portalUrl },
    ctaNote: "One tap and you're in &mdash; <strong>no password to remember</strong>.",
    closingHtml: emailParagraph(
      `Not sure what a number means, or something looks off? Reply to this email, or ask in the portal &mdash; that's what it's there for.`
    ),
    signoff: "Your Ironbooks team",
  });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
