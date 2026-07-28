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
import { fetchProfitAndLoss, fetchPLDetailAll, type PLDetailRow } from "@/lib/qbo-reports";
import {
  fetchTransactionsForAccount, reclassifyTransactionLines,
  SUPPORTED_TX_TYPES, type SupportedTxType,
} from "@/lib/qbo-reclass";
import { normalizeAccountName } from "@/lib/account-name";

// Above this many movable lines, skip line-by-line reclass and let the balance
// JE carry the whole account — moving hundreds of transactions inline would
// blow the function timeout. (Detail is preserved for the common case; only
// very large accounts fall back to a lump JE.)
const MAX_RECLASS_LINES = 500;

/**
 * Strip a leading QBO account-number prefix from each ":"-segment. QBO's P&L
 * REPORTS prefix the AcctNum ("5210 Paint & Materials", "6260 Insurance:6261
 * General Liability Insurance") whenever a file has account numbering on — but
 * Account.Name carries NO number. So matching a report row to an account by
 * name silently fails for every numbered chart (Despres, 2026-07-18: the drain
 * "moved $0" and the account was retired with $26k still on it). Strip it.
 */
export function stripAcctNumPrefix(name: string): string {
  return String(name || "")
    .split(":")
    .map((seg) => seg.replace(/^\s*\d{3,}\s+/, "").trim())
    .join(":");
}

/** Normalized, account-number-tolerant key for matching a report label to an
 *  account name. */
function matchKey(name: string): string {
  return normalizeAccountName(stripAcctNumPrefix(name));
}

/** All name forms an account might match a report row under (full + leaf,
 *  numbered + stripped). */
