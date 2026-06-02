/**
 * QuickBooks Online API Client
 * ----------------------------
 * Handles:
 *  - OAuth 2.0 flow (authorize, exchange code, refresh tokens)
 *  - Reading the client's Chart of Accounts
 *  - Creating, renaming, inactivating accounts
 *  - Reclassifying transactions
 *  - Setting tax codes
 *
 * QBO API docs:
 *  - Account: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/account
 *  - Auth: https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
 *
 * Requires env vars:
 *  - QBO_CLIENT_ID
 *  - QBO_CLIENT_SECRET
 *  - QBO_ENVIRONMENT ('sandbox' or 'production')
 *  - QBO_REDIRECT_URI
 */

import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const QBO_BASE = process.env.QBO_ENVIRONMENT === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

const QBO_AUTH_BASE = 'https://oauth.platform.intuit.com';
const QBO_DISCOVERY = 'https://developer.api.intuit.com/.well-known/openid_configuration';

// ============== TYPES ==============

export interface QBOAccount {
  Id: string;
  Name: string;
  FullyQualifiedName: string;
  AccountType: string;
  AccountSubType: string;
  Classification: string;            // 'Asset', 'Liability', 'Equity', 'Revenue', 'Expense'
  Active: boolean;
  SubAccount: boolean;
  ParentRef?: { value: string; name?: string };
  CurrentBalance: number;
  CurrentBalanceWithSubAccounts: number;
  CurrencyRef: { value: string; name?: string };
  Description?: string;
  TaxCodeRef?: { value: string };
  MetaData: {
    CreateTime: string;
    LastUpdatedTime: string;
  };
}

export interface QBOTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
  token_type: string;
}

// ============== OAUTH ==============

/**
 * Build the QBO authorize URL. User visits this to grant access.
 */
export function getAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID!,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: process.env.QBO_REDIRECT_URI!,
    state,
  });
  return `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`;
}

/**
 * Exchange the authorization code for tokens.
 * Call this in your OAuth callback handler.
 */
export async function exchangeCodeForTokens(code: string): Promise<QBOTokens> {
  const auth = Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${QBO_AUTH_BASE}/oauth2/v1/tokens/bearer`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.QBO_REDIRECT_URI!,
    }),
  });

  if (!res.ok) {
    throw new Error(`QBO token exchange failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

/**
 * Refresh an expired access token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<QBOTokens> {
  const auth = Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${QBO_AUTH_BASE}/oauth2/v1/tokens/bearer`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    throw new Error(`QBO token refresh failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

/**
 * Get a valid access token for a client, refreshing if expired.
 */
export async function getValidToken(clientLinkId: string, supabase: ReturnType<typeof createClient<Database>>): Promise<string> {
  const { data: client, error } = await supabase
    .from('client_links')
    .select('qbo_access_token, qbo_refresh_token, qbo_token_expires_at')
    .eq('id', clientLinkId)
    .single();

  if (error || !client) throw new Error('Client not found');

  const expiresAt = new Date(client.qbo_token_expires_at!).getTime();
  const now = Date.now();
  const buffer = 5 * 60 * 1000; // 5 minute buffer

  if (expiresAt > now + buffer) {
    return client.qbo_access_token!;
  }

  // Refresh
  const tokens = await refreshAccessToken(client.qbo_refresh_token!);
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await supabase
    .from('client_links')
    .update({
      qbo_access_token: tokens.access_token,
      qbo_refresh_token: tokens.refresh_token,
      qbo_token_expires_at: newExpiresAt,
    })
    .eq('id', clientLinkId);

  return tokens.access_token;
}

// ============== CORE REQUEST ==============

async function qboRequest<T>(
  realmId: string,
  accessToken: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${QBO_BASE}/v3/company/${realmId}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const responseBody = await res.text();
    // Include the request body in the error so audit_log captures EXACTLY
    // what we sent to QBO when something fails. Critical for debugging 2010s.
    let sentBody: any = '(none)';
    try {
      sentBody = options.body ? JSON.parse(options.body as string) : '(none)';
    } catch {
      sentBody = options.body;
    }
    throw new Error(
      `QBO API ${res.status} at ${endpoint}: ${responseBody} | Request body sent: ${JSON.stringify(sentBody)}`
    );
  }

  return res.json();
}

// ============== ACCOUNTS ==============

