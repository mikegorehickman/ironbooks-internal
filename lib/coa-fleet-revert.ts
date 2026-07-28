/**
 * Fleet apply-master-coa REVERT (2026-07-26, Mike's 19-client list).
 *
 * The fleet-wide apply-master-coa runs (2026-07-11 + 07-14) pushed the master
 * chart into every client — including clients whose charts should have been
 * left alone. The tool was ADDITIVE-ONLY and every run logged exactly which
 * account names it created (audit_log.apply_master_coa → request_payload
 * .created), so the revert is precise: inactivate those accounts again.
 *
 * Safety classification per created account (the whole point of this module):
 *   safe      — active, ZERO postings since the apply date, zero balance
 *               → inactivating restores the pre-tool chart exactly
 *   activity  — has postings or a balance → NOT touched; transactions must be
 *               reclassed off it first (surfaced for a human)
 *   ambiguous — 2+ active accounts share the name → NOT touched
 *   gone      — already inactive / renamed → nothing to do
 *
 * Execution is per-client (never fleet-wide one-click — Clean Cut incident),
 * dry-run by default, children before parents (QBO error 6000 otherwise),
 * and a parent is skipped when any ACTIVE child is not itself being removed.
 * Every write is audit-logged (coa_fleet_revert_inactivated).
 */

import {
  getValidToken,
  fetchAllAccountsIncludingInactive,
  inactivateAccount,
  qboRequest,
  type QBOAccount,
} from "./qbo";
import { fetchPLDetailAll } from "./qbo-reports";
import { drainAndRetireAccount, type DrainRetireResult } from "./coa-reclass-je";

const APPLY_START = "2026-07-11";

export interface RevertAccount {
  name: string;
  id: string;
  type: string;
  fq: string;
  parent: string | null;
}

export interface RevertPlan {
  client_link_id: string;
  client_name: string;
  created_count: number;
  safe: RevertAccount[];
  activity: { name: string; id: string; type: string; classification: string; balance: number; posted: boolean }[];
  ambiguous: string[];
  gone: string[];
  /** Active accounts NOT created by the push — step-2 drain targets. */
  targets: { id: string; name: string; fq: string; type: string; classification: string }[];
}

/** Created-account names for one client, unioned across every apply event. */
export async function createdNamesFor(service: any, clientLinkId: string): Promise<string[]> {
  const { data: ev } = await service
    .from("audit_log")
    .select("request_payload")
    .eq("event_type", "apply_master_coa")
    .order("occurred_at", { ascending: false })
    .limit(500);
  const names = new Set<string>();
  for (const e of (ev as any[]) || []) {
    const p = e.request_payload || {};
    if (p.client_link_id !== clientLinkId) continue;
    for (const n of p.created || []) names.add(typeof n === "string" ? n : n?.name || String(n));
  }
  return [...names];
}

export async function buildRevertPlan(
  service: any,
  client: { id: string; client_name: string; qbo_realm_id: string }
): Promise<RevertPlan> {
  const createdNames = await createdNamesFor(service, client.id);
  const plan: RevertPlan = {
    client_link_id: client.id,
    client_name: client.client_name,
    created_count: createdNames.length,
    safe: [], activity: [], ambiguous: [], gone: [], targets: [],
  };
  if (createdNames.length === 0) return plan;

  const token = await getValidToken(client.id, service);
  const today = new Date().toISOString().slice(0, 10);
  const [accounts, plDetail] = await Promise.all([
    fetchAllAccountsIncludingInactive(client.qbo_realm_id, token),
    // Accrual so invoice/bill lines count as activity too, not just cash hits.
    fetchPLDetailAll(client.qbo_realm_id, token, APPLY_START, today, "Accrual"),
  ]);

  const activeByName = new Map<string, QBOAccount[]>();
  for (const a of accounts) {
    if (a.Active === false) continue;
    const list = activeByName.get(a.Name) || [];
    list.push(a);
    activeByName.set(a.Name, list);
  }
  const postedNames = new Set<string>();
  for (const r of plDetail || []) {
    postedNames.add(r.account);
    postedNames.add(String(r.account || "").split(":").pop()!.trim());
  }

  for (const name of createdNames) {
    const matches = activeByName.get(name) || [];
    if (matches.length === 0) plan.gone.push(name);
    else if (matches.length > 1) plan.ambiguous.push(name);
    else {
      const a = matches[0];
      const bal = Math.abs(a.CurrentBalanceWithSubAccounts ?? a.CurrentBalance ?? 0);
      const posted = postedNames.has(a.Name) || postedNames.has(a.FullyQualifiedName);
      if (posted || bal >= 0.01) {
        plan.activity.push({
          name, id: a.Id, type: a.AccountType,
          classification: a.Classification || "", balance: a.CurrentBalance, posted,
        });
      } else {
        plan.safe.push({
          name, id: a.Id, type: a.AccountType,
          fq: a.FullyQualifiedName, parent: a.ParentRef?.value || null,
        });
      }
    }
  }

  // Children before parents (QBO refuses to inactivate an account with active
  // subaccounts — error 6000, the Wombacher lesson).
  plan.safe.sort((x, y) => (y.fq?.split(":").length || 1) - (x.fq?.split(":").length || 1));

  // A parent in the safe list is only removable if every ACTIVE child is also
  // being removed in this same run. Otherwise leave it (and say why).
  const removing = new Set(plan.safe.map((s) => s.id));
  const keep: RevertAccount[] = [];
  for (const s of [...plan.safe]) {
    const activeChildren = accounts.filter(
      (a) => a.Active !== false && a.ParentRef?.value === s.id
    );
    const blocked = activeChildren.some((c) => !removing.has(c.Id));
    if (blocked) {
      removing.delete(s.id);
      keep.push(s);
    }
  }
  if (keep.length > 0) {
    plan.safe = plan.safe.filter((s) => removing.has(s.id));
    for (const k of keep) {
      plan.activity.push({
        name: k.name, id: k.id, type: k.type, classification: "", balance: 0, posted: false,
      });
    }
  }

  // Step-2 drain targets: every active account that was NOT created by the
  // push (the client's own chart — where the postings belong).
  const createdSet = new Set(createdNames);
  plan.targets = accounts
    .filter((a) => a.Active !== false && !createdSet.has(a.Name))
    .map((a) => ({
      id: a.Id, name: a.Name, fq: a.FullyQualifiedName,
      type: a.AccountType, classification: a.Classification || "",
    }))
    .sort((x, y) => (x.fq || x.name).localeCompare(y.fq || y.name));
  return plan;
}

