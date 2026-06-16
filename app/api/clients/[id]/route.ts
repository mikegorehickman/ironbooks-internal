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
  const allowed = [
    "status", "assigned_bookkeeper_id", "due_date", "client_name", "notes",
    "is_active", "state_province", "client_email", "client_phone",
    // Profile detail fields (migration 73)
    "contact_first_name", "contact_last_name", "legal_business_name",
    "trade_type", "corporate_type", "fiscal_year_end", "country",
    "address_line1", "address_line2", "city", "postal_code",
    "annual_revenue_range", "taxes_up_to_date", "prior_bookkeeper",
    "accounting_software", "payroll_provider", "employee_count_range",
    "uses_business_cards", "keeps_receipts", "bank_connected_to_software",
  ];
  for (const k of allowed) {
    if (k in body) updates[k] = body[k];
  }

  // Stamp profile_updated_at whenever any profile-detail field is touched,
  // so the card can show "last edited" without the caller sending it.
  const profileFields = new Set([
    "contact_first_name", "contact_last_name", "legal_business_name",
    "trade_type", "corporate_type", "fiscal_year_end", "country",
    "address_line1", "address_line2", "city", "postal_code",
    "annual_revenue_range", "taxes_up_to_date", "prior_bookkeeper",
    "accounting_software", "payroll_provider", "employee_count_range",
    "uses_business_cards", "keeps_receipts", "bank_connected_to_software",
    "client_phone", "client_email", "state_province",
  ]);
  if (Object.keys(updates).some((k) => profileFields.has(k))) {
    updates.profile_updated_at = new Date().toISOString();
  }

  // Validate status enum
  if (updates.status && !["onboarding", "active", "behind", "paused", "churned"].includes(updates.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No updates provided" }, { status: 400 });
  }

  const service = createServiceSupabase();

  // Gate `is_active` flips behind admin/lead role. A bookkeeper toggling
  // it (intentionally or via a stale UI state) silently hides the client
  // from the reclass picker, COA picker, kanban, and clients list —
  // creating exactly the "where did this client go?" support load we
  // hit with Lionetti Painting. Only admin/lead can archive/reactivate.
  if ("is_active" in updates) {
    const { data: profile } = await service
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!profile || !["admin", "lead"].includes((profile as any).role)) {
      return NextResponse.json(
        { error: "Only admin or lead can change a client's active status" },
        { status: 403 }
      );
    }
  }

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

  // ARCHIVE, don't hard-delete. Setting is_active=false removes the client
  // from the active list but keeps every row (jobs, history, portal,
  // messages) intact so it can be restored from the Reactivate control.
  // A real delete would cascade and be unrecoverable.
  const { error } = await service
    .from("client_links")
    .update({ is_active: false } as any)
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "client_archived",
    request_payload: {
      client_link_id: id,
      client_name: (prior as any)?.client_name ?? null,
      qbo_realm_id: (prior as any)?.qbo_realm_id ?? null,
      assigned_bookkeeper_id: (prior as any)?.assigned_bookkeeper_id ?? null,
    } as any,
  });

  return NextResponse.json({ ok: true, archived: true });
}
