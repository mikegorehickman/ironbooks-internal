import {
  listCustomersByEmail,
  searchStripeCustomers,
  getCustomerBillingInfo,
  getCustomerInvoices,
} from "@/lib/stripe-billing";

/**
 * Sync IronBooks' subscription billing from the platform Stripe account into
 * billing_subscriptions (the master client↔customer mapping + MRR) and
 * billing_payments (collected invoices, bucketed by month) for a given year.
 *
 * Matching order per active client: existing stripe_customer_id → exact email
 * (client_email) → fuzzy name (legal/company name). Manual payments are never
 * touched — only source='stripe' rows are refreshed.
 */
const norm = (s: string | null | undefined) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export interface BillingSyncResult {
  scanned: number;
  matched: number;
  unmatched: string[];
  paymentsWritten: number;
}

export async function syncBilling(service: any, year: number): Promise<BillingSyncResult> {
  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, legal_business_name, client_email, contact_first_name, contact_last_name, stripe_customer_id, jurisdiction")
    .eq("is_active", true);

  const result: BillingSyncResult = { scanned: 0, matched: 0, unmatched: [], paymentsWritten: 0 };

  for (const c of (clients || []) as any[]) {
    result.scanned++;
    let customerId: string | null = c.stripe_customer_id || null;
    let method = customerId ? "existing" : null;

    // Match by exact email.
    if (!customerId && c.client_email) {
      try {
        const matches = await listCustomersByEmail(c.client_email);
        if (matches.length) { customerId = matches[0].id; method = "email"; }
      } catch { /* keep null */ }
    }
    // Match by company/legal name (only accept a confident name overlap).
    if (!customerId) {
      const name = c.legal_business_name || c.client_name || "";
      if (name.trim()) {
        try {
          const found = await searchStripeCustomers(name, 5);
          const target = norm(name);
          const hit = found.find((f) => {
            const fn = norm(f.name);
            return fn && (fn === target || fn.includes(target) || target.includes(fn));
          });
          if (hit) { customerId = hit.id; method = "name"; }
        } catch { /* keep null */ }
      }
    }

    if (!customerId) {
      result.unmatched.push(c.client_name || c.id);
      // Still upsert a stub row so the client shows in the grid (no Stripe).
      await service.from("billing_subscriptions").upsert(
        { client_link_id: c.id, subscription_status: "none", currency: c.jurisdiction === "CA" ? "cad" : "usd", updated_at: new Date().toISOString() },
        { onConflict: "client_link_id" }
      );
      continue;
    }

    result.matched++;
    let mrrCents = 0;
    let subId: string | null = null;
    let status: string | null = null;
    try {
      const info = await getCustomerBillingInfo(customerId);
      mrrCents = Math.round((info.monthlyAmountDollars || 0) * 100);
      subId = info.subscriptionId;
      status = info.subscriptionStatus;
    } catch { /* leave defaults */ }

    await service.from("billing_subscriptions").upsert(
      {
        client_link_id: c.id,
        stripe_customer_id: customerId,
        stripe_subscription_id: subId,
        mrr_cents: mrrCents,
        subscription_status: status || "none",
        currency: c.jurisdiction === "CA" ? "cad" : "usd",
        match_method: method,
        matched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_link_id" }
    );

    // Refresh this year's Stripe-sourced payments (leave manual rows intact).
    try {
      const invoices = await getCustomerInvoices(customerId, 36);
      const thisYear = invoices.filter(
        (inv) => inv.status === "paid" && new Date(inv.created).getUTCFullYear() === year && inv.amountPaid > 0
      );
      await service
        .from("billing_payments")
        .delete()
        .eq("client_link_id", c.id)
        .eq("period_year", year)
        .eq("source", "stripe");
      if (thisYear.length) {
        const rows = thisYear.map((inv) => ({
          client_link_id: c.id,
          period_year: year,
          period_month: new Date(inv.created).getUTCMonth() + 1,
          amount_cents: Math.round(inv.amountPaid * 100),
          status: "collected",
          source: "stripe",
          method: "stripe",
          kind: "subscription",
          stripe_invoice_id: inv.id,
        }));
        const { error } = await service.from("billing_payments").insert(rows);
        if (!error) result.paymentsWritten += rows.length;
      }
    } catch { /* skip invoices for this client */ }
  }

  return result;
}
