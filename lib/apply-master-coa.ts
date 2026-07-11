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
}): Promise<ApplyResult> {
  const { clientLinkId, clientName, realmId, accessToken, masterRows, dryRun } = params;

  const qboAccounts = await fetchAllAccounts(realmId, accessToken);
  // Existing names — include INACTIVE accounts too: QBO rejects creating a
  // name that collides with a deleted account, so we treat those as present
  // rather than failing the create.
  const existing = new Map<string, { id: string; active: boolean }>(
    qboAccounts.map((a: any) => [
      normalizeAccountName(a.Name),
      { id: a.Id, active: a.Active !== false },
    ])
  );

  const parents = new Map<string, MasterCoaRow>(
    masterRows.filter((m) => m.is_parent).map((m) => [m.account_name, m])
  );

  const missingLeaves = masterRows.filter(
    (m) => !m.is_parent && !existing.has(normalizeAccountName(m.account_name))
  );

  const result: ApplyResult = {
    client_link_id: clientLinkId,
    client_name: clientName,
    missing: missingLeaves.map((m) => m.account_name),
    created: [],
    errors: [],
    dry_run: dryRun,
  };
  if (dryRun || missingLeaves.length === 0) return result;

  // Parent id cache: existing QBO parents by normalized name + ones we create.
  const parentIdByName = new Map<string, string>();
  for (const [norm, acc] of existing) {
    if (acc.active) parentIdByName.set(norm, acc.id);
  }

  async function ensureParent(parentName: string, childType: string): Promise<string | undefined> {
    const norm = normalizeAccountName(parentName);
    const cached = parentIdByName.get(norm);
    if (cached) return cached;
    const masterParent = parents.get(parentName);
    try {
      const created = await createAccount(realmId, accessToken, {
        name: parentName,
        accountType: masterParent?.qbo_account_type || childType,
        accountSubType: masterParent?.qbo_account_subtype || "OtherMiscellaneousExpense",
      });
      parentIdByName.set(norm, created.Id);
      result.created.push(parentName);
      return created.Id;
    } catch (err: any) {
      result.errors.push({ account: parentName, message: err.message });
      return undefined;
    }
  }

  for (const leaf of missingLeaves) {
    try {
      let parentRefId: string | undefined;
      if (leaf.parent_account_name) {
        parentRefId = await ensureParent(leaf.parent_account_name, leaf.qbo_account_type);
      }
      const created = await createAccount(realmId, accessToken, {
        name: leaf.account_name,
        accountType: leaf.qbo_account_type,
        accountSubType: leaf.qbo_account_subtype || "OtherMiscellaneousExpense",
        parentRefId,
      });
      result.created.push(leaf.account_name);
      parentIdByName.set(normalizeAccountName(created.Name), created.Id);
    } catch (err: any) {
      result.errors.push({ account: leaf.account_name, message: err.message });
    }
  }

  return result;
}
