import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { verifyGhlWebhook } from "@/lib/ghl";
import {
  extractContactId,
  extractContactFields,
  upsertLeadFromWebhook,
  resolveOrCreateClientForWon,
  deriveJurisdictionFromForm,
} from "@/lib/onboarding";

export const dynamic = "force-dynamic";

// The SNAP bookkeeping sales pipeline. A "won" elsewhere (e.g. the Profit
// X-Ray & Discovery pipeline) is NOT a bookkeeping client and must not mint a
// client profile. If GHL ever sends a pipeline id, we gate on this; when the
// payload omits it (older workflow config) we trust the workflow is bound to
// the Sales pipeline and proceed.
const SALES_PIPELINE_ID = "lcF5sqcxDLrykCIqB4Eh";

function pipelineIsBookkeeping(payload: any): boolean {
  const pid =
    payload?.pipeline_id ||
    payload?.pipelineId ||
    payload?.opportunity?.pipelineId ||
    null;
  // No pipeline in payload → trust the GHL workflow's own pipeline scoping.
  if (!pid) return true;
  return pid === SALES_PIPELINE_ID;
}

/**
 * POST /api/webhooks/ghl/won
 *
 * Fired by the GHL workflow when an opportunity is marked WON. Two effects:
 *   1. Creates/updates the onboarding lead and stamps won_at (onboarding clock).
 *   2. Creates the SNAP client profile (client_links, status "onboarding") if
 *      one doesn't already exist for this contact's email, and links the lead
 *      to it. A won deal is a committed client, so it gets a profile at once.
 *
 * GHL setup: Workflow trigger "Opportunity Status Changed → Won" on the
 * Ironbooks Sales pipeline → Webhook action → this URL, with header
 * `x-snap-webhook-secret: <GHL_WEBHOOK_SECRET>`.
 *
 * Field mapping is best-effort (see lib/onboarding.ts `pick`/`extract*`); the
 * full raw payload is stored so we can finalize the mapping against a real
 * sample without losing anything.
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

  const contactId = extractContactId(payload);
  if (!contactId) {
    console.warn("[ghl/won] no contact id in payload", Object.keys(payload || {}));
    return NextResponse.json({ error: "Missing contact id" }, { status: 422 });
  }

  const service = createServiceSupabase();
  const fields = extractContactFields(payload);
  const result = await upsertLeadFromWebhook(service, "won", contactId, payload, {
    won_at: new Date().toISOString(),
    ...fields,
  });

  if (!result.ok) {
    console.error("[ghl/won] upsert failed:", result.error);
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  // On WON, create the SNAP client right away (status=onboarding) so it exists
  // before the onboarding form arrives. Bookkeeping-pipeline wins only — a
  // Profit X-Ray / Discovery "won" must not mint a bookkeeping profile.
  // Idempotent: honor the lead's already-linked client first, else
  // resolveOrCreateClientForWon (email-match, else create). Fail-soft — a
  // flaky create/link must never break the webhook ack.
  let clientLinkId: string | null = null;
  let clientCreated = false;
  if (pipelineIsBookkeeping(payload)) {
    try {
      const { data: lead } = await (service as any)
        .from("onboarding_leads")
        .select("client_link_id")
        .eq("id", result.id)
        .maybeSingle();
      clientLinkId = lead?.client_link_id || null;

      if (!clientLinkId) {
        const r = await resolveOrCreateClientForWon(service, {
          email: fields.email,
          fullName: fields.full_name,
          businessName: fields.business_name,
          phone: fields.phone,
          jurisdiction: deriveJurisdictionFromForm(payload),
          ghlContactId: contactId,
          ghlOpportunityId: fields.ghl_opportunity_id,
        });
        if (r.error) console.error("[ghl/won] client create failed:", r.error);
        clientLinkId = r.clientLinkId;
        clientCreated = r.created;
      }

      if (clientLinkId) {
        await (service as any)
          .from("onboarding_leads")
          .update({ client_link_id: clientLinkId, updated_at: new Date().toISOString() })
          .eq("id", result.id);
        await service.from("audit_log").insert({
          event_type: clientCreated ? "ghl_won_created_client" : "ghl_won_linked_client",
          request_payload: {
            lead_id: result.id,
            client_link_id: clientLinkId,
            email: fields.email,
            created: clientCreated,
          } as any,
        });
      }
    } catch (e: any) {
      console.warn("[ghl/won] client create/link skipped:", e?.message);
    }
  }

  return NextResponse.json({
    ok: true,
    lead_id: result.id,
    client_link_id: clientLinkId,
    client_created: clientCreated,
  });
}
