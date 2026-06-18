import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { verifyGhlWebhook } from "@/lib/ghl";
import {
  extractContactId,
  extractContactFields,
  applyOnboardingFormToProfile,
  deriveJurisdictionFromForm,
} from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/ghl/ob-form
 *
 * Fired when a client completes the Ironbooks onboarding form in GHL. The form
 * payload is keyed on EMAIL (no GHL contact id), so this:
 *   1. Stamps the onboarding lead (board) — matched by contact id OR email,
 *      created if neither exists, so the form lands on the board with answers.
 *   2. Resolves the SNAP client (client_links): a lead's linked client →
 *      else a client whose client_email matches → else CREATES the account
 *      (status=onboarding, jurisdiction derived from province).
 *   3. Maps the form answers onto that client's profile fields (migration 73).
 *
 * GHL setup: Form submitted trigger → Webhook action → this URL, with the
 * `x-snap-webhook-secret` header (or ?secret= query) set to GHL_WEBHOOK_SECRET.
 */
export async function POST(request: Request) {
  if (!verifyGhlWebhook(request)) {
    return NextResponse.json({ error: "Invalid webhook secret" }, { status: 401 });
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const cf = extractContactFields(payload); // full_name, email, phone, business_name, ghl_opportunity_id
  const contactId = extractContactId(payload); // usually null for the form
  const email = (cf.email ? String(cf.email) : "").trim();
  const emailLc = email.toLowerCase();

  // Email is the match key for this form; a contact id is a bonus when present.
  if (!emailLc && !contactId) {
    console.warn("[ghl/ob-form] no email or contact id in payload", Object.keys(payload || {}));
    return NextResponse.json(
      { error: "Onboarding form needs an email (or contact id) to match a client" },
      { status: 422 }
    );
  }

  const service = createServiceSupabase();
  const nowIso = new Date().toISOString();

  // Raw event audit (fail-soft — never block the ack on this).
  try {
    await (service as any)
      .from("onboarding_webhook_events")
      .insert({ kind: "ob_form", ghl_contact_id: contactId || `email:${emailLc}`, payload });
  } catch {
    /* ignore */
  }

  // ── 1. Onboarding lead (board). Match by contact id first, then email, so a
  //    form lands on the existing WON lead when there is one instead of a dup.
  let leadId: string | null = null;
  let leadClientLinkId: string | null = null;
  let existingLead: any = null;
  if (contactId) {
    existingLead = (
      await (service as any)
        .from("onboarding_leads")
        .select("id, client_link_id")
        .eq("ghl_contact_id", contactId)
        .maybeSingle()
    ).data;
  }
  if (!existingLead && emailLc) {
    existingLead = (
      await (service as any)
        .from("onboarding_leads")
        .select("id, client_link_id")
        .ilike("email", emailLc)
        .limit(1)
        .maybeSingle()
    ).data;
  }

  const leadFields: Record<string, any> = {
    ghl_contact_id: contactId || `email:${emailLc}`,
    ob_form_submitted_at: nowIso,
    ob_form_payload: payload,
    full_name: cf.full_name,
    email: cf.email,
    phone: cf.phone,
    business_name: cf.business_name,
    raw: payload,
    updated_at: nowIso,
  };
  if (existingLead) {
    leadId = existingLead.id;
    leadClientLinkId = existingLead.client_link_id || null;
    await (service as any).from("onboarding_leads").update(leadFields).eq("id", leadId);
  } else {
    const { data: ins } = await (service as any)
      .from("onboarding_leads")
      .insert({ source: "ob_form_webhook", status: "active", ...leadFields })
      .select("id")
      .maybeSingle();
    leadId = ins?.id || null;
  }

  // ── 2. Resolve the SNAP client: linked lead → client_email match → create.
  let clientLinkId: string | null = leadClientLinkId;
  let created = false;

  if (!clientLinkId && emailLc) {
    const { data: existingClient } = await (service as any)
      .from("client_links")
      .select("id")
      .ilike("client_email", emailLc)
      .limit(1)
      .maybeSingle();
    clientLinkId = existingClient?.id || null;
  }

  if (!clientLinkId) {
    // No account yet → create one. Profile fields are applied below; here we
    // set identity + the email match-key + derived jurisdiction.
    const clientName = cf.business_name || cf.full_name || "New onboarding client";
    const insert: Record<string, any> = {
      client_name: clientName,
      client_email: cf.email || null,
      client_phone: cf.phone || null,
      status: "onboarding",
      is_active: true,
    };
    const jur = deriveJurisdictionFromForm(payload);
    if (jur) insert.jurisdiction = jur;

    const { data: createdClient, error: createErr } = await (service as any)
      .from("client_links")
      .insert(insert)
      .select("id")
      .single();
    if (createErr) {
      console.error("[ghl/ob-form] client create failed:", createErr.message);
      return NextResponse.json(
        { ok: false, error: `Create client failed: ${createErr.message}`, lead_id: leadId },
        { status: 500 }
      );
    }
    clientLinkId = createdClient.id;
    created = true;
  }

  if (!clientLinkId) {
    return NextResponse.json(
      { ok: false, error: "Could not resolve or create a client", lead_id: leadId },
      { status: 500 }
    );
  }

  // Connect the lead to the resolved client (so the board + client profile tie
  // together), without forcing a status change in the onboarding lifecycle.
  if (leadId && clientLinkId && leadClientLinkId !== clientLinkId) {
    await (service as any)
      .from("onboarding_leads")
      .update({ client_link_id: clientLinkId, updated_at: nowIso })
      .eq("id", leadId);
  }

  // ── 3. Map the form answers onto the client profile. On a freshly created
  //    client we overwrite (nothing to stomp); on an existing one we fill
  //    blanks only so a bookkeeper's manual edits are never clobbered.
  let profileFilled = 0;
  try {
    const r = await applyOnboardingFormToProfile(service, clientLinkId, payload, {
      overwrite: created,
    });
    profileFilled = r.filled;
    if (r.error) console.warn("[ghl/ob-form] profile fill error:", r.error);
  } catch (e: any) {
    console.warn("[ghl/ob-form] profile fill skipped:", e?.message);
  }

  // Audit trail for the created/matched account.
  try {
    await service.from("audit_log").insert({
      event_type: created ? "onboarding_form_created_client" : "onboarding_form_matched_client",
      request_payload: {
        client_link_id: clientLinkId,
        lead_id: leadId,
        email: cf.email,
        business_name: cf.business_name,
        created,
        profile_filled: profileFilled,
      } as any,
    });
  } catch {
    /* ignore */
  }

  return NextResponse.json({
    ok: true,
    client_link_id: clientLinkId,
    created,
    matched_by: leadClientLinkId ? "lead" : created ? "created" : "email",
    lead_id: leadId,
    profile_filled: profileFilled,
  });
}