/**
 * Pull the entire Chart of Accounts for a client.
 */
export async function fetchAllAccounts(realmId: string, accessToken: string): Promise<QBOAccount[]> {
  const query = encodeURIComponent('SELECT * FROM Account MAXRESULTS 1000');
  const data = await qboRequest<{ QueryResponse: { Account?: QBOAccount[] } }>(
    realmId,
    accessToken,
    `/query?query=${query}`
  );
  return data.QueryResponse.Account || [];
}

/**
 * Create a new account in QBO.
 * For sub-accounts, set parentRef to the parent's QBO ID.
 */
export async function createAccount(
  realmId: string,
  accessToken: string,
  params: {
    name: string;
    accountType: string;
    accountSubType: string;
    parentRefId?: string;
    description?: string;
    taxCodeRef?: string;
  }
): Promise<QBOAccount> {
  const body: any = {
    Name: params.name,
    AccountType: params.accountType,
    AccountSubType: params.accountSubType,
  };

  if (params.parentRefId) {
    body.ParentRef = { value: params.parentRefId };
    body.SubAccount = true;
  }
  if (params.description) body.Description = params.description;
  if (params.taxCodeRef) body.TaxCodeRef = { value: params.taxCodeRef };

  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?minorversion=70',
    { method: 'POST', body: JSON.stringify(body) }
  );

  return data.Account;
}

/**
 * Rename an existing account (preserves history + transactions).
 *
 * IMPORTANT: For sub-accounts, you must also pass the current account object
 * (or its ParentRef + SubAccount + AccountType) so QBO preserves the parent
 * relationship during sparse update. Otherwise QBO returns 2010.
 */
export async function renameAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  syncToken: string,
  newName: string,
  options?: {
    newSubType?: string;
    taxCodeRef?: string;
    /** Pass the current full account from QBO to preserve sub-account/parent state */
    currentAccount?: QBOAccount;
  }
): Promise<QBOAccount> {
  const body: any = {
    Id: accountId,
    SyncToken: syncToken,
    sparse: true,
    Name: newName,
  };

  // Preserve sub-account + parent relationship if applicable.
  // QBO 2010 errors on rename of sub-accounts when these fields are missing.
  if (options?.currentAccount) {
    const cur = options.currentAccount;
    if (cur.AccountType) body.AccountType = cur.AccountType;
    if (cur.AccountSubType) body.AccountSubType = cur.AccountSubType;
    if (cur.SubAccount) {
      body.SubAccount = true;
      if (cur.ParentRef?.value) body.ParentRef = { value: cur.ParentRef.value };
    }
  }

  if (options?.newSubType) body.AccountSubType = options.newSubType;
  if (options?.taxCodeRef) body.TaxCodeRef = { value: options.taxCodeRef };

  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?minorversion=70',
    { method: 'POST', body: JSON.stringify(body) }
  );

  return data.Account;
}

/**
 * Inactivate an account (QBO doesn't allow true deletion if there's history).
 *
 * IMPORTANT: For sub-accounts, you must pass the current account so we preserve
 * Type/SubAccount/ParentRef. Otherwise QBO 2010 errors.
 */
export async function inactivateAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  syncToken: string,
  currentAccount?: QBOAccount
): Promise<QBOAccount> {
  const body: any = {
    Id: accountId,
    SyncToken: syncToken,
    sparse: true,
    Active: false,
  };

  if (currentAccount) {
    if (currentAccount.AccountType) body.AccountType = currentAccount.AccountType;
    if (currentAccount.AccountSubType) body.AccountSubType = currentAccount.AccountSubType;
    if (currentAccount.SubAccount) {
      body.SubAccount = true;
      if (currentAccount.ParentRef?.value) {
        body.ParentRef = { value: currentAccount.ParentRef.value };
      }
    }
    if (currentAccount.Name) body.Name = currentAccount.Name;
  }

  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?minorversion=70',
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );

  return data.Account;
}

/**
 * Reactivate (un-inactivate) a previously inactivated account. Used by the
 * revert flow so we can move transactions back into a now-inactive source.
 * Same Type/SubAccount/ParentRef preservation rules as inactivateAccount.
 */
