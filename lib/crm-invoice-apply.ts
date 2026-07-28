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
export const MATCH_MEMO = "SNAP CRM match: bank deposit matched to invoice payment (UF cleared)";

const r2 = (n: number) => Math.round((n || 0) * 100) / 100;

/**
 * Find the account to absorb a processing/merchant-fee gap between what the
 * customer paid and what actually landed in the bank. Auto-detected from the
 * client's chart (Mike 2026-07-28); returns null when nothing suitable exists
 * so the caller can ask instead of guessing wrong.
 */
export function findFeeAccount(accounts: QBOAccount[]): { id: string; name: string } | null {
  const active = accounts.filter((a) => a.Active !== false);
  const isExpense = (a: QBOAccount) =>
    /expense/i.test(String(a.AccountType || "")) || String(a.AccountType) === "Cost of Goods Sold";
  // Most specific first — a dedicated merchant/processing fee account beats a
  // generic "Bank Charges", which beats nothing.
  const patterns = [
    /merchant\s*(service|account)?\s*fee/i,
    /payment\s*process(ing)?\s*fee/i,
    /process(ing)?\s*fee/i,
    /(stripe|square|paypal)\s*fee/i,
    /credit\s*card\s*(process|merchant|fee)/i,
    /bank\s*(charge|fee|service charge)/i,
  ];
  for (const re of patterns) {
    const hit = active.find((a) => isExpense(a) && re.test(String(a.Name || "")));
    if (hit) return { id: hit.Id, name: hit.Name };
  }
  return null;
}

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

export interface MatchOutcome {
  invoiceId: string;
  outcome: "matched" | "would_match" | "skipped_stale" | "skipped_already" | "skipped_closed" | "needs_fee_account" | "failed";
  detail?: string;
  /** The fee/adjustment absorbed to keep the deposit total unchanged. */
  feeAmount?: number;
}

/**
 * MATCH the bank deposit to the invoice's payment — the QBO-native fix, and the
 * one a bookkeeper would do by hand (Mike 2026-07-28: "there is a feature in
 * QBO which matches deposit to invoice, which then clears the UF").
 *
 * The setup we're correcting: the CRM pushed an Invoice AND a Payment that
 * landed in Undeposited Funds and was never deposited, while the real bank
 * deposit got categorized straight to an income account. Revenue counts twice
 * and UF carries a stuck balance.
 *
 * The fix rewrites ONE line on the existing deposit:
 *   income line (amount L)  →  LinkedTxn line to the Payment (amount P)
 *                              + balancing fee line (L − P) when they differ
 *
 * Because L is preserved, the deposit TOTAL never changes — bank reconciliation
 * is untouched. The payment leaves UF, the invoice stays PAID, revenue is
 * recognized once (off the invoice), and nothing is voided or destroyed. This
 * is strictly better than voiding the invoice (which guts A/R history) or
 * repointing to an A/R credit (which depends on "auto-apply credits" being on).
 *
 * P > L is the normal case: the customer paid P, the processor kept a fee, the
 * bank received L. The gap is booked to the fee account so the books explain it.
 */
