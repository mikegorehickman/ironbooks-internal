import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import crypto from "crypto";
import { createCheckoutSession } from "@/lib/stripe-billing";

export const dynamic = "force-dynamic";

/**
 * POST /api/coaching-calls/checkout  { coach_key }
 *
 * Portal client buys a $150 / 30-min call with Lisa or Kedma. Picks the
 * currency from the client's jurisdiction (CA→CAD, else USD), attaches their
 * Stripe customer so the card is pre-filled, and returns a Stripe Checkout URL.
 * On success Stripe sends them to /book/[token] (the scheduling page).
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const coachKey = String(body.coach_key || "").trim();
  if (!coachKey) return NextResponse.json({ error: "coach_key required" }, { status: 400 });

  const service = createServiceSupabase();

  // Resolve the buyer's client (same path as the portal billing page).
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const impersonating = cookieStore.get("ironbooks_impersonate_client_link_id")?.value || null;
  let clientLinkId = impersonating;
  if (!clientLinkId) {
    const { data: mapping } = await (service as any)
      .from("client_users")
      .select("client_link_id")
      .eq("user_id", user.id)
      .maybeSingle();
    clientLinkId = mapping?.client_link_id || null;
  }
  if (!clientLinkId) return NextResponse.json({ error: "No client linked to your account." }, { status: 403 });

  const { data: cl } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, client_email, stripe_customer_id")
    .eq("id", clientLinkId)
    .single();
  if (!cl) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // Coach must exist + be active.
  const { data: coach } = await service
    .from("coaching_call_settings")
    .select("coach_key, coach_name, active")
    .eq("coach_key", coachKey)
    .maybeSingle();
  if (!coach || (coach as any).active === false) {
    return NextResponse.json({ error: "That coach isn't available for booking." }, { status: 400 });
  }

  const currency = (cl as any).jurisdiction === "CA" ? "cad" : "usd";
  const priceId =
    currency === "cad"
      ? process.env.STRIPE_COACHING_PRICE_CAD
      : process.env.STRIPE_COACHING_PRICE_USD;
  if (!priceId) {
    return NextResponse.json(
      { error: `Coaching-call price not configured (${currency.toUpperCase()}). Set STRIPE_COACHING_PRICE_${currency.toUpperCase()}.` },
      { status: 500 }
    );
  }

  const token = crypto.randomBytes(24).toString("base64url");
  const buyerEmail = (cl as any).client_email || user.email || null;
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const { error: insErr } = await service.from("coaching_call_bookings").insert({
    token,
    coach_key: coachKey,
    buyer_user_id: user.id,
    buyer_client_link_id: clientLinkId,
    buyer_email: buyerEmail,
    buyer_name: (cl as any).client_name,
    currency,
    payment_status: "pending",
    expires_at: expiresAt,
  } as any);
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://app.ironbooks.com";
  try {
    const session = await createCheckoutSession({
      priceId,
      successUrl: `${baseUrl}/book/${token}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/portal/billing`,
      customerId: (cl as any).stripe_customer_id || null,
      customerEmail: buyerEmail,
      metadata: { token, coach_key: coachKey, client_link_id: clientLinkId },
    });
    await service
      .from("coaching_call_bookings")
      .update({ stripe_checkout_session_id: session.id } as any)
      .eq("token", token);
    return NextResponse.json({ url: session.url });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Could not start checkout" }, { status: 500 });
  }
}
