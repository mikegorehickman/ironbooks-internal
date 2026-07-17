/**
 * CRM invoice remediation — the KEEP-INVOICE write path (Mike 2026-07-17:
 * "I don't like [killing CRM invoice sync] in case they like invoicing").
 *
 * For a client who actively uses invoicing, voiding their invoices guts their
 * records. The accounting-correct alternative keeps the invoice and fixes the
 * DEPOSIT instead:
 *   1. Void the phantom CRM payment(s) (sitting in Undeposited Funds, never
 *      deposited) — this reopens the invoice.
 *   2. Repoint the matched bank-deposit line from the income account to
 *      ACCOUNTS RECEIVABLE + the invoice's customer. QBO treats an A/R
 *      deposit line with a customer as a payment credit; with "automatically
 *      apply credits" on (QBO default for most files) it applies to the open
 *      invoice — revenue then recognizes ONCE, off the paid invoice, on the
 *      deposit's date. Totals never change → bank recon untouched.
 *
 * If the file doesn't auto-apply credits, the credit sits on the customer and
 * the outcome says so — linking is one click in Receive Payment. We report
 * that state honestly rather than pretending.
 *
 * Same guard discipline as every other writer: memo idempotency, snapshot
 * before write, exact line match (account + amount) or whole-txn refusal.
 */

import { qboRequest, voidPayment, type QBOAccount } from "./qbo";
import { normalizeAccountKey } from "./gst-extraction";

export const KEEP_INVOICE_MEMO = "SNAP CRM keep-invoice: deposit applied to A/R";

const r2 = (n: number) => Math.round((n || 0) * 100) / 100;

export interface KeepInvoiceOutcome {
  invoiceId: string;
  outcome: "applied" | "would_apply" | "skipped_stale" | "skipped_already" | "skipped_closed" | "failed";
  detail?: string;
}

/** Find the client's Accounts Receivable account (first active A/R). */
export function findArAccount(accounts: QBOAccount[]): { id: string; name: string } | null {
  const ar = accounts.find(
    (a) => a.Active !== false && a.AccountType === "Accounts Receivable"
  );
  return ar ? { id: ar.Id, name: ar.Name } : null;
}

/**
 * Pure line matcher (fixture-tested): locate the deposit line to repoint —
 * DepositLineDetail, income account (normalized name match), exact |amount|.
 */
export function findDepositLineIndex(
  entityLines: any[],
  incomeAccountName: string,
  amount: number
): number {
  const want = normalizeAccountKey(incomeAccountName);
  for (let i = 0; i < entityLines.length; i++) {
    const l = entityLines[i];
    if (l.DetailType !== "DepositLineDetail") continue;
    const name = l.DepositLineDetail?.AccountRef?.name;
    if (normalizeAccountKey(name) !== want) continue;
    if (r2(Number(l.Amount)) !== r2(Math.abs(amount))) continue;
    return i;
  }
  return -1;
}

/**
 * Execute the keep-invoice remediation for ONE invoice + its matched deposit.
 * Caller has already re-validated safety (phantom payments only) server-side.
 */
export async function applyDepositToInvoice(params: {
  realm: string;
  token: string;
  invoiceId: string;
  customerId: string;
  deposit: { txn_id: string; account: string; amount: number };
  phantomPaymentIds: string[];
  arAccountId: string;
  dryRun: boolean;
  closingDate: string | null;
  /** Persist a pre-edit snapshot (entity JSON) BEFORE any write. */
  snapshot: (kind: string, id: string, entity: any) => Promise<void>;
}): Promise<KeepInvoiceOutcome> {
  const { realm, token, invoiceId, customerId, deposit, phantomPaymentIds, arAccountId, dryRun, closingDate, snapshot } = params;

  // Fetch the deposit fresh.
  let entity: any;
  try {
    const data = await qboRequest<any>(realm, token, `/deposit/${deposit.txn_id}?minorversion=70`);
    entity = data?.Deposit;
  } catch (e: any) {
    return { invoiceId, outcome: "failed", detail: `deposit fetch: ${String(e?.message || e).slice(0, 200)}` };
  }
  if (!entity) return { invoiceId, outcome: "failed", detail: "deposit not found" };

  if (String(entity.PrivateNote || "").includes(KEEP_INVOICE_MEMO)) {
    return { invoiceId, outcome: "skipped_already" };
  }
  if (closingDate && entity.TxnDate && entity.TxnDate <= closingDate) {
    return { invoiceId, outcome: "skipped_closed", detail: `deposit in closed period (≤ ${closingDate})` };
  }

  const lines = (entity.Line || []).map((l: any) => ({ ...l }));
  const idx = findDepositLineIndex(lines, deposit.account, deposit.amount);
  if (idx === -1) {
    return {
      invoiceId,
      outcome: "skipped_stale",
      detail: `no deposit line matches ${deposit.account} @ ${deposit.amount} — books changed since the plan`,
    };
  }

  if (dryRun) return { invoiceId, outcome: "would_apply" };

  try {
    // 1. Void the phantom payment(s) first — reopens the invoice so the
    //    deposit credit has something to apply to.
    for (const pid of phantomPaymentIds) {
      const payData = await qboRequest<any>(
        realm,
        token,
        `/query?query=${encodeURIComponent(`SELECT * FROM Payment WHERE Id = '${pid}' MAXRESULTS 1`)}`
      );
      const pay = payData?.QueryResponse?.Payment?.[0];
      if (pay) await snapshot("Payment", pid, pay);
      await voidPayment(realm, token, pid, "Payment");
    }

    // 2. Snapshot + repoint the deposit line → A/R + customer.
    await snapshot("Deposit", deposit.txn_id, entity);
    const line = lines[idx];
    lines[idx] = {
      ...line,
      DepositLineDetail: {
        ...(line.DepositLineDetail || {}),
        AccountRef: { value: arAccountId },
        Entity: { value: customerId, type: "Customer" },
      },
    };
    const { MetaData: _m, domain: _d, TotalAmt: _t, ...core } = entity;
    const existingNote = String(entity.PrivateNote || "");
    const note = existingNote
      ? `${existingNote}\n${KEEP_INVOICE_MEMO} (Invoice ${invoiceId})`
      : `${KEEP_INVOICE_MEMO} (Invoice ${invoiceId})`;
    await qboRequest(realm, token, `/deposit?operation=update&minorversion=70`, {
      method: "POST",
      body: JSON.stringify({ ...core, Line: lines, PrivateNote: note, sparse: false }),
    });

    // 3. Honest post-state: did the credit auto-apply to the invoice?
    let applied = false;
    try {
      const invData = await qboRequest<any>(
        realm,
        token,
        `/query?query=${encodeURIComponent(`SELECT Id, Balance FROM Invoice WHERE Id = '${invoiceId}' MAXRESULTS 1`)}`
      );
      const bal = Number(invData?.QueryResponse?.Invoice?.[0]?.Balance);
      applied = Number.isFinite(bal) && bal <= 0.005;
    } catch {
      /* verification read is best-effort */
    }
    return {
      invoiceId,
      outcome: "applied",
      detail: applied
        ? "deposit applied — invoice shows PAID"
        : "deposit moved to A/R as a customer credit — invoice still open (auto-apply credits is off in this file); link it via Receive Payment",
    };
  } catch (e: any) {
    return { invoiceId, outcome: "failed", detail: String(e?.message || e).slice(0, 300) };
  }
}
