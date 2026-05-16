/**
 * Claude AI: Match Stripe deposits to customer invoices.
 *
 * Strategy:
 *  1. Build candidate invoices/payments per deposit using a ±7-day window.
 *  2. Ask Claude to pick the subset whose amounts best add up to the deposit
 *     (allowing the Stripe fee discrepancy: typically 2.9% + $0.30 per charge).
 *  3. Compute the discrepancy = matched_invoice_total − deposit_amount = fee.
 *  4. For Canada: split fee into pre-tax + tax using province rate.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  StripeDeposit,
  QBOInvoice,
  QBOCustomerPayment,
} from "./qbo-stripe-recon";
import { getProvinceTax, getServiceTaxRate } from "./canadian-tax";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-opus-4-7";

export interface InvoiceMatch {
  invoice_id: string;
  customer_name: string | null;
  /** Gross invoice amount (incl. any tax on the invoice) */
  amount: number;
  /** Pre-tax service revenue portion (calculated from province service-tax rate) */
  pre_tax_amount: number;
  /** Sales tax portion (HST/GST/QST/PST as applicable to services in this province) */
  tax_amount: number;
}

export interface DepositMatch {
  qbo_deposit_id: string;
  deposit_amount: number;
  deposit_date: string;
  deposit_memo: string;
  matched_invoices: InvoiceMatch[];
  matched_customer_names: string[];
  total_invoice_amount: number;
  /** Pre-tax revenue across all matched invoices */
  pre_tax_revenue: number;
  /** Sales tax collected from customers across all matched invoices */
  total_sales_tax_collected: number;
  /** Stripe processing fee (pre-tax for Canada, all-in for US) */
  computed_fee: number;
  /** ITC on Stripe fee (Canada only) */
  computed_tax: number;
  tax_code: string | null;
  ai_confidence: number;
  ai_reasoning: string;
  decision: "auto_approve" | "needs_review" | "flagged";
}

const SYSTEM_PROMPT = `You are the IronBooks AI Bookkeeper performing Stripe AR reconciliation for a residential painting contractor.

You will receive a Stripe deposit and a small pool of candidate invoices/customer-payments from the ±7-day window around it. Your job: pick the subset of invoices (or customer payments) whose amounts best add up to the deposit amount, allowing for Stripe processing fees.

STRIPE FEE EXPECTATIONS (loose, do NOT enforce strictly):
- Standard US/CA Stripe fees: 2.9% + $0.30 per successful card charge
- For a single-charge $1,000 deposit: expect ~$36 fee (deposit will be ~$964 not $1,000)
- For a 5-charge $5,000 batch: expect ~$160 fee total
- A "discrepancy" of 1.5%-4.5% of the gross invoice total is normal Stripe fee territory

RULES:
1. Pick the smallest plausible subset of invoices/payments that sum close to (deposit + plausible fees).
2. Prefer customer payments with linked invoices over raw invoices when both available.
3. Confidence 0.90+ when the fee discrepancy is in the standard Stripe range (2-4% of gross).
4. Confidence 0.70-0.89 when fee is plausible but discrepancy is outside the normal range.
5. Confidence <0.70 means flag — no reasonable match found.
6. NEVER invent invoices. Only pick from the provided candidates.
7. Reasoning: ONE sentence, mention which customers and the implied fee %.

Return STRICTLY valid JSON:
{
  "matches": [
    {
      "qbo_deposit_id": "string",
      "matched_invoice_ids": ["string"],
      "confidence": 0.00-1.00,
      "reasoning": "string"
    }
  ]
}

No markdown, no preamble.`;

const BATCH_SIZE = 10;          // deposits per Claude call
const CANDIDATE_WINDOW_DAYS = 7;

