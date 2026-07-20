/**
 * QBO Bank Rules Extensions
 * --------------------------
 * Adds bank rule CRUD + transaction aggregation by vendor.
 * Used by Module 2 (Bank Rules).
 *
 * Note: QBO's BankRule API is part of the v3 API but is less documented
 * than Account. We use the Purchase/Bill/Expense queries to discover vendor
 * patterns, then create rules via the BankRule entity.
 */

import { qboRateLimiter } from "./qbo";

const QBO_BASE = process.env.QBO_ENVIRONMENT === "production"
  ? "https://quickbooks.api.intuit.com"
  : "https://sandbox-quickbooks.api.intuit.com";

// ============== TYPES ==============

export interface VendorTransaction {
  id: string;
  type: string;            // 'Purchase', 'Bill', 'Expense'
  date: string;
  amount: number;
  description: string;     // vendor name or memo
  accountId: string;
  accountName: string;
}

export interface VendorGroup {
  vendor_pattern: string;        // normalized payee name
  transaction_count: number;
  total_amount: number;
  sample_descriptions: string[]; // up to 5 examples
  current_accounts: Record<string, number>;  // account → tx count (where they currently land)
  primary_current_account?: string;          // most common account used
}

export interface QBOBankRule {
  Id?: string;
  Name: string;
  Active: boolean;
  Priority?: number;
  Conditions: {
    AccountType: "Bank" | "CreditCard";
    Condition: Array<{
      Field: "Description" | "Amount" | "Account";
      Operator: "Contains" | "Is" | "DoesNotContain" | "StartsWith";
      Value: string;
    }>;
  };
  Actions: {
    PayeeId?: string;
    CategoryId: string;        // QBO account ID
    TaxCodeId?: string;
    Memo?: string;
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
    throw new Error(`QBO API ${res.status}: ${body}`);
  }
  return res.json();
}

// ============== TRANSACTION FETCHING ==============

/**
 * Pull recent expense-like transactions across all relevant types.
 * Returns flattened list suitable for vendor grouping.
 */
