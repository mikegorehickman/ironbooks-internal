import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { sendPortalInviteEmail } from "@/lib/client-comms";
import { createActivationLink } from "@/lib/portal-invite";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/resend-portal-invite
 *
 * Re-send the portal login (magic) link to a client's active portal user(s) —
 * for expired links or "I can't log in." Also CONFIRMS the auth email first, so
 * a client who was invited but never clicked the original link can sign in
 * (an unconfirmed user can't request a magic link on an invite-only instance).
 * Staff only (admin/lead/bookkeeper).
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: client } = await service
    .from("client_links")
    .select("client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  const clientName = (client as any).client_name || "your business";

  // Active portal users mapped to this client.
  const { data: maps } = await (service as any)
    .from("client_users")
    .select("user_id")
    .eq("client_link_id", clientLinkId)
    .eq("active", true);
  if (!maps || maps.length === 0) {
    return NextResponse.json(
      { error: "No portal user on file yet — invite the client to the portal first." },
      { status: 400 }
    );
  }
  const { data: users } = await service
    .from("users")
    .select("id, email, full_name")
    .in("id", maps.map((m: any) => m.user_id));

  const sent: string[] = [];
  const failed: string[] = [];

  for (const u of (users || []) as any[]) {
    if (!u.email) continue;
    try {
      // Confirm the email so sign-in works even if they never clicked the
      // original invite (root cause of "can't log in").
      await service.auth.admin.updateUserById(u.id, { email_confirm: true });

      // 7-day activation link (mints a fresh Supabase link at click time), so
      // the emailed link works for a week instead of ≤24h.
      const link = await createActivationLink(service, {
        userId: u.id,
        clientLinkId,
        email: u.email,
        createdBy: user.id,
      });
      if (!link) { failed.push(u.email); continue; }

      const ok = await sendPortalInviteEmail({
        to: u.email,
        fullName: u.full_name || clientName,
        clientName,
        actionLink: link,
        isResend: true,
      });
      (ok ? sent : failed).push(u.email);
    } catch {
      failed.push(u.email);
    }
  }

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "portal_login_link_resent",
    request_payload: { client_link_id: clientLinkId, sent, failed } as any,
  });

  return NextResponse.json({ ok: sent.length > 0, sent, failed });
}
