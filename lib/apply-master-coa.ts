/**
 * Fleet "apply standard COA" — create every missing master account in a
 * client's QBO, additively. No renames, no merges, no deletions: those are
 * judgment calls that stay in the reviewed COA-cleanup flow. This covers the
 * deterministic half fleet-wide so every KB / reclass / master-dropdown
 * target resolves on every client (and the KB-fallback remediation has real
 * destination accounts to point at).
 */
import { fetchAllAccounts, createAccount } from "@/lib/qbo";
import { normalizeAccountName } from "@/lib/account-name";

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
  // rather than failing the create.
  const existing = new Map<string, { id: string; active: boolean; type: string }>(
    qboAccounts.map((a: any) => [
      normalizeAccountName(a.Name),
      { id: a.Id, active: a.Active !== false, type: a.AccountType || "" },
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
    errors: [],
    dry_run: dryRun,
  };
  if (dryRun || missingLeaves.length === 0) return result;

  // Parent cache: existing QBO parents (id + type) by normalized name, plus
  // ones we create. Type matters: QBO refuses to nest a child under a parent
  // of a different AccountType, and many client charts hold wrongly-typed
  // parents (e.g. "Salaries & Payroll" as Other Expense — JP's finding).
  const parentByName = new Map<string, { id: string; type: string }>();
  for (const [norm, acc] of existing) {
    if (acc.active) parentByName.set(norm, { id: acc.id, type: acc.type });
  }

  async function ensureParent(parentName: string, childType: string): Promise<{ id: string; type: string } | undefined> {
    const norm = normalizeAccountName(parentName);
    const cached = parentByName.get(norm);
    if (cached) return cached;
    const masterParent = parents.get(parentName);
    const type = masterParent?.qbo_account_type || childType;
    try {
      const created = await createWithRetry({
        name: parentName,
        accountType: type,
        accountSubType: masterParent?.qbo_account_subtype || "OtherMiscellaneousExpense",
      });
      const entry = { id: created.Id, type };
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
        // retype engine fix the parent + re-nest later.
        if (parent && parent.type === leaf.qbo_account_type) {
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
      parentByName.set(normalizeAccountName(created.Name), { id: created.Id, type: leaf.qbo_account_type });
    } catch (err: any) {
      result.errors.push({ account: leaf.account_name, message: err.message });
    }
  }

  return result;
}
