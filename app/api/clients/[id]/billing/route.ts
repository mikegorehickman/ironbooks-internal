import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  getCustomerBillingInfo,
  getCustomerInvoices,
  findStripeCustomerIdByEmail,
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

  // Auto-link by email if not set yet (then persist).
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
