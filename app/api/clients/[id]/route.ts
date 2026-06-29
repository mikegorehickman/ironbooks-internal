import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { syncClientLoginEmail, type LoginEmailSync } from "@/lib/client-email";
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

  // When the contact email changes, repoint the client's portal LOGIN to
  // match (Supabase auth + public.users.email) — otherwise the new address
  // saves to client_links but the client still signs in with the old one.
  // The client_links write above already succeeded; a login-sync hiccup
  // (e.g. address already taken) is reported, not fatal.
  let loginSync: LoginEmailSync | null = null;
  if (
    "client_email" in updates &&
    updates.client_email &&
    (prior as any)?.client_email !== updates.client_email
  ) {
    loginSync = await syncClientLoginEmail(service, id, updates.client_email);
  }

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
      ...(loginSync ? { portal_login_updated: loginSync.portalUpdated } : {}),
    } as any,
  });

  return NextResponse.json({
    client: data,
    login_updated: loginSync?.portalUpdated ?? 0,
    login_note: loginSync?.note ?? null,
    login_error: loginSync?.error ?? null,
  });
}

/**
 * DELETE /api/clients/[id]
 *
 * Removes a client. Two modes, chosen automatically:
 *   - HARD DELETE when the client has no financial footprint (no payments,
 *     subscription, closed month, reclass/COA job, or connected QBO) — a
 *     mistakenly-added client gets fully removed, including its portal user
 *     mapping, onboarding lead, and messages.
 *   - ARCHIVE (is_active=false) when it DOES touch financial info — every row
 *     is kept intact so the books/history are preserved and it can be
 *     restored from the Reactivate control. The clients list filters
 *     is_active, so an archived client disappears from the UI either way.
 *
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
  if (!prior) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // ── Does this client touch financial info? If so we archive (preserve);
  //    otherwise it's safe to hard-delete. A connected QBO realm counts.
  const financialTables = ["billing_payments", "billing_subscriptions", "monthly_rec_runs", "reclass_jobs", "coa_jobs"];
  let hasFinancial = !!(prior as any).qbo_realm_id;
  for (const t of financialTables) {
    if (hasFinancial) break;
    try {
      const { count } = await (service as any).from(t).select("id", { count: "exact", head: true }).eq("client_link_id", id);
      if ((count || 0) > 0) hasFinancial = true;
    } catch { /* table may not exist in this env — ignore */ }
  }

  if (!hasFinancial) {
    // HARD DELETE. Remove non-financial children first (best-effort), then the
    // client row. If a child table we didn't anticipate still references it,
    // the final delete FK-errors → we fall back to archiving so the request
    // never half-completes.
    const childTables = ["client_users", "onboarding_leads", "client_communications", "support_tickets"];
    for (const t of childTables) {
      try { await (service as any).from(t).delete().eq("client_link_id", id); } catch { /* ignore */ }
    }
    const { error: delErr } = await service.from("client_links").delete().eq("id", id);
    if (!delErr) {
      await service.from("audit_log").insert({
        user_id: user.id,
        event_type: "client_deleted",
        request_payload: { client_link_id: id, client_name: (prior as any)?.client_name ?? null, mode: "hard_delete" } as any,
      });
      return NextResponse.json({ ok: true, deleted: true });
    }
    // FK constraint or other error → fall through to archive.
    console.warn(`[clients/DELETE] hard delete blocked for ${id}, archiving instead: ${delErr.message}`);
  }

  // ARCHIVE — financial footprint present (or hard delete was blocked).
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
