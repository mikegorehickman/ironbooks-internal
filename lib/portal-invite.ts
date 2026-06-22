import { sendPortalInviteEmail } from "@/lib/client-comms";

/**
 * Provision (and optionally email) a client portal user. The single source of
 * truth for portal invites — used by the admin invite route AND the GHL
 * onboarding-form webhook (auto-invite), so the fiddly auth-user edge cases
 * (ghost rows, already-registered recovery, re-invites) live in one place.
 *
 * Effects:
 *   - New email           → Supabase auth invite (generateLink) + users row (role=client)
 *   - Existing internal   → refuse (won't downgrade staff to clients)
 *   - Existing client     → resend a fresh sign-in link
 *   - Ghost (viewer/null, no mapping) → upgrade to client
 *   - Upserts the client_users mapping (reactivates if soft-disabled)
 *
 * Does NOT write the audit log — the caller does, so each surface can record
 * its own event type. Returns a plain result; the caller maps it to a response.
 */
export interface ProvisionResult {
  ok: boolean;
  status: number;
  userId?: string;
  resend: boolean;
  silent: boolean;
  error?: string;
  message?: string;
}

export async function provisionPortalUser(
  service: any,
  opts: {
    email: string;
    fullName: string;
    clientLinkId: string;
    clientName?: string;
    /** false = create the account silently, no email (testing/impersonation). */
    sendInvite?: boolean;
    invitedBy?: string | null;
  }
): Promise<ProvisionResult> {
  const email = (opts.email || "").trim().toLowerCase();
  const fullName = (opts.fullName || "").trim();
  const clientLinkId = opts.clientLinkId;
  const sendInvite = opts.sendInvite !== false;
  const invitedBy = opts.invitedBy ?? null;

  if (!email || !fullName || !clientLinkId) {
    return { ok: false, status: 400, resend: false, silent: !sendInvite, error: "Missing required fields (email, full_name, client_link_id)" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, status: 400, resend: false, silent: !sendInvite, error: "Invalid email format" };
  }

  // Resolve the client name for the email if not supplied.
  let clientName: string = opts.clientName || "";
  if (!clientName) {
    const { data: client } = await service
      .from("client_links")
      .select("client_name")
      .eq("id", clientLinkId)
      .maybeSingle();
    if (!client) return { ok: false, status: 404, resend: false, silent: !sendInvite, error: "Client not found" };
    clientName = (client as any).client_name || "your business";
  }

  const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/callback`;

  const linkForExistingUser = async (): Promise<string | null> => {
    const ml = await service.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo } });
    if (ml?.data?.properties?.action_link) return ml.data.properties.action_link;
    const inv = await service.auth.admin.generateLink({
      type: "invite",
      email,
      options: { data: { full_name: fullName, role: "client" }, redirectTo },
    });
    return inv?.data?.properties?.action_link || null;
  };

  const { data: existing } = await service
    .from("users")
    .select("id, role, is_active, full_name")
    .eq("email", email)
    .maybeSingle();

  let userId: string;
  let isResend = false;

  if (existing) {
    const existingRole = (existing as any).role;
    if (existingRole !== "client") {
      const isPossibleGhost = !existingRole || existingRole === "viewer";
      if (isPossibleGhost) {
        const { data: anyMapping } = await service
          .from("client_users")
          .select("id")
          .eq("user_id", (existing as any).id)
          .maybeSingle();
        if (!anyMapping) {
          // Ghost row — upgrade to client.
          userId = (existing as any).id;
          await service
            .from("users")
            .update({
              role: "client",
              full_name: fullName || (existing as any).full_name,
              is_active: true,
              invited_by: invitedBy,
              invited_at: new Date().toISOString(),
            })
            .eq("id", userId);
          if (sendInvite) {
            const link = await linkForExistingUser();
            if (link) {
              await sendPortalInviteEmail({ to: email, fullName, clientName, actionLink: link, isResend: false });
            }
          }
        } else {
          return { ok: false, status: 409, resend: false, silent: !sendInvite, error: "This email already has portal access. Use resend instead." };
        }
      } else {
        return { ok: false, status: 409, resend: false, silent: !sendInvite, error: `This email is already an internal user (role=${existingRole}).` };
      }
    } else {
      // Already a client → resend.
      userId = (existing as any).id;
      isResend = true;
      if (!(existing as any).is_active) {
        await service.from("users").update({ is_active: true }).eq("id", userId);
      }
      if (sendInvite) {
        const link = await linkForExistingUser();
        if (!link) return { ok: false, status: 500, resend: true, silent: false, error: "Resend failed: could not generate a sign-in link" };
        await sendPortalInviteEmail({ to: email, fullName, clientName, actionLink: link, isResend: true });
      }
    }
  } else {
    // No public.users row. Create the auth user + branded invite.
    let authResponse: any;
    const isAlreadyRegistered = (msg: string) => /already.*registered|already.*been.*registered|user.*already.*exists/i.test(msg);
    const recoverExistingAuthUser = async (): Promise<{ user: any } | null> => {
      try {
        const { data: list } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const match = list?.users?.find((u: any) => (u.email || "").toLowerCase() === email);
        return match ? { user: match } : null;
      } catch {
        return null;
      }
    };

    if (sendInvite) {
      const { data, error: inviteErr } = await service.auth.admin.generateLink({
        type: "invite",
        email,
        options: { data: { full_name: fullName, role: "client" }, redirectTo },
      });
      let inviteLink: string | null = data?.properties?.action_link || null;
      if (inviteErr || !data?.user) {
        if (inviteErr && isAlreadyRegistered(inviteErr.message)) {
          const recovered = await recoverExistingAuthUser();
          if (!recovered) return { ok: false, status: 500, resend: false, silent: false, error: `Email registered but couldn't recover auth user: ${inviteErr.message}` };
          authResponse = recovered;
          inviteLink = await linkForExistingUser();
        } else {
          return { ok: false, status: 500, resend: false, silent: false, error: inviteErr?.message || "Invite failed" };
        }
      } else {
        authResponse = data;
      }
      if (inviteLink) {
        await sendPortalInviteEmail({ to: email, fullName, clientName, actionLink: inviteLink, isResend: false });
      }
    } else {
      const { data, error: createErr } = await service.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { full_name: fullName, role: "client" },
      });
      if (createErr || !data?.user) {
        if (createErr && isAlreadyRegistered(createErr.message)) {
          const recovered = await recoverExistingAuthUser();
          if (!recovered) return { ok: false, status: 500, resend: false, silent: true, error: `Email registered but couldn't recover auth user: ${createErr.message}` };
          authResponse = recovered;
        } else {
          return { ok: false, status: 500, resend: false, silent: true, error: createErr?.message || "Silent create failed" };
        }
      } else {
        authResponse = data;
      }
    }
    userId = authResponse.user.id;

    const { error: upsertErr } = await service.from("users").upsert(
      { id: userId, email, full_name: fullName, role: "client", is_active: true, invited_by: invitedBy, invited_at: new Date().toISOString() },
      { onConflict: "id" }
    );
    if (upsertErr) return { ok: false, status: 500, resend: false, silent: !sendInvite, error: `User row upsert failed: ${upsertErr.message}` };
  }

  // client_users mapping (one portal user → one client).
  const { data: existingMapping } = await service
    .from("client_users")
    .select("id, client_link_id, active")
    .eq("user_id", userId)
    .maybeSingle();
  if (existingMapping) {
    const m = existingMapping as any;
    if (m.client_link_id !== clientLinkId) {
      return { ok: false, status: 409, resend: isResend, silent: !sendInvite, error: "This user is already mapped to a different client." };
    }
    if (!m.active) await service.from("client_users").update({ active: true }).eq("id", m.id);
  } else {
    const { error: mapErr } = await service.from("client_users").insert({
      user_id: userId,
      client_link_id: clientLinkId,
      invited_by: invitedBy,
      invited_at: new Date().toISOString(),
      active: true,
    });
    if (mapErr) return { ok: false, status: 500, resend: isResend, silent: !sendInvite, error: `Mapping insert failed: ${mapErr.message}` };
  }

  return {
    ok: true,
    status: 200,
    userId,
    resend: isResend,
    silent: !sendInvite,
    message: isResend ? `Magic link re-sent to ${email}` : sendInvite ? `Invite sent to ${email}` : `Account created silently for ${email}`,
  };
}
