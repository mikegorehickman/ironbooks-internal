/**
 * UCPI (Unapplied Cash Payment Income) resolution
 * -----------------------------------------------
 * When a customer PAYMENT is received but not applied to an invoice, QBO parks
 * it on the "Unapplied Cash Payment Income" system account — so cash-basis
 * income counts money that may not be earned yet. Each unapplied payment is
 * either:
 *   (a) EARNED — the job's done and there's an open invoice → apply the payment
 *       to that invoice (it moves out of UCPI into real revenue), or
 *   (b) A DEPOSIT for future work → it's unearned; move it to a balance-sheet
 *       Customer-Deposits liability, NOT income, or
 *   (c) NOT actually collected → void it (it shouldn't be recognized at all).
 *
 * The client answers two questions ("collected?" and "deposit or job done?");
 * this module locates the unapplied payments + their candidate invoices and
 * turns an answer into a resolution plan. PURE — the caller fetches the QBO
 * Payment/Invoice entities and executes the plan.
 *
 * Overlaps the CRM-invoice remediation engine (same Payment/Invoice objects);
 * the "apply" and "void" branches reuse that engine's writers.
 */

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface UcpiPayment {
  payment_id: string;
  customer: string | null;
  customer_id: string | null;
  date: string;
  total: number;
  /** UnappliedAmt — the portion sitting in UCPI. */
  unapplied: number;
  /** Where the cash landed (DepositToAccountRef.name) — null = Undeposited Funds. */
  deposit_account: string | null;
  method: string | null;
}

export interface UcpiOpenInvoice {
  invoice_id: string;
  doc_number: string | null;
  date: string;
  /** Open balance still owed. */
  balance: number;
  total: number;
}

export interface UcpiItem {
  customer: string | null;
  customer_id: string | null;
  /** Sum of unapplied across this customer's payments. */
  unapplied_total: number;
  payments: UcpiPayment[];
  /** This customer's open invoices — the candidates to apply the payment to. */
  open_invoices: UcpiOpenInvoice[];
  /** True when there's at least one open invoice (the "earned" path is available). */
  has_open_invoices: boolean;
}

/** Raw QBO Payment entities → the ones carrying an unapplied balance. */
export function extractUnappliedPayments(payments: any[]): UcpiPayment[] {
  const out: UcpiPayment[] = [];
  for (const p of payments || []) {
    const unapplied = Number(p?.UnappliedAmt) || 0;
    if (unapplied <= 0.005) continue;
    out.push({
      payment_id: String(p.Id),
      customer: p?.CustomerRef?.name ?? null,
      customer_id: p?.CustomerRef?.value != null ? String(p.CustomerRef.value) : null,
      date: p?.TxnDate || "",
      total: r2(p?.TotalAmt),
      unapplied: r2(unapplied),
      deposit_account: p?.DepositToAccountRef?.name ?? null,
      method: p?.PaymentMethodRef?.name ?? null,
    });
  }
  return out;
}

/** Raw QBO Invoice entities → the ones still open (balance > 0). */
export function extractOpenInvoices(invoices: any[]): UcpiOpenInvoice[] {
  const out: UcpiOpenInvoice[] = [];
  for (const inv of invoices || []) {
    const balance = Number(inv?.Balance) || 0;
    if (balance <= 0.005) continue;
    out.push({
      invoice_id: String(inv.Id),
      doc_number: inv?.DocNumber ?? null,
      date: inv?.TxnDate || "",
      balance: r2(balance),
      total: r2(inv?.TotalAmt),
    });
  }
  return out;
}

/** Group unapplied payments by customer + attach each customer's open invoices. */
export function buildUcpiItems(
  payments: UcpiPayment[],
  openInvoices: (UcpiOpenInvoice & { customer_id?: string | null })[]
): UcpiItem[] {
  const invByCustomer = new Map<string, UcpiOpenInvoice[]>();
  for (const inv of openInvoices) {
    const cid = String((inv as any).customer_id ?? "");
    if (!cid) continue;
    const list = invByCustomer.get(cid) || [];
    list.push(inv);
    invByCustomer.set(cid, list);
  }

  const byCustomer = new Map<string, UcpiItem>();
  for (const p of payments) {
    const key = p.customer_id || `name:${(p.customer || "").toLowerCase()}` || `pmt:${p.payment_id}`;
    const item = byCustomer.get(key) || {
      customer: p.customer,
      customer_id: p.customer_id,
      unapplied_total: 0,
      payments: [],
      open_invoices: p.customer_id ? (invByCustomer.get(p.customer_id) || []).slice() : [],
      has_open_invoices: false,
    };
    item.payments.push(p);
    item.unapplied_total = r2(item.unapplied_total + p.unapplied);
    item.has_open_invoices = item.open_invoices.length > 0;
    byCustomer.set(key, item);
  }
  // Oldest open invoice first (the natural one to apply an unapplied payment to).
  for (const item of byCustomer.values()) {
    item.open_invoices.sort((a, b) => a.date.localeCompare(b.date));
  }
  return [...byCustomer.values()].sort((a, b) => b.unapplied_total - a.unapplied_total);
}

/** The two questions the client answers, per Mike's spec. */
export interface UcpiAnswer {
  /** Q1 — has the money actually been collected? */
  collected: boolean;
  /** Q2 — only meaningful when collected: is it a deposit for a future job, or
   *  is the job completed (earned)? */
  kind?: "earned" | "deposit";
}

export type UcpiActionKind = "apply_to_invoice" | "to_deposit_liability" | "void" | "manual";

export interface UcpiResolution {
  action: UcpiActionKind;
  reason: string;
  /** For apply_to_invoice: the invoice(s) to apply the payment onto, oldest first. */
  target_invoices?: UcpiOpenInvoice[];
}

/**
 * PURE branch: turn the client's answer into a resolution plan.
 *   - not collected            → void (never real income)
 *   - collected + job done     → apply to the open invoice(s); manual if none
 *   - collected + future job   → move to Customer-Deposits liability (unearned)
 */
export function planUcpiResolution(item: UcpiItem, answer: UcpiAnswer): UcpiResolution {
  if (!answer.collected) {
    return { action: "void", reason: "Client says it was never collected — void the unapplied payment so it stops counting as income." };
  }
  if (answer.kind === "deposit") {
    return { action: "to_deposit_liability", reason: "Deposit for a future job — unearned. Move to the Customer Deposits balance-sheet liability (not revenue)." };
  }
  if (answer.kind === "earned") {
    if (item.open_invoices.length === 0) {
      return { action: "manual", reason: "Job done but no open invoice to apply the payment to — create/find the invoice in QBO, then apply." };
    }
    return {
      action: "apply_to_invoice",
      reason: `Job done — apply the payment to ${item.open_invoices.length === 1 ? "the open invoice" : "the open invoice(s), oldest first"} so it lands in real revenue.`,
      target_invoices: item.open_invoices,
    };
  }
  return { action: "manual", reason: "Collected, but the client hasn't said whether it's a deposit or a completed job." };
}
