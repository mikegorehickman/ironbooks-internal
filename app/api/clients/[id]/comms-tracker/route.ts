import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * PATCH /api/clients/[id]/comms-tracker
 *
 * Toggle the manual "sent" checkboxes on a client's communication
 * trackers. The platform can detect that the artifact was "created"
 * (email generated, Stripe Connect token issued, PDF available) but
 * can't observe outbound email — so the bookkeeper checks the box.
 *
 * Body:
 *   {
 *     ask_client_sent?: boolean       // toggle ask_client_email_sent_at
 *     stripe_request_sent?: boolean   // toggle stripe_request_sent_confirmed_at
 *     cleanup_pdf_sent?: boolean      // toggle cleanup_pdf_sent_at
 *   }
 *
 * true → set the timestamp + user; false → clear back to null.
 * Idempotent — re-setting an already-true checkbox is a no-op
 * (timestamp not refreshed).
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));

  const service = createServiceSupabase();
  // Pull current values to keep behavior idempotent.
  const { data: existing } = await service
    .from("client_links")
    .select(
      "id, ask_client_email_sent_at, stripe_request_sent_confirmed_at, cleanup_pdf_sent_at"
    )
    .eq("id", clientLinkId)
    .single();
  if (!existing) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const now = new Date().toISOString();
  const update: Record<string, any> = {};

  if (typeof body.ask_client_sent === "boolean") {
    if (body.ask_client_sent && !(existing as any).ask_client_email_sent_at) {
      update.ask_client_email_sent_at = now;
      update.ask_client_email_sent_by = user.id;
    } else if (!body.ask_client_sent) {
      update.ask_client_email_sent_at = null;
      update.ask_client_email_sent_by = null;
    }
  }
  if (typeof body.stripe_request_sent === "boolean") {
    if (body.stripe_request_sent && !(existing as any).stripe_request_sent_confirmed_at) {
      update.stripe_request_sent_confirmed_at = now;
      update.stripe_request_sent_confirmed_by = user.id;
    } else if (!body.stripe_request_sent) {
      update.stripe_request_sent_confirmed_at = null;
      update.stripe_request_sent_confirmed_by = null;
    }
  }
  if (typeof body.cleanup_pdf_sent === "boolean") {
    if (body.cleanup_pdf_sent && !(existing as any).cleanup_pdf_sent_at) {
      update.cleanup_pdf_sent_at = now;
      update.cleanup_pdf_sent_by = user.id;
    } else if (!body.cleanup_pdf_sent) {
      update.cleanup_pdf_sent_at = null;
      update.cleanup_pdf_sent_by = null;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  const { error } = await service
    .from("client_links")
    .update(update as any)
    .eq("id", clientLinkId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, updated: update });
}
