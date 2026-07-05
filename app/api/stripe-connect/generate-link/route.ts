import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { generateConnectToken } from "@/lib/stripe-oauth";

/**
 * POST /api/stripe-connect/generate-link
 *
 * Bookkeeper-initiated: creates a one-time-use connect token for a client and
 * returns the URL the bookkeeper sends to the client. The URL is valid for 7
 * days and gets marked used the moment the client completes Stripe OAuth.
 *
 * Body:
 *  {
 *    client_link_id: string
 *  }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { client_link_id } = body;
  if (!client_link_id) {
    return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  }

  const service = createServiceSupabase();

  // Confirm the client exists and is active
  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name, stripe_connection_status, is_active")
    .eq("id", client_link_id)
    .single();
  if (!clientLink) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // If already connected, no need for a new token — return clear message
  if (clientLink.stripe_connection_status === "connected") {
    return NextResponse.json(
      { error: "Stripe is already connected for this client. Disconnect first if you need to re-link." },
      { status: 400 }
    );
  }

  // Generate token + insert. Expires in 7 days.
  const token = generateConnectToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { error: insertErr } = await service
    .from("stripe_connect_tokens")
    .insert({
      token,
      client_link_id,
      created_by: user.id,
      expires_at: expiresAt,
    } as any);
  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // Mark client as pending Stripe connection (so the rest of the app knows).
  // stripe_request_sent_at drives the cleanup board's Awaiting-Stripe sort +
  // the fleet-health stale-link warning.
  await service
    .from("client_links")
    .update({
      stripe_connection_status: "pending",
      stripe_request_sent_at: new Date().toISOString(),
    } as any)
    .eq("id", client_link_id);

  // Audit log entry
  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "stripe_connect_link_generated",
    request_payload: {
      message: `Stripe connect link generated for ${clientLink.client_name}`,
      client_link_id,
      expires_at: expiresAt,
    } as any,
  });

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://internal.ironbooks.com";
  const url = `${baseUrl}/stripe-connect/${token}`;

  return NextResponse.json({
    token,
    url,
    expires_at: expiresAt,
    client_name: clientLink.client_name,
  });
}
