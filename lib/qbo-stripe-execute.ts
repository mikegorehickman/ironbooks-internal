/**
 * QBO Stripe AR Reconciliation — Execution (Phase 2 v2)
 * ──────────────────────────────────────────────────────
 * Rewrites each matched Stripe deposit into a properly decomposed deposit:
 *
 *   POSITIVE LINES (sum to deposit + fee):
 *     • One income line per matched customer/invoice (Painting Revenue,
 *       customer-tagged) for the pre-tax amount
 *     • One aggregated sales tax line (HST Payable / GST Payable etc) for the
 *       total tax collected from customers — Canada only, and only if the
 *       province actually taxes painting services (BC/MB exempt PST on labor)
 *
 *   NEGATIVE LINES (sum to the fee discrepancy):
 *     • Stripe processing fee (pre-tax) → Bank Charges & Fees
 *     • Tax on the Stripe fee (ITC) → HST Receivable / Input Tax Credits
 *       (Canada only)
 *
 *   net = positive_total − negative_total = bank deposit amount
 *
 * QBO Deposit lines don't accept TaxCodeRef directly (it's a banking transaction,
 * not a sales transaction), so tax is recorded by routing aggregate amounts to
 * dedicated tax-payable / tax-recoverable accounts. This matches the canonical
 * CRA / IRS treatment for service contractors processing payments via Stripe.
 *
 * Idempotency: any line starting with [Ironbooks Stripe Recon] is stripped
 * before re-applying — safe to re-run after tweaking fees in the review UI.
 */

import { qboRateLimiter, fetchAllAccounts } from "./qbo";

const QBO_BASE =
  process.env.QBO_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

const IRONBOOKS_TAG = "[Ironbooks Stripe Recon]";

// ─────────── Types ───────────

interface QBODepositLine {
  Id?: string;
  Amount: number;
  Description?: string;
  DetailType: "DepositLineDetail";
  DepositLineDetail: {
    AccountRef: { value: string; name?: string };
    Entity?: { value: string; type?: string; name?: string };
    PaymentMethodRef?: { value: string };
    ClassRef?: { value: string };
  };
}

interface QBODeposit {
  Id: string;
  SyncToken: string;
  TxnDate: string;
  TotalAmt?: number;
  PrivateNote?: string;
  Line: QBODepositLine[];
  DepositToAccountRef?: { value: string; name?: string };
  CurrencyRef?: { value: string };
  sparse?: boolean;
}

export interface ExpenseAccountTargets {
  /** Where Painting Revenue is posted (positive income lines) */
  revenueAccountId: string;
  revenueAccountName: string;
  /** Canada — where sales tax collected from customers is posted (positive) */
  taxPayableAccountId?: string;
  taxPayableAccountName?: string;
  /** Where the Stripe processing fee is expensed (negative) */
  stripeFeeAccountId: string;
  stripeFeeAccountName: string;
  /** Canada — where the ITC on the Stripe fee is posted (negative) */
  taxOnFeeAccountId?: string;
  taxOnFeeAccountName?: string;
}

interface InvoiceLineForExecute {
  invoice_id: string;
  customer_name: string | null;
  pre_tax_amount: number;
  tax_amount: number;
  /** Pre-resolved QBO customer id (set by the Stripe API path so we skip
   *  the findCustomerIdByName round-trip). */
  qbo_customer_id?: string | null;
  /** If set, used verbatim as the deposit-line description suffix instead
   *  of "Invoice {invoice_id}". Set by the Stripe API path to e.g.
   *  "3 Stripe charges · payout po_xxx" so the line isn't misleading. */
  description_label?: string | null;
}

export interface ExecuteMatchInput {
  qbo_deposit_id: string;
  matched_invoices: InvoiceLineForExecute[];
  matched_customer_names: string[];
  pre_tax_revenue: number;
  total_sales_tax_collected: number;
  computed_fee: number;        // pre-tax processing fee
  computed_tax: number;        // ITC on fee (Canada)
  tax_code: string | null;     // e.g. "HST"
}

export interface ExecuteMatchResult {
  qbo_deposit_id: string;
  new_sync_token: string;
  income_lines: number;
  fee_applied: number;
  tax_collected_applied: number;
  tax_on_fee_applied: number;
}

