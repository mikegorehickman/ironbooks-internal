/**
 * Undeposited Funds → Accounts Receivable matcher.
 *
 * For each UF Payment that hasn't been applied to an invoice yet, try
 * to find the open Invoice it almost certainly belongs to. Returns
 * one MatchResult per UF Payment, sorted by descending confidence:
 *
 *   exact_invoice_number — UF memo says "INV-1234" and we have an
 *     open invoice with DocNumber=1234. Highest confidence (0.99).
 *
 *   high_confidence — same customer + exact amount match (single
 *     candidate within ±30 days). Bookkeeper can auto-approve in
 *     bulk.
 *
 *   low_confidence — same customer + amount match (but multiple
 *     candidates), OR customer match + approximate amount, OR
 *     customer name only. Recommendation only; bookkeeper picks.
 *
 *   unmatched — no candidates worth surfacing. Bookkeeper handles
 *     manually or writes off.
 *
 * Match output also includes the full candidate pool for the same
 * customer (so the review UI can render a picker when the suggestion
 * isn't right).
 */

import type { UFPayment, OpenInvoice } from "./qbo-balance-sheet";

const DATE_WINDOW_DAYS = 30;
const AMOUNT_TOLERANCE_DOLLARS = 0.5; // round-off margin

export type MatchKind =
  | "exact_invoice_number"
  | "high_confidence"
  | "low_confidence"
  | "unmatched";

export interface CandidateInvoice {
  qbo_invoice_id: string;
  doc_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  txn_date: string;
  balance: number;
  total_amount: number;
  /** Why this candidate is being suggested (for the bookkeeper). */
  reason: string;
}

export interface MatchResult {
  payment: UFPayment;
  kind: MatchKind;
  confidence: number;
  reasoning: string;
  proposed: CandidateInvoice[];    // 1 invoice for confident matches; the AI's pick for low_confidence
  candidates: CandidateInvoice[];  // full pool considered (for manual picker)
}

function daysBetween(aISO: string, bISO: string): number {
  const a = new Date(aISO).getTime();
  const b = new Date(bISO).getTime();
  return Math.abs(a - b) / 86400000;
}

function withinTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= AMOUNT_TOLERANCE_DOLLARS;
}