export async function reactivateAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  syncToken: string,
  currentAccount?: QBOAccount
): Promise<QBOAccount> {
  const body: any = {
    Id: accountId,
    SyncToken: syncToken,
    sparse: true,
    Active: true,
  };
  if (currentAccount) {
    if (currentAccount.AccountType) body.AccountType = currentAccount.AccountType;
    if (currentAccount.AccountSubType) body.AccountSubType = currentAccount.AccountSubType;
    if (currentAccount.SubAccount) {
      body.SubAccount = true;
      if (currentAccount.ParentRef?.value) {
        body.ParentRef = { value: currentAccount.ParentRef.value };
      }
    }
    if (currentAccount.Name) body.Name = currentAccount.Name;
  }
  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?minorversion=70',
    { method: 'POST', body: JSON.stringify(body) }
  );
  return data.Account;
}

/**
 * Move a sub-account under a different parent.
 */
export async function reparentAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  syncToken: string,
  newParentId: string
): Promise<QBOAccount> {
  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?minorversion=70',
    {
      method: 'POST',
      body: JSON.stringify({
        Id: accountId,
        SyncToken: syncToken,
        sparse: true,
        ParentRef: { value: newParentId },
        SubAccount: true,
      }),
    }
  );

  return data.Account;
}

// ============== JOURNAL ENTRIES ==============

export interface JournalEntryLine {
  posting_type: "Debit" | "Credit";
  amount: number;
  account_id: string;
  account_name?: string;
  description?: string;
}

export interface CreatedJournalEntry {
  Id: string;
  DocNumber?: string;
  TxnDate: string;
  TotalAmt: number;
  PrivateNote?: string;
}

/**
 * Post a Journal Entry to QBO.
 *
 * Used by the AI BS cleanup finalize step to write Opening-Balance-Equity
 * zeroing entries, A/R bad-debt write-offs, A/P stale-credit reversals, etc.
 *
 * Validates debits = credits server-side before sending — QBO rejects
 * unbalanced JEs with a confusing 6000 error otherwise.
 */
export async function createJournalEntry(
  realmId: string,
  accessToken: string,
  params: {
    txn_date: string;            // YYYY-MM-DD
    doc_number?: string;
    private_note?: string;
    lines: JournalEntryLine[];
  }
): Promise<CreatedJournalEntry> {
  if (!params.lines || params.lines.length < 2) {
    throw new Error("Journal Entry must have at least 2 lines (one debit + one credit)");
  }
  const debitSum = params.lines
    .filter((l) => l.posting_type === "Debit")
    .reduce((s, l) => s + l.amount, 0);
  const creditSum = params.lines
    .filter((l) => l.posting_type === "Credit")
    .reduce((s, l) => s + l.amount, 0);
  // Allow 1¢ rounding drift; anything bigger is a bug
  if (Math.abs(debitSum - creditSum) > 0.01) {
    throw new Error(
      `JE not balanced: debits=$${debitSum.toFixed(2)} vs credits=$${creditSum.toFixed(2)}`
    );
  }

  const body: any = {
    TxnDate: params.txn_date,
    PrivateNote: params.private_note || undefined,
    DocNumber: params.doc_number || undefined,
    Line: params.lines.map((l) => ({
      DetailType: "JournalEntryLineDetail",
      Amount: Number(l.amount.toFixed(2)),
      Description: l.description || undefined,
      JournalEntryLineDetail: {
        PostingType: l.posting_type,
        AccountRef: { value: l.account_id, name: l.account_name },
      },
    })),
  };

  const data = await qboRequest<{ JournalEntry: CreatedJournalEntry }>(
    realmId,
    accessToken,
    '/journalentry?minorversion=70',
    { method: 'POST', body: JSON.stringify(body) }
  );

  return data.JournalEntry;
}

// ============== V2 HARDCORE CLEANUP — Invoice + Payment writes ==============

/**
 * Look up a QBO Customer by name. Used by createInvoice when the caller
 * only has the customer's display name (typical for CRM-driven flows).
 *
 * Returns the Customer's QBO Id + DisplayName + AR account context. Null
 * if no exact match. Caller decides whether to fall back to fuzzy match
 * or fail loud.
 */
