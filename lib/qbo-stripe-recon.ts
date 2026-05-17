/**
 * QBO Stripe AR Reconciliation
 * ─────────────────────────────
 * Fetches Stripe-origin deposits and the surrounding AR data (customer payments
 * + invoices) needed to match deposits to invoices. Read-only — execution
 * (writing matches back to QBO) lives in a separate Phase 2 module.
 */

import { qboRateLimiter } from "./qbo";

const QBO_BASE =
  process.env.QBO_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

// Stripe-origin signals — both the descriptor on bank-fed deposits and common
// memo patterns. The "ST-" prefix shows up on Stripe payouts.
const STRIPE_PATTERNS: RegExp[] = [
  /\bstripe\b/i,
  /stripe\s*payouts?/i,
  /\bSTRP\b/,
  /^ST-\w/,
];

export interface StripeDeposit {
  qbo_deposit_id: string;
  txn_type: "Deposit" | "JournalEntry";
  amount: number;
  date: string;            // YYYY-MM-DD
  memo: string;
  source_descriptor: string;
}

export interface QBOInvoice {
  id: string;
  doc_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  txn_date: string;
  total_amount: number;     // gross including any tax QBO has on the invoice
  balance: number;          // outstanding after partial payments
  status: "open" | "paid" | "partial";
  /** Tax actually attached to the invoice in QBO (may be 0 if not configured). */
  qbo_total_tax: number;
}

export interface QBOCustomerPayment {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  txn_date: string;
  total_amount: number;
  payment_method: string | null;
  deposit_to_account_id: string | null;
  /** Invoice IDs this payment applied to */
  linked_invoice_ids: string[];
  unapplied_amount: number;
}

