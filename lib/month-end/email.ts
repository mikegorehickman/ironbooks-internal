import type { PeriodBounds } from "./types";
import { resolveFromEmail } from "@/lib/email-sender";

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

  const subject = `Your ${params.period.label} financial statements are ready — ${params.clientName}`;
  const excerpt = params.aiSummaryExcerpt.split("\n").filter(Boolean).slice(0, 2).join(" ");

  const text = [
    `Hi ${params.recipientFirstName},`,
    ``,
    `Your books for ${params.period.label} are closed and reconciled. Here's a quick summary:`,
    ``,
    excerpt,
    ``,
    `View your full statements in the Ironbooks portal:`,
    params.portalUrl,
    ``,
    `Questions? Reply to this email or use Ask AI in your portal.`,
    ``,
    `— The Ironbooks team`,
  ].join("\n");

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
        subject,
        text,
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