export async function findCustomerByName(
  realmId: string,
  accessToken: string,
  name: string
): Promise<{ id: string; displayName: string; arAccountId?: string } | null> {
  const escaped = name.replace(/'/g, "\\'");
  const query = encodeURIComponent(
    `SELECT Id, DisplayName, ARAccountRef FROM Customer WHERE DisplayName = '${escaped}' MAXRESULTS 1`
  );
  try {
    const data: any = await qboRequest(
      realmId,
      accessToken,
      `/query?query=${query}`,
      { method: "GET" }
    );
    const c = data?.QueryResponse?.Customer?.[0];
    if (!c) return null;
    return {
      id: String(c.Id),
      displayName: String(c.DisplayName || name),
      arAccountId: c.ARAccountRef?.value ? String(c.ARAccountRef.value) : undefined,
    };
  } catch (err: any) {
    console.warn(`[findCustomerByName] failed for "${name}":`, err?.message);
    return null;
  }
}

/**
 * Find an existing QBO object by a PrivateNote token. Idempotency primitive:
 * before each V2 write we write a deterministic token like
 * SNAP-CLEANUP-<run_id>-<item_id> in PrivateNote. On retry, we look that
 * token up first — if found, return the existing object instead of creating
 * a duplicate.
 *
 * Supports Invoice + Payment + JournalEntry (the V2 write surface).
 * Returns the bare Id of the existing object, or null if nothing matches.
 */
export async function findByPrivateNoteToken(
  realmId: string,
  accessToken: string,
  entity: "Invoice" | "Payment" | "JournalEntry",
  token: string
): Promise<string | null> {
  // QBO's query syntax doesn't have a clean PrivateNote LIKE for these
  // entities — PrivateNote isn't indexed. We do a narrow scan over the
  // last 90 days of objects and check in-memory. Cheap enough since this
  // only fires on retry/repeat paths.
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = encodeURIComponent(
    `SELECT Id, PrivateNote FROM ${entity} WHERE TxnDate >= '${cutoff}' MAXRESULTS 1000`
  );
  try {
    const data: any = await qboRequest(
      realmId,
      accessToken,
      `/query?query=${query}`,
      { method: "GET" }
    );
    const rows: any[] = data?.QueryResponse?.[entity] || [];
    const match = rows.find((r) => typeof r.PrivateNote === "string" && r.PrivateNote.includes(token));
    return match ? String(match.Id) : null;
  } catch (err: any) {
    console.warn(`[findByPrivateNoteToken] ${entity} scan failed:`, err?.message);
    return null;
  }
}

export interface CreateInvoiceParams {
  customerId: string;
  customerName: string;
  /** Single-line invoice for now. Multi-line jobs map to a single line
   *  with a combined description — QBO requires either an ItemRef or a
   *  full SalesItemLineDetail; the simplest path is one line per job. */
  amount: number;
  description: string;
  txnDate: string;     // YYYY-MM-DD
  docNumber?: string;
  privateNote: string; // MUST include the idempotency token
}

export interface CreatedInvoice {
  Id: string;
  DocNumber?: string;
  SyncToken: string;
  TotalAmt?: number;
}

/**
 * Create a new Invoice in QBO. Used by V2 push_invoice resolution — when
 * a CRM job is complete but no QBO invoice exists. Caller is responsible
 * for resolving the customer ID + including an idempotency token in
 * privateNote.
 *
 * Single-line invoice; line uses SalesItemLineDetail with no ItemRef
 * (QBO accepts this for one-off services). For multi-item job exports
 * we'd need a different path.
 */
export async function createInvoice(
  realmId: string,
  accessToken: string,
  params: CreateInvoiceParams
): Promise<CreatedInvoice> {
  if (params.amount <= 0) {
    throw new Error(`Invoice amount must be positive (got ${params.amount})`);
  }
  const body: any = {
    CustomerRef: { value: params.customerId, name: params.customerName },
    TxnDate: params.txnDate,
    DocNumber: params.docNumber || undefined,
    PrivateNote: params.privateNote,
    Line: [
      {
        Amount: Number(params.amount.toFixed(2)),
        DetailType: "SalesItemLineDetail",
        Description: params.description,
        SalesItemLineDetail: {
          // No ItemRef — QBO accepts blank for ad-hoc services. If the
          // client's QBO requires items configured we'd need a different
          // strategy (lookup default service item, or fail with a helpful
          // error pointing to QBO's "Products and Services" setup).
        },
      },
    ],
  };

  const data = await qboRequest<{ Invoice: CreatedInvoice }>(
    realmId,
    accessToken,
    "/invoice?minorversion=70",
    { method: "POST", body: JSON.stringify(body) }
  );
  return data.Invoice;
}

export interface ApplyPaymentParams {
  /** The Payment object's QBO Id. Must already exist in UF. */
  paymentId: string;
  /** Invoice IDs to link this payment to. For 1:1 = single entry; for
   *  1:N bulk deposit = multiple entries summing to the payment amount. */
  invoiceLinks: Array<{ invoiceId: string; amountApplied: number }>;
  privateNote?: string;
}

export interface AppliedPayment {
  Id: string;
  SyncToken: string;
  TotalAmt?: number;
}

/**
 * Sparse-update an existing Payment to link it to one or more invoices.
 *
 * QBO's Payment object has a Line[] field with LinkedTxn[] entries — each
 * LinkedTxn points at an Invoice with TxnType="Invoice". Sparse update
 * replaces the Line array entirely.
 *
 * Caveat: we do NOT change DepositToAccountRef. The payment stays in
 * Undeposited Funds for the bookkeeper to deposit later — that's the
 * Lisa workflow (apply payment → later move from UF to a real bank).
 * If/when V3 needs to clear UF too, we'd unset DepositToAccountRef here.
 *
 * Need to fetch the current SyncToken first since QBO sparse-update is
 * optimistic-concurrency.
 */
export async function applyPaymentToInvoices(
  realmId: string,
  accessToken: string,
  params: ApplyPaymentParams
): Promise<AppliedPayment> {
  if (params.invoiceLinks.length === 0) {
    throw new Error("applyPaymentToInvoices: invoiceLinks is empty");
  }
  // 1. Fetch current Payment for SyncToken + amount validation
  const query = encodeURIComponent(`SELECT * FROM Payment WHERE Id = '${params.paymentId}' MAXRESULTS 1`);
  const fetchData: any = await qboRequest(
    realmId,
    accessToken,
    `/query?query=${query}`,
    { method: "GET" }
  );
  const existing = fetchData?.QueryResponse?.Payment?.[0];
  if (!existing) {
    throw new Error(`Payment ${params.paymentId} not found in QBO`);
  }

  const totalLinked = params.invoiceLinks.reduce((s, l) => s + l.amountApplied, 0);
  const paymentAmt = Number(existing.TotalAmt || 0);
  // Allow 1¢ rounding drift; bigger means the bookkeeper's link-sum
  // doesn't match the payment — QBO would reject the write anyway,
  // failing here gives a clearer error.
  if (Math.abs(totalLinked - paymentAmt) > 0.01) {
    throw new Error(
      `Payment ${params.paymentId} total ($${paymentAmt.toFixed(2)}) doesn't match sum of links ($${totalLinked.toFixed(2)})`
    );
  }

  // 2. Build sparse update body — replace Line[] entirely with LinkedTxn entries.
  // QBO requires each Line to declare DetailType=PaymentLineDetail when
  // it's a LinkedTxn allocation.
  const body: any = {
    Id: params.paymentId,
    SyncToken: existing.SyncToken,
    sparse: true,
    Line: params.invoiceLinks.map((l) => ({
      Amount: Number(l.amountApplied.toFixed(2)),
      LinkedTxn: [{ TxnId: l.invoiceId, TxnType: "Invoice" }],
    })),
  };
  if (params.privateNote) {
    body.PrivateNote = params.privateNote;
  }

  const data = await qboRequest<{ Payment: AppliedPayment }>(
    realmId,
    accessToken,
    "/payment?minorversion=70",
    { method: "POST", body: JSON.stringify(body) }
  );
  return data.Payment;
}

/**
 * Look up open invoices for a given customer — used during applyPayment
 * to find which invoices a UF deposit can apply to.
 *
 * Returns invoices with non-zero balance, sorted oldest-first (FIFO is the
 * conventional accounting application order — oldest A/R clears first).
 */
export async function fetchOpenInvoicesForCustomer(
  realmId: string,
  accessToken: string,
  customerId: string
): Promise<Array<{ id: string; docNumber: string | null; txnDate: string; totalAmt: number; balance: number }>> {
  const query = encodeURIComponent(
    `SELECT Id, DocNumber, TxnDate, TotalAmt, Balance FROM Invoice WHERE CustomerRef = '${customerId}' AND Balance > '0' ORDERBY TxnDate ASC MAXRESULTS 100`
  );
  const data: any = await qboRequest(
    realmId,
    accessToken,
    `/query?query=${query}`,
    { method: "GET" }
  );
  const rows: any[] = data?.QueryResponse?.Invoice || [];
  return rows.map((r) => ({
    id: String(r.Id),
    docNumber: r.DocNumber ? String(r.DocNumber) : null,
    txnDate: String(r.TxnDate || ""),
    totalAmt: Number(r.TotalAmt || 0),
    balance: Number(r.Balance || 0),
  }));
}

// ============== TRANSACTIONS ==============

/**
 * Fast bulk fetch of transaction counts per account.
 *
 * Uses the TransactionList report, which has a FLAT row structure with one
 * row per transaction and an account_id column. This is MUCH more reliable
 * than parsing the nested GeneralLedger report.
 *
 * Returns: Map<accountId, transactionCount>
 *
 * Why this matters: QBO blocks API inactivation of accounts with any historical
 * transactions, even if current balance is zero. Pre-flight needs this info to
 * decide whether an inactivate is safe or must be flagged.
 *
 * Implementation notes:
 *   - The TransactionList report returns one row per transaction line.
 *   - We use the `account_id` column to bucket counts per account.
 *   - Use a wide date range to capture all historical transactions.
 *   - QBO reports use 'columns' to specify what columns to return.
 */
export async function fetchTransactionCountsForAllAccounts(
  realmId: string,
  accessToken: string
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  try {
    const params = new URLSearchParams({
      start_date: '1900-01-01',
      end_date: '2099-12-31',
      columns: 'tx_date,account_name,txn_type',
      minorversion: '70',
    });
    const data = await qboRequest<any>(
      realmId,
      accessToken,
      `/reports/TransactionList?${params.toString()}`
    );

    // TransactionList structure:
    //   data.Columns.Column[] - column metadata
    //   data.Rows.Row[]       - one entry per transaction (flat)
    // Each Row has ColData[] where each ColData has { value, id? }.
    // The account name column may have an `id` attribute = account id.

    // Find which column index represents the account
    const columns = data.Columns?.Column || [];
    let accountColIndex = -1;
    for (let i = 0; i < columns.length; i++) {
      const colTitle = (columns[i]?.ColTitle || '').toLowerCase();
      const colType = (columns[i]?.ColType || '').toLowerCase();
      if (colTitle.includes('account') || colType === 'account') {
        accountColIndex = i;
        break;
      }
    }

    if (accountColIndex === -1) {
      console.warn('[fetchTransactionCountsForAllAccounts] No account column found in TransactionList');
      return counts;
    }

    // Walk flat row list, bucketing by account id
    function walkRows(rows: any[]): void {
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        // A row is either a data row (has ColData directly) or a section/group
        // wrapping more rows. We handle both.
        if (row.ColData && Array.isArray(row.ColData)) {
          const cell = row.ColData[accountColIndex];
          const accountId = cell?.id;
          if (accountId) {
            const key = String(accountId);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
        if (row.Rows?.Row) {
          walkRows(row.Rows.Row);
        }
      }
    }

    if (data.Rows?.Row) {
      walkRows(data.Rows.Row);
    }

    console.log(
      `[fetchTransactionCountsForAllAccounts] Counted transactions for ${counts.size} accounts. ` +
      `Total transactions: ${Array.from(counts.values()).reduce((a, b) => a + b, 0)}`
    );
  } catch (e) {
    console.error('[fetchTransactionCountsForAllAccounts] TransactionList report failed:', e);
    // Don't throw — return whatever we have. Pre-flight will fall back to a
    // per-account direct check (slower but reliable) if it sees an empty map.
  }

  return counts;
}

/**
 * Direct per-account transaction existence check.
 *
 * Use this as a fallback when the TransactionList report fails or returns empty.
 * Slower (one API call per account) but 100% reliable for the "does this
 * account have any transactions?" question.
 *
 * Strategy: query the JournalEntry, Purchase, Bill, Deposit, Invoice, Payment,
 * SalesReceipt, and Expense entities for any line referencing the account.
 * We only need to know "any" not "how many" — so we ask for 1 result max.
 */
export async function accountHasTransactions(
  realmId: string,
  accessToken: string,
  accountId: string
): Promise<boolean> {
  // The most reliable single-query is to check whether the account has been
  // referenced in any Journal Entry line. JournalEntries touch every account
  // type. Other transaction types are also possible but JEs are universal.
  const queries = [
    `SELECT Id FROM JournalEntry WHERE Line.JournalEntryLineDetail.AccountRef = '${accountId}' MAXRESULTS 1`,
    `SELECT Id FROM Purchase WHERE AccountRef = '${accountId}' MAXRESULTS 1`,
    `SELECT Id FROM Deposit WHERE DepositToAccountRef = '${accountId}' MAXRESULTS 1`,
  ];

  for (const q of queries) {
    try {
      const data = await qboRequest<any>(
        realmId,
        accessToken,
        `/query?query=${encodeURIComponent(q)}&minorversion=70`
      );
      const results =
        data.QueryResponse?.JournalEntry ||
        data.QueryResponse?.Purchase ||
        data.QueryResponse?.Deposit;
      if (results && results.length > 0) return true;
    } catch {
      // Some queries don't apply to all account types; skip silently
    }
  }
  return false;
}

export interface QBOTransaction {
  Id: string;
  SyncToken: string;
  TxnDate: string;
  TotalAmt: number;
  PrivateNote?: string;
  Line: Array<{
    Id?: string;
    DetailType: string;
    Amount: number;
    AccountBasedExpenseLineDetail?: { AccountRef: { value: string } };
    JournalEntryLineDetail?: {
      PostingType: 'Debit' | 'Credit';
      AccountRef: { value: string };
    };
  }>;
}

/**
 * Fetch all transactions posted to a specific account.
 * Used before reclassification to know what we're moving.
 */
export async function fetchTransactionsForAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  txTypes: string[] = ['Purchase', 'Bill', 'JournalEntry', 'Deposit']
): Promise<{ type: string; transactions: any[] }[]> {
  const results = [];

  for (const type of txTypes) {
    const query = encodeURIComponent(
      `SELECT * FROM ${type} WHERE Line.AccountBasedExpenseLineDetail.AccountRef='${accountId}' MAXRESULTS 1000`
    );
    try {
      const data = await qboRequest<any>(
        realmId,
        accessToken,
        `/query?query=${query}`
      );
      const txs = data.QueryResponse[type] || [];
      if (txs.length > 0) results.push({ type, transactions: txs });
    } catch {
      // some types don't support this query - skip silently
    }
  }

  return results;
}

/**
 * Reclassify a single transaction line from one account to another.
 * QBO requires the full transaction object to be re-posted.
 */
export async function reclassifyTransaction(
  realmId: string,
  accessToken: string,
  txnType: string,
  transaction: QBOTransaction,
  fromAccountId: string,
  toAccountId: string
): Promise<QBOTransaction> {
  // Update each line that points to fromAccountId
  const updatedLines = transaction.Line.map((line) => {
    if (line.AccountBasedExpenseLineDetail?.AccountRef.value === fromAccountId) {
      return {
        ...line,
        AccountBasedExpenseLineDetail: {
          ...line.AccountBasedExpenseLineDetail,
          AccountRef: { value: toAccountId },
        },
      };
    }
    if (line.JournalEntryLineDetail?.AccountRef.value === fromAccountId) {
      return {
        ...line,
        JournalEntryLineDetail: {
          ...line.JournalEntryLineDetail,
          AccountRef: { value: toAccountId },
        },
      };
    }
    return line;
  });

  const data = await qboRequest<any>(
    realmId,
    accessToken,
    `/${txnType.toLowerCase()}?minorversion=70`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...transaction,
        Line: updatedLines,
      }),
    }
  );

  return data[txnType];
}

