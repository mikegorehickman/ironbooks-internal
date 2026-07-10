/**
 * QBO write helpers for BS cleanup proposed entries.
 */

import {
  applyPaymentToInvoices,
  applyBillPaymentToBills,
  createJournalEntry,
  createPaymentForInvoice,
  findByPrivateNoteToken,
  type JournalEntryLine,
} from "@/lib/qbo";

const QBO_BASE =
  process.env.QBO_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

async function qboFetch(
  realmId: string,
  accessToken: string,
  path: string,
  init?: RequestInit
): Promise<any> {
  const res = await fetch(`${QBO_BASE}/v3/company/${realmId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`QBO ${res.status} ${path}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

export async function voidQboInvoice(
  realmId: string,
  accessToken: string,
  invoiceId: string,
  privateNote?: string
): Promise<string> {
  const query = encodeURIComponent(`SELECT * FROM Invoice WHERE Id = '${invoiceId}'`);
  const data = await qboFetch(realmId, accessToken, `/query?query=${query}`, { method: "GET" });
  const inv = data?.QueryResponse?.Invoice?.[0];
  if (!inv) throw new Error(`Invoice ${invoiceId} not found in QBO`);

  const voidPayload: Record<string, unknown> = {
    Id: inv.Id,
    SyncToken: inv.SyncToken,
  };
  if (privateNote) voidPayload.PrivateNote = privateNote;

  const voidRes = await qboFetch(
    realmId,
    accessToken,
    "/invoice?operation=void&minorversion=70",
    { method: "POST", body: JSON.stringify(voidPayload) }
  );
  return voidRes?.Invoice?.Id || invoiceId;
}

export async function applyUfPaymentToInvoice(
  realmId: string,
  accessToken: string,
  params: {
    paymentId: string;
    invoiceId: string;
    amount: number;
    runId: string;
    entryId: string;
  }
): Promise<string> {
  const idempotencyToken = `SNAP-CLEANUP-${params.runId}-${params.entryId}`;
  const result = await applyPaymentToInvoices(realmId, accessToken, {
    paymentId: params.paymentId,
    invoiceLinks: [{ invoiceId: params.invoiceId, amountApplied: params.amount }],
    privateNote: `Ironbooks BS Cleanup UF→A/R — ${idempotencyToken}`,
  });
  return result?.Id || params.paymentId;
}

export async function applyApPaymentToBill(
  realmId: string,
  accessToken: string,
  params: {
    billPaymentId: string;
    billId: string;
    amount: number;
    runId: string;
    entryId: string;
  }
): Promise<string> {
  const idempotencyToken = `SNAP-CLEANUP-AP-${params.runId}-${params.entryId}`;
  const result = await applyBillPaymentToBills(realmId, accessToken, {
    billPaymentId: params.billPaymentId,
    billLinks: [{ billId: params.billId, amountApplied: params.amount }],
    privateNote: `Ironbooks BS Cleanup payment→Bill — ${idempotencyToken}`,
  });
  return result?.Id || params.billPaymentId;
}

/**
 * AR Aging Cleanup: create a brand-new Receive Payment against a stale open
 * invoice, deposited to the Uncleared Deposits clearing account. Idempotent
 * via a PrivateNote token pre-check — a retried execute can never double-pay
 * the same invoice.
 */
export async function createArAgingClearPayment(
  realmId: string,
  accessToken: string,
  params: {
    customerId: string;
    customerName?: string;
    invoiceId: string;
    amount: number;
    txnDate: string;
    depositToAccountId: string;
    depositToAccountName?: string;
    runId: string;
    entryId: string;
  }
): Promise<string> {
  const idempotencyToken = `SNAP-CLEANUP-${params.runId}-${params.entryId}-ARP`;
  const existing = await findByPrivateNoteToken(realmId, accessToken, "Payment", idempotencyToken);
  if (existing) {
    console.warn(`[createArAgingClearPayment] idempotent hit — Payment ${existing} already posted for ${idempotencyToken}`);
    return existing;
  }
  const result = await createPaymentForInvoice(realmId, accessToken, {
    customerId: params.customerId,
    customerName: params.customerName,
    invoiceId: params.invoiceId,
    amount: params.amount,
    txnDate: params.txnDate,
    depositToAccountId: params.depositToAccountId,
    depositToAccountName: params.depositToAccountName,
    privateNote: `Ironbooks AR aging clear — ${idempotencyToken}`,
  });
  return result?.Id || "";
}

/**
 * AR Aging Cleanup: post the lump pre-engagement writeoff JE. QBO's tolerance
 * for multiple A/R lines (each with a Customer entity) in one JE varies by
 * file configuration, so when the single lump entry is rejected we fall back
 * to one JE per customer automatically — same net effect, more entries.
 * Both paths are self-idempotent (createJournalEntry hashes date+note+lines).
 */
export async function postArAgingWriteoffJe(
  realmId: string,
  accessToken: string,
  params: {
    txnDate: string;
    memo: string;
    debit: { accountId: string; accountName?: string; amount: number; description?: string };
    credits: Array<{
      accountId: string;
      accountName?: string;
      amount: number;
      description?: string;
      customerId: string;
      customerName?: string;
    }>;
  }
): Promise<string> {
  const creditLines: JournalEntryLine[] = params.credits.map((c) => ({
    posting_type: "Credit" as const,
    amount: c.amount,
    account_id: c.accountId,
    account_name: c.accountName,
    description: c.description,
    entity: { type: "Customer" as const, id: c.customerId, name: c.customerName },
  }));

  try {
    const je = await createJournalEntry(realmId, accessToken, {
      txn_date: params.txnDate,
      private_note: params.memo,
      lines: [
        {
          posting_type: "Debit",
          amount: params.debit.amount,
          account_id: params.debit.accountId,
          account_name: params.debit.accountName,
          description: params.debit.description,
        },
        ...creditLines,
      ],
    });
    return je?.Id || "";
  } catch (err: any) {
    // Multi-AR-line JE rejected → per-customer fallback (only when there was
    // more than one customer to begin with; a single-line failure is real).
    if (params.credits.length <= 1) throw err;
    console.warn(`[postArAgingWriteoffJe] lump JE rejected (${String(err?.message).slice(0, 120)}) — falling back to one JE per customer`);
    const ids: string[] = [];
    for (const c of params.credits) {
      const je = await createJournalEntry(realmId, accessToken, {
        txn_date: params.txnDate,
        private_note: `${params.memo} — ${c.customerName || c.customerId}`,
        lines: [
          {
            posting_type: "Debit",
            amount: c.amount,
            account_id: params.debit.accountId,
            account_name: params.debit.accountName,
            description: params.debit.description,
          },
          {
            posting_type: "Credit",
            amount: c.amount,
            account_id: c.accountId,
            account_name: c.accountName,
            description: c.description,
            entity: { type: "Customer", id: c.customerId, name: c.customerName },
          },
        ],
      });
      if (je?.Id) ids.push(je.Id);
    }
    return ids.join(",");
  }
}

export { createJournalEntry };
