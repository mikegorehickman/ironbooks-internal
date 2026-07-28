import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts } from "@/lib/qbo";
import { normalizeAccountName } from "@/lib/account-name";
import { classifyRuleTargets, summarize } from "@/lib/bank-rules-coa";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Bank-rules ↔ master-COA conformance, fleet-wide (CA + US).
 *
 * GET                       → one row per active client with rules: counts of
 *                             on-master vs off-master targets. DB-only, so it
 *                             loads fast; off-master here is a maximum (the
 *                             per-client plan refines it against live QBO).
 * POST { client_link_id, action: "plan" }
 *                           → per-client classification against the client's
 *                             OWN jurisdiction master COA + their live chart,
 *                             with retarget suggestions for broken ones.
 * POST { client_link_id, action: "retarget", mappings: [{rule_id, target}] }
 *                           → rewrite those rules' target_account_name. DB
 *                             only — no QBO write; the next export carries it.
 */

async function requireAdmin() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return { error: NextResponse.json({ error: "Forbidden — admin/lead only" }, { status: 403 }) };
  }
  return { user, service };
}

/**
 * Master account names for a jurisdiction (painters, with fallback).
 *
 * `postableOnly` drops parent/header accounts: QBO lets you post to a parent
 * but it collapses the child detail and is one of the known cleanup defects,
 * so a parent is never offered as a retarget destination. Conformance
 * CHECKING still uses the full set — a rule already sitting on a parent
 * shouldn't be reported as broken.
 */
async function masterNamesFor(
  service: any,
  jurisdiction: string,
  industry?: string | null,
  postableOnly = false
) {
  const ind = industry || "painters";
  let { data } = await service
    .from("master_coa")
    .select("account_name, is_parent")
    .eq("jurisdiction", jurisdiction)
    .eq("industry", ind);
  if (!data || data.length === 0) {
    ({ data } = await service
      .from("master_coa")
      .select("account_name, is_parent")
      .eq("jurisdiction", jurisdiction)
      .eq("industry", "painters"));
  }
  const rows = ((data as any[]) || []).filter((m) => m.account_name);
  const kept = postableOnly ? rows.filter((m) => !m.is_parent) : rows;
  return [...new Set(kept.map((m) => m.account_name))];
}

