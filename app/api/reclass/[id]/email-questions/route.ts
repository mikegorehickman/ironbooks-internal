import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { resolveClientContactEmails, sendResendEmailTracked } from "@/lib/client-comms";

export const dynamic = "force-dynamic";

/**
 * POST /api/reclass/[id]/email-questions
 *
 * Sends the "questions about transactions" cleanup email directly to the
 * client — the Send-Email twin of the modal's Copy-into-Double workflow.
 * The bookkeeper edits subject/intro/table in the ClientEmailModal; the
 * already-rendered branded HTML + plain-text are POSTed here and shipped
 * via Resend so there's no copy-paste step.
 *
 * Recipient: active portal-user emails, else client_links.client_email
 * (see resolveClientContactEmails). reply_to = the sending bookkeeper so
 * the client's answers land straight in their inbox.
 *
 * Body: { subject, html, text }
 * Returns: { ok, sent, recipients: string[] } or a 4xx with a reason the
 * modal surfaces (so "no email on file" tells the bookkeeper to use Copy
 * instead).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;

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

  // Resolve the client from the reclass job — never trust a client id from
  // the request body.
  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, client_link_id, client_name")
    .eq("id", jobId)
    .single();
  if (!job) return NextResponse.json({ error: "Reclass job not found" }, { status: 404 });
  const clientLinkId = (job as any).client_link_id as string;
  const clientName = (job as any).client_name || "your business";

  let body: { subject?: string; html?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const subject = (body.subject || "").trim().slice(0, 300);
  const html = (body.html || "").trim();
  const text = (body.text || "").trim();
  if (!subject || (!html && !text)) {
    return NextResponse.json(
      { error: "Subject and email body are required" },
      { status: 400 }
    );
  }

  const recipients = await resolveClientContactEmails(service, clientLinkId);
  if (recipients.length === 0) {
    return NextResponse.json(
      {
        error:
          "No email on file for this client. Use “Copy Email Body + Table” and paste it into Double instead.",
        reason: "no_recipient",
      },
      { status: 422 }
    );
  }

  const replyTo = (actor as any)?.email || "admin@ironbooks.com";
  // Tracked send: returns the Resend message id (durable proof it left our
  // side) and the REAL error string when it doesn't — so a failure surfaces
  // the actual cause (bad domain, missing key, bounce) instead of a generic
  // "try Copy" that hides why nothing arrived.
  const result = await sendResendEmailTracked({ to: recipients, subject, html, text, replyTo });

  // Log every attempt to client_email_log (queryable email history; the Resend
  // webhook later flips status delivered/bounced by matching provider_message_id).
  const nowIso = new Date().toISOString();
  try {
    await (service as any).from("client_email_log").insert(
      recipients.map((addr) => ({
        client_link_id: clientLinkId,
        to_address: addr,
        subject,
        email_type: "reclass_questions",
        status: result.ok ? "sent" : "failed",
        provider_message_id: result.messageId || null,
        error: result.ok ? null : result.error || "unknown",
        created_by: user.id,
        ts: nowIso,
      })) as any
    );
  } catch (e: any) {
    console.warn(`[email-questions] client_email_log insert failed: ${e?.message}`);
  }

  if (!result.ok) {
    return NextResponse.json(
      {
        error: `Email didn't send — ${result.error || "Resend rejected the request"}. Fix the issue or use “Copy for Double” as a fallback.`,
        reason: "send_failed",
      },
      { status: 502 }
    );
  }

  // Audit trail — queryable from /admin/audit (who emailed which client, when).
  await service.from("audit_log").insert({
    event_type: "reclass_questions_email_sent",
    user_id: user.id,
    request_payload: {
      reclass_job_id: jobId,
      client_link_id: clientLinkId,
      client_name: clientName,
      sent_by: (actor as any)?.full_name || (actor as any)?.email || user.id,
      recipients,
      subject,
      provider_message_id: result.messageId || null,
      sent_at: nowIso,
    } as any,
  });

  return NextResponse.json({ ok: true, sent: true, recipients, message_id: result.messageId || null });
}
