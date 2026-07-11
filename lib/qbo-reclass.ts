/**
 * QBO Reclassification Engine
 * ----------------------------
 * Line-level transaction reclassification for Bill, Purchase, Expense, VendorCredit.
 *
 * Key design decisions:
 *  - Work at line level (not transaction level) - a Bill with 5 lines hitting 3 accounts,
 *    we only move the lines hitting the source account, leaving others untouched.
 *  - Detect reconciled status per-line (cleared field).
 *  - Detect bank-fed vs manual entries via OnlineBankingTxnReference presence.
 *  - Append audit memo to transaction PrivateNote (one append per transaction even if
 *    multiple lines on it get reclassified).
 *  - Each update increments SyncToken; we capture token at discovery time and refresh
 *    if stale at execution time.
 */

import { qboRateLimiter, getValidToken, sourceFromRequest } from "./qbo";

const QBO_BASE =
  process.env.QBO_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

// Transaction types we support for reclassification
export const SUPPORTED_TX_TYPES = ["Bill", "Purchase", "Expense", "VendorCredit"] as const;
export type SupportedTxType = (typeof SUPPORTED_TX_TYPES)[number];

// ============== TYPES ==============

export interface ReclassLine {
  // Identity
  transaction_id: string;
  transaction_type: SupportedTxType;
  line_id: string;
  sync_token: string;

  // Context
  transaction_date: string;          // YYYY-MM-DD
  transaction_amount: number;        // signed line amount
  vendor_name: string;
  current_account_id: string;
  current_account_name: string;
  description: string;               // line description, if any
  private_note: string;              // transaction-level memo

  // Detection flags
  is_reconciled: boolean;            // line.cleared === "Reconciled"
  is_bank_fed: boolean;
  is_manual_entry: boolean;

  // Source account: which bank/CC the money moved through (Purchase/Expense
  // header AccountRef). Bills/VendorCredits report "Accounts Payable".
  // Optional for backward-compat with queued chunk payloads.
  bank_account_name?: string | null;
}

export interface QBOLine {
  Id?: string;
  LineNum?: number;
  Description?: string;
  Amount: number;
  DetailType: string;
  AccountBasedExpenseLineDetail?: {
    AccountRef: { value: string; name?: string };
    TaxCodeRef?: { value: string };
    BillableStatus?: string;
    CustomerRef?: { value: string };
    ClassRef?: { value: string };
  };
  // Other line detail types we don't touch
  JournalEntryLineDetail?: unknown;
  // Status fields
  Cleared?: string;                  // "Reconciled" | "Cleared" | undefined
}

export interface QBOTransaction {
  Id: string;
  SyncToken: string;
  domain?: string;
  sparse?: boolean;
  TxnDate: string;
  TotalAmt?: number;
  PrivateNote?: string;
  Line: QBOLine[];
  VendorRef?: { value: string; name?: string };
  EntityRef?: { value: string; name?: string };
  // Purchase/Expense/Check: the bank or credit-card account the money moved
  // through. Bills/VendorCredits have no payment account (they're A/P).
  AccountRef?: { value: string; name?: string };
  PayeeRef?: { value: string; name?: string };
  // Bank-fed / online txn marker
  OnlineBankingTxnReference?: unknown;
  GlobalTaxCalculation?: string;
  DocNumber?: string;
  MetaData?: {
    CreateTime?: string;
    LastUpdatedTime?: string;
  };
}

// ============== HELPERS ==============

async function qboRequest<T>(
  realmId: string,
  accessToken: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  await qboRateLimiter.throttle(realmId);
  const url = `${QBO_BASE}/v3/company/${realmId}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO API ${res.status} on ${endpoint}: ${body}`);
  }
  return res.json();
}

// ============== TRANSACTION FETCHING ==============

/**
 * Fetch all transactions hitting a specific account within a date range,
 * across all 4 supported types. Returns flattened line-level data.
 */
