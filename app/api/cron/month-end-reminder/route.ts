import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { defaultDeliveryPeriod, buildFleetReadiness } from "@/lib/month-end";
import { appBaseUrl } from "@/lib/month-end/api-auth";
import { resolveFromEmail } from "@/lib/email-sender";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/month-end-reminder
 * Emails admin when clients are ready to deliver (no auto-send).
 * Schedule: 1st of month, mid-morning UTC.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") || "";
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const period = defaultDeliveryPeriod();
  const service = createServiceSupabase();
  const fleet = await buildFleetReadiness(service, period);

  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = resolveFromEmail(
    process.env.MONTH_END_FROM_EMAIL,
    process.env.SUPPORT_FROM_EMAIL
  );
  const toEmail = process.env.MONTH_END_ADMIN_EMAIL || "admin@ironbooks.com";

  const subject = `[Ironbooks] Month-end: ${fleet.counts.ready} ready, ${fleet.counts.blocked} blocked — ${fleet.period.label}`;
  const text = [
    `Month-end delivery status for ${fleet.period.label}:`,
    ``,
    `  Ready to send:  ${fleet.counts.ready}`,
    `  Blocked:        ${fleet.counts.blocked}`,
    `  Already sent:   ${fleet.counts.sent}`,
    `  Failed:         ${fleet.counts.failed}`,
    ``,
    `Open the command center: ${appBaseUrl()}/month-end?period_year=${period.periodYear}&period_month=${period.periodMonth}`,
  ].join("\n");

  if (apiKey && fleet.counts.ready > 0) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: fromEmail, to: [toEmail], subject, text }),
    });
  }

  return NextResponse.json({
    ok: true,
    period,
    counts: fleet.counts,
    emailed: !!(apiKey && fleet.counts.ready > 0),
  });
}
