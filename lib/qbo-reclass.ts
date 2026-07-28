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

import { findOrCreateVendor } from "./qbo";
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

/**
 * Retries 429 and 5xx with backoff, mirroring lib/qbo.ts's shared client.
 *
 * This file used to have a no-retry version, and the transaction fetchers below
 * paired it with `catch { break }` — so a single throttle response abandoned
 * pagination and permanently lost every remaining page, reported as a clean
 * successful run. That is how a job "pulls" 1,000 of 2,600 transactions and
 * tells nobody.
 */
async function qboRequest<T>(
  realmId: string,
  accessToken: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const MAX_ATTEMPTS = 3;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await qboRateLimiter.throttle(realmId);
    const url = `${QBO_BASE}/v3/company/${realmId}${endpoint}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
    } catch (err: any) {
      // Network error / timeout — retryable.
      lastErr = new Error(`QBO request failed on ${endpoint}: ${err?.message || err}`);
      if (attempt < MAX_ATTEMPTS) { await sleep(500 * 2 ** (attempt - 1)); continue; }
      throw lastErr;
    }

    if (res.ok) return res.json();

    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    lastErr = new Error(`QBO API ${res.status} on ${endpoint}: ${body}`);
    if (retryable && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("retry-after")) * 1000;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 500 * 2 ** (attempt - 1));
      continue;
    }
    throw lastErr;
  }
  throw lastErr || new Error(`QBO API request failed on ${endpoint}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============== TRANSACTION FETCHING ==============

/**
 * Fetch all transactions hitting a specific account within a date range,
 * across all 4 supported types. Returns flattened line-level data.
 */
/**
 * A page of a QBO entity query that we never managed to read.
 *
 * The point of this type is that "we don't know what's in there" must be
 * representable. Before it existed, a failed page was a `console.warn` and a
 * `break`, and the job reported success — so there was no way, from inside the
 * product, to distinguish a complete period from a half-read one.
 */
export interface FetchTruncation {
  tx_type: string;
  /** 0-based page index that failed; every page from here on was never read. */
  failed_at_page: number;
  rows_read_before_failure: number;
  message: string;
}

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
  /** Lines seen but not auto-reclassifiable (item-based, unknown detail type). */
  transactionsSkippedUnsupported: number;
  unreclassifiableLines: UnreclassifiableLine[];
  /** Non-empty means the pull is INCOMPLETE — pages we never read. */
  truncations: FetchTruncation[];
  typesQueried: string[];
}> {
  let totalPulled = 0;
  const allLines: ReclassLine[] = [];
  const unreclassifiable: UnreclassifiableLine[] = [];
  const truncations: FetchTruncation[] = [];
  const typesQueried: string[] = [];

  // SEQUENTIAL, not Promise.all. The rate limiter's own contract (lib/qbo.ts)
  // states that true in-flight concurrency per realm must be 1, because
  // RateLimiter.throttle is non-atomic — four concurrent callers read the same
  // lastCallAt, sleep the same interval, and then fire simultaneously. This
  // fetcher was the one place in the codebase that burst 4 concurrent 1000-row
  // queries at a single realm, which is exactly what provoked the 429s that the
  // old `catch { break }` then turned into silent data loss.
  for (const txType of SUPPORTED_TX_TYPES) {
    typesQueried.push(txType);
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const startPosition = page * pageSize + 1;
      const query = encodeURIComponent(
        `SELECT * FROM ${txType} WHERE TxnDate >= '${dateStart}' AND TxnDate <= '${dateEnd}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
      );

      let txs: QBOTransaction[];
      try {
        const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
        txs = data.QueryResponse?.[txType] || [];
      } catch (err: any) {
        // Record the gap instead of pretending the period is complete. The
        // caller decides whether to fail the job or warn — either way a human
        // learns that page `page` of `txType` was never read.
        truncations.push({
          tx_type: txType,
          failed_at_page: page,
          rows_read_before_failure: totalPulled,
          message: String(err?.message || err),
        });
        console.error(`[qbo-reclass] ${txType} pagination aborted at page ${page}: ${err?.message}`);
        break;
      }

      totalPulled += txs.length;

      for (const tx of txs) {
        const isBankFed = !!tx.OnlineBankingTxnReference;
        const isManualEntry = !isBankFed && !tx.DocNumber;
        const vendorName =
          tx.VendorRef?.name || tx.EntityRef?.name || tx.PayeeRef?.name || "Unknown vendor";

        for (const line of tx.Line || []) {
          const detail = line.AccountBasedExpenseLineDetail;
          if (detail?.AccountRef?.value) {
            allLines.push({
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
              is_reconciled: line.Cleared === "Reconciled",
              is_bank_fed: isBankFed,
              is_manual_entry: isManualEntry,
              bank_account_name:
                tx.AccountRef?.name ||
                (txType === "Bill" || txType === "VendorCredit" ? "Accounts Payable" : null),
            });
            continue;
          }

          // Item-based lines (a purchase booked against a Product/Service
          // rather than an account) used to be dropped here with no counter and
          // no log, while the parent transaction still incremented the "pulled"
          // stat — so the job looked complete. lib/qbo-rules.ts:120 records a
          // client whose ENTIRE purchase history is item-based; for them this
          // filter meant SNAP saw nothing and said so to no one.
          //
          // We can't safely re-point an item line without resolving the item's
          // own account mapping, so these are surfaced for manual handling
          // rather than silently eaten.
          const itemDetail = (line as any).ItemBasedExpenseLineDetail;
          if (itemDetail) {
            unreclassifiable.push({
              reason: "item_based",
              transaction_id: tx.Id,
              transaction_type: txType,
              line_id: line.Id || "",
              transaction_date: tx.TxnDate,
              vendor_name: vendorName,
              amount: line.Amount || 0,
              item_ref: itemDetail.ItemRef,
              description: line.Description || "",
            });
          } else if (line.Amount != null && (line as any).DetailType) {
            unreclassifiable.push({
              reason: "unknown_detail_type",
              transaction_id: tx.Id,
              transaction_type: txType,
              line_id: line.Id || "",
              transaction_date: tx.TxnDate,
              vendor_name: vendorName,
              amount: line.Amount || 0,
              description: `${(line as any).DetailType}: ${line.Description || ""}`,
            });
          }
        }
      }

      hasMore = txs.length >= pageSize;
      page++;
    }
  }

  return {
    lines: allLines,
    transactionsPulled: totalPulled,
    // Kept for callers that still read it, but it is NO LONGER a count of
    // entity types that threw — see `truncations` for that, which is the honest
    // signal. This now counts lines we saw but cannot auto-reclassify.
    transactionsSkippedUnsupported: unreclassifiable.length,
    unreclassifiableLines: unreclassifiable,
    truncations,
    typesQueried,
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
      /** STALE GUARD (vendor remediation): only apply this line if its
       *  CURRENT QBO account still matches this name. If a bookkeeper (or
       *  anyone) moved the line since we scanned, we skip it instead of
       *  overwriting a human decision. Compared normalized + leaf-name
       *  tolerant ("Parent:Child" matches "Child"). */
      expected_current_account_name?: string | null;
    }>;
    auditMemo: string;       // appended to PrivateNote
    /** Canonical payee to set as the QBO vendor when the transaction has
     *  none (Purchase-family only; Bills always carry a VendorRef).
     *  Best-effort — failures never block the reclass. */
    vendorName?: string | null;
  }
): Promise<ReclassResult> {
  // Step 1: Refetch fresh transaction (get current SyncToken)
  const tx = await refetchTransaction(realmId, accessToken, params.txType, params.txId);

  // Step 1.5: Stale guard — drop line updates whose current account no longer
  // matches what the caller scanned. Never overwrite a human's later change.
  const normName = (s: string | null | undefined) =>
    (s || "").toLowerCase().replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim();
  const accountsMatch = (currentFull: string | null | undefined, expected: string): boolean => {
    const cur = normName(currentFull);
    const exp = normName(expected);
    if (!cur || !exp) return false;
    if (cur === exp) return true;
    const curLeaf = cur.split(":").pop() || cur;
    const expLeaf = exp.split(":").pop() || exp;
    return curLeaf === expLeaf;
  };
  const staleSkipped: ReclassResult["lines_not_applied"] = [];
  const txLineById = new Map<string, any>();
  for (const l of (tx.Line ?? []) as any[]) if (l.Id) txLineById.set(String(l.Id), l);
  const effectiveUpdates = params.lineUpdates.filter((u) => {
    if (!u.expected_current_account_name) return true;
    const line = txLineById.get(String(u.line_id));
    const currentName = line?.AccountBasedExpenseLineDetail?.AccountRef?.name ?? null;
    if (accountsMatch(currentName, u.expected_current_account_name)) return true;
    staleSkipped.push({
      line_id: u.line_id,
      requested_account_id: String(u.new_account_id),
      actual_account_id: line?.AccountBasedExpenseLineDetail?.AccountRef?.value != null
        ? String(line.AccountBasedExpenseLineDetail.AccountRef.value)
        : null,
      reason: `stale: current account "${currentName ?? "(none)"}" no longer matches expected "${u.expected_current_account_name}" — skipped to preserve the later change`,
    });
    return false;
  });
  if (effectiveUpdates.length === 0) {
    // Every requested line is stale — nothing to write; leave QBO untouched.
    return {
      tx,
      lines_requested: params.lineUpdates.length,
      lines_applied: 0,
      lines_not_applied: staleSkipped,
    };
  }

  // Step 2: Mutate matching lines.
  // Build a completely clean AccountBasedExpenseLineDetail for updated lines — no fallback
  // empty-string AccountRef, no stray fields from the original that could confuse QBO.
  const lineUpdateMap = new Map(effectiveUpdates.map((u) => [u.line_id, u]));
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

  // Step 4.5: Payee (best-effort). Bank-fed Purchases often carry no vendor
  // even when the description identifies one — set the KB's canonical payee
  // so QBO shows who was paid. Purchase-family only (Bills/VendorCredits
  // require a VendorRef already); any failure here never blocks the reclass.
  let entityRefPatch: { EntityRef: { value: string; type: string } } | null = null;
  if (
    params.vendorName &&
    params.txType === "Purchase" &&
    !(tx as any).EntityRef &&
    !(tx as any).VendorRef
  ) {
    try {
      const vendorId = await findOrCreateVendor(realmId, accessToken, params.vendorName);
      if (vendorId) entityRefPatch = { EntityRef: { value: vendorId, type: "Vendor" } };
    } catch {
      // best-effort only
    }
  }

  // Step 5: Build payload — explicitly exclude QBO read-only / computed fields
  // (MetaData, domain, TotalAmt) so they can't trigger unexpected validation.
  const { MetaData: _meta, domain: _domain, TotalAmt: _total, ...txCore } = tx as any;
  const updatePayload = {
    ...txCore,
    Line: safeLines,
    PrivateNote: newMemo,
    sparse: false,
    ...(entityRefPatch || {}),
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
  const notApplied: ReclassResult["lines_not_applied"] = [...staleSkipped];
  for (const update of effectiveUpdates) {
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
      `${applied}/${effectiveUpdates.length} attempted lines confirmed (${staleSkipped.length} stale-skipped), ${notApplied.length} not applied. ` +
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
  const attempted = effectiveUpdates.length;
  if (applied < attempted && attempted > 0) {
    throw new Error(
      `QBO accepted the update but applied only ${applied}/${attempted} attempted lines for ${params.txType}/${params.txId}. ` +
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

// ============== UNCOVERED ENTITY COVERAGE SCAN ==============

/**
 * QBO entity types the reclass/recon pipelines DO NOT fetch or reclassify.
 *
 * SUPPORTED_TX_TYPES is Bill / Purchase / Expense / VendorCredit — the
 * expense family. Everything below moves real money and can sit in a holding
 * account indefinitely, and until now SNAP produced no row, no skip, and no
 * warning for any of it. That is why a client can "finish" a reclass and still
 * have hundreds of uncategorized transactions in QBO:
 *
 *   - Deposit          → uncategorized INCOME, and the credit leg of transfers
 *   - JournalEntry     → manual entries, including ones SNAP's own tools posted
 *   - Transfer         → both legs of an inter-account move
 *   - CreditCardPayment→ card payments, which are balance-sheet, not expense
 *
 * This scan is deliberately READ-ONLY. It exists so an incomplete period is
 * VISIBLE rather than silent; re-pointing these safely needs a different write
 * path per type (a Deposit line is not a Purchase line), which is separate work.
 */
export const UNCOVERED_TX_TYPES = [
  "Deposit",
  "JournalEntry",
  "Transfer",
  "CreditCardPayment",
] as const;
export type UncoveredTxType = (typeof UNCOVERED_TX_TYPES)[number];

export interface UncoveredEntitySample {
  transaction_id: string;
  transaction_type: string;
  transaction_date: string;
  amount: number;
  /** Best-effort account name this transaction touches. */
  account_name: string;
  description: string;
  /** True when the touched account looks like a holding pen. */
  in_holding_account: boolean;
}

export interface UncoveredEntityCoverage {
  /** Per-type transaction counts found in the period. */
  counts: Record<string, number>;
  /** Subset sitting in an Uncategorized / Ask-My-Accountant style account. */
  inHoldingAccount: number;
  /** Absolute dollar value of the holding-account subset. */
  holdingAccountValue: number;
  samples: UncoveredEntitySample[];
  /** Types whose query failed — coverage for these is UNKNOWN, not zero. */
  failedTypes: Array<{ tx_type: string; message: string }>;
}

/**
 * Extract the account-bearing legs of a transaction whose shape we don't
 * otherwise model. Each uncovered type stores its account reference in a
 * different place, so this is intentionally shape-tolerant rather than typed.
 */
function accountLegsOf(tx: any, txType: string): Array<{ name: string; amount: number; description: string }> {
  const legs: Array<{ name: string; amount: number; description: string }> = [];

  // Transfer is header-level: no Line array, two account refs.
  if (txType === "Transfer") {
    if (tx.FromAccountRef?.name) legs.push({ name: tx.FromAccountRef.name, amount: tx.Amount || 0, description: tx.PrivateNote || "" });
    if (tx.ToAccountRef?.name) legs.push({ name: tx.ToAccountRef.name, amount: tx.Amount || 0, description: tx.PrivateNote || "" });
    return legs;
  }
  // CreditCardPayment likewise carries header refs.
  if (txType === "CreditCardPayment") {
    if (tx.BankAccountRef?.name) legs.push({ name: tx.BankAccountRef.name, amount: tx.Amount || 0, description: tx.PrivateNote || "" });
    if (tx.CreditCardAccountRef?.name) legs.push({ name: tx.CreditCardAccountRef.name, amount: tx.Amount || 0, description: tx.PrivateNote || "" });
    return legs;
  }

  for (const line of tx.Line || []) {
    const ref =
      line.DepositLineDetail?.AccountRef ||
      line.JournalEntryLineDetail?.AccountRef ||
      line.AccountBasedExpenseLineDetail?.AccountRef;
    if (ref?.name || ref?.value) {
      legs.push({
        name: ref.name || `(account ${ref.value})`,
        amount: line.Amount || 0,
        description: line.Description || tx.PrivateNote || "",
      });
    }
  }
  // A Deposit whose lines carry no account still lands somewhere.
  if (legs.length === 0 && tx.DepositToAccountRef?.name) {
    legs.push({ name: tx.DepositToAccountRef.name, amount: tx.TotalAmt || 0, description: tx.PrivateNote || "" });
  }
  return legs;
}

/**
 * Count (and sample) transactions in the period that SNAP's reclass pipeline
 * structurally cannot touch. Never throws: a failed type is reported in
 * `failedTypes` so "we don't know" stays distinguishable from "there are none".
 */
export async function scanUncoveredEntities(
  realmId: string,
  accessToken: string,
  dateStart: string,
  dateEnd: string,
  isHoldingAccount: (accountName: string | null | undefined) => boolean
): Promise<UncoveredEntityCoverage> {
  const counts: Record<string, number> = {};
  const samples: UncoveredEntitySample[] = [];
  const failedTypes: Array<{ tx_type: string; message: string }> = [];
  let inHoldingAccount = 0;
  let holdingAccountValue = 0;

  for (const txType of UNCOVERED_TX_TYPES) {
    counts[txType] = 0;
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const query = encodeURIComponent(
        `SELECT * FROM ${txType} WHERE TxnDate >= '${dateStart}' AND TxnDate <= '${dateEnd}' ` +
          `STARTPOSITION ${page * pageSize + 1} MAXRESULTS ${pageSize}`
      );
      let txs: any[];
      try {
        const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
        txs = data.QueryResponse?.[txType] || [];
      } catch (err: any) {
        // Not every QBO company file exposes every entity (CreditCardPayment in
        // particular is region/version dependent). Record and move on — this is
        // a diagnostic, and it must never fail the job it is reporting on.
        failedTypes.push({ tx_type: txType, message: String(err?.message || err).slice(0, 200) });
        break;
      }

      counts[txType] += txs.length;
      for (const tx of txs) {
        for (const leg of accountLegsOf(tx, txType)) {
          const holding = isHoldingAccount(leg.name);
          if (holding) {
            inHoldingAccount++;
            holdingAccountValue += Math.abs(Number(leg.amount) || 0);
          }
          if (samples.length < 40 && holding) {
            samples.push({
              transaction_id: tx.Id,
              transaction_type: txType,
              transaction_date: tx.TxnDate,
              amount: Number(leg.amount) || 0,
              account_name: leg.name,
              description: leg.description,
              in_holding_account: true,
            });
          }
        }
      }

      hasMore = txs.length >= pageSize;
      page++;
    }
  }

  return { counts, inHoldingAccount, holdingAccountValue, samples, failedTypes };
}

// ============== EXPORTS ==============

export { getValidToken, sourceFromRequest };