// ─────────── Helpers ───────────

async function qboRequest<T>(
  realmId: string,
  accessToken: string,
  endpoint: string,
  init: RequestInit = {}
): Promise<T> {
  await qboRateLimiter.throttle(realmId);
  const url = `${QBO_BASE}/v3/company/${realmId}${endpoint}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO ${res.status} ${endpoint}: ${body}`);
  }
  return res.json();
}

/**
 * Look up the QBO Customer ID for a given name. Some clients have many
 * customers, so we do a server-side query for the exact name. Returns null
 * when not found (the row still posts, just without a customer reference).
 */
async function findCustomerIdByName(
  realmId: string,
  accessToken: string,
  name: string
): Promise<string | null> {
  const escaped = name.replace(/'/g, "\\'");
  const query = encodeURIComponent(
    `SELECT * FROM Customer WHERE DisplayName = '${escaped}' MAXRESULTS 1`
  );
  try {
    const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
    return data?.QueryResponse?.Customer?.[0]?.Id || null;
  } catch {
    return null;
  }
}

// Account name candidates, in priority order — the single source of truth for
// BOTH the execute-time resolver and the pre-flight check (so they never drift).
const STRIPE_ACCOUNT_NAMES = {
  revenue: ["Painting Revenue", "Service Revenue", "Sales of Product Income", "Services"],
  fee: [
    "Bank Charges & Fees",
    "Bank Charges and Fees",
    "Merchant Fees",
    "Merchant Processing Fees",
    "Bank Service Charges",
    "Accounting & Bookkeeping",
  ],
  taxPayable: ["GST/HST Payable", "Sales Tax Payable", "HST Payable", "GST Payable", "PST Payable", "QST Payable"],
  taxOnFee: [
    "GST/HST Receivable",
    "GST Receivable",
    "HST Receivable",
    "Input Tax Credits",
    "ITCs",
    "GST/HST ITC",
    "Sales Tax Recoverable",
    "GST/HST Payable", // last-resort same-account
  ],
} as const;

export interface StripeAccountCheck {
  ok: boolean;
  /** Account roles that have no matching QBO account, with the name to create. */
  missing: { label: string; suggested: string }[];
}

/**
 * Pre-flight: does the client's QBO chart have the accounts Stripe recon needs
 * to write back? Non-throwing twin of resolveExpenseAccounts — run on the New
 * form so a missing account is caught BEFORE discovery, not after Execute.
 */
export async function checkExpenseAccounts(
  realmId: string,
  accessToken: string,
  jurisdiction: "US" | "CA"
): Promise<StripeAccountCheck> {
  const accounts = await fetchAllAccounts(realmId, accessToken);
  const active = accounts.filter((a) => a.Active !== false);
  const has = (names: readonly string[]) => {
    const lowered = names.map((n) => n.toLowerCase());
    return active.some((a) => lowered.includes(a.Name.toLowerCase()));
  };

  const missing: { label: string; suggested: string }[] = [];
  if (!has(STRIPE_ACCOUNT_NAMES.revenue)) missing.push({ label: "Revenue", suggested: "Painting Revenue" });
  if (!has(STRIPE_ACCOUNT_NAMES.fee)) missing.push({ label: "Stripe fee expense", suggested: "Bank Charges & Fees" });
  if (jurisdiction === "CA") {
    if (!has(STRIPE_ACCOUNT_NAMES.taxPayable)) missing.push({ label: "Sales-tax payable", suggested: "GST/HST Payable" });
    if (!has(STRIPE_ACCOUNT_NAMES.taxOnFee)) missing.push({ label: "GST/HST receivable / ITC", suggested: "GST/HST Receivable" });
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Resolve all destination accounts for the write-back. Throws with a clear
 * message naming exactly which account is missing.
 */
export async function resolveExpenseAccounts(
  realmId: string,
  accessToken: string,
  jurisdiction: "US" | "CA"
): Promise<ExpenseAccountTargets> {
  const accounts = await fetchAllAccounts(realmId, accessToken);
  const active = accounts.filter((a) => a.Active !== false);

  const findByNames = (names: readonly string[]) => {
    const lowered = names.map((n) => n.toLowerCase());
    return active.find((a) => lowered.includes(a.Name.toLowerCase()));
  };

  // Revenue
  const revenueAccount = findByNames(STRIPE_ACCOUNT_NAMES.revenue);
  if (!revenueAccount) {
    throw new Error(
      'Could not find a revenue account. Create "Painting Revenue" in QBO and re-run.'
    );
  }

  // Stripe fee
  const feeAccount = findByNames(STRIPE_ACCOUNT_NAMES.fee);
  if (!feeAccount) {
    throw new Error(
      'Could not find a Stripe fee expense account. Create "Bank Charges & Fees" (or "Merchant Fees") in QBO and re-run.'
    );
  }

  const result: ExpenseAccountTargets = {
    revenueAccountId: revenueAccount.Id,
    revenueAccountName: revenueAccount.Name,
    stripeFeeAccountId: feeAccount.Id,
    stripeFeeAccountName: feeAccount.Name,
  };

  if (jurisdiction === "CA") {
    // Sales tax collected from customers (a liability we owe to CRA)
    const taxPayable = findByNames(STRIPE_ACCOUNT_NAMES.taxPayable);
    if (!taxPayable) {
      throw new Error(
        'Could not find a sales-tax-payable account. Create "GST/HST Payable" (or "Sales Tax Payable") in QBO and re-run.'
      );
    }
    result.taxPayableAccountId = taxPayable.Id;
    result.taxPayableAccountName = taxPayable.Name;

    // ITC on the Stripe fee (recoverable on inputs)
    const taxOnFee = findByNames(STRIPE_ACCOUNT_NAMES.taxOnFee);
    if (!taxOnFee) {
      throw new Error(
        'Could not find a GST/HST receivable / ITC account. Create "GST/HST Receivable" (or "Input Tax Credits") in QBO and re-run.'
      );
    }
    result.taxOnFeeAccountId = taxOnFee.Id;
    result.taxOnFeeAccountName = taxOnFee.Name;
  }

  return result;
}

function buildLabeledMemo(
  existingMemo: string | undefined,
  customerNames: string[]
): string {
  const today = new Date().toISOString().slice(0, 10);
  const customers = customerNames.length > 0 ? customerNames.join(", ") : "unmatched";
  const tag = `${IRONBOOKS_TAG} ${today}: Stripe payment for ${customers}`;
  const existing = (existingMemo || "").replace(/\[Ironbooks Stripe Recon\][^\n]*/gi, "").trim();
  return existing ? `${tag}\n${existing}` : tag;
}

/**
 * Apply full Stripe reconciliation to a single deposit. Decomposes the gross
 * customer payment into per-customer income + collected tax (Canada), and
 * subtracts the Stripe fee + ITC on the fee.
 */
export async function applyStripeReconToDeposit(
  realmId: string,
  accessToken: string,
  match: ExecuteMatchInput,
  targets: ExpenseAccountTargets,
  jurisdiction: "US" | "CA"
): Promise<ExecuteMatchResult> {
  // 1. Fetch current deposit (need fresh SyncToken + existing Line[] context)
  const fetched: any = await qboRequest(
    realmId, accessToken,
    `/deposit/${match.qbo_deposit_id}`,
  );
  const deposit: QBODeposit = fetched.Deposit;
  if (!deposit) throw new Error(`Deposit ${match.qbo_deposit_id} not found`);

  // 2. Strip prior Ironbooks lines so we can safely re-run
  const cleanLines: QBODepositLine[] = (deposit.Line || []).filter(
    (l) => !(l.Description || "").startsWith(IRONBOOKS_TAG)
  );

  // 3. Resolve unique customers → QBO IDs.
  //    For Stripe API path the customer_id is pre-resolved and passed
  //    through on each line; for QBO AI path we look up by name. Skip
  //    the name lookup when no customer_name is provided (e.g. the
  //    "unattributed Stripe charges" line).
  const customerIdMap = new Map<string, string>();
  for (const inv of match.matched_invoices) {
    if (inv.qbo_customer_id) {
      // Stripe path already gave us the id — record it under the name so
      // dedupe by name still works for AI-path rows mixed in.
      if (inv.customer_name) customerIdMap.set(inv.customer_name, inv.qbo_customer_id);
      continue;
    }
    const name = (inv.customer_name || "").trim();
    if (!name || customerIdMap.has(name)) continue;
    const id = await findCustomerIdByName(realmId, accessToken, name);
    if (id) customerIdMap.set(name, id);
  }

  // 4. Build new lines
  const linesToAdd: QBODepositLine[] = [];

  // 4a. POSITIVE per-invoice income lines (pre-tax revenue)
  for (const inv of match.matched_invoices) {
    if (inv.pre_tax_amount <= 0) continue;
    const customerName = inv.customer_name || "Unattributed";
    const customerId =
      inv.qbo_customer_id ??
      (customerName ? customerIdMap.get(customerName) : undefined);
    // Use description_label if the data source set one (Stripe API path);
    // otherwise default to "Invoice X" (QBO AI matcher path).
    const label = inv.description_label
      ? inv.description_label
      : `Invoice ${inv.invoice_id}`;
    linesToAdd.push({
      Amount: Number(inv.pre_tax_amount.toFixed(2)),
      Description: inv.customer_name
        ? `${IRONBOOKS_TAG} ${customerName} · ${label}`
        : `${IRONBOOKS_TAG} ${label}`,
      DetailType: "DepositLineDetail",
      DepositLineDetail: {
        AccountRef: { value: targets.revenueAccountId, name: targets.revenueAccountName },
        ...(customerId ? { Entity: { type: "Customer", value: customerId, name: customerName } } : {}),
      },
    });
  }

  // 4b. POSITIVE aggregated sales-tax-collected line (Canada only)
  if (
    jurisdiction === "CA" &&
    match.total_sales_tax_collected > 0 &&
    targets.taxPayableAccountId
  ) {
    linesToAdd.push({
      Amount: Number(match.total_sales_tax_collected.toFixed(2)),
      Description: `${IRONBOOKS_TAG} ${match.tax_code || "Sales tax"} collected on Stripe payment`,
      DetailType: "DepositLineDetail",
      DepositLineDetail: {
        AccountRef: { value: targets.taxPayableAccountId, name: targets.taxPayableAccountName },
      },
    });
  }

  // 4c. NEGATIVE Stripe processing fee
  if (match.computed_fee > 0) {
    linesToAdd.push({
      Amount: -Math.abs(Number(match.computed_fee.toFixed(2))),
      Description: `${IRONBOOKS_TAG} Stripe processing fee${
        match.matched_customer_names.length > 0
          ? ` (${match.matched_customer_names.join(", ")})`
          : ""
      }`,
      DetailType: "DepositLineDetail",
      DepositLineDetail: {
        AccountRef: { value: targets.stripeFeeAccountId, name: targets.stripeFeeAccountName },
      },
    });
  }

  // 4d. NEGATIVE ITC on Stripe fee (Canada only)
  if (
    jurisdiction === "CA" &&
    match.computed_tax > 0 &&
    targets.taxOnFeeAccountId
  ) {
    linesToAdd.push({
      Amount: -Math.abs(Number(match.computed_tax.toFixed(2))),
      Description: `${IRONBOOKS_TAG} ${match.tax_code || "Tax"} on Stripe fee (ITC)`,
      DetailType: "DepositLineDetail",
      DepositLineDetail: {
        AccountRef: { value: targets.taxOnFeeAccountId, name: targets.taxOnFeeAccountName },
      },
    });
  }

  // 5. Compose update payload and POST
  const updatedDeposit: any = {
    ...deposit,
    PrivateNote: buildLabeledMemo(deposit.PrivateNote, match.matched_customer_names),
    Line: [...cleanLines, ...linesToAdd],
    sparse: false,
  };

  const response: any = await qboRequest(
    realmId, accessToken,
    `/deposit?operation=update`,
    { method: "POST", body: JSON.stringify(updatedDeposit) }
  );

  return {
    qbo_deposit_id: match.qbo_deposit_id,
    new_sync_token: response.Deposit?.SyncToken || deposit.SyncToken,
    income_lines: match.matched_invoices.length,
    fee_applied: match.computed_fee,
    tax_collected_applied: match.total_sales_tax_collected,
    tax_on_fee_applied: match.computed_tax,
  };
}