export async function matchDepositToInvoicePayment(params: {
  realm: string;
  token: string;
  invoiceId: string;
  /** The UF payment(s) on this invoice — matched into the deposit, not voided. */
  payments: Array<{ id: string; amount: number }>;
  /** The bank deposit whose income line is the duplicate. */
  deposit: { txn_id: string; account: string; amount: number };
  /** Absorbs any payment-vs-deposit gap (processing fees). */
  feeAccount: { id: string; name: string } | null;
  dryRun: boolean;
  closingDate: string | null;
  snapshot: (kind: string, id: string, entity: any) => Promise<void>;
}): Promise<MatchOutcome> {
  const { realm, token, invoiceId, payments, deposit, feeAccount, dryRun, closingDate, snapshot } = params;

  if (payments.length === 0) {
    return { invoiceId, outcome: "failed", detail: "no payment to match — nothing sits in Undeposited Funds for this invoice" };
  }

  let entity: any;
  try {
    const data = await qboRequest<any>(realm, token, `/deposit/${deposit.txn_id}?minorversion=70`);
    entity = data?.Deposit;
  } catch (e: any) {
    return { invoiceId, outcome: "failed", detail: `deposit fetch: ${String(e?.message || e).slice(0, 200)}` };
  }
  if (!entity) return { invoiceId, outcome: "failed", detail: "deposit not found" };

  const note0 = String(entity.PrivateNote || "");
  if (note0.includes(MATCH_MEMO)) return { invoiceId, outcome: "skipped_already" };
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

  // L = what the bank received for this revenue; P = what the customer paid.
  const L = r2(Number(lines[idx].Amount));
  const P = r2(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const gap = r2(L - P); // negative when a fee was withheld
  if (gap !== 0 && !feeAccount) {
    return {
      invoiceId,
      outcome: "needs_fee_account",
      detail: `payment ${P.toFixed(2)} vs deposit ${L.toFixed(2)} differs by ${Math.abs(gap).toFixed(2)} (likely a processing fee) — no merchant/bank-fee account found in this chart to absorb it`,
      feeAmount: gap,
    };
  }

  if (dryRun) {
    return {
      invoiceId,
      outcome: "would_match",
      feeAmount: gap,
      detail: gap === 0
        ? `would match payment ${P.toFixed(2)} to deposit ${deposit.txn_id}`
        : `would match payment ${P.toFixed(2)} to deposit ${deposit.txn_id} + ${Math.abs(gap).toFixed(2)} fee to ${feeAccount!.name}`,
    };
  }

  try {
    await snapshot("Deposit", deposit.txn_id, entity);

    // Replace the duplicate income line with the UF link (+ fee balancer).
    const replacement: any[] = payments.map((p) => ({
      Amount: r2(p.amount),
      DetailType: "DepositLineDetail",
      // No DepositLineDetail.AccountRef — LinkedTxn is what pulls the payment
      // out of Undeposited Funds (same shape createDeposit uses).
      LinkedTxn: [{ TxnId: p.id, TxnType: "Payment" }],
    }));
    if (gap !== 0) {
      replacement.push({
        Amount: gap,
        DetailType: "DepositLineDetail",
        Description: "Processing fee withheld on customer payment (SNAP match)",
        DepositLineDetail: { AccountRef: { value: feeAccount!.id, name: feeAccount!.name } },
      });
    }
    const newLines = [...lines.slice(0, idx), ...replacement, ...lines.slice(idx + 1)];

    const { MetaData: _m, domain: _d, TotalAmt: _t, ...core } = entity;
    const note = note0 ? `${note0}\n${MATCH_MEMO} (Invoice ${invoiceId})` : `${MATCH_MEMO} (Invoice ${invoiceId})`;
    await qboRequest(realm, token, `/deposit?operation=update&minorversion=70`, {
      method: "POST",
      body: JSON.stringify({ ...core, Line: newLines, PrivateNote: note, sparse: false }),
    });

    // Honest post-state: the payment should now carry a Deposit link (UF clear)
    // and the invoice should still read PAID.
    let ufCleared: boolean | null = null;
    let invoicePaid: boolean | null = null;
    try {
      const pid = payments[0].id;
      const pd = await qboRequest<any>(
        realm, token, `/query?query=${encodeURIComponent(`SELECT * FROM Payment WHERE Id = '${pid}' MAXRESULTS 1`)}`
      );
      const pay = pd?.QueryResponse?.Payment?.[0];
      if (pay) {
        ufCleared = ((pay.Line || []) as any[]).some((l) =>
          ((l.LinkedTxn || []) as any[]).some((lt) => /deposit/i.test(String(lt.TxnType)))
        );
      }
      const inv = await qboRequest<any>(
        realm, token, `/query?query=${encodeURIComponent(`SELECT Id, Balance FROM Invoice WHERE Id = '${invoiceId}' MAXRESULTS 1`)}`
      );
      const bal = Number(inv?.QueryResponse?.Invoice?.[0]?.Balance);
      if (Number.isFinite(bal)) invoicePaid = bal <= 0.005;
    } catch {
      /* verification reads are best-effort */
    }

    const bits = [`payment ${P.toFixed(2)} matched to deposit ${deposit.txn_id}`];
    if (gap !== 0) bits.push(`${Math.abs(gap).toFixed(2)} fee → ${feeAccount!.name}`);
    if (ufCleared === true) bits.push("UF cleared");
    else if (ufCleared === false) bits.push("payment still shows in UF — verify in QBO");
    if (invoicePaid === false) bits.push("invoice no longer reads paid — verify in QBO");
    return { invoiceId, outcome: "matched", feeAmount: gap, detail: bits.join(" · ") };
  } catch (e: any) {
    return { invoiceId, outcome: "failed", detail: String(e?.message || e).slice(0, 300) };
  }
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
