import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { sendPortalInviteEmail } from "@/lib/client-comms";
import { NextResponse } from "next/server";

/**
 * POST /api/admin/invite-client
 *
 * Sends a magic-link signup invitation to a client and provisions them
 * for the portal. Idempotent enough to handle re-invites of existing
 * client users.
 *
 * Body:
 *   { email, full_name, client_link_id }
 *
 * Effects (in order, with rollback-style cleanup on later failures):
 *   1. Validate caller is admin/lead
 *   2. Validate the client_link_id exists
 *   3. Check users.email — three branches:
 *        a) New email           → Supabase auth invite + insert users row (role=client)
 *        b) Existing internal   → reject (won't downgrade staff to clients)
 *        c) Existing client     → re-send invite (no row insert), update client_users
 *   4. Upsert client_users row (user_id, client_link_id) — flips active=true
 *      if it was soft-disabled
 *   5. Audit log
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
    return NextResponse.json(
      { error: "Forbidden — admin or lead required" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({} as any));
  const email = (body.email || "").trim().toLowerCase();
  const fullName = (body.full_name || "").trim();
  const clientLinkId = body.client_link_id;
  // When false: provision the account silently (no email sent). Used for
  // testing — admin can immediately impersonate the user to walk the
  // portal. Default true preserves the original invite-and-email behavior.
  const sendInvite: boolean = body.send_invite !== false;

  if (!email || !fullName || !clientLinkId) {
    return NextResponse.json(
      { error: "Missing required fields (email, full_name, client_link_id)" },
      { status: 400 }
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
  }

  // 2. Validate client_link exists
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // 3. Check existing user
  const { data: existing } = await service
    .from("users")
    .select("id, role, is_active, full_name")
    .eq("email", email)
    .maybeSingle();

  let userId: string;
  let isResend = false;

  const clientName = (client as any).client_name || "your business";
  const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/callback`;

  // Generate a sign-in link for an auth user we know already exists (resend /
  // ghost recovery). magiclink covers confirmed users; invite is the fallback
  // for a not-yet-confirmed account. Returns the action_link or null. NOTE:
  // generateLink does NOT send an email — we send our own branded one.
  const linkForExistingUser = async (): Promise<string | null> => {
    const ml = await (service as any).auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo },
    });
    if (ml?.data?.properties?.action_link) return ml.data.properties.action_link;
    const inv = await (service as any).auth.admin.generateLink({
      type: "invite",
      email,
      options: { data: { full_name: fullName, role: "client" }, redirectTo },
    });
    return inv?.data?.properties?.action_link || null;
  };

  if (existing) {
    const existingRole = (existing as any).role;

    // Ghost-row recovery: Supabase projects with handle_new_user triggers
    // auto-create a public.users row when auth.users gets one. If a previous
    // invite attempt failed mid-flight, you can end up with that orphan
    // row stamped at the trigger's default role (often 'viewer' or NULL)
    // and NO client_users mapping. Detect that case and treat as a fresh
    // invite so the admin doesn't get stuck on "email already exists".
    if (existingRole !== "client") {
      const isPossibleGhost = !existingRole || existingRole === "viewer";
      if (isPossibleGhost) {
        const { data: anyMapping } = await service
          .from("client_users" as any)
          .select("id")
          .eq("user_id", (existing as any).id)
          .maybeSingle();
        if (!anyMapping) {
          // Ghost confirmed — upgrade to client via the upsert below.
          userId = (existing as any).id;
          await service
            .from("users")
            .update({
              role: "client",
              full_name: fullName || (existing as any).full_name,
              is_active: true,
              invited_by: user.id,
              invited_at: new Date().toISOString(),
            } as any)
            .eq("id", userId);

          // If this is a silent-create, we're done with the auth side —
          // the auth.users row already exists. Skip to the mapping insert.
          // For invite path, generate a sign-in link and send our own branded
          // email (generateLink does not send one).
          if (sendInvite) {
            const link = await linkForExistingUser();
            if (link) {
              await sendPortalInviteEmail({
                to: email,
                fullName,
                clientName,
                actionLink: link,
                isResend: false, // it's a fresh-from-the-user's-POV invite
              });
            }
            isResend = false;
          }
          // Fall through to the mapping upsert below
        } else {
          return NextResponse.json(
            {
              error: `This email already has portal access. Use the resend button instead.`,
            },
            { status: 409 }
          );
        }
      } else {
        // Hard block on downgrading an internal user (admin/lead/bookkeeper).
        return NextResponse.json(
          {
            error: `This email is already in the system as an internal user (role=${existingRole}). Pick a different email or have an admin re-classify the existing user.`,
          },
          { status: 409 }
        );
      }
    } else {
      // ── existing user IS already role='client' ──
      userId = (existing as any).id;
      isResend = true;

      // Bump them back to active if they were soft-disabled.
      if (!(existing as any).is_active) {
        await service.from("users").update({ is_active: true } as any).eq("id", userId);
      }

      // For silent re-creates, we just want to re-ensure their client_users
      // mapping is active — no email. Skip the link generation entirely.
      if (sendInvite) {
        // Generate a fresh sign-in link and send our own branded email.
        const link = await linkForExistingUser();
        if (!link) {
          return NextResponse.json(
            { error: "Resend failed: could not generate a sign-in link" },
            { status: 500 }
          );
        }
        await sendPortalInviteEmail({
          to: email,
          fullName,
          clientName,
          actionLink: link,
          isResend: true,
        });
      }
    } // close the "existing user IS already a client" else branch
  } else {
    // 3a. No public.users row for this email. Two scenarios:
    //   - Genuinely new user — create them
    //   - auth.users HAS them but public.users doesn't (e.g. admin manually
    //     deleted the public.users row between attempts, or the trigger
    //     didn't fire). createUser/inviteUserByEmail will fail with "already
    //     registered" — we recover by looking up the existing auth user.
    let authResponse: any;
    const recoverExistingAuthUser = async (): Promise<{ user: any } | null> => {
      try {
        // Supabase admin listUsers paginates. For our scale 1000 is plenty;
        // if you hit this limit, the recovery still works for any user on page 1.
        const { data: list } = await (service as any).auth.admin.listUsers({
          page: 1,
          perPage: 1000,
        });
        const match = list?.users?.find(
          (u: any) => (u.email || "").toLowerCase() === email
        );
        return match ? { user: match } : null;
      } catch {
        return null;
      }
    };

    const isAlreadyRegistered = (msg: string) =>
      /already.*registered|already.*been.*registered|user.*already.*exists/i.test(msg);

    if (sendInvite) {
      // generateLink type:"invite" CREATES the auth user and returns the
      // sign-in link WITHOUT sending Supabase's bare default email — we send
      // our own branded one below.
      const { data, error: inviteErr } = await (service as any).auth.admin.generateLink({
        type: "invite",
        email,
        options: { data: { full_name: fullName, role: "client" }, redirectTo },
      });
      let inviteLink: string | null = data?.properties?.action_link || null;
      if (inviteErr || !data?.user) {
        if (inviteErr && isAlreadyRegistered(inviteErr.message)) {
          // Recover — auth user exists, just couldn't re-invite
          const recovered = await recoverExistingAuthUser();
          if (!recovered) {
            return NextResponse.json(
              { error: `Email is registered but couldn't recover the auth user: ${inviteErr.message}` },
              { status: 500 }
            );
          }
          authResponse = recovered;
          // Re-issue a magic link for the branded email (works on confirmed users)
          inviteLink = await linkForExistingUser();
        } else {
          return NextResponse.json(
            { error: inviteErr?.message || "Invite failed" },
            { status: 500 }
          );
        }
      } else {
        authResponse = data;
      }
      if (inviteLink) {
        await sendPortalInviteEmail({
          to: email,
          fullName,
          clientName,
          actionLink: inviteLink,
          isResend: false,
        });
      }
    } else {
      const { data, error: createErr } = await (service as any).auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { full_name: fullName, role: "client" },
      });
      if (createErr || !data?.user) {
        if (createErr && isAlreadyRegistered(createErr.message)) {
          const recovered = await recoverExistingAuthUser();
          if (!recovered) {
            return NextResponse.json(
              { error: `Email is registered but couldn't recover the auth user: ${createErr.message}` },
              { status: 500 }
            );
          }
          authResponse = recovered;
        } else {
          return NextResponse.json(
            { error: createErr?.message || "Silent create failed" },
            { status: 500 }
          );
        }
      } else {
        authResponse = data;
      }
    }
    userId = authResponse.user.id;

    // UPSERT (not INSERT) — Supabase projects commonly have a handle_new_user
    // trigger on auth.users that auto-creates a public.users row with default
    // role (often 'viewer'). Our explicit row needs to override those defaults
    // without colliding on the primary key. Same logic applies to both the
    // invite path and the silent-create path.
    const { error: upsertErr } = await service.from("users").upsert(
      {
        id: userId,
        email,
        full_name: fullName,
        role: "client",
        is_active: true,
        invited_by: user.id,
        invited_at: new Date().toISOString(),
      } as any,
      { onConflict: "id" }
    );
    if (upsertErr) {
      return NextResponse.json(
        { error: `User row upsert failed: ${upsertErr.message}` },
        { status: 500 }
      );
    }
  }

  // 4. Upsert client_users mapping. Unique on user_id means re-invites for
  //    a different client will conflict — that's intentional (one portal
  //    user → one client). The admin must explicitly transfer if needed.
  const { data: existingMapping } = await service
    .from("client_users" as any)
    .select("id, client_link_id, active")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingMapping) {
    const m = existingMapping as any;
    if (m.client_link_id !== clientLinkId) {
      return NextResponse.json(
        {
          error: `This user is already mapped to a different client. Remove their existing mapping first if you want to re-assign them.`,
        },
        { status: 409 }
      );
    }
    // Reactivate if it was soft-disabled
    if (!m.active) {
      await service
        .from("client_users" as any)
        .update({ active: true } as any)
        .eq("id", m.id);
    }
  } else {
    const { error: mapErr } = await service.from("client_users" as any).insert({
      user_id: userId,
      client_link_id: clientLinkId,
      invited_by: user.id,
      invited_at: new Date().toISOString(),
      active: true,
    } as any);
    if (mapErr) {
      return NextResponse.json(
        { error: `Mapping insert failed: ${mapErr.message}` },
        { status: 500 }
      );
    }
  }

  // 5. Audit log
  await service.from("audit_log").insert({
    event_type: isResend
      ? "client_invite_resent"
      : sendInvite ? "client_invited" : "client_silent_created",
    user_id: user.id,
    request_payload: {
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      invited_email: email,
      invited_full_name: fullName,
      resend: isResend,
      silent: !sendInvite,
    } as any,
  });

  return NextResponse.json({
    ok: true,
    user_id: userId,
    resend: isResend,
    silent: !sendInvite,
    message: isResend
      ? `Magic link re-sent to ${email}`
      : sendInvite
        ? `Invite sent to ${email}`
        : `Account created silently for ${email} (no email sent)`,
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
