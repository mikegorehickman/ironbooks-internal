import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { sendPortalInviteEmail } from "@/lib/client-comms";
import { createActivationLink } from "@/lib/portal-invite";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/portal-users/send-login   { user_id }
 *
 * Email ONE portal user their branded 7-day login link (used by the
 * "Send login email" popup after adding a user, and the per-row re-send).
 * Confirms the auth email first so a never-clicked invite can still sign in —
 * same fix as the all-users resend, but scoped to a single user so adding a new
 * teammate doesn't spam the existing ones. Staff only (admin/lead/bookkeeper).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const targetUserId = String(body.user_id || "").trim();
  if (!targetUserId) return NextResponse.json({ error: "user_id required" }, { status: 400 });

  const { data: client } = await service
    .from("client_links")
    .select("client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  const clientName = (client as any).client_name || "your business";

  // The target must actually be an active portal user of THIS client.
  const { data: mapping } = await (service as any)
    .from("client_users")
    .select("user_id, first_login_at")
    .eq("client_link_id", clientLinkId)
    .eq("user_id", targetUserId)
    .eq("active", true)
    .maybeSingle();
  if (!mapping) {
    return NextResponse.json({ error: "This user isn't an active portal user on this client" }, { status: 404 });
  }

  const { data: target } = await service
    .from("users")
    .select("id, email, full_name")
    .eq("id", targetUserId)
    .single();
  if (!target || !(target as any).email) {
    return NextResponse.json({ error: "User has no email on file" }, { status: 400 });
  }
  const email = (target as any).email as string;

  try {
    // Confirm the email so sign-in works even if they never clicked the invite.
    await service.auth.admin.updateUserById(targetUserId, { email_confirm: true });

    const link = await createActivationLink(service, {
      userId: targetUserId,
      clientLinkId,
      email,
      createdBy: user.id,
    });
    if (!link) return NextResponse.json({ error: "Couldn't create the login link" }, { status: 500 });

    const ok = await sendPortalInviteEmail({
      to: email,
      fullName: (target as any).full_name || clientName,
      clientName,
      actionLink: link,
      isResend: !!(mapping as any).first_login_at, // wording only
    });
    if (!ok) return NextResponse.json({ error: `Couldn't send to ${email}` }, { status: 502 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Send failed" }, { status: 500 });
  }

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "portal_login_link_sent",
    request_payload: { client_link_id: clientLinkId, target_user_id: targetUserId, sent: [email] } as any,
  });

  return NextResponse.json({ ok: true, sent: email });
}
