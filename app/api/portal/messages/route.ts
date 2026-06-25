import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import {
  validateAttachments,
  type ClientCommunication,
} from "@/lib/client-comms";

export const dynamic = "force-dynamic";

/**
 * /api/portal/messages — client side of the bookkeeper↔client thread.
 *
 * GET  → last 200 communications for the authed client's client_link,
 *        oldest-first (thread order), with bookkeeper sender names.
 * POST → send a message from the client. Body: { body, attachments? }.
 *        Attachments must already be uploaded via /upload-url; their
 *        paths are prefix-validated against the client's own folder.
 *        Mirrors the support-ticket pattern: row persisted first, then
 *        a best-effort email to admin@ironbooks.com.
 */
export async function GET() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;
  const service = createServiceSupabase();

  const { data: rows, error } = await (service as any)
    .from("client_communications")
    .select("*")
    .eq("client_link_id", ctx.clientLinkId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const messages = ((rows as ClientCommunication[]) || []).reverse();

  // Enrich bookkeeper-sent rows with the sender's display name
  const senderIds = [
    ...new Set(messages.filter((m) => m.direction === "to_client" && m.sender_user_id).map((m) => m.sender_user_id)),
  ] as string[];
  if (senderIds.length > 0) {
    const { data: senders } = await service
      .from("users")
      .select("id, full_name")
      .in("id", senderIds);
    const nameById = new Map(((senders as any[]) || []).map((u) => [u.id, u.full_name]));
    for (const m of messages) {
      if (m.direction === "to_client" && m.sender_user_id) {
        m.sender_name = nameById.get(m.sender_user_id) || null;
      }
    }
  }

  return NextResponse.json({ messages });
}

export async function POST(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  let payload: { body?: string; attachments?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const body = (payload.body || "").trim().slice(0, 8000);
  const attResult = validateAttachments(payload.attachments ?? [], ctx.clientLinkId);
  if (!attResult.ok) {
    return NextResponse.json({ error: attResult.error }, { status: 400 });
  }
  if (!body && attResult.attachments.length === 0) {
    return NextResponse.json({ error: "Write a message or attach a file" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { data: inserted, error: insertErr } = await (service as any)
    .from("client_communications")
    .insert({
      client_link_id: ctx.clientLinkId,
      sender_user_id: ctx.userId,
      direction: "from_client",
      kind: "message",
      body: body || null,
      attachments: attResult.attachments,
    })
    .select("*")
    .single();
  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // No internal email — client messages surface in-app only (the client_link's
  // Messages thread + the bookkeeper's unread badge / Today). Per the
  // no-internal-emails policy, the DB row is the only notification.

  return NextResponse.json({ ok: true, message: inserted });
}
