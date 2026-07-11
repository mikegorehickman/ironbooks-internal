import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { applyMasterCoaToClient, type MasterCoaRow } from "@/lib/apply-master-coa";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/apply-master-coa — create every missing master account in
 * ONE client's QBO (additive only; renames/merges stay in the reviewed COA
 * cleanup). The /admin/apply-master-coa page loops clients in the browser,
 * so each invocation stays small and a failure only affects one client.
 *
 * Body: { client_link_id: string, dry_run?: boolean }
 * Auth: admin only.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }

  const body = await request.json();
  const clientLinkId = String(body.client_link_id || "");
  const dryRun = body.dry_run !== false; // default TRUE — writes are opt-in
  if (!clientLinkId) {
    return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, jurisdiction, industry, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!clientLink) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!clientLink.is_active || !clientLink.qbo_realm_id) {
    return NextResponse.json({ error: "Client inactive or not QBO-connected" }, { status: 400 });
  }

  // Resolve the template. Clients carry legacy/unsupported industry values
  // ("painting" instead of "painters"; general_contractors/chimney_sweepers
  // have no dedicated template yet) — fall back to the painters template
  // rather than erroring, since it's the standard chart and deliberately
  // trade-generic. The client's industry field is not modified.
  const industryRaw = ((clientLink as any).industry as string) || "painters";
  const jurisdiction = clientLink.jurisdiction || "US";
  let { data: masterRows } = await service
    .from("master_coa")
    .select("account_name, parent_account_name, is_parent, qbo_account_type, qbo_account_subtype")
    .eq("industry", industryRaw)
    .eq("jurisdiction", jurisdiction);
  if ((!masterRows || masterRows.length === 0) && industryRaw !== "painters") {
    ({ data: masterRows } = await service
      .from("master_coa")
      .select("account_name, parent_account_name, is_parent, qbo_account_type, qbo_account_subtype")
      .eq("industry", "painters")
      .eq("jurisdiction", jurisdiction));
  }
  if (!masterRows || masterRows.length === 0) {
    return NextResponse.json({ error: `No master COA rows for jurisdiction=${jurisdiction} (industry=${industryRaw}, painters fallback also empty)` }, { status: 400 });
  }

  try {
    const accessToken = await getValidToken(clientLink.id, service as any, "ironbooks/api/admin/apply-master-coa");
    const result = await applyMasterCoaToClient({
      clientLinkId: clientLink.id,
      clientName: clientLink.client_name,
      realmId: clientLink.qbo_realm_id,
      accessToken,
      masterRows: masterRows as MasterCoaRow[],
      dryRun,
    });

    if (!dryRun && (result.created.length > 0 || result.errors.length > 0)) {
      await service.from("audit_log").insert({
        event_type: "apply_master_coa",
        user_id: user.id,
        request_payload: {
          client_link_id: clientLink.id,
          client_name: clientLink.client_name,
          created: result.created,
          errors: result.errors,
          missing_before: result.missing.length,
        },
      } as any);
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message, client_link_id: clientLink.id, client_name: clientLink.client_name },
      { status: 500 }
    );
  }
}
