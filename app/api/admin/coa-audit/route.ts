import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, QBOReauthRequiredError } from "@/lib/qbo";
import { computeCoaDrift, type DriftMasterRow } from "@/lib/coa-drift";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/admin/coa-audit — READ-ONLY drift report for ONE client: how far
 * its live QBO chart is from the master COA (matched / wrong-type /
 * non-master / missing-required + a conformance %). No writes. The
 * /admin/coa-audit page loops clients in the browser. Admin only.
 *
 * This is the triage layer for the "apply the master COA to every client"
 * phase — it tells us which clients need the transformative standardization
 * pass (merge/retype/rename) and how badly, before any QBO write happens.
 *
 * Body: { client_link_id: string }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "");
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, jurisdiction, industry, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!clientLink) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!clientLink.is_active || !clientLink.qbo_realm_id) {
    return NextResponse.json({ error: "Client inactive or not QBO-connected" }, { status: 400 });
  }

  // Same template resolution + painters fallback as apply-master-coa.
  const industryRaw = ((clientLink as any).industry as string) || "painters";
  const jurisdiction = clientLink.jurisdiction || "US";
  let { data: masterRows } = await service
    .from("master_coa")
    .select("account_name, qbo_account_type, qbo_account_subtype, parent_account_name, is_parent, is_required")
    .eq("industry", industryRaw)
    .eq("jurisdiction", jurisdiction);
  if ((!masterRows || masterRows.length === 0) && industryRaw !== "painters") {
    ({ data: masterRows } = await service
      .from("master_coa")
      .select("account_name, qbo_account_type, qbo_account_subtype, parent_account_name, is_parent, is_required")
      .eq("industry", "painters")
      .eq("jurisdiction", jurisdiction));
  }
  if (!masterRows || masterRows.length === 0) {
    return NextResponse.json({ error: `No master COA for ${jurisdiction}/${industryRaw}` }, { status: 400 });
  }

  try {
    const accessToken = await getValidToken(clientLink.id, service as any, "ironbooks/api/admin/coa-audit");
    const accounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
    const drift = computeCoaDrift(accounts as any, masterRows as DriftMasterRow[]);
    return NextResponse.json({
      client_link_id: clientLink.id,
      client_name: clientLink.client_name,
      jurisdiction,
      ...drift,
    });
  } catch (err: any) {
    if (err instanceof QBOReauthRequiredError) {
      return NextResponse.json({ error: "QBO reconnect required", reauth: true, client_link_id: clientLink.id, client_name: clientLink.client_name }, { status: 200 });
    }
    return NextResponse.json({ error: err.message, client_link_id: clientLink.id, client_name: clientLink.client_name }, { status: 500 });
  }
}
