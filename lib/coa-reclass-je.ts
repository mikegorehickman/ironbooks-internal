/**
 * Reclassify a P&L account's balance onto another account via journal entries.
 *
 * QBO's API cannot MERGE accounts (renaming to an existing name returns a
 * duplicate-name error — the UI merge isn't exposed), and it cannot move
 * invoice/sales-receipt revenue by line (income comes from the Item's
 * IncomeAccountRef, not the line). The accountant-standard way to consolidate
 * an income/expense/COGS account into another — or to move a wrongly-typed
 * account's balance into a correctly-typed one — is a reclassifying journal
 * entry: one JE per month over the range, dated month-end, so monthly
 * (cash-basis) statements stay correct.
 *
 * Direction: drain the source in the OPPOSITE of its normal balance and add to
 * the target in the source's normal direction (income/equity are credit-normal,
 * expense/other-expense/COGS are debit-normal). A negative month (contra/refund)
 * flips both. Caller inactivates the drained source afterward.
 *
 * Idempotent: createJournalEntry hashes (realm, date, note, lines), so re-running
 * the same reclass won't double-post.
 */
import {
  createJournalEntry, createAccount, renameAccount, inactivateAccount, fetchAllAccounts,
  updateAccountType, qboRequest, type JournalEntryLine, type QBOAccount,
} from "@/lib/qbo";

// Known-good QBO AccountSubTypes per AccountType. Used to force a freshly-created
// (empty) twin into the right section when the master COA's stored subtype is
// invalid or mismatched — which makes QBO silently COERCE the AccountType (e.g.
// master has "CostOfLabor" instead of "CostOfLaborCos", or an Other-Expense
// subtype on an account typed "Expense").
const DEFAULT_SUBTYPE: Record<string, string> = {
  "cost of goods sold": "SuppliesMaterialsCogs",
  "expense": "OfficeGeneralAdministrativeExpenses",
  "other expense": "OtherMiscellaneousExpense",
  "income": "ServiceFeeIncome",
  "other income": "OtherMiscellaneousIncome",
};
import { fetchProfitAndLossByMonth } from "@/lib/qbo-pl-by-month";
import { normalizeAccountName } from "@/lib/account-name";

