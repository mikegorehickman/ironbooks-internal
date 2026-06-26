import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { buildClientIndex, suggestClient } from "@/lib/billing-match";
import { getStripeCustomer } from "@/lib/stripe-billing";
import { MatchClient } from "./match-client";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * /admin/billing/match — review + confirm the Stripe charges that didn't
 * auto-map to a client. Suggests a client per charge (exact portal/billing
 * email → 95% fuzzy email → 95% fuzzy name), with a manual picker fallback.
 */
export default async function BillingMatchPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "billing_admin"].includes((actor as any)?.role || "")) redirect("/dashboard");

  const { data: rows } = await (service as any)
    .from("billing_unmatched_charges").select("*").order("amount_cents", { ascending: false });
  const index = await buildClientIndex(service);

  // Resolve email/name per charge (fetch the Stripe customer for cus_-only rows
  // so we can still suggest by email/name), then compute the best suggestion.
  const items = [];
  for (const r of ((rows as any[]) || [])) {
    let email: string | null = r.who && String(r.who).includes("@") ? String(r.who).toLowerCase() : null;
    let name: string | null = null;
    if (!email && r.stripe_customer_id) {
      try { const c = await getStripeCustomer(r.stripe_customer_id); email = c?.email || null; name = c?.name || null; } catch { /* ignore */ }
    }
    const suggestion = r.stripe_customer_id ? suggestClient(index, email, name) : null;
    items.push({
      id: r.id, chargeId: r.stripe_charge_id, customerId: r.stripe_customer_id || null,
      who: r.who, displayEmail: email, amountCents: r.amount_cents, currency: r.currency,
      year: r.period_year, month: r.period_month, suggestion,
    });
  }

  // Picker offers ONLY clients not already mapped to a Stripe customer — you're
  // matching a charge to a client who still needs one.
  const mapped = new Set(index.byCustomer.values());
  const clients = index.clients
    .filter((c) => !mapped.has(c.id))
    .map((c) => ({ id: c.id, company: c.company }))
    .sort((a, b) => a.company.localeCompare(b.company));

  return <MatchClient items={items} clients={clients} />;
}
