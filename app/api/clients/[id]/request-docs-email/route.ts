import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { sendResendEmailTracked } from "@/lib/client-comms";

export const dynamic = "force-dynamic";

/**
 * Document-request email for the BS Cleanup "Need from client" panel.
 *
 * GET  → { emails } — the client's active portal-user emails, used to
 *        prefill the To field (empty for clients with no portal yet).
 * POST → { to: string[], subject, html, text } — sends the branded email
 *        via Resend, mirrors the plain-text body into the client's
 *        message thread (so there's a trail + it's visible if/when they
 *        get a portal), and audit-logs the send.
 *
 * The HTML comes from the modal preview so what the bookkeeper SAW is
 * exactly what gets sent — internal staff only, same trust level as the
 * copy-paste path it replaces.
 */

async function resolveStaff() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, service };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const auth = await resolveStaff();
  if ("error" in auth) return auth.error;
  const { service } = auth;

  const { data: mappings } = await (service as any)
    .from("client_users")
    .select("user_id")
    .eq("client_link_id", id)
    .eq("active", true);
  const userIds = ((mappings as any[]) || []).map((m) => m.user_id).filter(Boolean);
  let emails: string[] = [];
  if (userIds.length > 0) {
    const { data: users } = await service
      .from("users")
      .select("email")
      .in("id", userIds)
      .eq("is_active", true);
    emails = ((users as any[]) || []).map((u) => u.email).filter(Boolean);
  }
  return NextResponse.json({ emails });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const auth = await resolveStaff();
  if ("error" in auth) return auth.error;
  const { user, service } = auth;

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", id)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  let body: { to?: string[]; subject?: string; html?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const to = (Array.isArray(body.to) ? body.to : [])
    .map((e) => String(e).trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e))
    .slice(0, 10);
  if (to.length === 0) {
    return NextResponse.json({ error: "At least one valid email address is required" }, { status: 400 });
  }
  const subject = String(body.subject || "").trim().slice(0, 200);
  const html = String(body.html || "").slice(0, 100_000);
  const text = String(body.text || "").trim().slice(0, 20_000);
  if (!subject || !text) {
    return NextResponse.json({ error: "Subject and body are required" }, { status: 400 });
  }

  const sent = await sendResendEmailTracked({
    to,
    subject,
    text,
    html: html || undefined,
    replyTo: process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com",
  });
  if (!sent.ok) {
    return NextResponse.json(
      { error: sent.error || "Resend rejected the send — check RESEND_API_KEY / domain setup and try again." },
      { status: 502 }
    );
  }

  // Log the send so it shows in the "Request emails sent" line + syncs from
  // Resend (same email_type as the portal-message send path).
  try {
    await (service as any).from("client_email_log").insert({
      client_link_id: id,
      to_address: to.join(", "),
      email_type: "bs_statements",
      subject,
      status: "sent",
      provider_message_id: sent.messageId ?? null,
      created_by: user.id,
    });
  } catch (e: any) {
    console.warn(`[request-docs-email] client_email_log insert failed: ${e?.message}`);
  }

  // Trail: the request lives in the client's message thread too, marked
  // as emailed directly so nobody re-sends it from the portal flow.
  await (service as any).from("client_communications").insert({
    client_link_id: id,
    sender_user_id: user.id,
    direction: "to_client",
    kind: "message",
    subject,
    body: `${text}\n\n— Sent by email to ${to.join(", ")}`,
  });

  await service.from("audit_log").insert({
    event_type: "request_docs_email_sent",
    user_id: user.id,
    request_payload: {
      client_link_id: id,
      client_name: (client as any).client_name,
      recipients: to,
      subject,
    } as any,
  });

  return NextResponse.json({ ok: true, recipients: to.length });
}
