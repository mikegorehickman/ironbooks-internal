/**
 * Send the client a branded "please upload these statements" email — the
 * Balance Sheet stage's statement-request. Reuses the same direct-send +
 * client_email_log infra as the Stripe connect request. The statement_requests
 * rows themselves are created separately (POST /api/clients/[id]/statement-requests);
 * this just emails the client + logs it + stamps bs_statements_requested_at.
 */

import {
  resolveClientContactEmails,
  sendResendEmailTracked,
} from "@/lib/client-comms";

export interface StatementRequestEmailResult {
  ok: boolean;
  sent: boolean;
  recipients: number;
  addresses: string[];
  noAddress: boolean;
  error?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendStatementRequestEmail(
  service: any,
  params: {
    clientLinkId: string;
    clientName: string;
    /** statement labels, e.g. "Bank statement — Chase Checking ****1234" */
    labels: string[];
    createdByUserId: string | null;
    overrideEmail?: string | null;
  }
): Promise<StatementRequestEmailResult> {
  const { clientLinkId, clientName, labels, createdByUserId, overrideEmail } = params;

  let addresses: string[] = [];
  const override = (overrideEmail || "").trim().toLowerCase();
  if (override) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(override)) {
      return { ok: false, sent: false, recipients: 0, addresses: [], noAddress: true, error: "That doesn't look like a valid email address." };
    }
    addresses = [override];
    await service.from("client_links").update({ client_email: override } as any).eq("id", clientLinkId);
  } else {
    const { data: cl } = await service
      .from("client_links")
      .select("email_hard_bounced")
      .eq("id", clientLinkId)
      .single();
    if (cl?.email_hard_bounced) {
      return { ok: false, sent: false, recipients: 0, addresses: [], noAddress: true, error: "The email on file previously bounced — enter a new address." };
    }
    addresses = await resolveClientContactEmails(service, clientLinkId);
  }

  if (addresses.length === 0) {
    return { ok: false, sent: false, recipients: 0, addresses: [], noAddress: true };
  }

  const portalUrl =
    process.env.NEXT_PUBLIC_PORTAL_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "https://snap.ironbooks.com";
  const uploadUrl = `${portalUrl}/portal/messages`;
  const firstName = (clientName || "").split(" ")[0] || "there";
  const listHtml = labels.map((l) => `<li style="margin:4px 0;">${esc(l)}</li>`).join("");
  const subject = `Please upload a few statements so we can finish your books — ${clientName}`;

  const html = `
<div style="background:#F4F5F7;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E5E7EB;">
    <div style="background:#0F1F2E;padding:22px 28px;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;">Ironbooks</div>
      <div style="color:#8CD3CC;font-size:12px;margin-top:2px;">Advancing Financial Literacy In The Trades</div>
    </div>
    <div style="padding:28px;">
      <h2 style="margin:0 0 14px;color:#0F1F2E;font-size:18px;">A few statements to finish your cleanup</h2>
      <p style="color:#33414E;font-size:14px;line-height:1.6;margin:0 0 12px;">Hi ${esc(firstName)},</p>
      <p style="color:#33414E;font-size:14px;line-height:1.6;margin:0 0 12px;">To finish reconciling the books for <strong>${esc(clientName)}</strong>, we need to verify a few ending balances against your statements. Could you upload the following?</p>
      <ul style="color:#33414E;font-size:14px;line-height:1.6;margin:0 0 18px;padding-left:20px;">${listHtml}</ul>
      <a href="${uploadUrl}" style="display:inline-block;background:#1A9B8F;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:12px 26px;border-radius:8px;">Upload your statements</a>
      <p style="color:#8A94A0;font-size:12px;margin:24px 0 0;line-height:1.55;">You can upload right in your portal under Messages. If anything's unclear or you'd rather send them another way, just reply to this email.</p>
    </div>
  </div>
  <div style="max-width:560px;margin:12px auto 0;text-align:center;color:#9AA3AD;font-size:11px;">Sent by your Ironbooks bookkeeping team for ${esc(clientName)}.</div>
</div>`;

  const text = [
    `Hi ${firstName},`,
    ``,
    `To finish reconciling the books for ${clientName}, we need to verify a few ending balances against your statements. Could you upload the following?`,
    ``,
    ...labels.map((l) => `  • ${l}`),
    ``,
    `Upload them in your portal under Messages: ${uploadUrl}`,
    ``,
    `If anything's unclear, just reply to this email.`,
    ``,
    `Kindly,`,
    `Ironbooks`,
  ].join("\n");

  let okCount = 0;
  for (const addr of addresses) {
    const r = await sendResendEmailTracked({
      to: addr,
      subject,
      text,
      html,
      replyTo: process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com",
    });
    if (r.ok) okCount++;
    await service.from("client_email_log").insert({
      client_link_id: clientLinkId,
      to_address: addr,
      email_type: "bs_statements",
      subject,
      status: r.ok ? "sent" : "failed",
      provider_message_id: r.messageId ?? null,
      error: r.ok ? null : r.error ?? null,
      created_by: createdByUserId,
    } as any);
  }

  await service
    .from("client_links")
    .update({ bs_statements_requested_at: new Date().toISOString() } as any)
    .eq("id", clientLinkId);

  await service.from("audit_log").insert({
    user_id: createdByUserId,
    event_type: "bs_statements_requested",
    request_payload: { client_link_id: clientLinkId, labels, recipients: addresses } as any,
  });

  return {
    ok: okCount > 0,
    sent: okCount > 0,
    recipients: okCount,
    addresses,
    noAddress: false,
    error: okCount === 0 ? "Email could not be sent (Resend rejected the send)." : undefined,
  };
}
