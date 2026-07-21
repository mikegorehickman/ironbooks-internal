import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { deliverClientEmail } from "@/lib/ask-client-email";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/ask-client
 *
 * The generic ask-client send endpoint behind the shared AskClientComposer.
 * Any client-scoped surface (P&L drill, an account view, a cleanup step) can
 * open the composer and post here; it delegates to the one delivery path
 * (lib/ask-client-email.ts) so branding, delivery proof and the unified
 * client_email_log history are identical everywhere.
 *
 * Body: { subject, html, text, email_type?, context? }
 * email_type is whitelisted so the log stays clean; unknown → "ask_client".
 */
const ALLOWED_TYPES = new Set([
  "ask_client",
  "ask_client_txns",
  "reclass_questions",
  "statement_request",
  "docs_request",
  "statements_ready",
  "portal_help",
  "general",
]);

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

  let body: {
    subject?: string;
    html?: string;
    text?: string;
    email_type?: string;
    context?: Record<string, any>;
    /** Also drop this into the client's portal inbox (client_communications)
     *  so they see it whether or not they open email. Used by the profile
     *  "Send email" drawer. No extra email — the branded send above is it. */
    portal_message?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const emailType =
    body.email_type && ALLOWED_TYPES.has(body.email_type) ? body.email_type : "ask_client";

  const r = await deliverClientEmail({
    service,
    clientLinkId,
    clientName: (client as any).client_name,
    userId: user.id,
    actor: actor as any,
    subject: body.subject || "",
    html: body.html || "",
    text: body.text || "",
    emailType,
    auditEventType: "ask_client_email_sent",
    auditExtra: { email_type: emailType, ...(body.context || {}) },
  });

  // Best-effort portal mirror. Only on a successful send, and never fatal —
  // the email already went out; a portal-insert hiccup shouldn't 500 the send.
  if (body.portal_message && r.status >= 200 && r.status < 300) {
    try {
      await (service as any).from("client_communications").insert({
        client_link_id: clientLinkId,
        sender_user_id: user.id,
        direction: "to_client",
        kind: "notification",
        subject: (body.subject || "").trim().slice(0, 200) || null,
        body: (body.text || "").trim().slice(0, 8000) || (body.subject || ""),
      });
    } catch (e: any) {
      console.warn(`[ask-client ${clientLinkId}] portal mirror failed:`, e?.message);
    }
  }

  return NextResponse.json(r.body, { status: r.status });
}
