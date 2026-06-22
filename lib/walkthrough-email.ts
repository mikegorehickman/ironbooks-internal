import { wrapBrandedEmail } from "@/lib/bulk-email";
import { sendResendEmail } from "@/lib/client-comms";

/**
 * Send the SNAP software-walkthrough email — fires once, the first time a
 * client's QuickBooks is connected (so their portal already has data when they
 * click in). Idempotent via client_links.walkthrough_email_sent_at, and safe
 * to call from any QBO-connect path.
 *
 * Gated on SNAP_WALKTHROUGH_VIDEO_URL: until that env var is set (i.e. the
 * walkthrough video exists), this no-ops WITHOUT stamping — so once the URL is
 * configured, future connects start getting it. Set it in Vercel when the
 * video is ready.
 */
export async function sendWalkthroughIfNeeded(
  service: any,
  clientLinkId: string
): Promise<{ sent: boolean; reason?: string }> {
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, client_email, qbo_refresh_token, walkthrough_email_sent_at, assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .maybeSingle();
  if (!client) return { sent: false, reason: "client_not_found" };
  if (!(client as any).qbo_refresh_token) return { sent: false, reason: "not_connected" };
  if ((client as any).walkthrough_email_sent_at) return { sent: false, reason: "already_sent" };

  const videoUrl = process.env.SNAP_WALKTHROUGH_VIDEO_URL;
  if (!videoUrl) {
    console.warn(`[walkthrough-email] SNAP_WALKTHROUGH_VIDEO_URL not set — skipped (not stamped) for ${clientLinkId}`);
    return { sent: false, reason: "no_video_url" };
  }

  // Recipient: the business email, else the active portal user's email.
  let to: string | null = (client as any).client_email || null;
  if (!to) {
    const { data: map } = await service
      .from("client_users")
      .select("user_id")
      .eq("client_link_id", clientLinkId)
      .eq("active", true)
      .maybeSingle();
    if ((map as any)?.user_id) {
      const { data: u } = await service.from("users").select("email").eq("id", (map as any).user_id).maybeSingle();
      to = (u as any)?.email || null;
    }
  }
  if (!to) {
    console.warn(`[walkthrough-email] no recipient email for ${clientLinkId} — skipped (not stamped)`);
    return { sent: false, reason: "no_recipient" };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://snap.ironbooks.com";
  const name = (client as any).client_name || "there";

  const bodyHtml = `
    <h1 style="font-family:Arial,Helvetica,sans-serif;color:#0F2A43;font-size:22px;margin:0 0 12px;">Your books are connected — here's how SNAP works</h1>
    <p style="font-family:Arial,Helvetica,sans-serif;color:#334155;font-size:15px;line-height:1.6;margin:0 0 16px;">
      Hi ${name}, we've connected to your QuickBooks and your portal is ready. We put together a short walkthrough so you can see exactly how everything works — your financials, your AI bookkeeper, and where to send us things.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
      <tr><td>
        <a href="${videoUrl}" style="display:inline-block;background:#0FB5A6;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:13px 26px;border-radius:8px;">▶  Watch the 5-minute walkthrough</a>
      </td></tr>
    </table>
    <p style="font-family:Arial,Helvetica,sans-serif;color:#334155;font-size:15px;line-height:1.6;margin:0 0 8px;">Inside your portal you can:</p>
    <ul style="font-family:Arial,Helvetica,sans-serif;color:#334155;font-size:15px;line-height:1.7;margin:0 0 18px;padding-left:20px;">
      <li>See your profit &amp; loss and balance sheet, always current</li>
      <li>Ask your AI bookkeeper a question any time</li>
      <li>Upload bank statements — we figure out the rest</li>
      <li>Message your bookkeeper directly</li>
    </ul>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">
      <tr><td>
        <a href="${appUrl}/portal" style="display:inline-block;background:#0F2A43;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;text-decoration:none;padding:11px 22px;border-radius:8px;">Open your portal</a>
      </td></tr>
    </table>
  `;

  const ok = await sendResendEmail({
    to: [to],
    subject: "Your books are connected — a quick tour of SNAP",
    text: `Hi ${name}, your QuickBooks is connected and your portal is ready. Watch the walkthrough: ${videoUrl}  •  Open your portal: ${appUrl}/portal`,
    html: wrapBrandedEmail({ bodyHtml }),
  });

  if (!ok) {
    console.warn(`[walkthrough-email] send failed for ${clientLinkId} — not stamped`);
    return { sent: false, reason: "send_failed" };
  }

  await service
    .from("client_links")
    .update({ walkthrough_email_sent_at: new Date().toISOString() })
    .eq("id", clientLinkId);
  try {
    await service.from("audit_log").insert({
      event_type: "walkthrough_email_sent",
      request_payload: { client_link_id: clientLinkId, to } as any,
    });
  } catch {
    /* ignore */
  }

  return { sent: true };
}
