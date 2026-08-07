import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { provisionPortalUser } from "@/lib/portal-invite";
import { sanitizeAllowedPages } from "@/lib/portal-pages";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Portal-user management for a single client account.
 *
 *   GET    /api/clients/[id]/portal-users        list the client's portal users
 *   POST   /api/clients/[id]/portal-users        add a user (role=client), with an
 *                                                 optional allowed_pages page list
 *   PATCH  /api/clients/[id]/portal-users        update a user's allowed_pages
 *   DELETE /api/clients/[id]/portal-users?user_id revoke a user's access
 *
 * Every portal user gets role=client and is mapped to this one client_link.
 * Per-user PAGE access is controlled via client_users.allowed_pages
 * (NULL = every page; see lib/portal-pages.ts) — enforced by middleware and
 * mirrored in the portal sidebar.
 *
 * ── FUTURE: paid seats ──────────────────────────────────────────────────────
 * Additional users are FREE today. When we monetise, gate POST on the client's
 * plan / seat count here (count active client_users for this client_link_id and
 * compare to an allowance), and surface an upsell instead of a hard block.
 */

const MANAGE_ROLES = new Set(["admin", "lead"]);
const VIEW_ROLES = new Set(["admin", "lead", "bookkeeper"]);

async function resolveActor() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  return { user, service, role: (actor as any)?.role || "" };
}

