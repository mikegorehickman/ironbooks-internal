import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { deliverClientEmail } from "@/lib/ask-client-email";

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
  // One shared delivery path (resolve → send → log → audit). See
  // lib/ask-client-email.ts. Reclass keeps its own "Copy for Double" fallback
  // wording via the message overrides.
  const r = await deliverClientEmail({
    service,
    clientLinkId,
    clientName,
    userId: user.id,
    actor: actor as any,
    subject: body.subject || "",
    html: body.html || "",
    text: body.text || "",
    emailType: "reclass_questions",
    auditEventType: "reclass_questions_email_sent",
    auditExtra: { reclass_job_id: jobId },
    noRecipientMessage:
      "No email on file for this client. Use “Copy Email Body + Table” and send it manually instead.",
    sendFailedMessage: (err) =>
      `Email didn't send — ${err}. Fix the issue or use “Copy Email Body + Table” as a fallback.`,
  });
  return NextResponse.json(r.body, { status: r.status });
}
