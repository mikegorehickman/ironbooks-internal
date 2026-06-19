/**
 * QBO data fetchers for Balance Sheet cleanup workflows.
 *
 *   - listBalanceSheetAccounts: bank / credit card / loan accounts with
 *     last-4 digits, for the account-picker page.
 *   - fetchUndepositedFundsPayments: every Payment sitting in
 *     Undeposited Funds, with customer + amount + date + memo + any
 *     linked invoice reference.
 *   - fetchOpenInvoices: every Invoice with a non-zero balance, used
 *     as the right-hand side of the UF → A/R matcher.
 */

import { qboRateLimiter } from "./qbo";
import { isDemoRealm, demoBalancesAsOf } from "./demo-data";

const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";

async function qboRequest<T>(
  realmId: string,
  accessToken: string,
  endpoint: string
): Promise<T> {
  await qboRateLimiter.throttle(realmId);
  const url = `${QBO_BASE}/${realmId}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO API ${res.status} on ${endpoint}: ${body}`);
  }
  return res.json();
}

// ───── Account types we care about for BS cleanup ─────
// (QBO AccountType strings, not Ironbooks aliases.)
export const BS_ACCOUNT_TYPES = [
  "Bank",
  "Credit Card",
  "Long Term Liability",
  "Other Current Liability",
] as const;

export type BSAccountKind = "bank" | "credit_card" | "loan";

export interface BSAccount {
  qbo_account_id: string;
  name: string;
  account_type: string;       // raw QBO AccountType
  account_subtype: string | null;
  kind: BSAccountKind;
  last4: string | null;       // parsed from AcctNum if present
  current_balance: number;
  currency: string | null;
  is_active: boolean;
}

function deriveKind(accountType: string, subType: string | null | undefined): BSAccountKind {
  if (accountType === "Bank") return "bank";
  if (accountType === "Credit Card") return "credit_card";
  // Both LongTermLiability and OtherCurrentLiability are loan-shaped.
  // Filter on subtype to exclude things like SalesTaxPayable / PayrollLiabilities
  // (those have their own subtypes).
  if (
    accountType === "Long Term Liability" ||
    accountType === "Other Current Liability"
  ) {
    return "loan";
  }
  return "bank"; // default fallback — caller should filter
}

function parseLast4(acctNum: string | null | undefined): string | null {
  if (!acctNum) return null;
  // QBO stores AcctNum as the full account number (sometimes); we
  // surface only the last 4 to the bookkeeper to disambiguate.
  const digits = String(acctNum).replace(/\D/g, "");
  if (digits.length === 0) return null;
  return digits.length <= 4 ? digits : digits.slice(-4);
}

/**
 * List bank / credit-card / loan accounts on the client's COA. Loans
 * include Long Term Liability and Other Current Liability minus the
 * subtypes that aren't actually loans (sales tax, payroll, etc.).
 */
