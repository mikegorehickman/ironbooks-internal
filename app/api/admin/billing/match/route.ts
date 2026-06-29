import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getCustomerBillingInfo, getCustomerInvoices } from "@/lib/stripe-billing";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/billing/match  { client_link_id, stripe_customer_id, year? }
 * Manually map a client to a Stripe customer, then sync that one client (MRR +
 * collected invoices). Also writes stripe_customer_id back to client_links so
 * it's the master mapping the client profile uses. Admin/lead only.
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
  const clientLinkId = b.client_link_id;
  const customerId = b.stripe_customer_id;
  const year = Number.isInteger(b.year) ? b.year : new Date().getUTCFullYear();
  if (!clientLinkId || !customerId) {
    return NextResponse.json({ error: "client_link_id and stripe_customer_id required" }, { status: 400 });
  }

  let mrrCents = 0, subId: string | null = null, status: string | null = null;
  try {
    const info = await getCustomerBillingInfo(customerId);
    mrrCents = Math.round((info.monthlyAmountDollars || 0) * 100);
    subId = info.subscriptionId;
    status = info.subscriptionStatus;
  } catch (e: any) {
    return NextResponse.json({ error: `Couldn't read that Stripe customer: ${e?.message || e}` }, { status: 502 });
  }

  await (service as any).from("billing_subscriptions").upsert(
    {
      client_link_id: clientLinkId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subId,
      mrr_cents: mrrCents,
      subscription_status: status || "none",
      match_method: "manual",
      matched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_link_id" }
  );

  // Master mapping → also stamp the client record (used in their profile).
  await service.from("client_links").update({ stripe_customer_id: customerId } as any).eq("id", clientLinkId);

  // This customer is now mapped → drop it from the unmatched worklist.
  await (service as any).from("billing_unmatched_charges").delete().eq("stripe_customer_id", customerId);

  // Refresh this year's Stripe payments for the client (leave manual rows).
  let paymentsWritten = 0;
  try {
    const invoices = await getCustomerInvoices(customerId, 36);
    const paid = invoices.filter(
      (inv) => inv.status === "paid" && new Date(inv.created).getUTCFullYear() === year && inv.amountPaid > 0
    );
    await (service as any).from("billing_payments").delete()
      .eq("client_link_id", clientLinkId).eq("period_year", year).eq("source", "stripe");
    if (paid.length) {
      const rows = paid.map((inv) => ({
        client_link_id: clientLinkId, period_year: year, period_month: new Date(inv.created).getUTCMonth() + 1,
        amount_cents: Math.round(inv.amountPaid * 100), status: "collected", source: "stripe",
        method: "stripe", kind: "subscription", stripe_invoice_id: inv.id,
      }));
      const { error } = await (service as any).from("billing_payments").insert(rows);
      if (!error) paymentsWritten = rows.length;
    }
  } catch { /* skip invoices */ }

  await service.from("audit_log").insert({
    user_id: user.id, event_type: "billing_manual_match",
    request_payload: { client_link_id: clientLinkId, stripe_customer_id: customerId, mrr_cents: mrrCents } as any,
  });

  return NextResponse.json({ ok: true, mrr_cents: mrrCents, payments_written: paymentsWritten });
}