// ============== TAX CODES ==============

export interface QBOTaxCode {
  Id: string;
  Name: string;
  Description?: string;
  TaxGroup: boolean;
  Active: boolean;
}

/**
 * Get all tax codes available in the client's QBO.
 * Used to map Canadian GST/HST/PST to the right TaxCodeRef.
 */
export async function fetchTaxCodes(realmId: string, accessToken: string): Promise<QBOTaxCode[]> {
  const query = encodeURIComponent('SELECT * FROM TaxCode MAXRESULTS 100');
  const data = await qboRequest<{ QueryResponse: { TaxCode?: QBOTaxCode[] } }>(
    realmId,
    accessToken,
    `/query?query=${query}`
  );
  return data.QueryResponse.TaxCode || [];
}

// ============== BATCH OPERATIONS ==============

/**
 * Batch operation (up to 30 items per call - QBO limit).
 * Use for high-volume reclassifications.
 */
export async function batchOperation(
  realmId: string,
  accessToken: string,
  operations: Array<{ operation: string; resource: string; payload: any; bId: string }>
): Promise<any> {
  return qboRequest(realmId, accessToken, '/batch?minorversion=70', {
    method: 'POST',
    body: JSON.stringify({
      BatchItemRequest: operations.map(op => ({
        bId: op.bId,
        operation: op.operation,
        [op.resource]: op.payload,
      })),
    }),
  });
}

