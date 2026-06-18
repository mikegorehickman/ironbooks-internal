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

  const { error } = await (service as any)
    .from("client_users")
    .update({ active })
    .eq("client_link_id", clientLinkId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await service.from("audit_log").insert({
    event_type: active ? "portal_access_activate" : "portal_access_deactivate",
    user_id: user.id,
    request_payload: { client_link_id: clientLinkId, user_ids: userIds } as any,
  });

  return NextResponse.json({
    ok: true,
    active,
    portal_user_count: active ? userIds.length : 0,
  });
}