async function qboRequest<T>(
  realmId: string,
  accessToken: string,
  endpoint: string
): Promise<T> {
  await qboRateLimiter.throttle(realmId);
  const url = `${QBO_BASE}/v3/company/${realmId}${endpoint}`;
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

function looksLikeStripe(...fields: (string | null | undefined)[]): boolean {
  const haystack = fields.filter(Boolean).join(" | ");
  if (!haystack) return false;
  return STRIPE_PATTERNS.some((re) => re.test(haystack));
}

/**
 * Fetch every Deposit in a date range whose descriptor / memo / line-account
 * descriptor flags it as Stripe-origin. Returns flattened deposit records.
 */
export async function fetchStripeDeposits(
  realmId: string,
  accessToken: string,
  dateStart: string,
  dateEnd: string
): Promise<StripeDeposit[]> {
  const results: StripeDeposit[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const startPosition = page * pageSize + 1;
    const query = encodeURIComponent(
      `SELECT * FROM Deposit WHERE TxnDate >= '${dateStart}' AND TxnDate <= '${dateEnd}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    let data: any;
    try {
      data = await qboRequest<any>(realmId, accessToken, `/query?query=${query}`);
    } catch (err: any) {
      console.warn("[stripe-recon] Deposit query failed:", err.message);
      break;
    }
    const deposits: any[] = data?.QueryResponse?.Deposit || [];
    for (const d of deposits) {
      const memo = (d.PrivateNote || "") as string;
      const docNumber = (d.DocNumber || "") as string;

      // Inspect each line: was it categorized to a Stripe-named clearing account?
      const lineDescriptors: string[] = [];
      for (const line of d.Line || []) {
        const detail = line.DepositLineDetail;
        const linkedName =
          detail?.AccountRef?.name ||
          detail?.Entity?.name ||
          line?.Description ||
          "";
        if (linkedName) lineDescriptors.push(linkedName);
      }
      const sourceDescriptor = lineDescriptors.join(" | ");

      if (looksLikeStripe(memo, docNumber, sourceDescriptor)) {
        results.push({
          qbo_deposit_id: d.Id,
          txn_type: "Deposit",
          amount: Number(d.TotalAmt || 0),
          date: d.TxnDate,
          memo,
          source_descriptor: sourceDescriptor,
        });
      }
    }
    if (deposits.length < pageSize) break;
    page++;
  }

  return results;
}

/**
 * Fetch invoices in a date range that could plausibly be paid by a Stripe deposit
 * — uses a small ±7-day window around the requested period to catch invoices
 * issued just before a payout.
 */
export async function fetchInvoicesForRange(
  realmId: string,
  accessToken: string,
  dateStart: string,
  dateEnd: string
): Promise<QBOInvoice[]> {
  // Widen by 30 days on each side. Stripe payouts can land weeks after
  // invoices are issued (weekly ACH schedules, held funds, etc.) — a tight
  // ±7-day window misses too many real pairings.
  const widened = (iso: string, days: number) => {
    const d = new Date(iso);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const widenedStart = widened(dateStart, -30);
  const widenedEnd = widened(dateEnd, 30);

  const results: QBOInvoice[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const startPosition = page * pageSize + 1;
    const query = encodeURIComponent(
      `SELECT * FROM Invoice WHERE TxnDate >= '${widenedStart}' AND TxnDate <= '${widenedEnd}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    let data: any;
    try {
      data = await qboRequest<any>(realmId, accessToken, `/query?query=${query}`);
    } catch (err: any) {
      console.warn("[stripe-recon] Invoice query failed:", err.message);
      break;
    }
    const invoices: any[] = data?.QueryResponse?.Invoice || [];
    for (const inv of invoices) {
      const total = Number(inv.TotalAmt || 0);
      const balance = Number(inv.Balance ?? total);
      let status: "open" | "paid" | "partial" = "open";
      if (balance === 0) status = "paid";
      else if (balance < total) status = "partial";

      const qboTotalTax = Number(inv.TxnTaxDetail?.TotalTax ?? 0);

      results.push({
        id: inv.Id,
        doc_number: inv.DocNumber || null,
        customer_id: inv.CustomerRef?.value || null,
        customer_name: inv.CustomerRef?.name || null,
        txn_date: inv.TxnDate,
        total_amount: total,
        balance,
        status,
        qbo_total_tax: qboTotalTax,
      });
    }
    if (invoices.length < pageSize) break;
    page++;
  }

  return results;
}

/**
 * Fetch customer Payments in the date range. These are the closest QBO concept
 * to "Stripe charge succeeded" — they link customer → invoice → deposit.
 */
export async function fetchCustomerPaymentsForRange(
  realmId: string,
  accessToken: string,
  dateStart: string,
  dateEnd: string
): Promise<QBOCustomerPayment[]> {
  const widened = (iso: string, days: number) => {
    const d = new Date(iso);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const widenedStart = widened(dateStart, -30);
  const widenedEnd = widened(dateEnd, 30);

  const results: QBOCustomerPayment[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const startPosition = page * pageSize + 1;
    const query = encodeURIComponent(
      `SELECT * FROM Payment WHERE TxnDate >= '${widenedStart}' AND TxnDate <= '${widenedEnd}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    let data: any;
    try {
      data = await qboRequest<any>(realmId, accessToken, `/query?query=${query}`);
    } catch (err: any) {
      console.warn("[stripe-recon] Payment query failed:", err.message);
      break;
    }
    const payments: any[] = data?.QueryResponse?.Payment || [];
    for (const p of payments) {
      const lines: any[] = p.Line || [];
      const linkedInvoices: string[] = [];
      for (const ln of lines) {
        const linked = ln.LinkedTxn || [];
        for (const lk of linked) {
          if (lk.TxnType === "Invoice" && lk.TxnId) linkedInvoices.push(lk.TxnId);
        }
      }

      results.push({
        id: p.Id,
        customer_id: p.CustomerRef?.value || null,
        customer_name: p.CustomerRef?.name || null,
        txn_date: p.TxnDate,
        total_amount: Number(p.TotalAmt || 0),
        payment_method: p.PaymentMethodRef?.name || null,
        deposit_to_account_id: p.DepositToAccountRef?.value || null,
        linked_invoice_ids: linkedInvoices,
        unapplied_amount: Number(p.UnappliedAmt || 0),
      });
    }
    if (payments.length < pageSize) break;
    page++;
  }

  return results;
}