export async function matchStripeDeposits(params: {
  clientName: string;
  jurisdiction: "US" | "CA";
  stateProvince: string;
  deposits: StripeDeposit[];
  invoices: QBOInvoice[];
  payments: QBOCustomerPayment[];
  autoApproveThreshold: number;   // confidence threshold for auto-approve
}): Promise<{
  matches: DepositMatch[];
  warnings: string[];
  summary: string;
}> {
  const allMatches: DepositMatch[] = [];
  const warnings: string[] = [];

  // Province tax setup (Canada only)
  const provinceTax = params.jurisdiction === "CA" ? getProvinceTax(params.stateProvince) : null;
  // Service-tax rate is the rate that actually applies to painting services
  // (BC/MB exempt PST/RST on labor; SK includes PST; etc.)
  const serviceTaxRate = params.jurisdiction === "CA" ? getServiceTaxRate(params.stateProvince) : 0;
  const taxCode = provinceTax?.serviceTax.components.join(" + ") || null;

  const invoiceById = new Map(params.invoices.map((i) => [i.id, i]));

  // Helper: candidate invoices within ±7 days of a deposit
  function candidatesFor(deposit: StripeDeposit) {
    const depD = new Date(deposit.date);
    const minD = new Date(depD); minD.setUTCDate(minD.getUTCDate() - CANDIDATE_WINDOW_DAYS);
    const maxD = new Date(depD); maxD.setUTCDate(maxD.getUTCDate() + CANDIDATE_WINDOW_DAYS);

    const invs = params.invoices.filter((inv) => {
      const d = new Date(inv.txn_date);
      return d >= minD && d <= maxD;
    });
    const pays = params.payments.filter((p) => {
      const d = new Date(p.txn_date);
      return d >= minD && d <= maxD;
    });
    return { invs, pays };
  }

  // Batch by deposit count
  for (let i = 0; i < params.deposits.length; i += BATCH_SIZE) {
    const batch = params.deposits.slice(i, i + BATCH_SIZE);

    const compactBatch = batch.map((d) => {
      const { invs, pays } = candidatesFor(d);
      return {
        qbo_deposit_id: d.qbo_deposit_id,
        amount: d.amount,
        date: d.date,
        memo: d.memo.slice(0, 200),
        candidate_invoices: invs.slice(0, 40).map((inv) => ({
          id: inv.id,
          customer: inv.customer_name,
          date: inv.txn_date,
          amount: inv.total_amount,
          balance: inv.balance,
          status: inv.status,
        })),
        candidate_payments: pays.slice(0, 40).map((p) => ({
          id: p.id,
          customer: p.customer_name,
          date: p.txn_date,
          amount: p.total_amount,
          method: p.payment_method,
          linked_invoice_ids: p.linked_invoice_ids,
        })),
      };
    });

    const userMessage = `CLIENT: ${params.clientName}
JURISDICTION: ${params.jurisdiction} (${params.stateProvince})

===== STRIPE DEPOSITS TO MATCH (batch: ${batch.length}) =====
${JSON.stringify(compactBatch, null, 2)}

Match each deposit to its underlying invoice(s). Return JSON only.`;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = response.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      warnings.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: no text response`);
      continue;
    }

    const raw = textBlock.text
      .trim()
      .replace(/^```json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/\s*```$/, "")
      .trim();

    let parsed: {
      matches: Array<{
        qbo_deposit_id: string;
        matched_invoice_ids: string[];
        confidence: number;
        reasoning: string;
      }>;
    };
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      warnings.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: JSON parse failed (${err.message})`);
      continue;
    }

    for (const m of parsed.matches || []) {
      const deposit = batch.find((d) => d.qbo_deposit_id === m.qbo_deposit_id);
      if (!deposit) continue;

      const confidence = Math.max(0, Math.min(1, m.confidence));
      const matchedInvoices: InvoiceMatch[] = [];
      for (const invId of m.matched_invoice_ids || []) {
        const inv = invoiceById.get(invId);
        if (!inv) continue;

        // Decompose invoice total into pre-tax revenue + sales tax collected.
        // Prefer QBO's actual tax detail if present; otherwise derive from the
        // province's service-tax rate (PST-exempt provinces will get tax=0 on labor).
        let preTax: number;
        let taxAmount: number;
        if (inv.qbo_total_tax > 0) {
          // Use QBO's recorded tax — most accurate
          taxAmount = inv.qbo_total_tax;
          preTax = inv.total_amount - taxAmount;
        } else if (serviceTaxRate > 0) {
          // Back out the service-tax rate from the gross
          preTax = inv.total_amount / (1 + serviceTaxRate);
          taxAmount = inv.total_amount - preTax;
        } else {
          // US or no-tax province
          preTax = inv.total_amount;
          taxAmount = 0;
        }

        matchedInvoices.push({
          invoice_id: inv.id,
          customer_name: inv.customer_name,
          amount: Number(inv.total_amount.toFixed(2)),
          pre_tax_amount: Number(preTax.toFixed(2)),
          tax_amount: Number(taxAmount.toFixed(2)),
        });
      }

      const totalInvoiceAmount = matchedInvoices.reduce((s, x) => s + x.amount, 0);
      const preTaxRevenue = matchedInvoices.reduce((s, x) => s + x.pre_tax_amount, 0);
      const totalSalesTaxCollected = matchedInvoices.reduce((s, x) => s + x.tax_amount, 0);

      // Stripe fee = invoice total - deposit amount (the "discrepancy")
      // The fee itself is taxed in Canada (tax on processing services). Split it.
      const grossDiscrepancy = Math.max(0, totalInvoiceAmount - deposit.amount);
      const preTaxFee =
        serviceTaxRate > 0
          ? grossDiscrepancy / (1 + serviceTaxRate)
          : grossDiscrepancy;
      const computedTax = grossDiscrepancy - preTaxFee;

      const customerNames = Array.from(
        new Set(matchedInvoices.map((m) => m.customer_name).filter(Boolean) as string[])
      );

      // Decision: auto_approve only when fee is in the normal Stripe range (1.5%-4.5% of gross)
      // AND AI confidence >= threshold.
      let decision: "auto_approve" | "needs_review" | "flagged" = "needs_review";
      if (matchedInvoices.length === 0 || totalInvoiceAmount === 0) {
        decision = "flagged";
      } else {
        const feePct = grossDiscrepancy / totalInvoiceAmount;
        const inExpectedFeeRange = feePct >= 0.005 && feePct <= 0.055;
        if (confidence >= params.autoApproveThreshold && inExpectedFeeRange) {
          decision = "auto_approve";
        } else if (confidence < 0.65) {
          decision = "flagged";
        }
      }

      allMatches.push({
        qbo_deposit_id: deposit.qbo_deposit_id,
        deposit_amount: deposit.amount,
        deposit_date: deposit.date,
        deposit_memo: deposit.memo,
        matched_invoices: matchedInvoices,
        matched_customer_names: customerNames,
        total_invoice_amount: Number(totalInvoiceAmount.toFixed(2)),
        pre_tax_revenue: Number(preTaxRevenue.toFixed(2)),
        total_sales_tax_collected: Number(totalSalesTaxCollected.toFixed(2)),
        computed_fee: Number(preTaxFee.toFixed(2)),
        computed_tax: Number(computedTax.toFixed(2)),
        tax_code: taxCode,
        ai_confidence: confidence,
        ai_reasoning: m.reasoning || "",
        decision,
      });
    }
  }

  // Fill in deposits Claude didn't return for (rare; usually flagged)
  for (const dep of params.deposits) {
    if (allMatches.find((m) => m.qbo_deposit_id === dep.qbo_deposit_id)) continue;
    allMatches.push({
      qbo_deposit_id: dep.qbo_deposit_id,
      deposit_amount: dep.amount,
      deposit_date: dep.date,
      deposit_memo: dep.memo,
      matched_invoices: [],
      matched_customer_names: [],
      total_invoice_amount: 0,
      pre_tax_revenue: 0,
      total_sales_tax_collected: 0,
      computed_fee: 0,
      computed_tax: 0,
      tax_code: taxCode,
      ai_confidence: 0,
      ai_reasoning: "No matching invoices identified.",
      decision: "flagged",
    });
  }

  const counts = {
    auto: allMatches.filter((m) => m.decision === "auto_approve").length,
    review: allMatches.filter((m) => m.decision === "needs_review").length,
    flagged: allMatches.filter((m) => m.decision === "flagged").length,
  };

  return {
    matches: allMatches,
    warnings,
    summary: `Matched ${allMatches.length} Stripe deposits: ${counts.auto} auto-approved, ${counts.review} need review, ${counts.flagged} flagged.`,
  };
}
