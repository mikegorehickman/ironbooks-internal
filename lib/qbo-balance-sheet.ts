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

  const NON_LOAN_LIABILITY_SUBTYPES = new Set([
    "SalesTaxPayable",
    "PayrollClearing",
    "PayrollTaxPayable",
    "GSTPayable",
    "HSTPayable",
    "PSTPayable",
    "QSTPayable",
    "TrustAccountsLiabilities",
    "DepositsBookedAsCurrentLiabilities",
    "UnearnedRevenue",
    "ProvisionForObligations",
    "AccruedLiabilities",
    "ShareholderNotesPayable",  // tracked separately; not a bank loan
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
 * QBO doesn't have a direct "find UF payments" endpoint, so we query
 * Payments with DepositToAccountRef pointing at the UF account.
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
      `SELECT * FROM Payment WHERE DepositToAccountRef = '${ufAccountId}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
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
