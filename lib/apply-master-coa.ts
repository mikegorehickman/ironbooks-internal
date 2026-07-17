/**
 * Fleet "apply standard COA" — create every missing master account in a
 * client's QBO, additively. No renames, no merges, no deletions: those are
 * judgment calls that stay in the reviewed COA-cleanup flow. This covers the
 * deterministic half fleet-wide so every KB / reclass / master-dropdown
 * target resolves on every client (and the KB-fallback remediation has real
 * destination accounts to point at).
 */
import { fetchAllAccounts, createAccount, updateAccountType, type QBOAccount } from "@/lib/qbo";
import { normalizeAccountName } from "@/lib/account-name";

/**
 * Pure nesting decision for a leaf's master parent (fixture-tested):
 *  - 'nest'    — existing parent is postable as-is (right type, top-level)
 *  - 'detach'  — existing parent matches by name but is ITSELF a sub-account
 *                while the master defines it top-level → un-nest it first
 *                (the Maple City bug: client had Marketing under "Advertising
 *                and Promotion", so new leaves became sub-of-sub)
 *  - 'no-nest' — wrong type (or detach impossible): create the leaf top-level
 *                and let the retype/re-parent engine sort it later
 */
export function parentNestAction(p: {
  exists: boolean;
  typeMatches: boolean;
  isSubAccount: boolean;
  masterTopLevel: boolean;
}): "nest" | "detach" | "no-nest" {
  if (!p.exists) return "no-nest";
  if (!p.typeMatches) return "no-nest";
  if (p.isSubAccount && p.masterTopLevel) return "detach";
  if (p.isSubAccount) return "no-nest";
  return "nest";
}

export interface MasterCoaRow {
  account_name: string;
  parent_account_name: string | null;
  is_parent: boolean;
  qbo_account_type: string;
  qbo_account_subtype: string | null;
}

export interface ApplyResult {
  client_link_id: string;
  client_name: string;
  missing: string[];            // master leaves absent from the client's QBO
  created: string[];            // accounts actually created this run
  /** Existing parent accounts un-nested to match the master's top-level
   *  placement (e.g. client's "Marketing" pulled out from under
   *  "Advertising and Promotion" before nesting leaves beneath it). */
  detached: string[];
  errors: { account: string; message: string }[];
  dry_run: boolean;
}