function matchCandidates(name: string): Set<string> {
  const out = new Set<string>();
  for (const v of [normalizeAccountName(name), matchKey(name)]) {
    if (v) { out.add(v); out.add(v.split(":").pop() || v); }
  }
  return out;
}

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
  // Account-number-tolerant match — the report prefixes AcctNum, the account
  // Name doesn't (see stripAcctNumPrefix).
  const cand = matchCandidates(source.Name);
  let row: { values: number[] } | null = null;
  for (const b of pl.blocks) {
    if (b.kind !== "section") continue;
    for (const a of b.accounts) {
      const forms = matchCandidates(a.name);
      if ([...forms].some((f) => cand.has(f))) { row = a; break; }
    }
    if (row) break;
  }

  const result: JeReclassResult = {
    moved: 0, jesPosted: 0, monthsWithActivity: 0, failures: [], foundInReport: !!row,
  };
  if (!row) return result; // no P&L activity in the range — nothing to move

  // Transaction-level detail for the range — lets each month's JE carry ONE
  // LINE PER SOURCE TRANSACTION on the target side (date · type · payee), so
  // the target's drill-down shows real detail instead of one lump "SNAP COA
  // merge" (Lisa, 2026-07-21 — Amundson). Payroll-sourced activity can't be
  // line-reclassed via the API at all, so this JE is the only automated move;
  // itemized lines preserve the visible audit trail. Best-effort: any doubt
  // (fetch failure, sum mismatch, too many rows) falls back to the lump.
  const detailByMonth = new Map<string, PLDetailRow[]>();
  try {
    const detail = await fetchPLDetailAll(realmId, accessToken, startDate, endDate, "Cash");
    for (const r of detail) {
      const forms = matchCandidates(r.account);
      if (![...forms].some((f) => cand.has(f))) continue;
      const key = String(r.date || "").slice(0, 7); // YYYY-MM
      if (!key || key.length !== 7) continue;
      const arr = detailByMonth.get(key) || [];
      arr.push(r);
      detailByMonth.set(key, arr);
    }
  } catch { /* detail is an enhancement — the lump JE still moves the money */ }

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

    // Itemize the target side when the month's detail rows reconcile exactly
    // to the month total: one JE line per source transaction, so the target
    // drill-down reads like the original register. Strict gate — anything off
    // by a cent (or >90 rows, or sub-cent rows that QBO would reject) lumps.
    const monthRows = detailByMonth.get(date.slice(0, 7)) || [];
    const rowsSum = monthRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const canItemize =
      monthRows.length > 0 &&
      monthRows.length <= 90 &&
      Math.abs(rowsSum - v) < 0.02 &&
      monthRows.every((r) => Math.abs(Number(r.amount) || 0) >= 0.01);
    const lines: JournalEntryLine[] = canItemize
      ? [
          { posting_type: sourcePosting, amount, account_id: source.Id, account_name: source.Name, description: memo },
          ...monthRows.map((r) => {
            const rv = Number(r.amount) || 0;
            // A row whose sign differs from the month's net flips its posting.
            const posting = (rv >= 0) === (v >= 0)
              ? targetPosting
              : targetPosting === "Debit" ? ("Credit" as const) : ("Debit" as const);
            const desc = [r.date, r.txn_type, r.name || r.memo || null, r.doc_number ? `#${r.doc_number}` : null]
              .filter(Boolean).join(" · ");
            return {
              posting_type: posting,
              amount: Math.abs(rv),
              account_id: target.Id,
              account_name: target.Name,
              description: (desc || memo).slice(0, 3900),
            };
          }),
        ]
      : [
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
  linesMoved: number;
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
  /** Allow the balance-JE sweep for residue line-reclass can't move.
   *  DEFAULT FALSE — a merge should reclassify real transactions, not lump
   *  them into a JE (see the sweep block below). Opt in only deliberately. */
  allowJeSweep?: boolean;
}): Promise<DrainRetireResult> {
  const { realmId, accessToken, source, target, startDate, endDate, memo, allAccounts } = params;
  const allowJeSweep = params.allowJeSweep === true;
  const out: DrainRetireResult = {
    moved: 0, jesPosted: 0, linesMoved: 0, monthsWithActivity: 0, foundInReport: false,
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

  // Move the ACTUAL transactions first (line-reclass) so the target account's
  // drill-down shows the real transactions — not one lump "COA merge" JE
  // (Despres, 2026-07-18). Only the four account-based expense types move this
  // way; income/deposit/JE-posted activity is swept by the balance JE after.
  try {
    const { lines } = await fetchTransactionsForAccount(realmId, accessToken, source.Id, startDate, endDate);
    const movable = lines.filter((l) => SUPPORTED_TX_TYPES.includes(l.transaction_type as SupportedTxType));
    if (movable.length > 0 && movable.length <= MAX_RECLASS_LINES) {
      const byTx = new Map<string, typeof movable>();
      for (const l of movable) {
        if (!byTx.has(l.transaction_id)) byTx.set(l.transaction_id, []);
        byTx.get(l.transaction_id)!.push(l);
      }
      for (const [txId, txLines] of byTx) {
        try {
          const res = await reclassifyTransactionLines(realmId, accessToken, {
            txType: txLines[0].transaction_type as SupportedTxType,
            txId,
            lineUpdates: txLines.map((l) => ({ line_id: l.line_id, new_account_id: target.Id, new_account_name: target.Name })),
            auditMemo: memo,
          });
          out.linesMoved += res.lines_applied;
          for (const na of res.lines_not_applied) out.failures.push(`line ${txId}: ${na.reason}`);
        } catch (e: any) {
          out.failures.push(`reclass ${txLines[0].transaction_type}/${txId}: ${String(e?.message || e).slice(0, 150)}`);
        }
      }
    }
  } catch (e: any) {
    out.failures.push(`fetch source transactions: ${String(e?.message || e).slice(0, 150)}`);
  }

  // Sweep whatever line-reclass couldn't move (income/deposit/JE/invoice items,
  // or an over-cap account) with per-month reclassifying JEs. Runs against the
  // POST-line-reclass P&L, so it only moves the residual — no double count.
  //
  // OFF BY DEFAULT since 2026-07-26 (Mike): a merge must RECLASSIFY the real
  // transactions, not lump them into a JE. The sweep is what collapsed GL
  // detail on nine accounts fleet-wide — a JE moves the balance but destroys
  // the transaction-level detail in the target's drill-down, and it can't be
  // undone without reversing entries. With the sweep off, an account whose
  // residue is income / deposits / paycheques simply doesn't finish: it stays
  // ACTIVE and is reported for a native merge in the QBO UI (which moves
  // everything with detail intact — the API has no equivalent). Callers that
  // genuinely want the old behavior must opt in explicitly.
  if (allowJeSweep) {
    const je = await reclassAccountViaJournalEntry({ realmId, accessToken, source, target, startDate, endDate, memo });
    out.moved = je.moved; out.jesPosted = je.jesPosted; out.monthsWithActivity = je.monthsWithActivity;
    out.foundInReport = je.foundInReport; out.failures.push(...je.failures);
  }

  const rp = await repointItemsToAccount({ realmId, accessToken, fromAccountId: source.Id, toAccountId: target.Id, toAccountName: target.Name });
  out.itemsRepointed = rp.repointed;
  out.failures.push(...rp.failures.map((f) => `re-point ${f}`));

  if (out.failures.length === 0) {
    // NEVER retire a source until it's CONFIRMED zeroed — the old code
    // inactivated whenever no step errored, so a drain that moved $0 (e.g. the
    // numbered-account name-match miss) still retired the account with its
    // balance on it. If the JE found + moved the account, it's zero by
    // construction; otherwise verify its P&L balance directly.
    let zeroed = out.foundInReport;
    if (!zeroed) {
      try {
        const bal = await accountPlBalanceInRange({ realmId, accessToken, account: source, startDate, endDate });
        zeroed = Math.abs(bal) < 0.01;
        if (!zeroed) {
          out.failures.push(
            `source still carries $${Math.round(Math.abs(bal)).toLocaleString()} that line-reclass can't move ` +
            `(income / deposits / paycheques / existing JEs) — left ACTIVE so nothing is stranded. ` +
            `Finish this one as a native merge in the QuickBooks UI: it moves every transaction with detail intact, ` +
            `which the API cannot do without a lump JE.`
          );
        }
      } catch (e: any) {
        out.failures.push(`couldn't verify source is empty — left active: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
    if (zeroed) {
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
  }
  return out;
}

/**
 * The source account's net P&L balance in a date range (accrual — the QBO
 * default view, and the true GL balance we need to be zero before retiring).
 * Account-number-tolerant; prefers account_id, falls back to name.
 */
export async function accountPlBalanceInRange(params: {
  realmId: string;
  accessToken: string;
  account: QBOAccount;
  startDate: string;
  endDate: string;
}): Promise<number> {
  const { realmId, accessToken, account, startDate, endDate } = params;
  const pl = await fetchProfitAndLoss(realmId, accessToken, startDate, endDate, "Accrual");
  const wantId = String(account.Id);
  const idLines = pl.lineItems.filter((l) => l.account_id && String(l.account_id) === wantId);
  if (idLines.length) return idLines.reduce((s, l) => s + l.amount, 0);
  const cand = matchCandidates(account.Name);
  return pl.lineItems
    .filter((l) => [...matchCandidates(l.label)].some((f) => cand.has(f)))
    .reduce((s, l) => s + l.amount, 0);
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
