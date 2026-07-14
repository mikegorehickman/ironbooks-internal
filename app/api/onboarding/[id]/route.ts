import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { resendOnboardingEmail } from "@/lib/ghl";
import { applyOnboardingFormToProfile } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * POST /api/onboarding/[id]  — board actions on an onboarding lead.
 * Admin/lead only.
 *
 * Body: { action, ... }
 *   resend                          — re-fire the GHL onboarding email
 *   assign        { assigned_to }   — set the owner
 *   note          { notes }         — save a note
 *   mark_attended                   — call happened (manual confirm)
 *   mark_no_show                    — call missed
 *   mark_lost     { lost_reason }   — drop the lead
 *   reactivate                      — un-lose a lead
 *   create_client                   — promote into client_links (→ Cleanup)
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const action = body.action as string;

  const { data: lead } = await (service as any)
    .from("onboarding_leads")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const now = new Date().toISOString();
  const stamp = (patch: Record<string, any>) =>
    (service as any).from("onboarding_leads").update({ ...patch, updated_at: now }).eq("id", id);

  switch (action) {
    case "resend": {
      try {
        await resendOnboardingEmail(lead.ghl_contact_id);
      } catch (e: any) {
        return NextResponse.json({ error: e?.message || "Resend failed" }, { status: 502 });
      }
      await stamp({ last_resend_at: now });
      await service.from("audit_log").insert({
        event_type: "onboarding_email_resent",
        user_id: user.id,
        request_payload: { lead_id: id, ghl_contact_id: lead.ghl_contact_id } as any,
      });
      return NextResponse.json({ ok: true });
    }

    case "assign":
      await stamp({ assigned_to: body.assigned_to || null });
      return NextResponse.json({ ok: true });

    case "note":
      await stamp({ notes: String(body.notes || "").slice(0, 4000) });
      return NextResponse.json({ ok: true });

    case "mark_attended":
      await stamp({ ob_call_status: "attended", ob_call_attended_at: now });
      return NextResponse.json({ ok: true });

    case "mark_no_show":
      await stamp({ ob_call_status: "no_show" });
      return NextResponse.json({ ok: true });

    case "mark_lost":
      await stamp({ status: "lost", lost_reason: String(body.lost_reason || "").slice(0, 500) });
      return NextResponse.json({ ok: true });

    case "reactivate":
      await stamp({ status: "active", lost_reason: null });
      return NextResponse.json({ ok: true });

    case "create_client": {
      if (lead.client_link_id) {
        // Client already exists (usually webhook-created on form completion).
        // STILL convert the lead — leaving it 'active' is how clients ended up
        // duplicated across the onboarding AND cleanup boards (ABE of
        // Mitchell, 2026-07-14).
        if (lead.status === "active") await stamp({ status: "converted" });
        return NextResponse.json({ ok: true, client_link_id: lead.client_link_id, already: true });
      }
      const clientName = lead.business_name || lead.full_name || "New client";
      const { data: created, error: createErr } = await (service as any)
        .from("client_links")
        .insert({
          client_name: clientName,
          status: "onboarding",
          is_active: true,
          assigned_bookkeeper_id: lead.assigned_to || null,
        } as any)
        .select("id")
        .single();
      if (createErr) {
        return NextResponse.json({ error: `Create client failed: ${createErr.message}` }, { status: 500 });
      }
      await stamp({ status: "converted", client_link_id: created.id });

      // Populate the new client's profile from the stored onboarding-form
      // answers (blanks-only). The insert above only set name/status/owner;
      // this fills contact, address, corporate type, revenue band, software,
      // etc. Fail-soft — a mapping hiccup must not fail the conversion.
      if (lead.ob_form_payload) {
        try {
          await applyOnboardingFormToProfile(service, created.id, lead.ob_form_payload);
        } catch (e: any) {
          console.warn(`[onboarding ${id}] profile fill on convert failed:`, e?.message);
        }
      }

      await service.from("audit_log").insert({
        event_type: "onboarding_lead_converted",
        user_id: user.id,
        request_payload: {
          lead_id: id,
          ghl_contact_id: lead.ghl_contact_id,
          client_link_id: created.id,
          client_name: clientName,
        } as any,
      });
      return NextResponse.json({ ok: true, client_link_id: created.id });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
