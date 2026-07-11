/**
 * Retype detection — pure logic, unit-tested.
 *
 * A client account "needs a retype" when its name matches a master account
 * (directly, dash/whitespace-insensitive — or via the rename target the
 * analyzer just proposed for it) but its QBO AccountType/AccountSubType
 * differs from the master's. Wrong types are why payroll shows below the
 * line (JP's "Salaries & Payroll" as Other Expense) and why correctly-typed
 * children can't nest under wrongly-typed parents.
 */
import { normalizeAccountName } from "@/lib/account-name";

export interface RetypeMasterRow {
  account_name: string;
  qbo_account_type: string;
  qbo_account_subtype: string | null;
}

export interface RetypeClientAccount {
  Id: string;
  Name: string;
  AccountType?: string;
  AccountSubType?: string;
}

export interface RetypePlan {
  qbo_account_id: string;
  current_name: string;
  current_type: string;
  current_subtype: string;
  new_type: string;
  new_subtype: string;
  reason: string;
}

export function computeRetypePlans(params: {
  masterRows: RetypeMasterRow[];
  clientAccounts: RetypeClientAccount[];
  /** qbo_account_id → proposed rename target (master name), from the analyzer. */
  renameTargets?: Map<string, string>;
}): RetypePlan[] {
  const { masterRows, clientAccounts, renameTargets } = params;
  const masterByName = new Map<string, RetypeMasterRow>(
    masterRows
      .filter((m) => !!m.account_name && !!m.qbo_account_type)
      .map((m) => [normalizeAccountName(m.account_name), m])
  );

  const plans: RetypePlan[] = [];
  for (const acct of clientAccounts) {
    const intendedName =
      renameTargets?.get(acct.Id) || acct.Name;
    const master = masterByName.get(normalizeAccountName(intendedName));
    if (!master) continue;

    const typeWrong = (acct.AccountType || "") !== master.qbo_account_type;
    const subtypeWrong =
      !!master.qbo_account_subtype &&
      (acct.AccountSubType || "") !== master.qbo_account_subtype;
    if (!typeWrong && !subtypeWrong) continue;

    plans.push({
      qbo_account_id: acct.Id,
      current_name: acct.Name,
      current_type: acct.AccountType || "",
      current_subtype: acct.AccountSubType || "",
      new_type: master.qbo_account_type,
      new_subtype: master.qbo_account_subtype || acct.AccountSubType || "",
      reason: typeWrong
        ? `"${acct.Name}" is typed ${acct.AccountType || "(none)"} but the standard chart says ${master.qbo_account_type}${master.qbo_account_subtype ? `/${master.qbo_account_subtype}` : ""} — wrong type puts it in the wrong statement section.`
        : `"${acct.Name}" has detail type ${acct.AccountSubType || "(none)"} but the standard chart says ${master.qbo_account_subtype}.`,
    });
  }
  return plans;
}