export interface UnreclassifiableLine {
  /** Why this line hit the account but can't be auto-reclassified */
  reason: "item_based" | "journal_entry_unsupported" | "unknown_detail_type";
  transaction_id: string;
  transaction_type: string;
  line_id: string;
  transaction_date: string;
  vendor_name: string;
  amount: number;
  /** For item_based: the QBO item id/name that's tied to this account */
  item_ref?: { value: string; name?: string };
  description: string;
}

export async function fetchTransactionsForAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  dateStart: string,    // YYYY-MM-DD
  dateEnd: string       // YYYY-MM-DD
): Promise<{
  lines: ReclassLine[];
  transactionsPulled: number;
  transactionsSkippedUnsupported: number;
  /** Lines that DO hit the account but can't be auto-reclassified (item-based,
   *  JEs without our support, etc.). Surfaced to the bookkeeper so they know
   *  to handle these manually in QBO instead of thinking the period was done. */
  unreclassifiableLines: UnreclassifiableLine[];
  /** Per-item-account map we resolved during the scan so the caller (or a
   *  future feature) can see which items map to which expense accounts. */
  itemToAccountMap: Map<string, { item_name: string; account_id: string }>;
}> {
  let totalPulled = 0;
  let skippedUnsupported = 0;
  const unreclassifiable: UnreclassifiableLine[] = [];
  const itemAccountCache = new Map<string, { item_name: string; account_id: string }>();

  // Lazy item lookup: when we see an ItemBasedExpenseLineDetail line, we
  // need to know which account that item maps to. QBO Items have
  // ExpenseAccountRef + IncomeAccountRef. We pull a batch of items only
  // when we hit a tx that uses items, to avoid an unnecessary roundtrip
  // on clients that don't use items.
  let itemsLoaded = false;
  async function ensureItemsLoaded() {
    if (itemsLoaded) return;
    itemsLoaded = true;
    try {
      let page = 0;
      const pageSize = 1000;
      while (true) {
        const startPosition = page * pageSize + 1;
        const query = encodeURIComponent(
          `SELECT Id, Name, Type, ExpenseAccountRef, IncomeAccountRef FROM Item STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
        );
        const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
        const items: any[] = data.QueryResponse?.Item || [];
        for (const it of items) {
          // An item can have BOTH refs (e.g. a service sold AND used as cost).
          // We map both so a search by accountId works either side.
          if (it.ExpenseAccountRef?.value) {
            itemAccountCache.set(String(it.Id) + ":expense", {
              item_name: it.Name,
              account_id: String(it.ExpenseAccountRef.value),
            });
          }
          if (it.IncomeAccountRef?.value) {
            itemAccountCache.set(String(it.Id) + ":income", {
              item_name: it.Name,
              account_id: String(it.IncomeAccountRef.value),
            });
          }
        }
        if (items.length < pageSize) break;
        page++;
        if (page > 50) break;
      }
    } catch (err: any) {
      console.warn("[qbo-reclass] Item lookup failed (item-based reclass will be skipped):", err.message);
    }
  }

  // Pull the 4 transaction types in PARALLEL. Each type independently
  // paginates through its result set; previously this ran sequentially
  // (Bill → Purchase → Expense → VendorCredit) which made every cleanup
  // 3-4x slower than necessary. The rate limiter (~450/min per realm)
  // throttles automatically if we'd exceed the budget.
  const perTypeResults = await Promise.all(
    SUPPORTED_TX_TYPES.map(async (txType) => {
      const typeLines: ReclassLine[] = [];
      let typePulled = 0;
      let typeUnsupported = 0;
      let page = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const startPosition = page * pageSize + 1; // QBO is 1-indexed
        const query = encodeURIComponent(
          `SELECT * FROM ${txType} WHERE TxnDate >= '${dateStart}' AND TxnDate <= '${dateEnd}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
        );

        try {
          const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
          const txs: QBOTransaction[] = data.QueryResponse?.[txType] || [];
          typePulled += txs.length;

          // Detect if any line uses Item-based detail. If so, we need the
          // item→account map to know which item-lines hit our account.
          // Load lazily — once we know there's at least one item-based line
          // anywhere in this batch, do the (cached) full Item pull.
          const hasItemBasedLines = txs.some((tx) =>
            (tx.Line || []).some((l: any) => l.DetailType === "ItemBasedExpenseLineDetail")
          );
          if (hasItemBasedLines) await ensureItemsLoaded();

          const targetId = String(accountId);

          for (const tx of txs) {
            // Detect status flags at transaction level
            const isBankFed = !!tx.OnlineBankingTxnReference;
            const isManualEntry = !isBankFed && !tx.DocNumber;
            const vendorName =
              tx.VendorRef?.name ||
              tx.EntityRef?.name ||
              tx.PayeeRef?.name ||
              "Unknown vendor";

            for (const line of tx.Line || []) {
              const dt = (line as any).DetailType;

              // ── AccountBased: line directly references the account ──
              if (dt === "AccountBasedExpenseLineDetail") {
                const detail = line.AccountBasedExpenseLineDetail;
                if (String(detail?.AccountRef?.value) !== targetId) continue;
                typeLines.push({
                  transaction_id: tx.Id,
                  transaction_type: txType,
                  line_id: line.Id || "",
                  sync_token: tx.SyncToken,
                  transaction_date: tx.TxnDate,
                  transaction_amount: line.Amount || 0,
                  vendor_name: vendorName,
                  current_account_id: targetId,
                  current_account_name: detail?.AccountRef?.name || "",
                  description: line.Description || "",
                  private_note: tx.PrivateNote || "",
                  is_reconciled: line.Cleared === "Reconciled",
                  is_bank_fed: isBankFed,
                  is_manual_entry: isManualEntry,
                });
                continue;
              }

              // ── ItemBased: line references an item that maps to an account ──
              // Reclass requires changing the ITEM, not the account on the line.
              // Out of scope for auto-reclass — surface as unreclassifiable so
              // the bookkeeper knows to handle these manually in QBO instead of
              // thinking the period was fully reclassed.
              if (dt === "ItemBasedExpenseLineDetail") {
                const detail = (line as any).ItemBasedExpenseLineDetail;
                const itemRef = detail?.ItemRef;
                if (!itemRef?.value) continue;
                const itemMapping =
                  itemAccountCache.get(String(itemRef.value) + ":expense") ||
                  itemAccountCache.get(String(itemRef.value) + ":income");
                if (itemMapping?.account_id !== targetId) continue;
                unreclassifiable.push({
                  reason: "item_based",
                  transaction_id: tx.Id,
                  transaction_type: txType,
                  line_id: line.Id || "",
                  transaction_date: tx.TxnDate,
                  vendor_name: vendorName,
                  amount: line.Amount || 0,
                  item_ref: { value: String(itemRef.value), name: itemRef.name },
                  description: line.Description || "",
                });
                continue;
              }

              // ── Any other detail type with an AccountRef we recognize ──
              // (e.g. a future QBO line type). Track but skip.
              const anyDetail = (line as any)[dt];
              if (anyDetail?.AccountRef?.value && String(anyDetail.AccountRef.value) === targetId) {
                unreclassifiable.push({
                  reason: "unknown_detail_type",
                  transaction_id: tx.Id,
                  transaction_type: txType,
                  line_id: line.Id || "",
                  transaction_date: tx.TxnDate,
                  vendor_name: vendorName,
                  amount: line.Amount || 0,
                  description: `Detail type "${dt}" not handled by reclass engine`,
                });
              }
            }
          }

          // QBO returns at most pageSize results
          hasMore = txs.length >= pageSize;
          page++;
        } catch (err: any) {
          // Some transaction types may not be queryable - log and continue
          console.warn(`Failed to query ${txType}:`, err.message);
          typeUnsupported++;
          break;
        }
      }
      return { typeLines, typePulled, typeUnsupported };
    })
  );

  const allLines: ReclassLine[] = [];
  for (const r of perTypeResults) {
    allLines.push(...r.typeLines);
    totalPulled += r.typePulled;
    skippedUnsupported += r.typeUnsupported;
  }

  return {
    lines: allLines,
    transactionsPulled: totalPulled,
    transactionsSkippedUnsupported: skippedUnsupported,
    unreclassifiableLines: unreclassifiable,
    itemToAccountMap: itemAccountCache,
  };
}

