import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, updateAccountType, QBOReauthRequiredError } from "@/lib/qbo";
import { computeRetypePlans, type RetypeMasterRow } from "@/lib/coa-retype";
import { applyMasterCoaToClient, type MasterCoaRow } from "@/lib/apply-master-coa";
import { computeCoaDrift, type DriftMasterRow } from "@/lib/coa-drift";
import { normalizeAccountName } from "@/lib/account-name";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/coa-audit/fix — apply the DETERMINISTIC, SAFE half of COA
 * standardization for ONE client, from the audit view, after the admin has
 * reviewed the specific changes (Mike, 2026-07-16: fix the COAs one by one,
 * verifying the changes and the re-write):
 *   - retype: change AccountType/SubType so an account sits in the right
 *     statement section (fixes the "expenses below net profit" case). Does
 *     NOT move transactions.
 *   - create: create a missing REQUIRED master account (additive).
 *
 * Deliberately NOT here: merges / renames / deletes of the non-master
 * sprawl — those move transactions + inactivate accounts and stay in the
 * reviewed per-client COA cleanup with its date-scope + guards.
 *
 * Server revalidates: it recomputes the plans from live QBO + master and
 * only touches accounts/names the client selected that are STILL valid
 * candidates — the request is never trusted blindly.
 *
 * Body: { client_link_id, retype_account_ids?: string[], create_account_names?: string[] }
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
  const retypeIds: string[] = Array.isArray(body.retype_account_ids) ? body.retype_account_ids.map(String) : [];
  const createNames: string[] = Array.isArray(body.create_account_names) ? body.create_account_names.map(String) : [];
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  if (retypeIds.length === 0 && createNames.length === 0) {
    return NextResponse.json({ error: "Nothing selected to fix" }, { status: 400 });
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, jurisdiction, industry, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!clientLink?.qbo_realm_id || !clientLink.is_active) {
    return NextResponse.json({ error: "Client not found / inactive / not QBO-connected" }, { status: 404 });
  }

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

  const summary = {
    retyped: [] as string[],
    created: [] as string[],
    failed: [] as { account: string; message: string }[],
  };

  try {
    const accessToken = await getValidToken(clientLink.id, service as any, "ironbooks/api/admin/coa-audit/fix");

    // ── Retypes (revalidated against live QBO) ──
    if (retypeIds.length > 0) {
      const accounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
      const byId = new Map(accounts.map((a) => [a.Id, a]));
      // Accounts that are a PARENT of something — QBO forbids changing the
      // type of an account that has subaccounts ("You cannot change the type
      // of an account with subaccounts"). Skip with a clear reason rather than
      // surfacing a raw 400.
      const hasChildren = new Set(
        accounts.filter((a) => a.Active !== false && (a as any).ParentRef?.value).map((a) => String((a as any).ParentRef.value))
      );
      const validPlans = computeRetypePlans({
        masterRows: masterRows as RetypeMasterRow[],
        clientAccounts: accounts.filter((a) => a.Active !== false),
      }).filter((p) => retypeIds.includes(p.qbo_account_id));

      for (const plan of validPlans) {
        const current: any = byId.get(plan.qbo_account_id);
        if (!current) {
          summary.failed.push({ account: plan.current_name, message: "account no longer exists" });
          continue;
        }
        if (hasChildren.has(String(plan.qbo_account_id))) {
          summary.failed.push({ account: plan.current_name, message: "has sub-accounts — QBO won't retype a parent; re-parent or retype its children first (handle in the per-client COA cleanup)" });
          continue;
        }
        const parent: any = current.ParentRef?.value ? byId.get(current.ParentRef.value) : null;
        const detachFromParent = !!current.SubAccount && !!parent && parent.AccountType !== plan.new_type;
        try {
          await updateAccountType(clientLink.qbo_realm_id, accessToken, plan.qbo_account_id, current.SyncToken, {
            newType: plan.new_type,
            newSubType: plan.new_subtype,
            currentAccount: current,
            detachFromParent,
          });
          summary.retyped.push(`${plan.current_name} → ${plan.new_type}`);
        } catch (e: any) {
          summary.failed.push({ account: plan.current_name, message: e.message });
        }
      }
    }

    // ── Create missing required (additive; reuses the existing primitive,
    //    scoped to the selected names, which it re-verifies as missing) ──
    if (createNames.length > 0) {
      const applyResult = await applyMasterCoaToClient({
        clientLinkId: clientLink.id,
        clientName: clientLink.client_name,
        realmId: clientLink.qbo_realm_id,
        accessToken,
        masterRows: masterRows as MasterCoaRow[],
        dryRun: false,
        onlyLeafNames: createNames,
      });
      summary.created = applyResult.created;
      for (const e of applyResult.errors) summary.failed.push(e);
    }

    // Fresh drift so the UI updates the conformance score in place.
    const accountsAfter = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
    const drift = computeCoaDrift(accountsAfter as any, masterRows as DriftMasterRow[]);

    await service.from("audit_log").insert({
      event_type: "coa_audit_fix",
      user_id: user.id,
      request_payload: {
        client_link_id: clientLink.id,
        client_name: clientLink.client_name,
        retyped: summary.retyped,
        created: summary.created,
        failed: summary.failed,
        conformance_after: drift.conformancePct,
      } as any,
    } as any);

    return NextResponse.json({ ...summary, drift });
  } catch (err: any) {
    if (err instanceof QBOReauthRequiredError) {
      return NextResponse.json({ error: "QBO reconnect required", reauth: true }, { status: 200 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
