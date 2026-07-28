/**
 * Fleet COA conformance — bring ONE client's chart to the current master COA.
 *
 * Composes the primitives the per-client audit already uses, in the order that
 * actually works:
 *
 *   1. CREATE  every missing master account (applyMasterCoaToClient — additive,
 *              parent-aware). Merges and rules need their targets to exist.
 *   2. RETYPE  accounts sitting in the wrong statement section.
 *   3. MERGE   each non-master account into its master target, NO JE:
 *              line-reclass moves the real Bill/Purchase/Expense/VendorCredit
 *              transactions; anything left (income, deposits, paycheques,
 *              existing JEs) is NOT lump-JE'd — the source stays ACTIVE and
 *              lands on a QBO-UI merge worklist. See drainAndRetireAccount's
 *              allowJeSweep (default false) — Mike, 2026-07-26.
 *
 * Planning is read-only. Execution is per client, never fleet-wide in one
 * click (Clean Cut rule), and only merges CONFIDENT proposals.
 */

import {
  getValidToken, fetchAllAccounts, fetchAllAccountsIncludingInactive, type QBOAccount,
} from "./qbo";
import { normalizeAccountName } from "./account-name";
import { computeCoaDrift, type DriftMasterRow } from "./coa-drift";
import { suggestMergeTarget, type MergeTarget } from "./coa-merge-suggest";
import { computeRetypePlans, type RetypeMasterRow } from "./coa-retype";
import { retypeAccountViaRebuild, drainAndRetireAccount } from "./coa-reclass-je";
import { applyMasterCoaToClient, type MasterCoaRow } from "./apply-master-coa";

/** Merges + retypes are scoped to this window (reclass + verify range). */
const RANGE_START = "2000-01-01";

export interface ConformanceMergeStep {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  targetId: string;
  targetName: string;
}

export interface ConformancePlan {
  client_link_id: string;
  client_name: string;
  jurisdiction: string;
  conformance_pct: number;
  total_active: number;
  matched: number;
  /** Master accounts absent from the live chart (any, not just required). */
  creates: string[];
  retypes: { id: string; name: string; from: string; to: string }[];
  merges: ConformanceMergeStep[];
  /** Non-master accounts with no confident target — a human decides. */
  unmatched: { id: string; name: string; type: string; reason: string }[];
}

export interface ConformanceResult {
  created: string[];
  retyped: string[];
  merged: { source: string; target: string; linesMoved: number }[];
  /** Merged as far as the API allows; residue needs a native QBO-UI merge. */
  needs_qbo_merge: { source: string; target: string; reason: string }[];
  failed: { step: string; error: string }[];
}

export interface ConformanceClient {
  id: string;
  client_name: string;
  qbo_realm_id: string;
  jurisdiction?: string | null;
  industry?: string | null;
}

async function masterRows(service: any, jurisdiction: string, industry?: string | null) {
  const ind = industry || "painters";
  const cols =
    "account_name, parent_account_name, is_parent, is_required, qbo_account_type, qbo_account_subtype";
  let { data } = await service
    .from("master_coa").select(cols)
    .eq("jurisdiction", jurisdiction).eq("industry", ind);
  if (!data || data.length === 0) {
    ({ data } = await service
      .from("master_coa").select(cols)
      .eq("jurisdiction", jurisdiction).eq("industry", "painters"));
  }
  return ((data as any[]) || []);
}

export async function buildConformancePlan(
  service: any,
  client: ConformanceClient
): Promise<ConformancePlan> {
  const jurisdiction = client.jurisdiction || "US";
  const token = await getValidToken(client.id, service);
  const accounts = await fetchAllAccounts(client.qbo_realm_id, token);
  const master = await masterRows(service, jurisdiction, client.industry);

  const drift = computeCoaDrift(accounts as any, master as DriftMasterRow[]);

  // Missing master accounts. CoaDrift only reports missingRequired, but a
  // merge/rule target has to exist regardless of the required flag — so
  // compute the full set against live names (incl. inactive, since QBO
  // refuses to recreate a name held by a deleted account).
  const liveNorm = new Set(accounts.map((a) => normalizeAccountName(a.Name)));
  const creates = master
    .filter((m) => !m.is_parent && !liveNorm.has(normalizeAccountName(m.account_name)))
    .map((m) => m.account_name as string);

  // Merge targets = live accounts whose name IS a master account.
  const masterByNorm = new Set(master.map((m) => normalizeAccountName(m.account_name)));
  const mergeTargets: MergeTarget[] = accounts
    .filter((a) => a.Active !== false && masterByNorm.has(normalizeAccountName(a.Name)))
    .map((a) => ({ id: a.Id, name: a.Name }));

  const merges: ConformanceMergeStep[] = [];
  const unmatched: ConformancePlan["unmatched"] = [];
  for (const nm of drift.nonMaster) {
    // Only P&L-ish accounts merge. Banks / credit cards / loans / A-R / A-P
    // are legitimately client-specific and must never be merged away.
    if (!/income|expense|cost of goods|equity/i.test(nm.type)) {
      unmatched.push({ id: nm.id, name: nm.name, type: nm.type, reason: `${nm.type} — not a merge candidate` });
      continue;
    }
    const s = suggestMergeTarget(nm.name, /cost of goods/i.test(nm.type), mergeTargets);
    if (s.confident && s.target && s.target.id !== nm.id) {
      merges.push({
        sourceId: nm.id, sourceName: nm.name, sourceType: nm.type,
        targetId: s.target.id, targetName: s.target.name,
      });
    } else {
      unmatched.push({ id: nm.id, name: nm.name, type: nm.type, reason: "no confident master target — pick one manually" });
    }
  }

  return {
    client_link_id: client.id,
    client_name: client.client_name,
    jurisdiction,
    conformance_pct: drift.conformancePct,
    total_active: drift.totalActive,
    matched: drift.matched,
    creates,
    retypes: drift.wrongType.map((w) => ({ id: w.id, name: w.name, from: w.currentType, to: w.masterType })),
    merges,
    unmatched,
  };
}

