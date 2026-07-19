import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccountsIncludingInactive, QBOReauthRequiredError } from "@/lib/qbo";
import { fetchProfitAndLoss } from "@/lib/qbo-reports";
import { stripAcctNumPrefix } from "@/lib/coa-reclass-je";
import { computeCoaDrift, type DriftMasterRow } from "@/lib/coa-drift";
import { suggestMergeTarget, type MergeTarget } from "@/lib/coa-merge-suggest";
import { suggestMergesWithAI, type AiMergeSource, type AiMergeTarget } from "@/lib/coa-merge-ai";
import { normalizeAccountName } from "@/lib/account-name";

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
    const accountsAll = await fetchAllAccountsIncludingInactive(clientLink.qbo_realm_id, accessToken);
    const accounts = accountsAll.filter((a) => a.Active !== false);
    const drift = computeCoaDrift(accounts as any, masterRows as DriftMasterRow[]);

    // "(deleted)" accounts still carrying YTD P&L activity — retired WITHOUT
    // being drained (old-cleanup damage; Despres 2026-07-18: $26k Paint &
    // Materials on a deleted account). Invisible to the active-only drift but
    // very visible on statements. Surfaced as merge candidates — the merge
    // endpoint reactivates, drains via JEs, and re-retires them properly.
    const stripDel = (s: string) => String(s || "").replace(/\s*\(deleted\)\s*$/i, "").trim();
    let deletedWithBalance: { id: string; name: string; type: string; amount: number }[] = [];
    try {
      const nowD = new Date();
      const pl = await fetchProfitAndLoss(
        clientLink.qbo_realm_id, accessToken,
        `${nowD.getFullYear()}-01-01`, nowD.toISOString().slice(0, 10)
      );
      const byAcct = new Map<string, { id: string; name: string; type: string; amount: number }>();
      for (const l of pl.lineItems) {
        if (!/\(deleted\)/i.test(l.label) || Math.abs(l.amount) < 0.01) continue;
        const labelKey = normalizeAccountName(stripAcctNumPrefix(stripDel(l.label)));
        const acct = l.account_id
          ? accountsAll.find((a) => String(a.Id) === String(l.account_id))
          : accountsAll.find(
              (a) => a.Active === false &&
                normalizeAccountName(stripAcctNumPrefix(stripDel(a.Name))) === labelKey
            );
        if (!acct || acct.Active !== false) continue;
        const prev = byAcct.get(acct.Id);
        byAcct.set(acct.Id, {
          id: acct.Id, name: acct.Name, type: acct.AccountType || "",
          amount: (prev?.amount || 0) + l.amount,
        });
      }
      deletedWithBalance = [...byAcct.values()];
    } catch {
      // Report fetch failed — skip the deleted sweep, never the scan.
    }

    // Merge proposals: the client's own accounts that already match a master
    // name are the valid merge TARGETS; an AI engine decides which non-master
    // ("sprawl") accounts should merge into which target — and, crucially,
    // which are NOT merge candidates at all (banks, cards, A/R–A/P, fixed
    // assets like vehicles/sprayers, loans) and should be left alone. The
    // bookkeeper approves/overrides one at a time; the merge route re-validates
    // and a human confirms before any transactions move.
    const masterTypeByNorm = new Map<string, string>();
    for (const m of masterRows as any[]) masterTypeByNorm.set(normalizeAccountName(m.account_name), m.qbo_account_type || "");
    const mergeTargets: MergeTarget[] = accounts
      .filter((a) => a.Active !== false && masterTypeByNorm.has(normalizeAccountName(a.Name)))
      .map((a) => ({ id: a.Id, name: a.Name }));
    const aiTargets: AiMergeTarget[] = mergeTargets.map((t) => ({
      id: t.id,
      name: t.name,
      type: (accounts.find((a) => a.Id === t.id) as any)?.AccountType || masterTypeByNorm.get(normalizeAccountName(t.name)) || "",
    }));
    const aiSources: AiMergeSource[] = [
      ...drift.nonMaster.map((nm) => ({ id: nm.id, name: nm.name, type: nm.type })),
      ...deletedWithBalance.map((d) => ({ id: d.id, name: stripDel(d.name), type: d.type })),
    ];

    let aiFailed = false;
    let suggestionById = new Map<string, { action: string; targetId: string | null; targetName: string | null; confidence: number; reason: string }>();
    try {
      const ai = await suggestMergesWithAI(aiSources, aiTargets);
      suggestionById = new Map(ai.map((s) => [s.sourceId, s]));
    } catch (e) {
      aiFailed = true; // fall back to the deterministic heuristic below
    }

    // Deleted-with-balance accounts get merge proposals too — same AI/heuristic
    // targeting; flagged so the UI can badge them and show the stranded amount.
    const deletedProposals = deletedWithBalance.map((d) => {
      const ai = suggestionById.get(d.id);
      const base = { sourceId: d.id, sourceName: d.name, sourceType: d.type, deleted: true, amount: d.amount };
      if (ai) {
        return {
          ...base,
          action: ai.action, targetId: ai.targetId, targetName: ai.targetName,
          confident: ai.action === "merge" && ai.confidence >= 0.85,
          reason: ai.reason || "retired without being drained — still carrying a balance",
        };
      }
      const isCogs = /cost of goods/i.test(d.type);
      const s = suggestMergeTarget(stripDel(d.name), isCogs, mergeTargets);
      const mergeable = /income|expense|cost of goods|equity/i.test(d.type);
      return {
        ...base,
        action: mergeable && s.confident ? "merge" : "leave",
        targetId: mergeable && s.confident ? s.target?.id || null : null,
        targetName: mergeable && s.confident ? s.target?.name || null : null,
        confident: mergeable && s.confident,
        reason: "deleted account still carrying a balance",
      };
    });

    const mergeProposals = drift.nonMaster.map((nm) => {
      const ai = suggestionById.get(nm.id);
      if (ai) {
        return {
          sourceId: nm.id, sourceName: nm.name, sourceType: nm.type,
          action: ai.action, targetId: ai.targetId, targetName: ai.targetName,
          confident: ai.action === "merge" && ai.confidence >= 0.85,
          reason: ai.reason,
        };
      }
      // Heuristic fallback (AI unavailable): only ever proposes P&L targets.
      const isCogs = /cost of goods/i.test(nm.type);
      const s = suggestMergeTarget(nm.name, isCogs, mergeTargets);
      const mergeable = /income|expense|cost of goods|equity/i.test(nm.type);
      return {
        sourceId: nm.id, sourceName: nm.name, sourceType: nm.type,
        action: mergeable && s.confident ? "merge" : "leave",
        targetId: mergeable && s.confident ? s.target?.id || null : null,
        targetName: mergeable && s.confident ? s.target?.name || null : null,
        confident: mergeable && s.confident,
        reason: mergeable ? "" : `${nm.type} account — not a merge candidate`,
      };
    });

    return NextResponse.json({
      client_link_id: clientLink.id,
      client_name: clientLink.client_name,
      jurisdiction,
      ...drift,
      mergeTargets,
      mergeProposals: [...mergeProposals, ...deletedProposals],
      deletedWithBalance: deletedWithBalance.length,
      aiSuggestions: !aiFailed,
    });
  } catch (err: any) {
    if (err instanceof QBOReauthRequiredError) {
      return NextResponse.json({ error: "QBO reconnect required", reauth: true, client_link_id: clientLink.id, client_name: clientLink.client_name }, { status: 200 });
    }
    return NextResponse.json({ error: err.message, client_link_id: clientLink.id, client_name: clientLink.client_name }, { status: 500 });
  }
}