/** GET — list this client's portal users (active + revoked), newest access last. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: clientLinkId } = await context.params;
  const { user, service, role, error } = await resolveActor();
  if (error) return error;
  if (!VIEW_ROLES.has(role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // allowed_pages selected separately so environments that haven't run
  // migration 154 yet keep working (the first select would fail there).
  let maps: any[] | null = null;
  {
    const res = await (service as any)
      .from("client_users")
      .select("user_id, active, invited_at, first_login_at, last_login_at, allowed_pages")
      .eq("client_link_id", clientLinkId)
      .order("invited_at", { ascending: true });
    maps = res.error
      ? (
          await (service as any)
            .from("client_users")
            .select("user_id, active, invited_at, first_login_at, last_login_at")
            .eq("client_link_id", clientLinkId)
            .order("invited_at", { ascending: true })
        ).data
      : res.data;
  }

  const rows = (maps as any[]) || [];
  if (rows.length === 0) return NextResponse.json({ ok: true, users: [] });

  const { data: users } = await service
    .from("users")
    .select("id, email, full_name, is_active")
    .in("id", rows.map((m) => m.user_id));
  const byId = new Map(((users as any[]) || []).map((u) => [u.id, u]));

  // Earliest active mapping = the "primary" user (label only — access is identical).
  const firstActive = rows.find((m) => m.active);

  const list = rows.map((m) => {
    const u = byId.get(m.user_id) || {};
    return {
      user_id: m.user_id,
      email: u.email || null,
      full_name: u.full_name || null,
      active: m.active,
      is_primary: firstActive ? m.user_id === firstActive.user_id : false,
      invited_at: m.invited_at,
      first_login_at: m.first_login_at,
      last_login_at: m.last_login_at,
      has_logged_in: !!m.first_login_at,
      // NULL/absent = full access to every portal page
      allowed_pages: Array.isArray(m.allowed_pages) ? m.allowed_pages : null,
    };
  });

  return NextResponse.json({ ok: true, users: list });
}

/**
 * POST — add a portal user to this client.
 * Body: { email, full_name, send_invite?, allowed_pages? }.
 * allowed_pages: array of page keys from lib/portal-pages.ts — omit (or send
 * every key) for full access. Defaults to send_invite:false (silent create) so
 * the UI can offer an explicit "send login email" step afterwards.
 * Idempotent-ish: re-adding an existing client user reactivates their mapping
 * (reported via `resend`) and applies the newly-chosen page list.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: clientLinkId } = await context.params;
  const { user, service, role, error } = await resolveActor();
  if (error) return error;
  if (!MANAGE_ROLES.has(role)) {
    return NextResponse.json({ error: "Forbidden — admin or lead required to add users" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const email = (body.email || "").trim().toLowerCase();
  const fullName = (body.full_name || "").trim();
  const sendInvite: boolean = body.send_invite === true; // default: create silently
  // null = full access (every key selected, or field omitted)
  const allowedPages = sanitizeAllowedPages(body.allowed_pages);

  if (!email || !fullName) {
    return NextResponse.json({ error: "Email and full name are required" }, { status: 400 });
  }

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
    invitedBy: (user as any).id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  // Apply the page selection to the (created or reactivated) mapping. Always
  // written — a reactivated user might carry a stale restriction from before.
  // If restrictions were requested but can't be stored (e.g. migration 154
  // missing), FAIL LOUDLY rather than silently granting full access.
  if (result.userId) {
    const { error: pagesError } = await (service as any)
      .from("client_users")
      .update({ allowed_pages: allowedPages })
      .eq("user_id", result.userId)
      .eq("client_link_id", clientLinkId);
    if (pagesError && allowedPages !== null) {
      return NextResponse.json(
        { error: "User was added, but the page restrictions could not be saved (is migration 154 applied?). The user currently has FULL access — edit their pages to retry." },
        { status: 500 }
      );
    }
  }

  await service.from("audit_log").insert({
    event_type: result.resend ? "client_user_reactivated" : "client_user_added",
    user_id: (user as any).id,
    request_payload: {
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      added_email: email,
      added_full_name: fullName,
      emailed: sendInvite,
      resend: result.resend,
      allowed_pages: allowedPages, // null = all pages
    } as any,
  });

  return NextResponse.json({
    ok: true,
    user_id: result.userId,
    already_existed: result.resend,
    emailed: sendInvite,
    message: result.message,
  });
}

/**
 * PATCH — update an existing portal user's page access.
 * Body: { user_id, allowed_pages } — allowed_pages is an array of page keys
 * (every key, or a non-array, means full access and is stored as NULL).
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: clientLinkId } = await context.params;
  const { user, service, role, error } = await resolveActor();
  if (error) return error;
  if (!MANAGE_ROLES.has(role)) {
    return NextResponse.json({ error: "Forbidden — admin or lead required to change page access" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const targetUserId = (body.user_id || "").trim();
  if (!targetUserId) return NextResponse.json({ error: "user_id required" }, { status: 400 });
  const allowedPages = sanitizeAllowedPages(body.allowed_pages);

  const { data: mapping } = await (service as any)
    .from("client_users")
    .select("id")
    .eq("user_id", targetUserId)
    .eq("client_link_id", clientLinkId)
    .maybeSingle();
  if (!mapping) return NextResponse.json({ error: "This user isn't on this client" }, { status: 404 });

  const { error: updateError } = await (service as any)
    .from("client_users")
    .update({ allowed_pages: allowedPages })
    .eq("id", (mapping as any).id);
  if (updateError) {
    return NextResponse.json(
      { error: "Couldn't save page access (is migration 154 applied?)" },
      { status: 500 }
    );
  }

  await service.from("audit_log").insert({
    event_type: "client_user_pages_updated",
    user_id: (user as any).id,
    request_payload: {
      client_link_id: clientLinkId,
      target_user_id: targetUserId,
      allowed_pages: allowedPages, // null = all pages
    } as any,
  });

  return NextResponse.json({ ok: true, allowed_pages: allowedPages });
}

/** DELETE ?user_id= — soft-disable a user's access to this client (history kept). */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: clientLinkId } = await context.params;
  const { user, service, role, error } = await resolveActor();
  if (error) return error;
  if (!MANAGE_ROLES.has(role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const targetUserId = new URL(request.url).searchParams.get("user_id");
  if (!targetUserId) return NextResponse.json({ error: "user_id required" }, { status: 400 });

  const { data: mapping } = await (service as any)
    .from("client_users")
    .select("id")
    .eq("user_id", targetUserId)
    .eq("client_link_id", clientLinkId)
    .maybeSingle();
  if (!mapping) return NextResponse.json({ error: "This user isn't on this client" }, { status: 404 });

  await (service as any).from("client_users").update({ active: false }).eq("id", (mapping as any).id);

  await service.from("audit_log").insert({
    event_type: "client_user_revoked",
    user_id: (user as any).id,
    request_payload: { client_link_id: clientLinkId, target_user_id: targetUserId } as any,
  });

  return NextResponse.json({ ok: true });
}
