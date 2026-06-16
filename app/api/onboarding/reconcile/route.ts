import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { fetchRecentWonOpportunities } from "@/lib/ghl";
import { upsertLeadFromWebhook } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * POST /api/onboarding/reconcile
 *
 * Admin/lead only. Pulls Won opportunities from the GHL API and upserts any
 * that aren't already in onboarding_leads. Intended for:
 *   - First-time setup / backfill (pass `since` in body to go back further)
 *   - Periodic self-healing (missed webhooks)
 *
 * Body (all optional):
 *   since  — ISO date string. How far back to scan. Defaults to 90 days.
 *             For a full backfill, pass e.g. "2025-01-01".
 *
 * Returns:
 *   { added, updated, skipped, errors, total }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const since: string | undefined = body.since || undefined;

  const opportunities = await fetchRecentWonOpportunities(since);
  if (opportunities.length === 0) {
    return NextResponse.json({ added: 0, updated: 0, skipped: 0, errors: 0, total: 0, message: "No won opportunities returned from GHL. If you have won deals, check the server logs for a GHL API error and confirm GHL_API_KEY + GHL_LOCATION_ID are set in Vercel." });
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const op of opportunities) {
    if (!op.contactId) { skipped++; continue; }

    // Check if already in SNAP by contact id
    const { data: existing } = await (service as any)
      .from("onboarding_leads")
      .select("id, status")
      .eq("ghl_contact_id", op.contactId)
      .maybeSingle();

    const isNew = !existing;

    // Build normalized payload — mirrors what the /won webhook receives,
    // so upsertLeadFromWebhook handles it the same way.
    const syntheticPayload = {
      contactId: op.contactId,
      opportunityId: op.id,
      first_name: op.contactName?.split(" ")[0] || null,
      last_name: op.contactName?.split(" ").slice(1).join(" ") || null,
      full_name: op.contactName,
      email: op.contactEmail,
      phone: op.contactPhone,
      company_name: op.contactCompany,
    };

    const result = await upsertLeadFromWebhook(
      service,
      "won",
      op.contactId,
      syntheticPayload,
      {
        won_at: op.wonAt || op.createdAt || new Date().toISOString(),
        full_name: op.contactName || null,
        email: op.contactEmail || null,
        phone: op.contactPhone || null,
        business_name: op.contactCompany || null,
        ghl_opportunity_id: op.id,
        source: "reconcile",
      }
    );

    if (!result.ok) {
      console.error(`[reconcile] failed for contact ${op.contactId}:`, result.error);
      errors++;
    } else if (isNew) {
      added++;
    } else {
      updated++;
    }
  }

  return NextResponse.json({ added, updated, skipped, errors, total: opportunities.length });
}