/**
 * Execute. Rebuilds the plan server-side first so we never act on a stale
 * preview. `mergeSourceIds` optionally restricts which merges run.
 */
export async function executeConformancePlan(
  service: any,
  client: ConformanceClient,
  opts: { actorUserId: string | null; mergeSourceIds?: string[] | null; skipMerges?: boolean }
): Promise<{ plan: ConformancePlan; result: ConformanceResult }> {
  const before = await buildConformancePlan(service, client);
  const result: ConformanceResult = { created: [], retyped: [], merged: [], needs_qbo_merge: [], failed: [] };

  const master = await masterRows(service, before.jurisdiction, client.industry);
  const token = await getValidToken(client.id, service);
  const today = new Date().toISOString().slice(0, 10);

  // ── 1. CREATE missing master accounts (parent-aware, additive) ──
  if (before.creates.length > 0) {
    try {
      const applied = await applyMasterCoaToClient({
        clientLinkId: client.id,
        clientName: client.client_name,
        realmId: client.qbo_realm_id,
        accessToken: token,
        masterRows: master as MasterCoaRow[],
        dryRun: false,
      });
      result.created = applied.created || [];
      for (const e of (applied as any).errors || []) {
        result.failed.push({ step: "create", error: String(e).slice(0, 180) });
      }
    } catch (e: any) {
      result.failed.push({ step: "create", error: String(e?.message || e).slice(0, 180) });
    }
  }

  // ── 2. RETYPE wrong-section accounts ──
  if (before.retypes.length > 0) {
    try {
      const live = await fetchAllAccountsIncludingInactive(client.qbo_realm_id, token);
      const wanted = new Set(before.retypes.map((r) => r.id));
      const plans = computeRetypePlans({
        masterRows: master as RetypeMasterRow[],
        clientAccounts: live as any,
      }).filter((p) => wanted.has(p.qbo_account_id));

      for (const rp of plans) {
        const account = live.find((a) => a.Id === rp.qbo_account_id);
        if (!account) continue;
        try {
          await retypeAccountViaRebuild({
            realmId: client.qbo_realm_id,
            accessToken: token,
            account,
            newType: rp.new_type,
            newSubType: rp.new_subtype,
            startDate: RANGE_START,
            endDate: today,
          });
          result.retyped.push(rp.current_name);
        } catch (e: any) {
          result.failed.push({ step: `retype ${rp.current_name}`, error: String(e?.message || e).slice(0, 180) });
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (e: any) {
      result.failed.push({ step: "retype", error: String(e?.message || e).slice(0, 180) });
    }
  }

  // ── 3. MERGE non-master → master (NO JE) ──
  if (!opts.skipMerges && before.merges.length > 0) {
    const allowed = opts.mergeSourceIds ? new Set(opts.mergeSourceIds) : null;
    // Refetch after creates/retypes so ids + SyncTokens are current.
    const live = await fetchAllAccountsIncludingInactive(client.qbo_realm_id, token);
    const byId = new Map(live.map((a) => [a.Id, a]));

    for (const step of before.merges) {
      if (allowed && !allowed.has(step.sourceId)) continue;
      const source = byId.get(step.sourceId) as QBOAccount | undefined;
      const target = byId.get(step.targetId) as QBOAccount | undefined;
      if (!source || source.Active === false) continue;
      if (!target || target.Active === false) {
        result.failed.push({ step: `merge ${step.sourceName}`, error: "target missing or inactive" });
        continue;
      }
      try {
        const drain = await drainAndRetireAccount({
          realmId: client.qbo_realm_id,
          accessToken: token,
          source,
          target,
          startDate: RANGE_START,
          endDate: today,
          memo: `SNAP conformance merge: "${source.Name}" → "${target.Name}"`,
          allAccounts: live,
          allowJeSweep: false, // policy: never lump residue into a JE
        });
        if (drain.inactivated) {
          result.merged.push({ source: source.Name, target: target.Name, linesMoved: drain.linesMoved });
        } else {
          result.needs_qbo_merge.push({
            source: source.Name,
            target: target.Name,
            reason:
              drain.failures[0] ||
              "residue line-reclass can't move (income / deposits / paycheques) — merge in the QuickBooks UI",
          });
        }
        await service.from("audit_log").insert({
          event_type: "coa_conformance_merge",
          user_id: opts.actorUserId,
          request_payload: {
            client_link_id: client.id, client_name: client.client_name,
            source: source.Name, target: target.Name,
            lines_moved: drain.linesMoved, jes_posted: drain.jesPosted,
            inactivated: drain.inactivated, failures: drain.failures,
          } as any,
        });
      } catch (e: any) {
        result.failed.push({ step: `merge ${step.sourceName}`, error: String(e?.message || e).slice(0, 200) });
      }
      await new Promise((r) => setTimeout(r, 200)); // pace QBO
    }
  }

  const after = await buildConformancePlan(service, client);
  await service.from("audit_log").insert({
    event_type: "coa_conformance_run",
    user_id: opts.actorUserId,
    request_payload: {
      client_link_id: client.id, client_name: client.client_name,
      before_pct: before.conformance_pct, after_pct: after.conformance_pct,
      created: result.created.length, retyped: result.retyped.length,
      merged: result.merged.length, needs_qbo_merge: result.needs_qbo_merge.length,
      failed: result.failed.length,
    } as any,
  });

  return { plan: after, result };
}
