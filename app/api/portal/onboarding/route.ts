import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { readOnboardingState, onboardingRequiredDone } from "@/lib/portal-onboarding";

export const dynamic = "force-dynamic";

/**
 * POST /api/portal/onboarding
 *
 * Client-facing (or admin-impersonating) actions for the portal onboarding
 * wizard. Merges into client_links.portal_onboarding (jsonb) so partial
 * progress persists across sessions.
 *
 * Body: { action, ...payload }
 *   - "watch_video"                          → stamp video_watched_at
 *   - "submit_form" + foundation fields      → write profile + entity_type +
 *                                              accounts attestation; stamp form_submitted_at
 *   - "ack_docs"                             → stamp docs_provided_at
 *   - "complete"                             → stamp completed_at (only once form + docs done)
 */
const FOUNDATION_FIELDS = [
  "legal_business_name", "trade_type", "fiscal_year_end", "payroll_provider",
  "prior_bookkeeper", "accounting_software", "employee_count_range",
  "contact_first_name", "contact_last_name", "client_phone", "state_province",
] as const;

const ENTITY_TYPES = ["c_corp", "s_corp", "partnership", "sole_prop"];

export async function POST(request: Request) {
  const ctxRes = await tryResolvePortalContext();
  if (!ctxRes.ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clientLinkId = ctxRes.ctx.clientLinkId;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = body?.action as string;

  const service = createServiceSupabase();
  const { data: row } = await (service as any)
    .from("client_links")
    .select("portal_onboarding")
    .eq("id", clientLinkId)
    .single();
  const state = readOnboardingState(row);
  const now = new Date().toISOString();

  const updates: Record<string, any> = {};

  if (action === "watch_video") {
    state.video_watched_at = state.video_watched_at || now;
  } else if (action === "submit_form") {
    // Foundation intake → write straight to the client profile (onboarding
    // now lives in SNAP). Whitelisted fields only.
    for (const f of FOUNDATION_FIELDS) {
      if (typeof body[f] === "string" && body[f].trim()) updates[f] = body[f].trim();
    }
    if (ENTITY_TYPES.includes(body.entity_type)) updates.entity_type = body.entity_type;
    if (Object.keys(updates).length) updates.profile_updated_at = now;
    state.form_submitted_at = now;
    state.accounts_attested = body.accounts_attested === true;
  } else if (action === "ack_docs") {
    state.docs_provided_at = now;
  } else if (action === "complete") {
    if (!onboardingRequiredDone(state)) {
      return NextResponse.json(
        { error: "Please complete the business details and documents steps first." },
        { status: 400 }
      );
    }
    state.completed_at = state.completed_at || now;
  } else {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  updates.portal_onboarding = state;
  const { error } = await (service as any)
    .from("client_links")
    .update(updates)
    .eq("id", clientLinkId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit foundation submissions + completion (internal awareness, no email).
  if (action === "submit_form" || action === "complete") {
    try {
      await service.from("audit_log").insert({
        event_type: action === "complete" ? "portal_onboarding_completed" : "portal_onboarding_form_submitted",
        request_payload: {
          client_link_id: clientLinkId,
          accounts_attested: state.accounts_attested,
          impersonated: ctxRes.ctx.impersonating || false,
        } as any,
      } as any);
    } catch { /* non-critical */ }
  }

  return NextResponse.json({ ok: true, state });
}
