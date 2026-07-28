import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { readOnboardingState, onboardingRequiredDone } from "@/lib/portal-onboarding";
import { maybeSendOnboardingReward, type RewardOutcome } from "@/lib/onboarding-reward";

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
  } else if (action === "save_progress") {
    // Autosave from the paged intake form — called on every "Next" so a client
    // can close the tab and resume. Stores the raw answers only; nothing is
    // validated and nothing is marked done.
    if (body.answers && typeof body.answers === "object") {
      state.form_draft = body.answers;
      state.form_draft_page = Number.isFinite(body.page) ? Number(body.page) : 0;
      state.form_saved_at = now;
    }
  } else if (action === "submit_form") {
    // The full intake. Everything is kept verbatim in form_answers (most of the
    // 29 fields have no column of their own), and the subset that maps onto the
    // client profile is written through so the rest of SNAP sees it.
    const ans = (body.answers && typeof body.answers === "object" ? body.answers : body) as any;

    const mapped: Record<string, string> = {
      legal_business_name: ans.companyName,
      trade_type: ans.tradeType,
      corporate_type: ans.corporationType,
      fiscal_year_end: ans.fiscalYearEnd,
      state_province: ans.provinceState,
      country: ans.country,
      annual_revenue_range: ans.annualRevenue,
      taxes_up_to_date: ans.taxesUpToDate,
      prior_bookkeeper: ans.lastBookkeeper,
      accounting_software: ans.accountingSoftware,
      employee_count_range: ans.employeeCount,
      keeps_receipts: ans.keepsReceipts,
      bank_connected_to_software: ans.bankConnected,
      uses_business_cards: ans.cardsUsed,
      payroll_provider:
        ans.payrollProvider === "Other" ? ans.payrollProviderOther : ans.payrollProvider,
      contact_first_name: ans.firstName,
      contact_last_name: ans.lastName,
      client_phone: ans.phone,
    };
    for (const [col, val] of Object.entries(mapped)) {
      if (typeof val === "string" && val.trim()) updates[col] = val.trim();
    }
    // Legacy direct-field callers (older clients mid-flow) still work.
    for (const f of FOUNDATION_FIELDS) {
      if (typeof body[f] === "string" && body[f].trim()) updates[f] = body[f].trim();
    }
    if (ENTITY_TYPES.includes(body.entity_type)) updates.entity_type = body.entity_type;
    if (Object.keys(updates).length) updates.profile_updated_at = now;

    state.form_answers = ans;
    state.form_draft = null;
    state.form_submitted_at = now;
    // The bank-list attestation is the one that matters — record the client's
    // own timestamp when they gave it, not when they hit submit.
    state.accounts_attested = ans.accountAttestation === true || body.accounts_attested === true;
    state.accounts_attested_at = ans.accountAttestationTimestamp || (state.accounts_attested ? now : null);
  } else if (action === "book_call") {
    // Client confirms the onboarding call is booked. The GHL appointment webhook
    // (/api/webhooks/ghl/ob-call) sets the same field authoritatively when it
    // fires; whichever lands first wins and the other is a no-op.
    state.call_booked_at = state.call_booked_at || now;
  } else if (action === "ack_docs") {
    // Retired from the wizard (statements are requested by the bookkeeper now),
    // but the action still works for any older client mid-flow.
    state.docs_provided_at = now;
  } else if (action === "complete") {
    if (!onboardingRequiredDone(state)) {
      return NextResponse.json(
        { error: "Please fill in your business details and book your onboarding call first." },
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

  // Finishing onboarding earns the thank-you gift card. Exactly-once and
  // never-for-staff are enforced inside the helper, which also never throws —
  // a reward problem must not fail the client's completion.
  let reward: RewardOutcome | null = null;
  if (action === "complete") {
    reward = await maybeSendOnboardingReward(service, clientLinkId, {
      impersonating: ctxRes.ctx.impersonating || false,
    });
  }

  return NextResponse.json({ ok: true, state, reward });
}