export async function applyMasterCoaToClient(params: {
  clientLinkId: string;
  clientName: string;
  realmId: string;
  accessToken: string;
  masterRows: MasterCoaRow[];
  dryRun: boolean;
  /**
   * Restrict account creation to these leaf names (normalized match) instead
   * of every missing master leaf. Used by the bank-rules QBO export, which
   * only needs the handful of accounts its own rules target created — not a
   * full fleet-style COA application as a side effect of a file download.
   */
  onlyLeafNames?: string[];
}): Promise<ApplyResult> {
  const { clientLinkId, clientName, realmId, accessToken, masterRows, dryRun, onlyLeafNames } = params;

  const qboAccounts = await fetchAllAccounts(realmId, accessToken);
  // Existing names — include INACTIVE accounts too: QBO rejects creating a
  // name that collides with a deleted account, so we treat those as present
  // rather than failing the create. `sub`/`raw` carry the account's own
  // nesting so we never blindly nest a leaf under a parent that is itself a
  // sub-account (the sub-of-sub bug).
  const existing = new Map<string, { id: string; active: boolean; type: string; sub: boolean; raw: QBOAccount }>(
    qboAccounts.map((a: any) => [
      normalizeAccountName(a.Name),
      { id: a.Id, active: a.Active !== false, type: a.AccountType || "", sub: a.SubAccount === true, raw: a },
    ])
  );

  const parents = new Map<string, MasterCoaRow>(
    masterRows.filter((m) => m.is_parent).map((m) => [m.account_name, m])
  );

  const onlyNamesNorm = onlyLeafNames
    ? new Set(onlyLeafNames.map((n) => normalizeAccountName(n)))
    : null;
  const missingLeaves = masterRows.filter(
    (m) =>
      !m.is_parent &&
      !existing.has(normalizeAccountName(m.account_name)) &&
      (!onlyNamesNorm || onlyNamesNorm.has(normalizeAccountName(m.account_name)))
  );

  // Fallback DetailType per AccountType — used when the master subtype is
  // rejected by QBO ("Invalid Enumeration"). P&L placement is driven by
  // AccountType; DetailType is descriptive, so a generic one beats failing.
  const GENERIC_SUBTYPE: Record<string, string> = {
    "Expense": "OtherMiscellaneousExpense",
    "Other Expense": "OtherMiscellaneousExpense",
    "Cost of Goods Sold": "OtherCostsOfServiceCos",
    "Income": "ServiceFeeIncome",
    "Other Income": "OtherMiscellaneousIncome",
    "Equity": "OwnersEquity",
  };
  async function createWithRetry(opts: { name: string; accountType: string; accountSubType: string; parentRefId?: string }) {
    try {
      return await createAccount(realmId, accessToken, opts);
    } catch (err: any) {
      const generic = GENERIC_SUBTYPE[opts.accountType];
      if (generic && generic !== opts.accountSubType && /Invalid Enumeration/i.test(err.message || "")) {
        return await createAccount(realmId, accessToken, { ...opts, accountSubType: generic });
      }
      throw err;
    }
  }

  const result: ApplyResult = {
    client_link_id: clientLinkId,
    client_name: clientName,
    missing: missingLeaves.map((m) => m.account_name),
    created: [],
    detached: [],
    errors: [],
    dry_run: dryRun,
  };
  if (dryRun || missingLeaves.length === 0) return result;

  // Parent cache: existing QBO parents (id + type + own nesting) by
  // normalized name, plus ones we create. Type matters: QBO refuses to nest a
  // child under a parent of a different AccountType. Nesting matters too: a
  // name-matched "parent" that is ITSELF a sub-account would make the new
  // leaf a sub-of-sub (Advertising and Promotion → Marketing → leaf), so it
  // must be detached to the master's top level first — or not used at all.
  const parentByName = new Map<string, { id: string; type: string; sub: boolean; raw?: QBOAccount }>();
  for (const [norm, acc] of existing) {
    if (acc.active) parentByName.set(norm, { id: acc.id, type: acc.type, sub: acc.sub, raw: acc.raw });
  }

  async function ensureParent(
    parentName: string,
    childType: string
  ): Promise<{ id: string; type: string; sub: boolean } | undefined> {
    const norm = normalizeAccountName(parentName);
    const masterParent = parents.get(parentName);
    // 2-level master: a referenced parent is top-level unless the master row
    // itself declares a parent (none do today).
    const masterTopLevel = !masterParent?.parent_account_name;
    const cached = parentByName.get(norm);

    if (cached) {
      const action = parentNestAction({
        exists: true,
        typeMatches: cached.type === (masterParent?.qbo_account_type || childType),
        isSubAccount: cached.sub,
        masterTopLevel,
      });
      if (action === "detach" && cached.raw) {
        try {
          const raw: any = cached.raw;
          await updateAccountType(realmId, accessToken, cached.id, String(raw.SyncToken ?? "0"), {
            newType: raw.AccountType,
            newSubType: raw.AccountSubType || "OtherMiscellaneousExpense",
            currentAccount: cached.raw,
            detachFromParent: true,
          });
          cached.sub = false;
          result.detached.push(parentName);
        } catch (err: any) {
          // Couldn't un-nest — report it and leave the leaf top-level rather
          // than create a sub-of-sub.
          result.errors.push({ account: parentName, message: `detach failed: ${err.message}` });
        }
      }
      return cached;
    }

    const type = masterParent?.qbo_account_type || childType;
    try {
      const created = await createWithRetry({
        name: parentName,
        accountType: type,
        accountSubType: masterParent?.qbo_account_subtype || "OtherMiscellaneousExpense",
      });
      const entry = { id: created.Id, type, sub: false };
      parentByName.set(norm, entry);
      result.created.push(parentName);
      return entry;
    } catch (err: any) {
      result.errors.push({ account: parentName, message: err.message });
      return undefined;
    }
  }

  for (const leaf of missingLeaves) {
    try {
      let parentRefId: string | undefined;
      if (leaf.parent_account_name) {
        const parent = await ensureParent(leaf.parent_account_name, leaf.qbo_account_type);
        // QBO: "For subaccounts, you must select the same account type as
        // their parent." Client charts commonly hold wrongly-typed parents
        // (e.g. "Salaries & Payroll" as Other Expense). Correct TYPE beats
        // correct NESTING — type drives P&L placement, nesting is a rollup —
        // so create the account top-level with the master's type and let the
        // retype engine fix the parent + re-nest later. Same rule when the
        // parent is still a sub-account (detach failed): never sub-of-sub.
        if (parent && parent.type === leaf.qbo_account_type && !parent.sub) {
          parentRefId = parent.id;
        }
      }
      const created = await createWithRetry({
        name: leaf.account_name,
        accountType: leaf.qbo_account_type,
        accountSubType: leaf.qbo_account_subtype || "OtherMiscellaneousExpense",
        parentRefId,
      });
      result.created.push(leaf.account_name);
      parentByName.set(normalizeAccountName(created.Name), { id: created.Id, type: leaf.qbo_account_type, sub: !!parentRefId });
    } catch (err: any) {
      result.errors.push({ account: leaf.account_name, message: err.message });
    }
  }

  return result;
}