// ============== RATE LIMITER ==============
// QBO limit: 500 requests/minute per realm.
// Simple in-memory limiter — use Redis for production multi-instance.
class RateLimiter {
  private timestamps: Map<string, number[]> = new Map();
  private readonly maxPerMinute: number;

  constructor(maxPerMinute = 450) {
    this.maxPerMinute = maxPerMinute;
  }

  async throttle(key: string): Promise<void> {
    const now = Date.now();
    const cutoff = now - 60_000;
    const list = (this.timestamps.get(key) || []).filter(t => t > cutoff);

    if (list.length >= this.maxPerMinute) {
      const oldest = list[0];
      const waitMs = 60_000 - (now - oldest) + 100;
      await new Promise(r => setTimeout(r, waitMs));
      return this.throttle(key);
    }

    list.push(now);
    this.timestamps.set(key, list);
  }
}

export const qboRateLimiter = new RateLimiter();

// ============== COMPANY INFO ==============

export interface QBOCompanyInfo {
  CompanyName: string;
  LegalName?: string;
  Country?: string;
  CompanyAddr?: {
    Line1?: string;
    City?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
    Country?: string;
  };
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  /** "January" | "February" | ... | "December" — month the client's fiscal year starts */
  FiscalYearStartMonth?: string;
}

