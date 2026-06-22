import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { provisionPortalUser } from "@/lib/portal-invite";
import { NextResponse } from "next/server";

/**
 * POST /api/admin/invite-client
 *
 * Sends a magic-link signup invitation to a client and provisions them for the
 * portal. The auth-user provisioning (new/ghost/existing/resend + branded
 * email) lives in lib/portal-invite (shared with the GHL onboarding webhook).
 * This route handles caller auth, client validation, audit, and the response.
 *
 * Body: { email, full_name, client_link_id, send_invite? }
 *   send_invite=false provisions silently (no email) for impersonation/testing.
 */

const ALLOWED_INVITER_ROLES = new Set(["admin", "lead"]);

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!ALLOWED_INVITER_ROLES.has((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const email = (body.email || "").trim().toLowerCase();
  const fullName = (body.full_name || "").trim();
  const clientLinkId = body.client_link_id;
  const sendInvite: boolean = body.send_invite !== false;

  if (!email || !fullName || !clientLinkId) {
    return NextResponse.json(
      { error: "Missing required fields (email, full_name, client_link_id)" },
      { status: 400 }
    );
  }

  // Validate the client exists (also gives us the name for the email).
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const result = await provisionPortalUser(service, {
    email,
    fullName,
    clientLinkId,
    clientName: (client as any).client_name || "your business",
    sendInvite,
    invitedBy: user.id,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await service.from("audit_log").insert({
    event_type: result.resend
      ? "client_invite_resent"
      : sendInvite ? "client_invited" : "client_silent_created",
    user_id: user.id,
    request_payload: {
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      invited_email: email,
      invited_full_name: fullName,
      resend: result.resend,
      silent: !sendInvite,
    } as any,
  });

  return NextResponse.json({
    ok: true,
    user_id: result.userId,
    resend: result.resend,
    silent: result.silent,
    message: result.message,
  });
}

/**
 * DELETE /api/admin/invite-client?user_id=...
 *
 * Soft-disables a client_users mapping. The user can no longer access the
 * portal but their history (chat, etc) is preserved for when they're
 * re-enabled. To fully delete, also delete the auth user — but that
 * cascades to all owned rows so we keep this safer-by-default.
 */
export async function DELETE(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!ALLOWED_INVITER_ROLES.has((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const targetUserId = searchParams.get("user_id");
  if (!targetUserId) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  const { data: mapping } = await service
    .from("client_users" as any)
    .select("client_link_id")
    .eq("user_id", targetUserId)
    .single();
  if (!mapping) {
    return NextResponse.json({ error: "Mapping not found" }, { status: 404 });
  }

  await service
    .from("client_users" as any)
    .update({ active: false } as any)
    .eq("user_id", targetUserId);

  await service.from("audit_log").insert({
    event_type: "client_access_revoked",
    user_id: user.id,
    request_payload: {
      target_user_id: targetUserId,
      client_link_id: (mapping as any).client_link_id,
    } as any,
  });

  return NextResponse.json({ ok: true });
}
