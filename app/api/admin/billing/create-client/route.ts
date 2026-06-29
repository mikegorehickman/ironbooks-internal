import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/billing/create-client
 *   { stripe_customer_id, email?, name?, currency? }
 *
 * For a billing payer with NO SNAP account yet (an unmatched Stripe charge):
 * create a client_links row in ONBOARDING status, assigned to Lisa so it lands
 * on her onboarding board, map the Stripe customer, and drop it from the
 * unmatched worklist. Idempotent — if a client already exists for the email or
 * customer, we map/return that instead of duplicating. Admin/lead/billing_admin.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "billing_admin"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const b = await request.json().catch(() => ({}));
  const customerId: string | null = b.stripe_customer_id || null;
  const email: string | null = b.email ? String(b.email).trim().toLowerCase() : null;
  const name: string | null = b.name ? String(b.name).trim() : null;
  const currency = ["usd", "cad"].includes(String(b.currency).toLowerCase()) ? String(b.currency).toLowerCase() : "usd";
  if (!customerId && !email) {
    return NextResponse.json({ error: "stripe_customer_id or email required" }, { status: 400 });
  }

  // Idempotency: reuse an existing client by email or mapped customer.
  let clientLinkId: string | null = null;
  if (email) {
    const { data: byEmail } = await (service as any).from("client_links").select("id").ilike("client_email", email).limit(1).maybeSingle();
    clientLinkId = byEmail?.id || null;
  }
  if (!clientLinkId && customerId) {
    const { data: byCust } = await (service as any).from("client_links").select("id").eq("stripe_customer_id", customerId).limit(1).maybeSingle();
    clientLinkId = byCust?.id || null;
  }

  let created = false;
  if (!clientLinkId) {
    // Assign to Lisa so it shows on her onboarding board (fall back to null).
    const { data: lisa } = await (service as any).from("users").select("id").ilike("email", "lisa@ironbooks.com").maybeSingle();
    const clientName = name || email || "New billing client";
    const insert: Record<string, any> = {
      client_name: clientName,
      client_email: email,
      status: "onboarding",
      is_active: true,
      jurisdiction: "US", // NOT NULL — best-effort default, corrected at onboarding
      assigned_bookkeeper_id: lisa?.id || null,
      stripe_customer_id: customerId,
      double_client_id: customerId ? `stripe_${customerId}` : `billing_${email}`,
      metadata: { created_from: "billing_unmatched", stripe_customer_id: customerId },
    };
    if (name) {
      const parts = name.split(/\s+/);
      insert.contact_first_name = parts[0] || null;
      if (parts.length > 1) insert.contact_last_name = parts.slice(1).join(" ");
    }
    const { data: row, error } = await (service as any).from("client_links").insert(insert).select("id").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    clientLinkId = row.id;
    created = true;
  } else if (customerId) {
    // Existing client → just ensure the customer is mapped.
    await service.from("client_links").update({ stripe_customer_id: customerId } as any).eq("id", clientLinkId);
  }

  // Map the Stripe customer on the subscription row + clear the unmatched worklist.
  if (customerId) {
    await (service as any).from("billing_subscriptions").upsert(
      { client_link_id: clientLinkId, stripe_customer_id: customerId, currency, match_method: "created_from_billing", updated_at: new Date().toISOString() },
      { onConflict: "client_link_id" }
    );
    await (service as any).from("billing_unmatched_charges").delete().eq("stripe_customer_id", customerId);
  }

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: created ? "billing_created_client" : "billing_mapped_existing_client",
    request_payload: { client_link_id: clientLinkId, email, stripe_customer_id: customerId, created } as any,
  });

  return NextResponse.json({ ok: true, client_link_id: clientLinkId, created });
}