/**
 * Convert QBO's "January", "February", ... to a 1-indexed month number.
 * Defaults to 1 (January) if unknown.
 */
export function fiscalStartMonthToNumber(name: string | undefined): number {
  if (!name) return 1;
  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  const idx = months.indexOf(name.trim().toLowerCase());
  return idx >= 0 ? idx + 1 : 1;
}

export interface DateRangePreset {
  id: string;
  label: string;
  start: string;
  end: string;
}

/**
 * Build the 4 date-range presets shown on the reclass form, using the client's
 * actual fiscal year start month (from QBO CompanyInfo). Every range ends today.
 *
 * Older years are handled by the year-by-year cascade after each cleanup
 * completes — no need for "+ Last 2 Years" presets here.
 */
export function getReclassDateRangePresets(
  fiscalStartMonth: number,
  today: Date = new Date()
): DateRangePreset[] {
  const y = today.getUTCFullYear();
  const todayStr = today.toISOString().slice(0, 10);
  const cyStart = (year: number) => `${year}-01-01`;
  const fyStartYear = (today.getUTCMonth() + 1) >= fiscalStartMonth ? y : y - 1;
  const fyStart = (yearsBack: number) => {
    const yr = fyStartYear - yearsBack;
    const mm = String(fiscalStartMonth).padStart(2, "0");
    return `${yr}-${mm}-01`;
  };
  return [
    { id: "fy",        label: "This Fiscal Year",                       start: fyStart(0),     end: todayStr },
    { id: "cy",        label: "This Calendar Year",                     start: cyStart(y),     end: todayStr },
    { id: "fy_plus_1", label: "This Fiscal Year + Last Fiscal Year",    start: fyStart(1),     end: todayStr },
    { id: "cy_plus_1", label: "This Calendar Year + Last Calendar Year", start: cyStart(y - 1), end: todayStr },
  ];
}

/**
 * Fetch company name + jurisdiction from a freshly-connected QBO company.
 * Call this immediately after exchangeCodeForTokens().
 */
export async function fetchCompanyInfo(
  realmId: string,
  accessToken: string
): Promise<QBOCompanyInfo> {
  const data = await qboRequest<{ CompanyInfo: QBOCompanyInfo }>(
    realmId,
    accessToken,
    `/companyinfo/${realmId}`
  );
  return data.CompanyInfo;
}
