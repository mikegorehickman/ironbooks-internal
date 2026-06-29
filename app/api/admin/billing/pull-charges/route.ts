import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { buildClientIndex } from "@/lib/billing-match";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/billing/pull-charges  { year?, month? }
 *
 * Pulls EVERY successful charge in the IronBooks platform Stripe account for the
 * month (subscriptions, setup fees, coaching calls — everything), matches each
 * charge's customer to a client (existing mapping → client_links.stripe_customer_id
 * → customer email), and records them as collected billing_payments for that
 * month. Replaces the month's Stripe-sourced rows so re-running is idempotent
 * and never double-counts. Returns a reconciliation: matched total by currency
 * + combined CAD, and the unmatched leftovers so they can be hand-mapped.
 * Admin/lead/billing_admin only.
 */
async function stripeGet(path: string): Promise<any> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  const r = await fetch(`https://api.stripe.com/v1${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Stripe ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

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
  const now = new Date();
  const year = Number.isInteger(b.year) ? b.year : now.getUTCFullYear();
  const month = Number.isInteger(b.month) ? b.month : now.getUTCMonth() + 1; // 1-12
  const start = Math.floor(Date.UTC(year, month - 1, 1) / 1000);
  const end = Math.floor(Date.UTC(year, month, 1) / 1000) - 1;

  // Mapping: customer id → client, and email → client (incl. portal-login
  // emails + subscription-mapped customers via the shared index).
  const index = await buildClientIndex(service);
  const { data: subs } = await (service as any).from("billing_subscriptions").select("client_link_id, stripe_customer_id");
  for (const s of ((subs as any[]) || [])) if (s.stripe_customer_id) index.byCustomer.set(s.stripe_customer_id, s.client_link_id);
  const custToClient = index.byCustomer;
  const emailToClient = index.byEmail;

  // Pull all succeeded charges in the window.
  let charges: any[] = [], startingAfter = "", more = true, pages = 0;
  try {
    while (more && pages < 30) {
      const q = `/charges?limit=100&created[gte]=${start}&created[lte]=${end}` + (startingAfter ? `&starting_after=${startingAfter}` : "");
      const d = await stripeGet(q);
      charges.push(...d.data); more = d.has_more; if (d.data.length) startingAfter = d.data[d.data.length - 1].id; pages++;
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Stripe pull failed" }, { status: 502 });
  }
  const ok = charges.filter((c) => c.paid && c.status === "succeeded" && !c.refunded);

  // Bucket by client.
  type Agg = { cents: number; currency: string; clientLinkId: string; newCustomer?: string };
  const matched = new Map<string, Agg>(); // client_link_id → agg (this month total)
  const unmatched: { who: string; cents: number; currency: string; chargeId: string; customerId: string | null }[] = [];
  let matchedUsd = 0, matchedCad = 0, unmatchedUsd = 0, unmatchedCad = 0;

  for (const c of ok) {
    const cents = (c.amount_captured ?? c.amount) || 0;
    const currency = (c.currency || "usd").toLowerCase();
    const email = (c.billing_details?.email || c.receipt_email || "").toLowerCase();
    let clientId = c.customer ? custToClient.get(c.customer) : undefined;
    let newCust: string | undefined;
    if (!clientId && email) { clientId = emailToClient.get(email); if (clientId && c.customer) newCust = c.customer; }

    if (clientId) {
      const a: Agg = matched.get(clientId) || { cents: 0, currency, clientLinkId: clientId };
      a.cents += cents; a.currency = currency; if (newCust) a.newCustomer = newCust;
      matched.set(clientId, a);
      if (currency === "cad") matchedCad += cents; else matchedUsd += cents;
    } else {
      unmatched.push({ who: email || c.customer || c.description || c.id, cents, currency, chargeId: c.id, customerId: c.customer || null });
      if (currency === "cad") unmatchedCad += cents; else unmatchedUsd += cents;
    }
  }

  // Write: replace this month's Stripe-sourced payments, then insert per matched client.
  await (service as any).from("billing_payments").delete().eq("period_year", year).eq("period_month", month).eq("source", "stripe");
  for (const [clientId, a] of matched) {
    // ensure subscription row + currency + newly-matched customer id (master mapping)
    await (service as any).from("billing_subscriptions").upsert(
      {
        client_link_id: clientId,
        currency: a.currency,
        ...(a.newCustomer ? { stripe_customer_id: a.newCustomer, match_method: "email" } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_link_id" }
    );
    if (a.newCustomer) await service.from("client_links").update({ stripe_customer_id: a.newCustomer } as any).eq("id", clientId);
    await (service as any).from("billing_payments").insert({
      client_link_id: clientId, period_year: year, period_month: month,
      amount_cents: a.cents, status: "collected", source: "stripe", method: "stripe", kind: "subscription",
      stripe_invoice_id: `month-${year}-${month}-${clientId}`, // one rollup row per client/month from charges
    });
  }

  // FX for the combined CAD figure.
  let fx = 1.37;
  try { const r = await fetch("https://open.er-api.com/v6/latest/USD"); const j = await r.json(); if (j?.rates?.CAD) fx = j.rates.CAD; } catch {}
  const combinedCad = (cents: number, usd: number) => Math.round(cents + usd * fx);

  // Persist the reconciliation snapshot (the "critical number" over time).
  await (service as any).from("billing_recon_runs").insert({
    period_year: year, period_month: month,
    charge_count: ok.length, matched_clients: matched.size,
    matched_usd_cents: matchedUsd, matched_cad_cents: matchedCad,
    unmatched_count: unmatched.length, unmatched_usd_cents: unmatchedUsd, unmatched_cad_cents: unmatchedCad,
    fx_usd_cad: fx, ran_by: user.id,
  });
  // Replace the month's unmatched-charges worklist with this pull's leftovers.
  await (service as any).from("billing_unmatched_charges").delete().eq("period_year", year).eq("period_month", month);
  if (unmatched.length) {
    await (service as any).from("billing_unmatched_charges").insert(
      unmatched.map((u) => ({
        period_year: year, period_month: month, stripe_charge_id: u.chargeId,
        stripe_customer_id: u.customerId, who: String(u.who).slice(0, 200),
        amount_cents: u.cents, currency: u.currency,
      }))
    );
  }

  await service.from("audit_log").insert({
    user_id: user.id, event_type: "billing_pull_charges",
    request_payload: { year, month, charges: ok.length, matched_clients: matched.size, unmatched: unmatched.length } as any,
  });

  return NextResponse.json({
    ok: true, year, month, fx,
    charges: ok.length,
    matched: {
      clients: matched.size,
      usd: matchedUsd / 100, cad: matchedCad / 100,
      combined_cad: combinedCad(matchedCad, matchedUsd / 100) / 100,
    },
    unmatched: {
      count: unmatched.length,
      usd: unmatchedUsd / 100, cad: unmatchedCad / 100,
      combined_cad: combinedCad(unmatchedCad, unmatchedUsd / 100) / 100,
      top: unmatched.sort((a, b) => b.cents - a.cents).slice(0, 15).map((u) => ({ who: u.who, amount: u.cents / 100, currency: u.currency.toUpperCase() })),
    },
  });
}
