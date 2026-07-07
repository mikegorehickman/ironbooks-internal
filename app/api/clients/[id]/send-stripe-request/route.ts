import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { sendStripeConnectionRequest } from "@/lib/stripe-connection-request";

/**
 * POST /api/clients/[id]/send-stripe-request
 *
 * Bookkeeper-initiated DIRECT send of the branded Stripe connect-request email
 * (vs. the legacy copy-to-clipboard modal). Mints a fresh 7-day token, emails
 * the client, logs to client_email_log, and stamps the reminder clock.
 *
 * Body: { isReminder?: boolean, override_email?: string }
 *  - override_email: when no address is on file, the bookkeeper supplies one;
 *    it's persisted to client_links.client_email (updates the profile) + used.
 *  - 200 with { sent:false, no_address:true } means "nothing on file — prompt
 *    the bookkeeper to enter an address" (NOT an error).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  // Internal-only: this emails the client directly, so portal users can't hit it.
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is fine */
  }

  const result = await sendStripeConnectionRequest(service, {
    clientLinkId,
    createdByUserId: user.id,
    isReminder: !!body.isReminder,
    overrideEmail: body.override_email ?? null,
  });

  if (!result.ok && !result.noAddress) {
    return NextResponse.json(
      { error: result.error || "Could not send connection request", ...result },
      { status: result.error?.includes("already connected") ? 409 : 500 }
    );
  }

  return NextResponse.json({
    sent: result.sent,
    recipients: result.recipients,
    addresses: result.addresses,
    no_address: result.noAddress,
    url: result.url,
    expires_at: result.expiresAt,
    error: result.error,
  });
}
