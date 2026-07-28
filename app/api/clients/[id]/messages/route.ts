import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  emailPortalUsersAboutMessage,
  type ClientCommunication,
} from "@/lib/client-comms";

export const dynamic = "force-dynamic";

/**
 * /api/clients/[id]/messages — bookkeeper side of the client thread.
 *
 * GET  → full thread for the client (internal roles incl. viewer)
 * POST → send a message or notification to the client (admin/lead/
 *        bookkeeper). Body: { kind: 'message'|'notification', subject?,
 *        body }. Persists first, then best-effort emails the client's
 *        active portal users so they know something is waiting.
 */

async function resolveInternalActor() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("id, role, full_name")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper", "viewer"].includes(role)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, role, service };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const auth = await resolveInternalActor();
  if ("error" in auth) return auth.error;
  const { service } = auth;

  const { data: rows, error } = await (service as any)
    .from("client_communications")
    .select("*")
    .eq("client_link_id", id)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const messages = ((rows as ClientCommunication[]) || []).reverse();

  // Names for both directions (client portal users + bookkeepers), plus
  // whoever dismissed each inbound row so the thread can say who cleared it.
  const nameIds = [
    ...new Set(
      messages.flatMap((m) => [m.sender_user_id, m.dismissed_by]).filter(Boolean)
    ),
  ] as string[];
  if (nameIds.length > 0) {
    const { data: senders } = await service
      .from("users")
      .select("id, full_name, email")
      .in("id", nameIds);
    const byId = new Map(((senders as any[]) || []).map((u) => [u.id, u.full_name || u.email]));
    for (const m of messages) {
      if (m.sender_user_id) m.sender_name = byId.get(m.sender_user_id) || null;
      if (m.dismissed_by) m.dismissed_by_name = byId.get(m.dismissed_by) || null;
    }
  }

  return NextResponse.json({ messages });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const auth = await resolveInternalActor();
  if ("error" in auth) return auth.error;
  const { user, role, service } = auth;
  if (role === "viewer") {
    return NextResponse.json({ error: "Viewers can't send messages" }, { status: 403 });
  }

  // Confirm the client exists + grab the name for the email subject
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, is_active")
    .eq("id", id)
    .single();
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  let payload: { kind?: string; subject?: string; body?: string; email_log_type?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const kind = payload.kind === "notification" ? "notification" : "message";
  // Optional: track this send in client_email_log (visible sent-status +
  // Resend sync). Used by the BS cleanup "Need from client" panel.
  const emailLogType = (payload.email_log_type || "").trim().slice(0, 40) || null;
  const subject = (payload.subject || "").trim().slice(0, 200) || null;
  const body = (payload.body || "").trim().slice(0, 8000);
  if (!body) {
    return NextResponse.json({ error: "Message body is required" }, { status: 400 });
  }

  const { data: inserted, error: insertErr } = await (service as any)
    .from("client_communications")
    .insert({
      client_link_id: id,
      sender_user_id: user.id,
      direction: "to_client",
      kind,
      subject,
      body,
    })
    .select("*")
    .single();
  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // Replying IS handling it — auto-dismiss this client's open inbound rows so
  // they drop out of the /today widget, the sidebar badge and the /clients
  // count. This is the "obvious it's been replied to" half of the model; the
  // explicit Dismiss button (POST /api/comms/dismiss) covers the rest.
  // read_at is set alongside so the thread stops rendering "● new".
  const nowIso = new Date().toISOString();
  await (service as any)
    .from("client_communications")
    .update({ read_at: nowIso, read_by: user.id, dismissed_at: nowIso, dismissed_by: user.id })
    .eq("client_link_id", id)
    .eq("direction", "from_client")
    .is("dismissed_at", null);

  // Refresh the server-rendered inbox surfaces so the cleared state shows
  // when the bookkeeper navigates back (they're force-dynamic, but this also
  // busts the client Router Cache for these paths on the next navigation).
  revalidatePath("/today");
  revalidatePath("/clients");

  // Best-effort email so the client knows to check their portal. The
  // outcome goes back to the composer so the bookkeeper is warned
  // IMMEDIATELY when the client won't be notified (no portal login,
  // send failure) — otherwise messages sit unseen until the next login.
  const emailDelivery = await emailPortalUsersAboutMessage(service, {
    clientLinkId: id,
    clientName: (client as any).client_name || "your business",
    kind,
    subject,
    body,
    portalOrigin: new URL(request.url).origin,
    ...(emailLogType ? { track: { emailType: emailLogType, createdBy: user.id } } : {}),
  });

  return NextResponse.json({ ok: true, message: inserted, email_delivery: emailDelivery });
}
