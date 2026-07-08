import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/billing/derive-billing-days  { dry_run?, overwrite? }
 *
 * Sets each billed client's billing_subscriptions.billing_day from the day of
 * the month they ACTUALLY get charged — so the coverage warning stops flagging
 * everyone as "no payment yet" just because it defaulted them to the 1st.
 *
 * Day-of-month source, in priority order:
 *   1. stripe_subscription_id → the subscription's billing_cycle_anchor
 *      (fallback current_period_start) — the true recurring billing day.
 *   2. stripe_customer_id (no sub) → the customer's most recent succeeded
 *      charge date.
 *   3. manual payer → the day-of-month of their most recent recorded manual
 *      payment (best proxy we have; manual rows carry no charge date).
 *
 * Stripe-derived days always overwrite (Stripe is the source of truth for the
 * recurring date). Manual-derived days only FILL a blank day — never clobber a
 * human-set one — unless overwrite:true. dry_run:true returns the plan without
 * writing. Admin/lead/billing_admin only. STRIPE_SECRET_KEY is Vercel-only, so
 * this runs on the deployed app.
 */
async function stripeGet(path: string): Promise<any> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  const r = await fetch(`https://api.stripe.com/v1${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Stripe ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

const dayOfMonthUTC = (unixSeconds: number): number | null => {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return null;
  const d = new Date(unixSeconds * 1000).getUTCDate();
  return d >= 1 && d <= 31 ? d : null;
};

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
  const dryRun = !!b.dry_run;
  const overwrite = !!b.overwrite;

  // All billed clients (a sub row exists for anyone with a Stripe sub or manual
  // MRR) + names for the report.
  const [subsRes, clientsRes, paysRes] = await Promise.all([
    (service as any).from("billing_subscriptions").select("client_link_id, stripe_subscription_id, stripe_customer_id, billing_day, mrr_cents, manual_mrr_cents"),
    service.from("client_links").select("id, client_name, legal_business_name"),
    (service as any)
      .from("billing_payments")
      .select("client_link_id, created_at, status, source")
      .eq("source", "manual")
      .eq("status", "collected")
      .order("created_at", { ascending: false }),
  ]);

  const subs = ((subsRes as any)?.data as any[]) || [];
  const nameById = new Map<string, string>(
    (((clientsRes as any)?.data as any[]) || []).map((c) => [c.id, c.legal_business_name || c.client_name || "(unnamed)"])
  );
  // Most recent manual collected payment per client (rows come newest-first).
  const latestManualDay = new Map<string, number>();
  for (const p of (((paysRes as any)?.data as any[]) || [])) {
    if (latestManualDay.has(p.client_link_id)) continue;
    const d = new Date(p.created_at).getUTCDate();
    if (d >= 1 && d <= 31) latestManualDay.set(p.client_link_id, d);
  }

  const updated: Array<{ client_link_id: string; name: string; old_day: number | null; new_day: number; source: string }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let stripeErrors = 0;

  for (const s of subs) {
    const name = nameById.get(s.client_link_id) || "(unknown)";
    let day: number | null = null;
    let source = "";

    try {
      if (s.stripe_subscription_id) {
        const sub = await stripeGet(`/subscriptions/${s.stripe_subscription_id}`);
        day = dayOfMonthUTC(sub.billing_cycle_anchor) ?? dayOfMonthUTC(sub.current_period_start) ?? dayOfMonthUTC(sub.created);
        source = "stripe_sub";
      } else if (s.stripe_customer_id) {
        const ch = await stripeGet(`/charges?customer=${s.stripe_customer_id}&limit=1`);
        const latest = (ch.data || []).find((c: any) => c.paid && c.status === "succeeded");
        if (latest) { day = dayOfMonthUTC(latest.created); source = "stripe_charge"; }
      }
    } catch {
      stripeErrors++;
    }

    // Fall back to the recorded manual-payment day.
    if (day == null && latestManualDay.has(s.client_link_id)) {
      day = latestManualDay.get(s.client_link_id)!;
      source = "manual";
    }

    if (day == null) { skipped.push({ name, reason: "no Stripe subscription/charge and no recorded payment" }); continue; }

    // Write rule: Stripe-authoritative always overwrites; manual only fills a
    // blank day (unless overwrite is forced).
    const isStripe = source === "stripe_sub" || source === "stripe_charge";
    const shouldWrite = overwrite || isStripe || s.billing_day == null;
    if (!shouldWrite) { skipped.push({ name, reason: `keeping existing day ${s.billing_day} (manual guess ${day} not applied)` }); continue; }
    if (s.billing_day === day) { continue; } // already correct — nothing to do

    if (!dryRun) {
      await (service as any).from("billing_subscriptions").update({ billing_day: day, updated_at: new Date().toISOString() }).eq("client_link_id", s.client_link_id);
    }
    updated.push({ client_link_id: s.client_link_id, name, old_day: s.billing_day ?? null, new_day: day, source });
  }

  if (!dryRun && updated.length) {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "billing_days_derived",
      request_payload: { updated: updated.length, skipped: skipped.length, stripe_errors: stripeErrors } as any,
    });
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    considered: subs.length,
    updated_count: updated.length,
    skipped_count: skipped.length,
    stripe_errors: stripeErrors,
    updated: updated.sort((a, b) => a.name.localeCompare(b.name)),
    skipped: skipped.slice(0, 50),
  });
}