export async function fetchRecentTransactions(
  realmId: string,
  accessToken: string,
  monthsBack = 6
): Promise<VendorTransaction[]> {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - monthsBack);
  const startStr = startDate.toISOString().split("T")[0];

  const results: VendorTransaction[] = [];

  // QBO transaction types that hit expense accounts
  const types = ["Purchase", "Bill", "Expense", "VendorCredit"];

  for (const type of types) {
    try {
      const query = encodeURIComponent(
        `SELECT * FROM ${type} WHERE TxnDate >= '${startStr}' MAXRESULTS 1000`
      );
      const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}&minorversion=70`);
      const txs = data.QueryResponse?.[type] || [];

      for (const tx of txs) {
        for (const line of tx.Line || []) {
          // Expense can be booked against an ACCOUNT (AccountBasedExpenseLineDetail /
          // JournalEntryLineDetail) OR against a Product/Service ITEM
          // (ItemBasedExpenseLineDetail) — the latter has no inline AccountRef but
          // is still real spend. A design studio (Jeva) books purchases against
          // items, so dropping item lines lost ALL 60 of its purchases → 0 rules.
          const acctDetail =
            line.AccountBasedExpenseLineDetail || line.JournalEntryLineDetail;
          const itemDetail = line.ItemBasedExpenseLineDetail;
          if (!acctDetail && !itemDetail) continue; // subtotal/discount/junk line

          const accountRef = acctDetail?.AccountRef;
          const itemName = itemDetail?.ItemRef?.name;

          // Get description from multiple possible places
          const description =
            tx.EntityRef?.name ||
            tx.PayeeRef?.name ||
            line.Description ||
            tx.PrivateNote ||
            "Unknown vendor";

          results.push({
            id: tx.Id,
            type,
            date: tx.TxnDate,
            amount: Math.abs(line.Amount || tx.TotalAmt || 0),
            description: String(description).trim(),
            accountId: accountRef?.value || "",
            accountName: accountRef?.name || (itemName ? `Item: ${itemName}` : "Uncategorized"),
          });
        }
      }
    } catch (e) {
      // Some QBO endpoints don't support all types - skip silently
      console.warn(`Failed to fetch ${type}:`, e);
    }
  }

  return results;
}

// ============== VENDOR GROUPING ==============

/**
 * Group transactions by normalized vendor name.
 * Returns clean groups suitable for rule generation.
 */
export function groupByVendor(
  transactions: VendorTransaction[],
  options: { minTransactions?: number; minTotalAmount?: number } = {}
): VendorGroup[] {
  const { minTransactions = 2, minTotalAmount = 0 } = options;

  const groups = new Map<string, VendorGroup>();

  for (const tx of transactions) {
    const normalized = normalizeVendorName(tx.description);
    if (!normalized) continue;

    let group = groups.get(normalized);
    if (!group) {
      group = {
        vendor_pattern: normalized,
        transaction_count: 0,
        total_amount: 0,
        sample_descriptions: [],
        current_accounts: {},
      };
      groups.set(normalized, group);
    }

    group.transaction_count++;
    group.total_amount += tx.amount;

    if (group.sample_descriptions.length < 5 && !group.sample_descriptions.includes(tx.description)) {
      group.sample_descriptions.push(tx.description);
    }

    group.current_accounts[tx.accountName] = (group.current_accounts[tx.accountName] || 0) + 1;
  }

  // Set primary account + filter
  const filtered: VendorGroup[] = [];
  for (const group of groups.values()) {
    if (group.transaction_count < minTransactions) continue;
    if (group.total_amount < minTotalAmount) continue;

    let max = 0;
    for (const [acct, count] of Object.entries(group.current_accounts)) {
      if (count > max) {
        max = count;
        group.primary_current_account = acct;
      }
    }
    filtered.push(group);
  }

  // Sort by transaction count desc
  filtered.sort((a, b) => b.transaction_count - a.transaction_count);
  return filtered;
}

/**
 * Normalize "SHERWIN-WILLIAMS #4521" and "Sherwin Williams Co" to "SHERWIN WILLIAMS"
 */
function normalizeVendorName(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[#\-_*\/\\.,]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(CO|INC|LLC|LTD|CORP|COMPANY|THE|STORE|#\d+|\d+)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ============== BANK RULE CRUD ==============

/**
 * ⚠ DEPRECATED — DO NOT CALL.
 *
 * QBO's public REST API does NOT support creating bank rules. Intuit
 * documents /bankrule but every POST returns:
 *   {"Fault":{"Error":[{"Message":"Unsupported Operation",
 *    "Detail":"Operation bankrule is not supported.","code":"500"}]}}
 *
 * Bank rules can only be created through the QBO UI by the user.
 *
 * Instead, write bank_rules rows to our local table with
 * status="active". SNAP's daily-recon engine (lib/daily-recon.ts)
 * reads them and applies them to incoming transactions, posting the
 * reclass to QBO via the supported Reclassify endpoint.
 *
 * If you find yourself wanting to call this, see:
 *   - /api/rules/execute       (button-driven activation)
 *   - /api/rules/from-reclass  (auto-creation from cleanup workflow)
 * Both write to bank_rules without touching QBO.
 *
 * This function throws synchronously so any new call site fails loud
 * during development instead of silently re-introducing the bug.
 */
export async function createBankRule(
  _realmId: string,
  _accessToken: string,
  rule: {
    name: string;
    vendorPattern: string;
    matchType: "Contains" | "StartsWith" | "Is";
    targetAccountId: string;
    taxCodeId?: string;
    priority?: number;
  }
): Promise<QBOBankRule> {
  throw new Error(
    `createBankRule() is disabled: QBO's public API does not support /bankrule. ` +
    `Tried to create "${rule.name}" → "${rule.vendorPattern}". ` +
    `Activate the rule locally via /api/rules/execute or /api/rules/from-reclass instead — ` +
    `SNAP's daily-recon engine applies bank rules without QBO's native feature.`
  );
}

export async function listBankRules(realmId: string, accessToken: string): Promise<QBOBankRule[]> {
  const query = encodeURIComponent("SELECT * FROM BankRule MAXRESULTS 1000");
  const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
  return data.QueryResponse?.BankRule || [];
}