function normalizeCustomer(name: string | null | undefined): string {
  return (name || "")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co\.?|the)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchUFtoAR(
  payments: UFPayment[],
  invoices: OpenInvoice[]
): MatchResult[] {
  // Pre-index invoices for fast lookup
  const invoicesByCustomerId = new Map<string, OpenInvoice[]>();
  const invoicesByCustomerName = new Map<string, OpenInvoice[]>();
  const invoiceByDocNumber = new Map<string, OpenInvoice>();

  for (const inv of invoices) {
    if (inv.customer_id) {
      const arr = invoicesByCustomerId.get(inv.customer_id) || [];
      arr.push(inv);
      invoicesByCustomerId.set(inv.customer_id, arr);
    }
    const normName = normalizeCustomer(inv.customer_name);
    if (normName) {
      const arr = invoicesByCustomerName.get(normName) || [];
      arr.push(inv);
      invoicesByCustomerName.set(normName, arr);
    }
    if (inv.doc_number) {
      invoiceByDocNumber.set(inv.doc_number.trim(), inv);
    }
  }

  const results: MatchResult[] = [];

  for (const pay of payments) {
    if (pay.already_applied) continue;

    // Pool of plausible candidates for this customer (used by every kind).
    let pool: OpenInvoice[] = [];
    if (pay.customer_id && invoicesByCustomerId.has(pay.customer_id)) {
      pool = invoicesByCustomerId.get(pay.customer_id)!;
    } else if (pay.customer_name) {
      const norm = normalizeCustomer(pay.customer_name);
      if (norm && invoicesByCustomerName.has(norm)) {
        pool = invoicesByCustomerName.get(norm)!;
      }
    }

    const candidates: CandidateInvoice[] = pool.map((inv) => ({
      qbo_invoice_id: inv.qbo_invoice_id,
      doc_number: inv.doc_number,
      customer_id: inv.customer_id,
      customer_name: inv.customer_name,
      txn_date: inv.txn_date,
      balance: inv.balance,
      total_amount: inv.total_amount,
      reason: "",
    }));

    // ── 1. EXACT INVOICE NUMBER MATCH (memo says INV-1234) ──
    if (pay.invoice_reference) {
      const hit = invoiceByDocNumber.get(pay.invoice_reference.trim());
      if (hit) {
        // Bonus check: amounts should at least be in the same ballpark.
        // (Cap < $0.50 means very high confidence; mismatch means it
        // might be a partial payment / over-payment — still propose.)
        const amountMatches = withinTolerance(pay.amount, hit.balance);
        const reason = amountMatches
          ? `Memo references invoice #${pay.invoice_reference}; amount matches outstanding balance`
          : `Memo references invoice #${pay.invoice_reference}; amount ($${pay.amount.toFixed(2)}) doesn't exactly match outstanding balance ($${hit.balance.toFixed(2)}) — partial payment or over-payment`;
        const proposed: CandidateInvoice = {
          qbo_invoice_id: hit.qbo_invoice_id,
          doc_number: hit.doc_number,
          customer_id: hit.customer_id,
          customer_name: hit.customer_name,
          txn_date: hit.txn_date,
          balance: hit.balance,
          total_amount: hit.total_amount,
          reason,
        };
        results.push({
          payment: pay,
          kind: "exact_invoice_number",
          confidence: amountMatches ? 0.99 : 0.9,
          reasoning: reason,
          proposed: [proposed],
          candidates,
        });
        continue;
      }
    }

    // No customer linkage and no invoice ref — nothing we can do.
    if (pool.length === 0) {
      results.push({
        payment: pay,
        kind: "unmatched",
        confidence: 0,
        reasoning: pay.customer_name
          ? `No open invoices found for ${pay.customer_name}. Customer may have no outstanding balance, or this payment is unrelated (refund, deposit, etc.).`
          : `Payment has no customer attached in QBO and no invoice number in the memo. Manual triage needed.`,
        proposed: [],
        candidates,
      });
      continue;
    }

    // ── 2. CUSTOMER + EXACT AMOUNT MATCH ──
    const exactAmount = pool.filter((inv) => withinTolerance(inv.balance, pay.amount));
    if (exactAmount.length === 1) {
      const inv = exactAmount[0];
      const dDays = daysBetween(pay.date, inv.txn_date);
      const closeDate = dDays <= DATE_WINDOW_DAYS;
      const reason = closeDate
        ? `Single open invoice for ${pay.customer_name} matching the exact amount, invoiced ${Math.round(dDays)} days ${new Date(inv.txn_date) <= new Date(pay.date) ? "before" : "after"} this payment`
        : `Single open invoice for ${pay.customer_name} matching the exact amount, but invoiced ${Math.round(dDays)} days from the payment date (worth a quick eyeball)`;
      const proposed: CandidateInvoice = {
        qbo_invoice_id: inv.qbo_invoice_id,
        doc_number: inv.doc_number,
        customer_id: inv.customer_id,
        customer_name: inv.customer_name,
        txn_date: inv.txn_date,
        balance: inv.balance,
        total_amount: inv.total_amount,
        reason,
      };
      results.push({
        payment: pay,
        kind: "high_confidence",
        confidence: closeDate ? 0.95 : 0.85,
        reasoning: reason,
        proposed: [proposed],
        candidates,
      });
      continue;
    }

    // ── 3. MULTIPLE EXACT-AMOUNT MATCHES (ambiguous) ──
    if (exactAmount.length > 1) {
      // Pick the one closest in date as the AI's suggestion, but
      // surface all candidates with their amount-match note.
      const sorted = [...exactAmount].sort(
        (a, b) => daysBetween(pay.date, a.txn_date) - daysBetween(pay.date, b.txn_date)
      );
      const pick = sorted[0];
      const proposed: CandidateInvoice = {
        qbo_invoice_id: pick.qbo_invoice_id,
        doc_number: pick.doc_number,
        customer_id: pick.customer_id,
        customer_name: pick.customer_name,
        txn_date: pick.txn_date,
        balance: pick.balance,
        total_amount: pick.total_amount,
        reason: `${exactAmount.length} open invoices for ${pay.customer_name} match this amount — picking the closest by date. Confirm which one this payment is for.`,
      };
      results.push({
        payment: pay,
        kind: "low_confidence",
        confidence: 0.6,
        reasoning: `${exactAmount.length} open invoices for ${pay.customer_name} all match the exact amount $${pay.amount.toFixed(2)}. Bookkeeper needs to pick.`,
        proposed: [proposed],
        candidates: candidates.map((c) => ({
          ...c,
          reason: withinTolerance(c.balance, pay.amount)
            ? `Exact amount match`
            : c.reason,
        })),
      });
      continue;
    }

    // ── 4. CUSTOMER MATCH BUT NO AMOUNT HIT ──
    // Suggest the oldest open invoice as a hint, but flag low confidence.
    const sortedByAge = [...pool].sort((a, b) =>
      a.txn_date.localeCompare(b.txn_date)
    );
    const hint = sortedByAge[0];
    const reason = `${pay.customer_name} has ${pool.length} open invoice${pool.length === 1 ? "" : "s"} totaling $${pool.reduce((s, i) => s + i.balance, 0).toFixed(2)}, but none exactly match this $${pay.amount.toFixed(2)} payment. Could be a partial payment, an overpayment, or unrelated.`;
    const proposed: CandidateInvoice = {
      qbo_invoice_id: hint.qbo_invoice_id,
      doc_number: hint.doc_number,
      customer_id: hint.customer_id,
      customer_name: hint.customer_name,
      txn_date: hint.txn_date,
      balance: hint.balance,
      total_amount: hint.total_amount,
      reason: `Oldest open invoice for ${pay.customer_name} — typical first guess for partial payments.`,
    };
    results.push({
      payment: pay,
      kind: "low_confidence",
      confidence: 0.4,
      reasoning: reason,
      proposed: [proposed],
      candidates,
    });
  }

  // Sort by confidence desc so the review UI shows the easiest decisions first.
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}
