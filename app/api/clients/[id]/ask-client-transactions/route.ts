import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { resolveClientContactEmails, sendResendEmailTracked } from "@/lib/client-comms";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/ask-client-transactions
 *
 * Sends a "questions about these transactions" email to the client, composed
 * in the P&L / account drill-down drawer (select rows → Ask Client → edit →
 * send). The modal renders the branded HTML + plain-text and posts them here;
 * we ship it via Resend (tracked) so there's a real message id + a durable
 * row in client_email_log, and a green "sent" verification in the UI.
 *
 * Recipient: active portal-user emails, else client_links.client_email.
 * reply_to = the sending bookkeeper so the client's answers land in their inbox.
 *
 * Body: { subject, html, text, account_name?, transaction_count? }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("id, role, full_name, email")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  let body: { subject?: string; html?: string; text?: string; account_name?: string; transaction_count?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const subject = (body.subject || "").trim().slice(0, 300);
  const html = (body.html || "").trim();
  const text = (body.text || "").trim();
  if (!subject || (!html && !text)) {
    return NextResponse.json({ error: "Subject and email body are required" }, { status: 400 });
  }

  const recipients = await resolveClientContactEmails(service, clientLinkId);
  if (recipients.length === 0) {
    return NextResponse.json(
      {
        error: "No email on file for this client — add a portal user or a contact email first, or copy the draft and send it manually.",
        reason: "no_recipient",
      },
      { status: 422 }
    );
  }

  const replyTo = (actor as any)?.email || "admin@ironbooks.com";
  const result = await sendResendEmailTracked({ to: recipients, subject, html, text, replyTo });

  const nowIso = new Date().toISOString();
  try {
    await (service as any).from("client_email_log").insert(
      recipients.map((addr) => ({
        client_link_id: clientLinkId,
        to_address: addr,
        subject,
        email_type: "ask_client_txns",
        status: result.ok ? "sent" : "failed",
        provider_message_id: result.messageId || null,
        error: result.ok ? null : result.error || "unknown",
        created_by: user.id,
        ts: nowIso,
      }))
    );
  } catch (e: any) {
    console.warn(`[ask-client-transactions] client_email_log insert failed: ${e?.message}`);
  }

  if (!result.ok) {
    return NextResponse.json(
      {
        error: `Email didn't send — ${result.error || "Resend rejected the request"}. Fix the issue or copy the draft and send it manually.`,
        reason: "send_failed",
      },
      { status: 502 }
    );
  }

  await service.from("audit_log").insert({
    event_type: "ask_client_transactions_email_sent",
    user_id: user.id,
    request_payload: {
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      account_name: body.account_name || null,
      transaction_count: body.transaction_count || null,
      sent_by: (actor as any)?.full_name || (actor as any)?.email || user.id,
      recipients,
      subject,
      provider_message_id: result.messageId || null,
      sent_at: nowIso,
    } as any,
  });

  return NextResponse.json({ ok: true, sent: true, recipients, message_id: result.messageId || null });
}