export async function listBalanceSheetAccounts(
  realmId: string,
  accessToken: string
): Promise<BSAccount[]> {
  // Single COA fetch — small enough for one request.
  const query = encodeURIComponent(
    `SELECT * FROM Account MAXRESULTS 1000`
  );
  const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
  const all: any[] = data?.QueryResponse?.Account || [];

  // Aggressive exclusion list. Anything tax-payable, suspense, deferred-
  // revenue, payroll-clearing, or accrued is NOT a "loan" the bookkeeper
  // reconciles against a lender statement. Without this filter the
  // landing page surfaces noise like "GST/HST Payable" with no statement
  // to reconcile against.
  const NON_LOAN_LIABILITY_SUBTYPES = new Set([
    // Sales tax (US + international variations)
    "SalesTaxPayable",
    "GlobalTaxPayable",
    "GlobalTaxSuspense",
    "GSTPayable",
    "HSTPayable",
    "PSTPayable",
    "QSTPayable",
    "VATPayable",
    "VATControl",
    "VATSuspense",
    // Payroll-related liabilities
    "PayrollClearing",
    "PayrollTaxPayable",
    "PayrollLiabilities",
    "FederalIncomeTaxPayable",
    "StateLocalIncomeTaxPayable",
    "WorkersCompensationPayable",
    // Deferred / accrued / suspense
    "DeferredRevenue",
    "UnearnedRevenue",
    "DepositsBookedAsCurrentLiabilities",
    "AccruedLiabilities",
    "AccruedHolidayPayable",
    "AccruedNonCurrentLiabilities",
    "ProvisionForObligations",
    "OtherCurrentLiabilities",   // catch-all; usually accruals
    "TrustAccountsLiabilities",
    // Shareholder / related-party (tracked elsewhere)
    "ShareholderNotesPayable",
    // Generic "other" buckets that aren't lender debt
    "OtherLongTermLiabilities",
  ]);

  return all
    .filter((a: any) => {
      if (a.Active === false) return false;
      if (!BS_ACCOUNT_TYPES.includes(a.AccountType)) return false;
      if (
        (a.AccountType === "Long Term Liability" ||
          a.AccountType === "Other Current Liability") &&
        a.AccountSubType &&
        NON_LOAN_LIABILITY_SUBTYPES.has(a.AccountSubType)
      ) {
        return false;
      }
      return true;
    })
    .map((a: any) => ({
      qbo_account_id: a.Id,
      name: a.Name,
      account_type: a.AccountType,
      account_subtype: a.AccountSubType || null,
      kind: deriveKind(a.AccountType, a.AccountSubType),
      last4: parseLast4(a.AcctNum),
      current_balance: Number(a.CurrentBalance || 0),
      currency: a.CurrencyRef?.value || null,
      is_active: a.Active !== false,
    }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Pull per-account balances as of a specific date via QBO's
 * BalanceSheet report. The report's leaf rows include both the QBO
 * account_id and the dollar balance at the requested date — exactly
 * what reconciliation needs (you can't reconcile a month-old statement
 * against today's QBO ledger).
 *
 * Returns Map<qbo_account_id, balance>. Missing accounts (e.g. zero
 * balance + suppressed from the report) default to 0 at the caller.
 */
export async function fetchBalancesAsOf(
  realmId: string,
  accessToken: string,
  asOfDate: string
): Promise<Map<string, number>> {
  if (isDemoRealm(realmId)) return demoBalancesAsOf();
  const url = `/reports/BalanceSheet?date=${encodeURIComponent(asOfDate)}&accounting_method=Accrual`;
  let data: any;
  try {
    data = await qboRequest<any>(realmId, accessToken, url);
  } catch (err: any) {
    console.warn(`[qbo-balance-sheet] BalanceSheet report failed for ${asOfDate}:`, err.message);
    return new Map();
  }

  const balances = new Map<string, number>();

  // Walk the nested Rows tree. Leaf rows are `type: 'Data'` with
  // `ColData: [{ value: <name>, id: <accountId> }, { value: <number> }]`.
  function walk(node: any) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (node.type === "Data" && node.ColData) {
      const cols = node.ColData;
      const idCol = cols.find((c: any) => c && c.id);
      const amountCol = cols[cols.length - 1];
      if (idCol && amountCol && amountCol.value != null) {
        const amount = Number(String(amountCol.value).replace(/,/g, ""));
        if (Number.isFinite(amount)) {
          balances.set(String(idCol.id), amount);
        }
      }
    }
    if (node.Row) walk(node.Row);
    if (node.Rows) walk(node.Rows);
  }

  walk(data?.Rows);
  return balances;
}

/**
 * Pull every QBO transaction that hits a given account over a date
 * window. Used by the gap analyzer to find likely duplicates / outliers
 * causing a reconciliation gap.
 *
 * QBO doesn't have a clean "all transactions for an account" endpoint;
 * the closest is the TransactionList report, which returns a flattened
 * row per posting line. We use that and pull the columns we need.
 */
export interface AccountTransaction {
  txn_id: string;
  txn_type: string;
  date: string;
  doc_number: string | null;
  customer_or_vendor: string | null;
  memo: string;
  amount: number;        // positive = credit, negative = debit (varies by account type)
  /** Signed delta to the account's balance. We compute via debit/credit columns. */
  delta: number;
  cleared: boolean;
}

export async function fetchAccountTransactions(
  realmId: string,
  accessToken: string,
  qboAccountId: string,
  startDate: string,
  endDate: string
): Promise<AccountTransaction[]> {
  const url = `/reports/TransactionList?account=${encodeURIComponent(qboAccountId)}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&columns=tx_date,txn_type,doc_num,name,memo,subt_nat_amount,subt_nat_home_amount,is_cleared&minorversion=70`;
  let data: any;
  try {
    data = await qboRequest<any>(realmId, accessToken, url);
  } catch (err: any) {
    console.warn(`[qbo-balance-sheet] TransactionList failed:`, err.message);
    return [];
  }

  const cols: any[] = data?.Columns?.Column || [];
  const colIndex = new Map<string, number>();
  cols.forEach((c, i) => {
    const key = c?.ColTitle || c?.ColType;
    if (key) colIndex.set(String(key).toLowerCase(), i);
  });
  function pick(row: any[], names: string[]): any {
    for (const n of names) {
      const i = colIndex.get(n.toLowerCase());
      if (i !== undefined && row[i] != null) return row[i];
    }
    return null;
  }

  const out: AccountTransaction[] = [];
  function walk(node: any) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (node.type === "Data" && node.ColData) {
      const row = node.ColData.map((c: any) => c?.value ?? "");
      const idRef = node.ColData.find((c: any) => c?.id);
      const dateVal = pick(row, ["Date", "tx_date"]);
      const typeVal = pick(row, ["Transaction Type", "txn_type"]);
      const docVal = pick(row, ["Num", "doc_num"]);
      const nameVal = pick(row, ["Name"]);
      const memoVal = pick(row, ["Memo/Description", "Memo"]);
      const amtVal = pick(row, [
        "Amount",
        "subt_nat_amount",
        "subt_nat_home_amount",
      ]);
      const clearedVal = pick(row, ["Clr", "is_cleared"]);

      const amount = Number(String(amtVal || "0").replace(/[,$ ]/g, ""));
      if (!Number.isFinite(amount)) return;

      out.push({
        txn_id: idRef?.id ? String(idRef.id) : "",
        txn_type: String(typeVal || ""),
        date: String(dateVal || ""),
        doc_number: docVal ? String(docVal) : null,
        customer_or_vendor: nameVal ? String(nameVal) : null,
        memo: String(memoVal || ""),
        amount,
        delta: amount,
        cleared: String(clearedVal || "").toLowerCase() === "c",
      });
    }
    if (node.Row) walk(node.Row);
    if (node.Rows) walk(node.Rows);
  }
  walk(data?.Rows);
  return out;
}

// ───── Undeposited Funds ─────

export interface UFPayment {
  qbo_payment_id: string;
  customer_id: string | null;
  customer_name: string | null;
  amount: number;
  date: string;             // YYYY-MM-DD (TxnDate)
  memo: string;
  /** If memo contains an invoice number like "INV-1234" or "#42",
   *  parsed out here for the matcher. */
  invoice_reference: string | null;
  /** True if the Payment already has a LinkedTxn pointing at an
   *  Invoice — meaning the bookkeeper applied it already. We exclude
   *  those from the matcher input. */
  already_applied: boolean;
}

const INVOICE_REF_PATTERNS = [
  /\bINV[\s\-#]?(\d+)/i,
  /\binvoice[\s\-#:]*(\d+)/i,
  /#\s*(\d{2,})/, // bare # followed by 2+ digits
];

function parseInvoiceRef(memo: string | null | undefined): string | null {
  if (!memo) return null;
  for (const re of INVOICE_REF_PATTERNS) {
    const m = memo.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Pull every Payment record that's still sitting in Undeposited Funds.
 *
 * IMPORTANT: QBO does NOT allow filtering Payment by DepositToAccountRef —
 * `SELECT ... FROM Payment WHERE DepositToAccountRef = '24'` returns a 400
 * ("property 'DepositToAccountRef' is not queryable") or a 503 SystemFault,
 * depending on the SELECT clause. So we page through ALL Payments and filter
 * on DepositToAccountRef client-side. The field IS present on each returned
 * Payment object even though it can't appear in a WHERE clause.
 *
 * `ufAccountId` should be the QBO Id of the "Undeposited Funds"
 * account (typically AccountSubType=UndepositedFunds).
 */
export async function fetchUndepositedFundsPayments(
  realmId: string,
  accessToken: string,
  ufAccountId: string
): Promise<UFPayment[]> {
  const results: UFPayment[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const startPosition = page * pageSize + 1;
    const query = encodeURIComponent(
      `SELECT * FROM Payment STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    let data: any;
    try {
      data = await qboRequest<any>(realmId, accessToken, `/query?query=${query}`);
    } catch (err: any) {
      console.warn("[uf-ar] UF Payment query failed:", err.message);
      break;
    }
    const rows: any[] = data?.QueryResponse?.Payment || [];
    for (const p of rows) {
      // Client-side gate: only payments deposited into the UF account.
      if (p.DepositToAccountRef?.value !== ufAccountId) continue;
      const memo = String(p.PrivateNote || "");
      // LinkedTxn at the top level of a Payment = already applied to
      // something (Invoice, JournalEntry, etc.). We filter these out
      // because they're not stranded in UF awaiting matching.
      const linked: any[] = p.Line?.flatMap?.((l: any) => l.LinkedTxn || []) || [];
      const appliedToInvoice = linked.some((l) => l.TxnType === "Invoice");

      results.push({
        qbo_payment_id: p.Id,
        customer_id: p.CustomerRef?.value || null,
        customer_name: p.CustomerRef?.name || null,
        amount: Number(p.TotalAmt || 0),
        date: p.TxnDate,
        memo,
        invoice_reference: parseInvoiceRef(memo) || parseInvoiceRef(p.PaymentRefNum),
        already_applied: appliedToInvoice,
      });
    }
    if (rows.length < pageSize) break;
    page++;
  }
  return results;
}

/**
 * Locate the QBO Undeposited Funds account ID for a realm.
 * Typically there's exactly one; if there are zero we throw so the
 * UI can show "no UF account exists for this client".
 */
export async function findUndepositedFundsAccountId(
  realmId: string,
  accessToken: string
): Promise<string | null> {
  const query = encodeURIComponent(
    `SELECT Id, Name, AccountSubType FROM Account WHERE AccountSubType = 'UndepositedFunds'`
  );
  const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
  const rows: any[] = data?.QueryResponse?.Account || [];
  return rows[0]?.Id || null;
}

// ───── Open A/R Invoices ─────

export interface OpenInvoice {
  qbo_invoice_id: string;
  doc_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  txn_date: string;
  due_date: string | null;
  total_amount: number;
  balance: number;          // outstanding amount
  currency: string | null;
}

/**
 * Pull every Invoice that still has a balance > 0 (i.e. is open / A/R).
 * Pagination handled.
 */
export async function fetchOpenInvoices(
  realmId: string,
  accessToken: string
): Promise<OpenInvoice[]> {
  const results: OpenInvoice[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const startPosition = page * pageSize + 1;
    const query = encodeURIComponent(
      `SELECT * FROM Invoice WHERE Balance > '0' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    let data: any;
    try {
      data = await qboRequest<any>(realmId, accessToken, `/query?query=${query}`);
    } catch (err: any) {
      console.warn("[uf-ar] Open Invoice query failed:", err.message);
      break;
    }
    const rows: any[] = data?.QueryResponse?.Invoice || [];
    for (const inv of rows) {
      results.push({
        qbo_invoice_id: inv.Id,
        doc_number: inv.DocNumber || null,
        customer_id: inv.CustomerRef?.value || null,
        customer_name: inv.CustomerRef?.name || null,
        txn_date: inv.TxnDate,
        due_date: inv.DueDate || null,
        total_amount: Number(inv.TotalAmt || 0),
        balance: Number(inv.Balance || 0),
        currency: inv.CurrencyRef?.value || null,
      });
    }
    if (rows.length < pageSize) break;
    page++;
  }
  return results;
}