export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;
  const { service } = auth;

  const { data: cls } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, industry, qbo_realm_id, is_active")
    .eq("is_active", true);
  const clients = ((cls as any[]) || []).filter((c) => c.qbo_realm_id && c.qbo_realm_id !== "DEMO");

  const { data: rules } = await service
    .from("bank_rules")
    .select("id, client_link_id, vendor_pattern, target_account_name")
    .not("target_account_name", "is", null)
    .limit(20000);

  const byClient = new Map<string, any[]>();
  for (const r of ((rules as any[]) || [])) {
    const list = byClient.get(r.client_link_id) || [];
    list.push(r);
    byClient.set(r.client_link_id, list);
  }

  // Master name sets per jurisdiction, fetched once.
  const jurisdictions = [...new Set(clients.map((c) => c.jurisdiction || "US"))];
  const masterByJur = new Map<string, Set<string>>();
  for (const j of jurisdictions) {
    const names = await masterNamesFor(service, j);
    masterByJur.set(j, new Set(names.map(normalizeAccountName)));
  }

  const rows = clients
    .map((c) => {
      const rs = byClient.get(c.id) || [];
      const master = masterByJur.get(c.jurisdiction || "US") || new Set<string>();
      let onMaster = 0;
      let offMaster = 0;
      for (const r of rs) {
        const n = normalizeAccountName(r.target_account_name);
        const leaf = normalizeAccountName(String(r.target_account_name).split(":").pop() || "");
        if (master.has(n) || master.has(leaf)) onMaster++;
        else offMaster++;
      }
      return {
        client_link_id: c.id,
        client_name: c.client_name,
        jurisdiction: c.jurisdiction || "US",
        total: rs.length,
        on_master: onMaster,
        off_master: offMaster,
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.off_master - a.off_master || a.client_name.localeCompare(b.client_name));

  return NextResponse.json({ clients: rows });
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;
  const { service, user } = auth;

  const body = await request.json().catch(() => ({} as any));
  const clientLinkId = String(body.client_link_id || "");
  const action = String(body.action || "plan");
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, jurisdiction, industry, qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  if (action === "plan") {
    const { data: rules } = await (service as any)
      .from("bank_rules")
      .select("id, vendor_pattern, target_account_name")
      .eq("client_link_id", clientLinkId)
      .not("target_account_name", "is", null);

    const jurisdiction = (client as any).jurisdiction || "US";
    // Full set for the conformance check; postable-only for suggestions and
    // the retarget dropdown.
    const masterNames = await masterNamesFor(service, jurisdiction, (client as any).industry);
    const postableNames = await masterNamesFor(service, jurisdiction, (client as any).industry, true);

    // Live chart separates legit non-master targets (bank accounts used by
    // transfer rules) from genuinely broken ones. Non-fatal if QBO is down —
    // we just report conservatively.
    let liveNames: string[] | null = null;
    let liveError: string | null = null;
    try {
      const token = await getValidToken(clientLinkId, service);
      const accounts = await fetchAllAccounts((client as any).qbo_realm_id, token);
      liveNames = accounts.flatMap((a) => [a.Name, a.FullyQualifiedName].filter(Boolean) as string[]);
    } catch (e: any) {
      liveError = String(e?.message || e).slice(0, 200);
    }

    const rows = classifyRuleTargets({
      rules: (rules as any[]) || [],
      masterNames,
      suggestFrom: postableNames,
      liveAccountNames: liveNames,
    });
    return NextResponse.json({
      ok: true,
      client_name: (client as any).client_name,
      jurisdiction,
      master_count: masterNames.length,
      master_names: postableNames.sort(),
      live_checked: !!liveNames,
      live_error: liveError,
      summary: summarize(rows),
      rows,
    });
  }

  if (action === "retarget") {
    const mappings = Array.isArray(body.mappings) ? body.mappings : [];
    if (mappings.length === 0) {
      return NextResponse.json({ error: "No mappings supplied" }, { status: 400 });
    }
    const jurisdiction = (client as any).jurisdiction || "US";
    // Retarget destinations are postable accounts only — never a parent.
    const masterNames = await masterNamesFor(service, jurisdiction, (client as any).industry, true);
    const masterSet = new Set(masterNames.map(normalizeAccountName));

    const updated: any[] = [];
    const failed: any[] = [];
    for (const m of mappings) {
      const ruleId = String(m.rule_id || "");
      const target = String(m.target || "").trim();
      if (!ruleId || !target) {
        failed.push({ rule_id: ruleId, error: "rule_id and target required" });
        continue;
      }
      // Only ever retarget ONTO the client's own jurisdiction master COA —
      // that's the whole point, and it stops a US name landing on a CA book.
      if (!masterSet.has(normalizeAccountName(target))) {
        failed.push({ rule_id: ruleId, error: `"${target}" is not in the ${jurisdiction} master COA` });
        continue;
      }
      const { error } = await (service as any)
        .from("bank_rules")
        .update({ target_account_name: target, target_qbo_account_id: null })
        .eq("id", ruleId)
        .eq("client_link_id", clientLinkId);
      if (error) failed.push({ rule_id: ruleId, error: error.message });
      else updated.push({ rule_id: ruleId, target });
    }

    if (updated.length > 0) {
      await service.from("audit_log").insert({
        event_type: "bank_rules_retargeted",
        user_id: user.id,
        request_payload: {
          client_link_id: clientLinkId,
          client_name: (client as any).client_name,
          jurisdiction,
          updated_count: updated.length,
          updated,
        } as any,
      });
    }
    return NextResponse.json({ ok: true, updated: updated.length, failed });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
