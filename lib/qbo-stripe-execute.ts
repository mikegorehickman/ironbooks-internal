/**
 * QBO Stripe AR Reconciliation — Execution (Phase 2)
 * ───────────────────────────────────────────────────
 * For each approved match, rewrite the QBO Deposit so that:
 *   1. PrivateNote is labeled with the matched customer names + IronBooks tag
 *   2. A negative line item is appended for the Stripe processing fee
 *   3. Canada only: a second negative line item is appended for the GST/HST/PST
 *      portion of the fee (treated as an Input Tax Credit on the fee expense)
 *
 * QBO's deposit endpoint does NOT support tax codes on Deposit line items
 * (it's a banking transaction, not a sales transaction). The standard CRA
 * treatment is to split the fee into two separate expense lines: the net
 * service fee + the recoverable input tax. That's what this does.
 *
 * Idempotency: skips matches with executed=true. The IronBooks tag in the
 * PrivateNote also acts as a re-run guard.
 */

import { qboRateLimiter, fetchAllAccounts } from "./qbo";
import type { Json } from "./database.types";

const QBO_BASE =
  process.env.QBO_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

const IRONBOOKS_TAG = "[IronBooks Stripe Recon]";

// ─────────── Types ───────────

interface QBODepositLine {
  Id?: string;
  Amount: number;
  Description?: string;
  DetailType: "DepositLineDetail";
  DepositLineDetail: {
    AccountRef: { value: string; name?: string };
    Entity?: { value: string; type?: string; name?: string };
    TaxCodeRef?: { value: string };
    PaymentMethodRef?: { value: string };
  };
  LinkedTxn?: Array<{ TxnId: string; TxnType: string }>;
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

/**
 * Accounts the execution layer needs to find in the client's COA.
 * Names are checked case-insensitively against the master COA + a few aliases.
 */
export interface ExpenseAccountTargets {
  /** The "Stripe Fees" / "Bank Charges & Fees" / "Merchant Fees" account */
  stripeFeeAccountId: string;
  stripeFeeAccountName: string;
  /** Canada only — the GST/HST/PST recoverable input tax account */
  taxOnFeeAccountId?: string;
  taxOnFeeAccountName?: string;
}

export interface ExecuteMatchInput {
  qbo_deposit_id: string;
  matched_customer_names: string[];
  computed_fee: number;        // pre-tax
  computed_tax: number;        // 0 for US
  tax_code: string | null;     // e.g. "HST" — for line description
}

export interface ExecuteMatchResult {
  qbo_deposit_id: string;
  new_sync_token: string;
  lines_added: number;
  total_fee_applied: number;
  total_tax_applied: number;
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
 * Resolve the destination accounts for fee + tax write-back from the client's
 * live COA. Tries known IronBooks names first, then common QBO defaults.
 * Throws a helpful error if a required account can't be found — the bookkeeper
 * must create it in QBO and re-run.
 */
export async function resolveExpenseAccounts(
  realmId: string,
  accessToken: string,
  jurisdiction: "US" | "CA"
): Promise<ExpenseAccountTargets> {
  const accounts = await fetchAllAccounts(realmId, accessToken);
  const active = accounts.filter((a) => a.Active !== false);

  const findByNames = (names: string[]) => {
    const lowered = names.map((n) => n.toLowerCase());
    return active.find((a) => lowered.includes(a.Name.toLowerCase()));
  };

  const feeAccount = findByNames([
    "Stripe Fees",
    "Stripe Processing Fees",
    "Merchant Fees",
    "Merchant Processing Fees",
    "Bank Charges & Fees",
    "Bank Charges and Fees",
    "Bank Service Charges",
    "Accounting & Bookkeeping", // last-resort IronBooks master account
  ]);
  if (!feeAccount) {
    throw new Error(
      'Could not find a destination account for Stripe fees. Create an expense account called "Stripe Fees", "Merchant Fees", or "Bank Charges & Fees" in QBO and re-run.'
    );
  }

  const result: ExpenseAccountTargets = {
    stripeFeeAccountId: feeAccount.Id,
    stripeFeeAccountName: feeAccount.Name,
  };

  if (jurisdiction === "CA") {
    const taxAccount = findByNames([
      "GST/HST Receivable",
      "GST Receivable",
      "HST Receivable",
      "Input Tax Credits",
      "ITCs",
      "GST/HST ITC",
      "Sales Tax Recoverable",
      "GST/HST Payable",   // last resort — net's correctly in remittance
    ]);
    if (!taxAccount) {
      throw new Error(
        'Could not find a GST/HST account. Create "GST/HST Receivable" (or "Input Tax Credits") in QBO and re-run.'
      );
    }
    result.taxOnFeeAccountId = taxAccount.Id;
    result.taxOnFeeAccountName = taxAccount.Name;
  }

  return result;
}

function buildLabeledMemo(
  existingMemo: string | undefined,
  customerNames: string[]
): string {
  const today = new Date().toISOString().slice(0, 10);
  const customers = customerNames.length > 0
    ? customerNames.join(", ")
    : "unmatched";
  const tag = `${IRONBOOKS_TAG} ${today}: Stripe payment for ${customers}`;
  // Already tagged? Don't double-tag — replace any existing IronBooks tag block.
  const existing = (existingMemo || "").replace(/\[IronBooks Stripe Recon\][^\n]*/gi, "").trim();
  return existing ? `${tag}\n${existing}` : tag;
}

/**
 * Update one Stripe deposit in QBO with the labeled memo and fee/tax lines.
 * Returns the new SyncToken so callers can persist it for future updates.
 */
export async function applyStripeReconToDeposit(
  realmId: string,
  accessToken: string,
  match: ExecuteMatchInput,
  targets: ExpenseAccountTargets,
  jurisdiction: "US" | "CA"
): Promise<ExecuteMatchResult> {
  // 1. Fetch current deposit (fresh SyncToken)
  const fetched: any = await qboRequest(
    realmId, accessToken,
    `/deposit/${match.qbo_deposit_id}`,
  );
  const deposit: QBODeposit = fetched.Deposit;
  if (!deposit) throw new Error(`Deposit ${match.qbo_deposit_id} not found`);

  // 2. Detect prior IronBooks run on this same deposit and strip those lines
  //    so we don't double-charge.
  const cleanLines: QBODepositLine[] = (deposit.Line || []).filter(
    (l) => !(l.Description || "").startsWith(IRONBOOKS_TAG)
  );

  // 3. Build new fee line(s)
  const linesToAdd: QBODepositLine[] = [];

  if (match.computed_fee > 0) {
    linesToAdd.push({
      Amount: -Math.abs(match.computed_fee),
      Description: `${IRONBOOKS_TAG} Stripe processing fee${match.matched_customer_names.length > 0 ? ` (${match.matched_customer_names.join(", ")})` : ""}`,
      DetailType: "DepositLineDetail",
      DepositLineDetail: {
        AccountRef: {
          value: targets.stripeFeeAccountId,
          name: targets.stripeFeeAccountName,
        },
      },
    });
  }

  if (jurisdiction === "CA" && match.computed_tax > 0 && targets.taxOnFeeAccountId) {
    linesToAdd.push({
      Amount: -Math.abs(match.computed_tax),
      Description: `${IRONBOOKS_TAG} ${match.tax_code || "Tax"} on Stripe fee`,
      DetailType: "DepositLineDetail",
      DepositLineDetail: {
        AccountRef: {
          value: targets.taxOnFeeAccountId,
          name: targets.taxOnFeeAccountName,
        },
      },
    });
  }

  // 4. Compose and send the update
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
    lines_added: linesToAdd.length,
    total_fee_applied: match.computed_fee,
    total_tax_applied: match.computed_tax,
  };
}

export type StripeExecuteJson = Json;