const MONTH_IDX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "Apr 2026" / "Jan. 2026" → "2026-04-30" (month-end). Null if not a month. */
function monthEndFromTitle(title: string): string | null {
  // QBO returns month columns as "Jan. 2026" (with a period) — strip
  // punctuation before matching so the parse doesn't silently fail.
  const cleaned = String(title || "").replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  const m = cleaned.match(/^([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const mi = MONTH_IDX[m[1].slice(0, 3).toLowerCase()];
  if (mi == null) return null;
  const year = parseInt(m[2], 10);
  const lastDay = new Date(year, mi + 1, 0).getDate(); // day 0 of next month = last day of this
  return `${year}-${String(mi + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function isCreditNormal(accountType: string): boolean {
  const t = (accountType || "").toLowerCase();
  return t === "income" || t === "other income" || t === "equity";
}

export interface JeReclassResult {
  /** Total absolute amount moved across all months. */
  moved: number;
  jesPosted: number;
  monthsWithActivity: number;
  failures: string[];
  /** True if the source account appeared in the P&L for the range at all. */
  foundInReport: boolean;
}

export async function reclassAccountViaJournalEntry(params: {
  realmId: string;
  accessToken: string;
  source: QBOAccount;
  target: QBOAccount;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  memo: string;
}): Promise<JeReclassResult> {
  const { realmId, accessToken, source, target, startDate, endDate, memo } = params;

  const pl = await fetchProfitAndLossByMonth(realmId, accessToken, startDate, endDate);
  const monthDates = pl.months.map((m) => monthEndFromTitle(m.title));

  // Locate the source account's monthly values (match on normalized full name,
  // or the leaf when the report flattened it to "Parent:Child").
  const wantFull = normalizeAccountName(source.Name);
  const wantLeaf = wantFull.split(":").pop() || wantFull;
  let row: { values: number[] } | null = null;
  for (const b of pl.blocks) {
    if (b.kind !== "section") continue;
    for (const a of b.accounts) {
      const norm = normalizeAccountName(a.name);
      if (norm === wantFull || (norm.split(":").pop() || norm) === wantLeaf) { row = a; break; }
    }
    if (row) break;
  }

  const result: JeReclassResult = {
    moved: 0, jesPosted: 0, monthsWithActivity: 0, failures: [], foundInReport: !!row,
  };
  if (!row) return result; // no P&L activity in the range — nothing to move

  const creditNormal = isCreditNormal(source.AccountType);
  for (let i = 0; i < row.values.length; i++) {
    const v = row.values[i];
    if (Math.abs(v) < 0.01) continue;
    const date = monthDates[i];
    if (!date) { result.failures.push(`${pl.months[i]?.title || `col ${i}`}: could not derive a posting date`); continue; }
    result.monthsWithActivity++;

    const amount = Math.abs(v);
    let sourcePosting: "Debit" | "Credit" = creditNormal ? "Debit" : "Credit";
    let targetPosting: "Debit" | "Credit" = creditNormal ? "Credit" : "Debit";
    if (v < 0) {
      sourcePosting = sourcePosting === "Debit" ? "Credit" : "Debit";
      targetPosting = targetPosting === "Debit" ? "Credit" : "Debit";
    }
    const lines: JournalEntryLine[] = [
      { posting_type: sourcePosting, amount, account_id: source.Id, account_name: source.Name, description: memo },
      { posting_type: targetPosting, amount, account_id: target.Id, account_name: target.Name, description: memo },
    ];
    try {
      await createJournalEntry(realmId, accessToken, {
        txn_date: date,
        private_note: `${memo} [${pl.months[i]?.title || date}]`,
        lines,
      });
      result.jesPosted++;
      result.moved += amount;
    } catch (e: any) {
      result.failures.push(`${pl.months[i]?.title || date}: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  return result;
}

export interface DetachResult {
  detached: number;
  failures: string[];
}

/**
 * Detach a parent account's sub-accounts to the top level (SubAccount:false) so
 * the now-childless parent can be drained + inactivated — QBO refuses to
 * inactivate an account that still has sub-accounts. The children keep their own
 * names/types/balances and become their own top-level accounts (mergeable/
 * retypeable on their own). Mirrors updateAccountType's detach (SubAccount:false,
 * no ParentRef).
 */
export async function detachSubAccounts(params: {
  realmId: string;
  accessToken: string;
  parentId: string;
  accounts: QBOAccount[];
}): Promise<DetachResult> {
  const { realmId, accessToken, parentId, accounts } = params;
  const res: DetachResult = { detached: 0, failures: [] };
  const children = accounts.filter(
    (a) => String((a as any).ParentRef?.value || "") === parentId && a.Active !== false
  );
  for (const c of children as any[]) {
    const body: any = {
      Id: c.Id,
      SyncToken: c.SyncToken,
      sparse: true,
      Name: c.Name,
      AccountType: c.AccountType,
      ...(c.AccountSubType && { AccountSubType: c.AccountSubType }),
      SubAccount: false, // detach: no ParentRef sent
    };
    try {
      await qboRequest(realmId, accessToken, `/account?minorversion=70`, { method: "POST", body: JSON.stringify(body) });
      res.detached++;
    } catch (e: any) {
      res.failures.push(`detach "${c.Name}": ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  return res;
}

export interface ItemRepointResult {
  repointed: number;
  failures: string[];
}

/**
 * Re-point every QBO Item (product/service) that uses `fromAccountId` as its
 * income or expense account onto `toAccountId`. Required before an account can
 * be inactivated — QBO blocks it ("used by a product or service") — and so
 * future invoices/bills using those items post to the target, not the retired
 * source. Sparse Item update (Id + SyncToken + Name + Type + the changed ref).
 */
export async function repointItemsToAccount(params: {
  realmId: string;
  accessToken: string;
  fromAccountId: string;
  toAccountId: string;
  toAccountName?: string;
}): Promise<ItemRepointResult> {
  const { realmId, accessToken, fromAccountId, toAccountId, toAccountName } = params;
  const result: ItemRepointResult = { repointed: 0, failures: [] };

  // Find items referencing the source account on either side.
  const items: any[] = [];
  const pageSize = 500;
  for (let page = 0; page < 40; page++) {
    const q = encodeURIComponent(
      `SELECT Id, Name, Type, IncomeAccountRef, ExpenseAccountRef, SyncToken, Active FROM Item STARTPOSITION ${page * pageSize + 1} MAXRESULTS ${pageSize}`
    );
    const data: any = await qboRequest(realmId, accessToken, `/query?query=${q}`);
    const batch: any[] = data?.QueryResponse?.Item || [];
    for (const it of batch) {
      if (
        String(it.IncomeAccountRef?.value || "") === fromAccountId ||
        String(it.ExpenseAccountRef?.value || "") === fromAccountId
      ) {
        items.push(it);
      }
    }
    if (batch.length < pageSize) break;
  }

  for (const it of items) {
    const body: any = { Id: it.Id, SyncToken: it.SyncToken, sparse: true, Name: it.Name, Type: it.Type };
    if (String(it.IncomeAccountRef?.value || "") === fromAccountId) {
      body.IncomeAccountRef = { value: toAccountId, ...(toAccountName && { name: toAccountName }) };
    }
    if (String(it.ExpenseAccountRef?.value || "") === fromAccountId) {
      body.ExpenseAccountRef = { value: toAccountId, ...(toAccountName && { name: toAccountName }) };
    }
    try {
      await qboRequest(realmId, accessToken, `/item?minorversion=70`, { method: "POST", body: JSON.stringify(body) });
      result.repointed++;
    } catch (e: any) {
      result.failures.push(`item "${it.Name}": ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  return result;
}

/**
 * Reactivate an inactive account so its balance can be drained. QBO appends
 * "(deleted)" to inactive names — strip it on the way back (falling back to
 * the suffixed name if the clean one collides with an active account).
 */
export async function reactivateAccount(params: {
  realmId: string;
  accessToken: string;
  account: QBOAccount;
}): Promise<QBOAccount> {
  const { realmId, accessToken, account } = params;
  const base: any = {
    Id: account.Id,
    SyncToken: (account as any).SyncToken,
    sparse: true,
    Active: true,
    AccountType: account.AccountType,
    ...(account.AccountSubType && { AccountSubType: account.AccountSubType }),
  };
  const cleanName = account.Name.replace(/\s*\(deleted\)\s*$/i, "").trim() || account.Name;
  try {
    const data = await qboRequest<{ Account: QBOAccount }>(realmId, accessToken, `/account?minorversion=70`, {
      method: "POST", body: JSON.stringify({ ...base, Name: cleanName }),
    });
    return data.Account;
  } catch {
    // Clean name taken by an active account — reactivate under the suffixed
    // name; the drain + retire doesn't care what it's called.
    const data = await qboRequest<{ Account: QBOAccount }>(realmId, accessToken, `/account?minorversion=70`, {
      method: "POST", body: JSON.stringify({ ...base, Name: account.Name }),
    });
    return data.Account;
  }
}

/**
 * Move an account under a new parent (or to top level with parentId null).
 * Sparse update; echoes Name/type so QBO doesn't 2010. Caller guarantees the
 * parent's AccountType matches (QBO 6000s otherwise).
 */
export async function setAccountParent(params: {
  realmId: string;
  accessToken: string;
  account: QBOAccount;
  parentId: string | null;
}): Promise<void> {
  const { realmId, accessToken, account, parentId } = params;
  const body: any = {
    Id: account.Id,
    SyncToken: (account as any).SyncToken,
    sparse: true,
    Name: account.Name,
    AccountType: account.AccountType,
    ...(account.AccountSubType && { AccountSubType: account.AccountSubType }),
  };
  if (parentId) {
    body.SubAccount = true;
    body.ParentRef = { value: parentId };
  } else {
    body.SubAccount = false;
  }
  await qboRequest(realmId, accessToken, `/account?minorversion=70`, { method: "POST", body: JSON.stringify(body) });
}

/**
 * Find an active account by (normalized) name, creating it if absent — with
 * the same verify-and-force-type guard as the retype rebuild, since QBO
 * coerces a new account's type to match a bad subtype. Used to materialize
 * missing master PARENT headings before nesting children under them.
 */
export async function ensureAccountExists(params: {
  realmId: string;
  accessToken: string;
  name: string;
  accountType: string;
  accountSubType?: string | null;
  allAccounts: QBOAccount[];
}): Promise<QBOAccount> {
  const { realmId, accessToken, name, accountType, allAccounts } = params;
  const existing = allAccounts.find(
    (a) => a.Active !== false && normalizeAccountName(a.Name) === normalizeAccountName(name)
  );
  if (existing) return existing;
  const subType = params.accountSubType || DEFAULT_SUBTYPE[accountType.toLowerCase()] || "";
  let created: QBOAccount;
  try {
    created = await createAccount(realmId, accessToken, { name, accountType, accountSubType: subType });
  } catch {
    created = await createAccount(realmId, accessToken, {
      name, accountType,
      accountSubType: DEFAULT_SUBTYPE[accountType.toLowerCase()] || subType,
    });
  }
  if ((created.AccountType || "").toLowerCase() !== accountType.toLowerCase()) {
    created = await updateAccountType(realmId, accessToken, created.Id, (created as any).SyncToken, {
      newType: accountType,
      newSubType: DEFAULT_SUBTYPE[accountType.toLowerCase()] || subType,
      currentAccount: created,
    });
  }
  return created;
}

export interface DrainRetireResult {
  moved: number;
  jesPosted: number;
  monthsWithActivity: number;
  foundInReport: boolean;
  itemsRepointed: number;
  childrenDetached: number;
  inactivated: boolean;
  failures: string[];
}

/**
 * The full "consolidate account A into account B" sequence, shared by merges
 * and retypes:
 *   1. detach A's sub-accounts to top level (so A can be retired),
 *   2. move A's balance to B via per-month reclassifying JEs,
 *   3. re-point Items that post to A onto B,
 *   4. inactivate A — but only if every prior step was clean.
 */
export async function drainAndRetireAccount(params: {
  realmId: string;
  accessToken: string;
  source: QBOAccount;
  target: QBOAccount;
  startDate: string;
  endDate: string;
  memo: string;
  allAccounts: QBOAccount[];
}): Promise<DrainRetireResult> {
  const { realmId, accessToken, source, target, startDate, endDate, memo, allAccounts } = params;
  const out: DrainRetireResult = {
    moved: 0, jesPosted: 0, monthsWithActivity: 0, foundInReport: false,
    itemsRepointed: 0, childrenDetached: 0, inactivated: false, failures: [],
  };

  const hasChildren = allAccounts.some(
    (a) => String((a as any).ParentRef?.value || "") === source.Id && a.Active !== false
  );
  if (hasChildren) {
    const d = await detachSubAccounts({ realmId, accessToken, parentId: source.Id, accounts: allAccounts });
    out.childrenDetached = d.detached;
    out.failures.push(...d.failures.map((f) => `re-parent ${f}`));
  }

  const je = await reclassAccountViaJournalEntry({ realmId, accessToken, source, target, startDate, endDate, memo });
  out.moved = je.moved; out.jesPosted = je.jesPosted; out.monthsWithActivity = je.monthsWithActivity;
  out.foundInReport = je.foundInReport; out.failures.push(...je.failures);

  const rp = await repointItemsToAccount({ realmId, accessToken, fromAccountId: source.Id, toAccountId: target.Id, toAccountName: target.Name });
  out.itemsRepointed = rp.repointed;
  out.failures.push(...rp.failures.map((f) => `re-point ${f}`));

  if (out.failures.length === 0) {
    try {
      const fresh = (await fetchAllAccounts(realmId, accessToken)).find((a) => a.Id === source.Id) as any;
      if (fresh && fresh.Active !== false) {
        await inactivateAccount(realmId, accessToken, source.Id, fresh.SyncToken, fresh);
      }
      out.inactivated = true;
    } catch (e: any) {
      out.failures.push(`inactivate source: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  return out;
}

export interface RetypeResult {
  account: string;
  newAccountId: string | null;
  createdType: string | null;
  drain: DrainRetireResult | null;
  failures: string[];
}

/**
 * Re-type an account whose QBO type is wrong (e.g. an Expense that should be
 * Cost of Goods Sold). QBO can't change a used account's type, so we rebuild:
 *   1. rename the wrong-typed account aside ("X (pre-retype)"),
 *   2. create a correctly-typed twin with the real name "X",
 *   3. drain the old one into the twin (JE + item re-point + child detach) and
 *      retire it.
 * Idempotent-ish: if a correctly-typed "X" already exists (a prior partial run),
 * it's reused as the target instead of creating a duplicate.
 */
export async function retypeAccountViaRebuild(params: {
  realmId: string;
  accessToken: string;
  account: QBOAccount;
  newType: string;
  newSubType: string;
  startDate: string;
  endDate: string;
  allAccounts?: QBOAccount[]; // ignored — refetched fresh below
}): Promise<RetypeResult> {
  const { realmId, accessToken, account: staleAccount, newType, newSubType, startDate, endDate } = params;
  // Re-fetch live accounts so we operate on FRESH state: a prior retype in the
  // same batch may have detached this account from a retyped parent (changing
  // its SyncToken + parent), which would 400 a rename done with stale state.
  const allAccounts = await fetchAllAccounts(realmId, accessToken);
  const account = (allAccounts.find((a) => a.Id === staleAccount.Id) as QBOAccount) || staleAccount;
  const out: RetypeResult = { account: account.Name, newAccountId: null, createdType: null, drain: null, failures: [] };

  const norm = (s: string) => (s || "").trim().toLowerCase();
  const realName = account.Name.replace(/\s*\(pre-retype[^)]*\)\s*$/i, "");

  // Reuse an already-correct twin if a prior run created it.
  let target = allAccounts.find(
    (a) => a.Id !== account.Id && a.Active !== false &&
      norm(a.Name) === norm(realName) &&
      (a.AccountType || "").toLowerCase() === newType.toLowerCase()
  ) as QBOAccount | undefined;

  let source: QBOAccount = account;
  if (!target) {
    // Free the real name: rename the wrong-typed account aside (unless already).
    // Suffix with the account Id so a re-run (after a prior partial attempt that
    // already left a "(pre-retype)" account) can't collide on the name.
    if (!/\(pre-retype[^)]*\)\s*$/i.test(account.Name)) {
      const suffix = ` (pre-retype ${account.Id})`;
      const base = (realName + suffix).length > 100 ? realName.slice(0, 100 - suffix.length - 1) + "…" : realName;
      try {
        source = await renameAccount(realmId, accessToken, account.Id, (account as any).SyncToken, `${base}${suffix}`, { currentAccount: account });
      } catch (e: any) {
        out.failures.push(`rename aside: ${String(e?.message || e).slice(0, 200)}`);
        return out;
      }
    }
    // Create the correctly-typed twin with the real name (top-level). QBO can
    // COERCE the AccountType to match a bad/mismatched AccountSubType, so this
    // may come back in the wrong section — corrected below.
    try {
      target = await createAccount(realmId, accessToken, { name: realName, accountType: newType, accountSubType: newSubType });
    } catch {
      // A bad subtype can also make creation throw — retry with a safe default.
      const def = DEFAULT_SUBTYPE[newType.toLowerCase()] || newSubType;
      try {
        target = await createAccount(realmId, accessToken, { name: realName, accountType: newType, accountSubType: def });
      } catch (e2: any) {
        out.failures.push(`create ${newType} "${realName}": ${String(e2?.message || e2).slice(0, 200)}`);
        return out;
      }
    }
    out.createdType = target.AccountType;
    // If QBO coerced the type (bad subtype), force it — the twin is brand-new
    // and empty, so a type change is allowed.
    if ((target.AccountType || "").toLowerCase() !== newType.toLowerCase()) {
      const def = DEFAULT_SUBTYPE[newType.toLowerCase()] || newSubType;
      try {
        target = await updateAccountType(realmId, accessToken, target.Id, (target as any).SyncToken, {
          newType, newSubType: def, currentAccount: target,
        });
        out.createdType = target.AccountType;
      } catch (e: any) {
        out.failures.push(`force type ${newType}: ${String(e?.message || e).slice(0, 200)}`);
        return out;
      }
      if ((target.AccountType || "").toLowerCase() !== newType.toLowerCase()) {
        out.failures.push(`twin created as ${target.AccountType}, not ${newType} (subtype "${newSubType}") even after correction`);
        return out;
      }
    }
  }
  out.newAccountId = target.Id;
  if (!out.createdType) out.createdType = target.AccountType;

  const drain = await drainAndRetireAccount({
    realmId, accessToken, source, target, startDate, endDate,
    memo: `SNAP COA retype: "${realName}" → ${newType}`,
    allAccounts,
  });
  out.drain = drain;
  out.failures.push(...drain.failures);
  return out;
}
