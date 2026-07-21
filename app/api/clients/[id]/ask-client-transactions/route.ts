import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { deliverClientEmail } from "@/lib/ask-client-email";

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
  // One shared delivery path (resolve → send → log → audit). See
  // lib/ask-client-email.ts.
  const r = await deliverClientEmail({
    service,
    clientLinkId,
    clientName: (client as any).client_name,
    userId: user.id,
    actor: actor as any,
    subject: body.subject || "",
    html: body.html || "",
    text: body.text || "",
    emailType: "ask_client_txns",
    auditEventType: "ask_client_transactions_email_sent",
    auditExtra: {
      account_name: body.account_name || null,
      transaction_count: body.transaction_count || null,
    },
  });
  return NextResponse.json(r.body, { status: r.status });
}
