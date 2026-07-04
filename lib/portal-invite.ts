import { randomBytes } from "crypto";
import { sendPortalInviteEmail } from "@/lib/client-comms";

/** How long an emailed activation link stays valid. */
export const ACTIVATION_TTL_DAYS = 7;

/**
 * Create a 7-day activation link for a portal user. Stores a high-entropy token
 * and returns the /auth/activate URL to email. Clicking it within 7 days mints
 * a fresh Supabase sign-in link server-side (see app/auth/activate) — so the
 * link the client holds works for a full week, despite Supabase magic links
 * themselves expiring in ≤24h. Returns null if the token couldn't be stored
 * (e.g. table not migrated yet) so callers can fall back to a raw link.
 */
export async function createActivationLink(
  service: any,
  opts: { userId: string; clientLinkId: string; email: string; createdBy?: string | null }
): Promise<string | null> {
  try {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + ACTIVATION_TTL_DAYS * 86400000).toISOString();
    const { error } = await service.from("portal_invite_tokens").insert({
      token,
      user_id: opts.userId,
      client_link_id: opts.clientLinkId,
      email: (opts.email || "").toLowerCase(),
      expires_at: expiresAt,
      created_by: opts.createdBy ?? null,
    });
    if (error) return null;
    const base = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    return `${base}/auth/activate?token=${token}`;
  } catch {
    return null;
  }
}

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
          // Invite email is sent once at the end (7-day activation link).
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
      // Invite/resend email is sent once at the end (7-day activation link).
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
      // generateLink(type:invite) creates the auth user; we email a 7-day
      // activation link at the end rather than this raw (≤24h) link.
      if (inviteErr || !data?.user) {
        if (inviteErr && isAlreadyRegistered(inviteErr.message)) {
          const recovered = await recoverExistingAuthUser();
          if (!recovered) return { ok: false, status: 500, resend: false, silent: false, error: `Email registered but couldn't recover auth user: ${inviteErr.message}` };
          authResponse = recovered;
        } else {
          return { ok: false, status: 500, resend: false, silent: false, error: inviteErr?.message || "Invite failed" };
        }
      } else {
        authResponse = data;
        // generateLink(type:invite) creates the user UNCONFIRMED. The self-serve
        // login form (signInWithOtp) then rejects them ("we don't have a portal
        // account") when signups are disabled, until they click the emailed link
        // once. Confirm the email now so the login form works immediately too.
        try {
          if (data.user?.id) await service.auth.admin.updateUserById(data.user.id, { email_confirm: true });
        } catch { /* non-fatal — the emailed link still works */ }
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

  // Email a single 7-day activation link (mints a fresh Supabase sign-in link
  // at click time), so the invite/resend link works for a full week instead of
  // Supabase's ≤24h. Falls back to silent provisioning if the link can't be made.
  if (sendInvite) {
    let actionLink = await createActivationLink(service, { userId, clientLinkId, email, createdBy: invitedBy });
    if (!actionLink) {
      // Fallback (e.g. migration 92 not applied yet) — raw Supabase link (≤24h)
      // so the invite still goes out rather than silently sending nothing.
      const ml = await service.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo } });
      actionLink = ml?.data?.properties?.action_link || null;
      if (!actionLink) {
        const inv = await service.auth.admin.generateLink({
          type: "invite",
          email,
          options: { data: { full_name: fullName, role: "client" }, redirectTo },
        });
        actionLink = inv?.data?.properties?.action_link || null;
      }
    }
    if (actionLink) {
      await sendPortalInviteEmail({ to: email, fullName, clientName, actionLink, isResend });
    }
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
