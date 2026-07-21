import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  getCustomerBillingInfo,
  getCustomerInvoices,
  findStripeCustomerIdByEmail,
  getStripeCustomer,
  searchStripeCustomers,
  listCustomersByEmail,
} from "@/lib/stripe-billing";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/billing — internal (admin/lead/bookkeeper).
 *
 * Returns the client's Stripe billing (tier/amount/status/next date) + paid
 * invoice history. Lazy-loaded by the profile Billing tab so the Stripe round
 * trip only happens when the tab is opened. Auto-links the customer by email
 * if no stripe_customer_id is on file yet (and persists it).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!(actor as any)?.role || (actor as any).role === "client") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ configured: false, billing: null, invoices: [] });
  }

  const { data: cl } = await service
    .from("client_links")
    .select("client_email, stripe_customer_id")
    .eq("id", id)
    .single();
  if (!cl) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  let customerId = (cl as any).stripe_customer_id as string | null;

  // 2-way sync: if the admin billing table (billing_subscriptions) already has
  // a Stripe customer for this client, adopt it here too (and persist), so a
  // connection made on /admin/billing shows as connected on the profile.
  if (!customerId) {
    try {
      const { data: sub } = await (service as any)
        .from("billing_subscriptions")
        .select("stripe_customer_id")
        .eq("client_link_id", id)
        .maybeSingle();
      if ((sub as any)?.stripe_customer_id) {
        customerId = (sub as any).stripe_customer_id;
        await service.from("client_links").update({ stripe_customer_id: customerId } as any).eq("id", id);
      }
    } catch { /* ignore */ }
  }

  // Auto-link by email if still not set (then persist).
  if (!customerId && (cl as any).client_email) {
    try {
      const found = await findStripeCustomerIdByEmail((cl as any).client_email);
      if (found) {
        customerId = found;
        await service.from("client_links").update({ stripe_customer_id: found } as any).eq("id", id);
      }
    } catch { /* ignore */ }
  }

  if (!customerId) {
    return NextResponse.json({ configured: true, linked: false, billing: null, invoices: [] });
  }

  try {
    const [billing, invoices] = await Promise.all([
      getCustomerBillingInfo(customerId),
      getCustomerInvoices(customerId, 24),
    ]);
    return NextResponse.json({ configured: true, linked: true, billing, invoices });
  } catch (e: any) {
    console.error("[client billing] Stripe fetch failed:", e.message);
    return NextResponse.json({ configured: true, linked: true, error: "Could not reach Stripe", billing: null, invoices: [] }, { status: 502 });
  }
}

/**
 * POST /api/clients/[id]/billing — internal (admin/lead/bookkeeper).
 *
 * Manually link a client to a Stripe customer when email auto-match misses.
 *   { action: "search", query }            → returns candidate customers
 *   { action: "set", stripeCustomerId }    → validates + saves the link
 *   { action: "unlink" }                   → clears the link
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role;
  if (!role || role === "client") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({} as any));
  const action = body.action;

  if (action === "search") {
    const q = (body.query || "").trim();
    if (!q) return NextResponse.json({ candidates: [] });
    // Email-ish query → exact list; otherwise substring search on name + email.
    const isEmail = /@/.test(q);
    const results = isEmail
      ? [...(await listCustomersByEmail(q)), ...(await searchStripeCustomers(`email~"${q.replace(/"/g, "")}"`, 10))]
      : [
          ...(await searchStripeCustomers(`name~"${q.replace(/"/g, "")}"`, 10)),
          ...(await searchStripeCustomers(`email~"${q.replace(/"/g, "")}"`, 10)),
        ];
    // De-dup by id, keep first occurrence.
    const seen = new Set<string>();
    const candidates = results.filter((c) => c && c.id && !seen.has(c.id) && seen.add(c.id)).slice(0, 15);
    return NextResponse.json({ candidates });
  }

  if (action === "unlink") {
    const { error } = await service.from("client_links").update({ stripe_customer_id: null } as any).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await service.from("audit_log").insert({
      event_type: "billing_stripe_unlinked",
      user_id: user.id,
      request_payload: { client_link_id: id } as any,
    });
    return NextResponse.json({ ok: true, linked: false });
  }

  if (action === "set") {
    const cusId = (body.stripeCustomerId || "").trim();
    if (!/^cus_[A-Za-z0-9]+$/.test(cusId)) {
      return NextResponse.json({ error: "Enter a valid Stripe customer id (cus_…)" }, { status: 400 });
    }
    let customer;
    try {
      customer = await getStripeCustomer(cusId);
    } catch (e: any) {
      return NextResponse.json({ error: `Stripe check failed: ${e?.message || "error"}` }, { status: 502 });
    }
    if (!customer) {
      return NextResponse.json({ error: "That Stripe customer doesn't exist (or was deleted)." }, { status: 404 });
    }
    const { error } = await service
      .from("client_links")
      .update({ stripe_customer_id: cusId } as any)
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // 2-way sync — mirror the link into the admin billing table so
    // /admin/billing shows this client as connected too.
    try {
      const { data: existingSub } = await (service as any)
        .from("billing_subscriptions").select("id").eq("client_link_id", id).maybeSingle();
      if (existingSub) {
        await (service as any).from("billing_subscriptions")
          .update({ stripe_customer_id: cusId }).eq("client_link_id", id);
      } else {
        await (service as any).from("billing_subscriptions")
          .insert({ client_link_id: id, stripe_customer_id: cusId });
      }
    } catch (e: any) {
      console.warn(`[client billing ${id}] billing_subscriptions mirror failed:`, e?.message);
    }
    await service.from("audit_log").insert({
      event_type: "billing_stripe_linked",
      user_id: user.id,
      request_payload: { client_link_id: id, stripe_customer_id: cusId, customer_name: customer.name } as any,
    });
    return NextResponse.json({ ok: true, linked: true, customer });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
