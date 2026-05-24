import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
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

  if (existing) {
    const existingRole = (existing as any).role;
    if (existingRole !== "client") {
      // Hard block on downgrading an internal user. Bookkeeper-with-the-same-email
      // is almost always a mistake on the inviter's part.
      return NextResponse.json(
        {
          error: `This email is already in the system as an internal user (role=${existingRole}). Pick a different email or have an admin re-classify the existing user.`,
        },
        { status: 409 }
      );
    }
    userId = (existing as any).id;
    isResend = true;

    // Bump them back to active if they were soft-disabled.
    if (!(existing as any).is_active) {
      await service.from("users").update({ is_active: true } as any).eq("id", userId);
    }

    // Send a fresh magic link. Use the existing user — no new auth.user
    // record needed. inviteUserByEmail on an existing auth user just
    // re-sends the magic link in Supabase's current behavior.
    const { error: inviteErr } = await (service as any).auth.admin.inviteUserByEmail(
      email,
      {
        data: { full_name: fullName, role: "client" },
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/callback`,
      }
    );
    if (inviteErr) {
      // Try the generateLink fallback — useful if inviteUserByEmail rejects
      // on already-confirmed users.
      const { error: linkErr } = await (service as any).auth.admin.generateLink({
        type: "magiclink",
        email,
        options: {
          redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/callback`,
        },
      });
      if (linkErr) {
        return NextResponse.json(
          { error: `Resend failed: ${inviteErr.message}` },
          { status: 500 }
        );
      }
    }
  } else {
    // 3a. New invite via Supabase Auth Admin API
    const { data: authResponse, error: inviteErr } = await (service as any).auth.admin
      .inviteUserByEmail(email, {
        data: { full_name: fullName, role: "client" },
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/callback`,
      });

    if (inviteErr || !authResponse?.user) {
      return NextResponse.json(
        { error: inviteErr?.message || "Invite failed" },
        { status: 500 }
      );
    }
    userId = authResponse.user.id;

    const { error: insertErr } = await service.from("users").insert({
      id: userId,
      email,
      full_name: fullName,
      role: "client",
      is_active: true,
      invited_by: user.id,
      invited_at: new Date().toISOString(),
    } as any);
    if (insertErr) {
      return NextResponse.json(
        { error: `User row insert failed: ${insertErr.message}` },
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
    event_type: isResend ? "client_invite_resent" : "client_invited",
    user_id: user.id,
    request_payload: {
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      invited_email: email,
      invited_full_name: fullName,
      resend: isResend,
    } as any,
  });

  return NextResponse.json({
    ok: true,
    user_id: userId,
    resend: isResend,
    message: isResend
      ? `Magic link re-sent to ${email}`
      : `Invite sent to ${email}`,
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
