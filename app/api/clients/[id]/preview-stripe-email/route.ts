import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { resolveClientContactEmails } from "@/lib/client-comms";
import { buildStripeConnectEmail } from "@/lib/stripe-connect-email";

/**
 * POST /api/clients/[id]/preview-stripe-email
 *
 * Side-effect-free preview of the Stripe connect-request email: resolves who it
 * would go to and renders the exact branded HTML/text, WITHOUT minting a token
 * or sending anything. Backs the "Preview" step in StripeConnectModal so the
 * bookkeeper can eyeball the greeting + recipient before hitting Send.
 *
 * Body: { override_email?: string, isReminder?: boolean }
 * Internal roles only.
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
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* empty */ }

  const { data: cl } = await service
    .from("client_links")
    .select("id, client_name, contact_first_name, client_email, email_hard_bounced")
    .eq("id", clientLinkId)
    .single();
  if (!cl) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // Resolve recipients exactly like the send path (override wins), but don't
  // persist anything.
  const override = (body.override_email || "").trim().toLowerCase();
  let addresses: string[] = [];
  let bounced = false;
  if (override) {
    addresses = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(override) ? [override] : [];
  } else if ((cl as any).email_hard_bounced) {
    bounced = true;
  } else {
    addresses = await resolveClientContactEmails(service, clientLinkId);
  }

  const firstName =
    ((cl as any).contact_first_name || "").trim() ||
    ((cl as any).client_name || "").split(" ")[0] ||
    "there";

  // Representative link — the real send mints a fresh 7-day token; the content
  // is otherwise identical to what will go out.
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://internal.ironbooks.com";
  const url = `${baseUrl}/stripe-connect/example-link`;
  const { html, text } = buildStripeConnectEmail(firstName, url, (cl as any).client_name, {
    isReminder: !!body.isReminder,
  });
  const subject = body.isReminder
    ? `Reminder: connect Stripe so we can finish your books — ${(cl as any).client_name}`
    : `Connect Stripe so we can reconcile your books — ${(cl as any).client_name}`;

  return NextResponse.json({
    html,
    text,
    subject,
    firstName,
    recipients: addresses,
    no_address: addresses.length === 0,
    email_hard_bounced: bounced,
  });
}
