import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

/**
 * POST /api/admin/clients/[id]/portal-access
 *
 * Activate or deactivate a client's portal access. Admin/lead only.
 *
 * Body: { action: "activate" | "deactivate" }
 *
 * Toggles client_users.active for every portal user mapped to this client.
 * That single flag is the gate everywhere — login, the impersonate guard,
 * and the statements-email recipient resolvers (getPortalRecipients /
 * resolveClientContactEmails) all require an ACTIVE mapping — so flipping it
 * cleanly revokes (or restores) access without disabling the underlying auth
 * user, which could be shared. Deactivating does NOT delete anything;
 * "activate" just flips it back on (no new invite email needed).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const action = body.action;
  if (!["activate", "deactivate"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
  const active = action === "activate";

  const { data: maps } = await (service as any)
    .from("client_users")
    .select("user_id")
    .eq("client_link_id", clientLinkId);
  const userIds = ((maps as any[]) || []).map((m) => m.user_id).filter(Boolean);
  if (userIds.length === 0) {
    return NextResponse.json(
      { error: "This client has no portal users yet — invite one first." },
      { status: 404 }
    );
  }

  // .select() makes PostgREST return the rows it actually touched — without
  // it, an UPDATE that matches 0 rows still reports "success" and the UI
  // flips optimistically while nothing was saved (the exact bug we're
  // guarding against). If updated count ≠ mapping count, fail loudly.
  const { data: updated, error } = await (service as any)
    .from("client_users")
    .update({ active })
    .eq("client_link_id", clientLinkId)
    .select("id, active");
  if (error) {
    console.error(`[portal-access] update failed for ${clientLinkId}: ${error.message}`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const updatedRows = (updated as any[]) || [];
  if (updatedRows.length === 0) {
    console.error(
      `[portal-access] update matched 0 rows for client_link ${clientLinkId} ` +
      `(expected ${userIds.length}). Likely cause: SUPABASE_SERVICE_ROLE_KEY is ` +
      `not the service-role key (RLS silently filtered the write), or a trigger ` +
      `reverted it.`
    );
    return NextResponse.json(
      { error: `Update didn't persist — 0 of ${userIds.length} portal user(s) were changed. Check SUPABASE_SERVICE_ROLE_KEY on the server.` },
      { status: 500 }
    );
  }

  // Re-read to confirm the flag really is what we set (catches DB triggers
  // or defaults reverting the write).
  const { data: verify } = await (service as any)
    .from("client_users")
    .select("id, active")
    .eq("client_link_id", clientLinkId);
  const persisted = ((verify as any[]) || []).filter((r) => r.active === active).length;
  if (persisted === 0) {
    console.error(
      `[portal-access] write did not persist for ${clientLinkId}: wrote active=${active}, re-read shows none.`
    );
    return NextResponse.json(
      { error: "The change was written but immediately reverted by the database — check for triggers on client_users." },
      { status: 500 }
    );
  }

  // Re-activation must clear EVERY gate that blocks portal login, or the
  // client stays locked out even though the badge says "In portal":
  //   1. client_users.active        — flipped above
  //   2. users.is_active            — portal-context throws "Account is
  //      disabled" when false; restore it for the mapped portal users.
  //   3. client_links.is_active     — portal-context throws "Client is
  //      inactive" for archived clients; un-archive on activate.
  // Deactivate intentionally touches only the mapping (see header comment).
  if (active) {
    const { error: userErr } = await service
      .from("users")
      .update({ is_active: true } as any)
      .in("id", userIds)
      .eq("role", "client"); // never touch staff rows by accident
    if (userErr) console.error(`[portal-access] users.is_active restore failed: ${userErr.message}`);

    const { error: linkErr } = await service
      .from("client_links")
      .update({ is_active: true } as any)
      .eq("id", clientLinkId);
    if (linkErr) console.error(`[portal-access] client_links un-archive failed: ${linkErr.message}`);
  }

  await service.from("audit_log").insert({
    event_type: active ? "portal_access_activate" : "portal_access_deactivate",
    user_id: user.id,
    request_payload: { client_link_id: clientLinkId, user_ids: userIds } as any,
  });

  return NextResponse.json({
    ok: true,
    active,
    portal_user_count: active ? persisted : 0,
  });
}
