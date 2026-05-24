import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * PATCH /api/clients/[id]
 *
 * Updates client status, assigned bookkeeper, name, notes.
 *
 * Body: { status?, assigned_bookkeeper_id?, client_name?, notes?, is_active? }
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const updates: Record<string, any> = {};

  // Whitelist editable fields
  const allowed = ["status", "assigned_bookkeeper_id", "due_date", "client_name", "notes", "is_active", "state_province"];
  for (const k of allowed) {
    if (k in body) updates[k] = body[k];
  }

  // Validate status enum
  if (updates.status && !["onboarding", "active", "behind", "paused", "churned"].includes(updates.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No updates provided" }, { status: 400 });
  }

  const service = createServiceSupabase();
  // Capture prior values so the audit log records the before/after diff,
  // not just "Lisa touched this client." Select * (one row, fine) — dynamic
  // column lists trip up the Supabase typed-select.
  const { data: prior } = await service
    .from("client_links")
    .select("*")
    .eq("id", id)
    .single();

  const { data, error } = await supabase
    .from("client_links")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "client_update",
    request_payload: {
      client_link_id: id,
      client_name: (prior as any)?.client_name ?? null,
      changes: Object.fromEntries(
        Object.entries(updates).map(([k, v]) => [
          k,
          { from: (prior as any)?.[k] ?? null, to: v },
        ])
      ),
    } as any,
  });

  return NextResponse.json({ client: data });
}

/**
 * DELETE /api/clients/[id]
 *
 * Permanently deletes a client and all associated records.
 * Restricted to admin and lead roles.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: profile } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "lead"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Snapshot name first — once the row is deleted we can't recover it
  // for the audit payload.
  const { data: prior } = await service
    .from("client_links")
    .select("client_name, assigned_bookkeeper_id, qbo_realm_id")
    .eq("id", id)
    .single();

  const { error } = await service.from("client_links").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "client_delete",
    request_payload: {
      client_link_id: id,
      client_name: (prior as any)?.client_name ?? null,
      qbo_realm_id: (prior as any)?.qbo_realm_id ?? null,
      assigned_bookkeeper_id: (prior as any)?.assigned_bookkeeper_id ?? null,
    } as any,
  });

  return NextResponse.json({ ok: true });
}