/**
 * Step 2 — an activity account can't just be switched off; its postings must
 * move first. Drain the account into a bookkeeper-chosen target (line-reclass
 * the real transactions, JE-sweep what can't be line-edited, verify-zero),
 * then retire it. Reuses drainAndRetireAccount — the same guarded path as the
 * COA-audit merge.
 *
 * Only accounts the fleet push CREATED can be drained through this tool —
 * enforced here, not just in the route.
 */
export async function drainRevertAccount(
  service: any,
  client: { id: string; client_name: string; qbo_realm_id: string },
  accountId: string,
  targetAccountId: string,
  opts: { actorUserId: string | null }
): Promise<DrainRetireResult & { source_name: string; target_name: string }> {
  const createdNames = new Set(await createdNamesFor(service, client.id));
  const token = await getValidToken(client.id, service);
  const accounts = await fetchAllAccountsIncludingInactive(client.qbo_realm_id, token);

  const source = accounts.find((a) => a.Id === accountId && a.Active !== false);
  const target = accounts.find((a) => a.Id === targetAccountId && a.Active !== false);
  if (!source) throw new Error("Source account not found or already inactive");
  if (!target) throw new Error("Target account not found or inactive");
  if (source.Id === target.Id) throw new Error("Source and target are the same account");
  if (!createdNames.has(source.Name)) {
    throw new Error(`"${source.Name}" wasn't created by the fleet push — out of scope for this revert`);
  }
  if (createdNames.has(target.Name)) {
    throw new Error(`"${target.Name}" was itself created by the push — pick one of the client's own accounts`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = await drainAndRetireAccount({
    realmId: client.qbo_realm_id,
    accessToken: token,
    source,
    target,
    // Postings can only have landed after the account was created.
    startDate: APPLY_START,
    endDate: today,
    memo: `SNAP fleet-COA revert: "${source.Name}" → "${target.Name}"`,
    allAccounts: accounts,
  });

  await service.from("audit_log").insert({
    event_type: "coa_fleet_revert_drained",
    user_id: opts.actorUserId,
    request_payload: {
      client_link_id: client.id,
      client_name: client.client_name,
      source_id: source.Id, source_name: source.Name,
      target_id: target.Id, target_name: target.Name,
      lines_moved: result.linesMoved, jes_posted: result.jesPosted,
      inactivated: result.inactivated, failures: result.failures,
    } as any,
  });

  return { ...result, source_name: source.Name, target_name: target.Name };
}

export interface RevertResult {
  inactivated: { name: string; id: string }[];
  failed: { name: string; id: string; error: string }[];
  dry_run: boolean;
}

/** Execute the safe part of a plan. Children first (plan order). */
export async function executeRevertPlan(
  service: any,
  client: { id: string; client_name: string; qbo_realm_id: string },
  plan: RevertPlan,
  opts: { dryRun: boolean; actorUserId: string | null }
): Promise<RevertResult> {
  const result: RevertResult = { inactivated: [], failed: [], dry_run: opts.dryRun };
  if (opts.dryRun) {
    result.inactivated = plan.safe.map((s) => ({ name: s.name, id: s.id }));
    return result;
  }
  const token = await getValidToken(client.id, service);
  for (const s of plan.safe) {
    try {
      // Fresh fetch for SyncToken + a last-line re-check that it's still
      // empty-of-balance and active before flipping it off.
      const data = await qboRequest<{ Account: any }>(
        client.qbo_realm_id, token, `/account/${s.id}?minorversion=70`
      );
      const acct = data?.Account;
      if (!acct || acct.Active === false) {
        result.inactivated.push({ name: s.name, id: s.id }); // already gone
        continue;
      }
      const bal = Math.abs(Number(acct.CurrentBalanceWithSubAccounts ?? acct.CurrentBalance ?? 0));
      if (bal >= 0.01) {
        result.failed.push({ name: s.name, id: s.id, error: `balance appeared (${bal}) — skipped` });
        continue;
      }
      await inactivateAccount(client.qbo_realm_id, token, s.id, String(acct.SyncToken), acct);
      result.inactivated.push({ name: s.name, id: s.id });
      await service.from("audit_log").insert({
        event_type: "coa_fleet_revert_inactivated",
        user_id: opts.actorUserId,
        request_payload: {
          client_link_id: client.id, client_name: client.client_name,
          account_id: s.id, account_name: s.name, account_type: s.type,
        } as any,
      });
      await new Promise((r) => setTimeout(r, 150)); // pace QBO
    } catch (e: any) {
      result.failed.push({ name: s.name, id: s.id, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return result;
}