/**
 * Fetch ALL line-level transactions in a date range, without filtering by
 * source account. Used by full_categorization workflow.
 */
export async function fetchAllTransactionLines(
  realmId: string,
  accessToken: string,
  dateStart: string,
  dateEnd: string
): Promise<{
  lines: ReclassLine[];
  transactionsPulled: number;
  transactionsSkippedUnsupported: number;
}> {
  let totalPulled = 0;
  let skippedUnsupported = 0;

  // Pull the 4 transaction types in PARALLEL. See fetchTransactionsForAccount
  // above for the same pattern + rate-limit rationale.
  const perTypeResults = await Promise.all(
    SUPPORTED_TX_TYPES.map(async (txType) => {
      const typeLines: ReclassLine[] = [];
      let typePulled = 0;
      let typeUnsupported = 0;
      let page = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const startPosition = page * pageSize + 1;
        const query = encodeURIComponent(
          `SELECT * FROM ${txType} WHERE TxnDate >= '${dateStart}' AND TxnDate <= '${dateEnd}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
        );

        try {
          const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
          const txs: QBOTransaction[] = data.QueryResponse?.[txType] || [];
          typePulled += txs.length;

          for (const tx of txs) {
            // Keep every line that points to an expense account
            const matchingLines = (tx.Line || []).filter((line) => {
              return !!line.AccountBasedExpenseLineDetail?.AccountRef?.value;
            });
            if (matchingLines.length === 0) continue;

            const isBankFed = !!tx.OnlineBankingTxnReference;
            const isManualEntry = !isBankFed && !tx.DocNumber;
            const vendorName =
              tx.VendorRef?.name || tx.EntityRef?.name || tx.PayeeRef?.name || "Unknown vendor";

            for (const line of matchingLines) {
              const isReconciled = line.Cleared === "Reconciled";
              const detail = line.AccountBasedExpenseLineDetail!;
              typeLines.push({
                transaction_id: tx.Id,
                transaction_type: txType,
                line_id: line.Id || "",
                sync_token: tx.SyncToken,
                transaction_date: tx.TxnDate,
                transaction_amount: line.Amount || 0,
                vendor_name: vendorName,
                current_account_id: detail.AccountRef.value,
                current_account_name: detail.AccountRef.name || "",
                description: line.Description || "",
                private_note: tx.PrivateNote || "",
                is_reconciled: isReconciled,
                is_bank_fed: isBankFed,
                is_manual_entry: isManualEntry,
                bank_account_name:
                  tx.AccountRef?.name ||
                  (txType === "Bill" || txType === "VendorCredit" ? "Accounts Payable" : null),
              });
            }
          }

          hasMore = txs.length >= pageSize;
          page++;
        } catch (err: any) {
          console.warn(`Failed to query ${txType}:`, err.message);
          typeUnsupported++;
          break;
        }
      }
      return { typeLines, typePulled, typeUnsupported };
    })
  );

  const allLines: ReclassLine[] = [];
  for (const r of perTypeResults) {
    allLines.push(...r.typeLines);
    totalPulled += r.typePulled;
    skippedUnsupported += r.typeUnsupported;
  }

  return {
    lines: allLines,
    transactionsPulled: totalPulled,
    transactionsSkippedUnsupported: skippedUnsupported,
  };
}

// ============== QBO BOOKS CLOSING DATE ==============

/**
 * Get the company's books closing date setting from QBO Preferences.
 * Transactions before this date require closing password and we skip them.
 */
export async function getCompanyClosingDate(
  realmId: string,
  accessToken: string
): Promise<string | null> {
  try {
    const data: any = await qboRequest(
      realmId,
      accessToken,
      "/preferences"
    );
    const prefs = data.Preferences;
    return prefs?.AccountingInfoPrefs?.BookCloseDate || null;
  } catch {
    return null;
  }
}

/**
 * Returns true if the given transaction date falls in QBO's closed period.
 */
export function isInClosedPeriod(
  txnDate: string,
  bookCloseDate: string | null
): boolean {
  if (!bookCloseDate) return false;
  return new Date(txnDate) <= new Date(bookCloseDate);
}

// ============== DOUBLE END-CLOSE HELPERS ==============
// Shared by the reclass workflow and the COA-cleanup merge step.

import type { DoubleEndCloseSummary } from "./double";

/**
 * Return the Double end-close record that covers the given transaction date,
 * if any. Matches by year+month (Double tracks closes per calendar month).
 */
export function findDoubleClose(
  txnDate: string,
  closes: DoubleEndCloseSummary[]
): DoubleEndCloseSummary | null {
  const d = new Date(txnDate);
  const yearMonth = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return closes.find((c) => c.yearMonth === yearMonth) || null;
}

/**
 * True if a Double end-close is in a state that means "this month is locked,
 * don't touch its transactions." Treats null/unknown as NOT locked to avoid
 * blocking work on missing metadata.
 */
export function isDoubleCloseLocked(status: string | null | undefined): boolean {
  if (!status) return false;
  return ["complete", "completed", "closed", "delivered"].includes(status.toLowerCase());
}

// ============== TRANSACTION UPDATE ==============

/**
 * Refetch a single transaction (we need fresh SyncToken at update time).
 */
export async function refetchTransaction(
  realmId: string,
  accessToken: string,
  txType: SupportedTxType,
  txId: string
): Promise<QBOTransaction> {
  const data: any = await qboRequest(
    realmId,
    accessToken,
    `/${txType.toLowerCase()}/${txId}`
  );
  return data[txType];
}

/**
 * Update one or more line items in a transaction to point at a new target account.
 * Appends an audit memo to the transaction's PrivateNote.
 *
 * Returns the updated transaction.
 */
/**
 * Result of a reclassify call. Critical: `lines_applied` is the count of
 * lines that the QBO RESPONSE confirmed are at the new account — NOT the
 * count we asked for. Callers should report this number, not the requested
 * count, to avoid the "we said success but QBO didn't change" bug class.
 *
 * `lines_not_applied` captures any line we asked to update but the QBO
 * response didn't reflect (line missing, account didn't change, etc.).
 * Throws an error if NO lines applied — that's a real failure.
 */
export interface ReclassResult {
  tx: QBOTransaction;
  lines_requested: number;
  lines_applied: number;
  lines_not_applied: Array<{
    line_id: string;
    requested_account_id: string;
    actual_account_id: string | null;
    reason: string;
  }>;
}

export async function reclassifyTransactionLines(
  realmId: string,
  accessToken: string,
  params: {
    txType: SupportedTxType;
    txId: string;
    lineUpdates: Array<{
      line_id: string;
      new_account_id: string;
      new_account_name?: string;
    }>;
    auditMemo: string;       // appended to PrivateNote
  }
): Promise<ReclassResult> {
  // Step 1: Refetch fresh transaction (get current SyncToken)
  const tx = await refetchTransaction(realmId, accessToken, params.txType, params.txId);

  // Step 2: Mutate matching lines.
  // Build a completely clean AccountBasedExpenseLineDetail for updated lines — no fallback
  // empty-string AccountRef, no stray fields from the original that could confuse QBO.
  const lineUpdateMap = new Map(params.lineUpdates.map((u) => [u.line_id, u]));
  const updatedLines = (tx.Line ?? []).map((line: any) => {
    if (!line.Id) return line;
    const update = lineUpdateMap.get(line.Id);
    if (!update?.new_account_id) return line;

    const originalDetail = line.AccountBasedExpenseLineDetail ?? {};
    return {
      ...line,
      AccountBasedExpenseLineDetail: {
        // Preserve optional sub-fields (tax, billable, class) but always set AccountRef last
        ...(originalDetail.TaxCodeRef    && { TaxCodeRef:    originalDetail.TaxCodeRef }),
        ...(originalDetail.BillableStatus && { BillableStatus: originalDetail.BillableStatus }),
        ...(originalDetail.CustomerRef   && { CustomerRef:   originalDetail.CustomerRef }),
        ...(originalDetail.ClassRef      && { ClassRef:      originalDetail.ClassRef }),
        AccountRef: {
          value: update.new_account_id,
          ...(update.new_account_name && { name: update.new_account_name }),
        },
      },
    };
  });

  // Step 3: Append memo
  const existingMemo = tx.PrivateNote || "";
  const newMemo = existingMemo.includes(params.auditMemo)
    ? existingMemo
    : (existingMemo ? existingMemo + "\n" : "") + params.auditMemo;

  // Step 4: Sanitize every line before sending.
  //
  // QBO error 2020 fires whenever a line reaches the API with
  // AccountBasedExpenseLineDetail present but AccountRef.value absent/empty.
  // This happens for several reasons:
  //   a) Line has the property set to null / {} / { AccountRef: null } / { AccountRef: { value: "" } }
  //   b) Line has DetailType "AccountBasedExpenseLineDetail" but the property itself is missing
  //   c) A non-AccountBased line (Item, SubTotal…) has the field as a stale/null property
  //
  // Rules:
  //   - If DetailType IS AccountBasedExpenseLineDetail AND AccountRef.value is invalid → drop line
  //   - If DetailType is anything else AND AccountBasedExpenseLineDetail is present but invalid → strip field
  //   - Otherwise → leave untouched
  const safeLines = (updatedLines as any[])
    .map((line) => {
      const isAccountBasedType = line.DetailType === "AccountBasedExpenseLineDetail";
      const detail = line.AccountBasedExpenseLineDetail;
      const hasValidRef = !!(detail?.AccountRef?.value);

      // Case (b): DetailType says AccountBased but property is absent
      const isMissingDetail = isAccountBasedType && detail === undefined;

      if (isMissingDetail || (detail !== undefined && !hasValidRef)) {
        if (isAccountBasedType) {
          console.warn(
            `[qbo-reclass] ${params.txType}/${params.txId} line ${line.Id ?? "(no id)"}: ` +
            `dropping — DetailType=AccountBasedExpenseLineDetail but AccountRef missing/invalid`
          );
          return null;
        }
        // Non-AccountBased line carrying a stale/null detail field: strip it
        console.warn(
          `[qbo-reclass] ${params.txType}/${params.txId} line ${line.Id ?? "(no id)"}: ` +
          `stripping invalid AccountBasedExpenseLineDetail from ${line.DetailType} line`
        );
        const { AccountBasedExpenseLineDetail: _bad, ...rest } = line;
        return rest;
      }

      return line;
    })
    .filter(Boolean);

  // Step 5: Build payload — explicitly exclude QBO read-only / computed fields
  // (MetaData, domain, TotalAmt) so they can't trigger unexpected validation.
  const { MetaData: _meta, domain: _domain, TotalAmt: _total, ...txCore } = tx as any;
  const updatePayload = {
    ...txCore,
    Line: safeLines,
    PrivateNote: newMemo,
    sparse: false,
  };

  let data: any;
  try {
    data = await qboRequest(
      realmId,
      accessToken,
      `/${params.txType.toLowerCase()}?operation=update`,
      {
        method: "POST",
        body: JSON.stringify(updatePayload),
      }
    );
  } catch (err: any) {
    // Log complete raw line data so we can diagnose any remaining failures
    console.error(
      `[qbo-reclass] update failed — ${params.txType}/${params.txId}\n` +
      `raw tx.Line: ${JSON.stringify((tx.Line ?? []).map((l: any) => ({
        Id: l.Id, DetailType: l.DetailType,
        hasDetail: l.AccountBasedExpenseLineDetail !== undefined,
        ref: l.AccountBasedExpenseLineDetail?.AccountRef,
      })))}\n` +
      `safeLines:  ${JSON.stringify(safeLines.map((l: any) => ({
        Id: l.Id, DetailType: l.DetailType,
        ref: l.AccountBasedExpenseLineDetail?.AccountRef,
      })))}`
    );
    throw err;
  }

  // ─── VERIFY THE RESPONSE ACTUALLY APPLIED OUR CHANGES ───
  // QBO will sometimes accept the payload but not reflect the requested
  // change (concurrent edit collision, line removed from the canonical
  // row, etc.). We've also seen our own sanitizer drop a line we asked
  // to update. Compare the response against what we requested.
  const returnedTx = data[params.txType] as QBOTransaction;
  const returnedLineMap = new Map<string, any>();
  for (const l of (returnedTx?.Line || []) as any[]) {
    if (l.Id) returnedLineMap.set(String(l.Id), l);
  }

  let applied = 0;
  const notApplied: ReclassResult["lines_not_applied"] = [];
  for (const update of params.lineUpdates) {
    const expected = String(update.new_account_id);
    const returnedLine = returnedLineMap.get(String(update.line_id));
    if (!returnedLine) {
      notApplied.push({
        line_id: update.line_id,
        requested_account_id: expected,
        actual_account_id: null,
        reason: "Line not present in QBO response (may have been removed by sanitizer or deleted on QBO)",
      });
      continue;
    }
    const actual =
      returnedLine.AccountBasedExpenseLineDetail?.AccountRef?.value != null
        ? String(returnedLine.AccountBasedExpenseLineDetail.AccountRef.value)
        : null;
    if (actual === expected) {
      applied++;
    } else {
      notApplied.push({
        line_id: update.line_id,
        requested_account_id: expected,
        actual_account_id: actual,
        reason: actual
          ? `QBO returned line at account ${actual} instead of requested ${expected}`
          : `Line present in QBO response but has no AccountRef (DetailType=${returnedLine.DetailType})`,
      });
    }
  }

  if (notApplied.length > 0) {
    console.warn(
      `[qbo-reclass] partial apply — ${params.txType}/${params.txId}: ` +
      `${applied}/${params.lineUpdates.length} lines confirmed, ${notApplied.length} not applied. ` +
      `Details: ${JSON.stringify(notApplied)}`
    );
  }

  // Hard failure if QBO didn't apply EVERY requested line. A partial apply
  // means money is left on the source account while the caller would
  // otherwise record the reclass as done (executed=true) — the books then
  // don't foot and resume logic skips the stragglers. Each not-applied line
  // is a genuine failure (the sanitizer only drops lines whose AccountRef is
  // invalid, and we always set a valid target), so throw on ANY shortfall
  // and let the caller route the transaction to review/failed. The lines
  // that DID apply are already saved in QBO; a retry re-applies the same
  // targets (a no-op for the moved lines) and re-attempts the stragglers.
  if (applied < params.lineUpdates.length && params.lineUpdates.length > 0) {
    throw new Error(
      `QBO accepted the update but applied only ${applied}/${params.lineUpdates.length} lines for ${params.txType}/${params.txId}. ` +
      `Not applied: ${notApplied.map((n) => `${n.line_id} (${n.reason})`).join("; ")}`
    );
  }

  return {
    tx: returnedTx,
    lines_requested: params.lineUpdates.length,
    lines_applied: applied,
    lines_not_applied: notApplied,
  };
}

// ============== VENDOR NORMALIZATION ==============

/**
 * Normalize "SHERWIN-WILLIAMS #4521" and "Sherwin Williams Co" to "SHERWIN WILLIAMS".
 * Used for grouping txs by vendor in scrub mode.
 */
export function normalizeVendorName(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[#\-_*\/\\.,]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(CO|INC|LLC|LTD|CORP|COMPANY|THE|STORE|#\d+|\d+)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ============== MEMO BUILDER ==============

/**
 * Build the standard Ironbooks audit memo for reclassed transactions.
 * Format: [Ironbooks reclass YYYY-MM-DD by {name}: {reason}]
 */
export function buildAuditMemo(
  bookkeeperName: string,
  reason: string,
  date?: Date
): string {
  const d = date || new Date();
  const dateStr = d.toISOString().split("T")[0];
  // Truncate reason to keep memos reasonable (PrivateNote has size limits)
  const trimmedReason = reason.length > 80 ? reason.slice(0, 77) + "..." : reason;
  return `[Ironbooks reclass ${dateStr} by ${bookkeeperName}: ${trimmedReason}]`;
}

export type ReclassBlockReason = "matched_download" | "closed_period" | null;

/**
 * Translate a raw QBO write error into a bookkeeper-facing explanation for the
 * cases we hit constantly, so the UI shows a next step instead of raw JSON.
 *
 * The big one: QBO refuses to change the account on a transaction that's
 * MATCHED to a bank-feed downloaded transaction (Business Validation Error
 * code 6000, "...matched to a downloaded transaction... unmatch the
 * transaction first"). There is no supported QBO API to unmatch — it can only
 * be undone in the QBO UI — so we hand the bookkeeper the exact steps.
 */
export function describeReclassError(err: any): { blocked: ReclassBlockReason; message: string } {
  const raw = String(err?.message || err || "");
  const is6000 = raw.includes('"code":"6000"') || /business validation error/i.test(raw);

  if (
    (is6000 && (/matched to a downloaded transaction/i.test(raw) || /unmatch the transaction first/i.test(raw))) ||
    /matched to a downloaded transaction/i.test(raw)
  ) {
    return {
      blocked: "matched_download",
      message:
        "QuickBooks won't recategorize this — it's matched to a bank-feed download, and QBO locks the account until it's unmatched. In QuickBooks: Transactions → Bank transactions → Categorized, find this transaction → Undo (that unmatches it), then approve here again. If it shouldn't move at all, reject it.",
    };
  }

  if (is6000 && (/closed|closing date|change is within the closed/i.test(raw))) {
    return {
      blocked: "closed_period",
      message:
        "QuickBooks blocked this because it falls in a closed period. Reopen the period in QBO (or have it re-opened) before recategorizing, or leave it as-is.",
    };
  }

  return { blocked: null, message: raw };
}

// ============== GROUP HELPERS (for scrub mode) ==============

export interface VendorGroup {
  vendor_pattern: string;       // normalized name
  display_name: string;         // a representative original name
  lines: ReclassLine[];
  total_amount: number;
  earliest_date: string;
  latest_date: string;
}

/**
 * Group lines by normalized vendor name. Used for scrub mode AI batching.
 * Returns groups sorted by line count (largest first).
 */
export function groupLinesByVendor(lines: ReclassLine[]): VendorGroup[] {
  const groups = new Map<string, VendorGroup>();

  for (const line of lines) {
    const pattern = normalizeVendorName(line.vendor_name);
    if (!pattern) continue;

    let group = groups.get(pattern);
    if (!group) {
      group = {
        vendor_pattern: pattern,
        display_name: line.vendor_name,
        lines: [],
        total_amount: 0,
        earliest_date: line.transaction_date,
        latest_date: line.transaction_date,
      };
      groups.set(pattern, group);
    }

    group.lines.push(line);
    group.total_amount += Math.abs(line.transaction_amount);
    if (line.transaction_date < group.earliest_date) group.earliest_date = line.transaction_date;
    if (line.transaction_date > group.latest_date) group.latest_date = line.transaction_date;
  }

  return Array.from(groups.values()).sort((a, b) => b.lines.length - a.lines.length);
}

// ============== EXPORTS ==============

export { getValidToken, sourceFromRequest };
