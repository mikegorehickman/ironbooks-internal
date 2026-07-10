/**
 * Structured metadata stored in proposed_entries.ai_reasoning (JSON).
 */

import type { MatchKind } from "@/lib/uf-ar-matcher";

export interface UfEntryMeta {
  v: 1;
  type: "uf_match";
  kind: MatchKind;
  reasoning: string;
  customer_name: string | null;
  payment_id: string;
  proposed_invoice_id: string | null;
  proposed_doc_number: string | null;
  candidates: Array<{
    qbo_invoice_id: string;
    doc_number: string | null;
    balance: number;
    customer_name: string | null;
    txn_date: string;
  }>;
}

export interface ArDuplicateMeta {
  v: 1;
  type: "ar_duplicate";
  reasoning: string;
  survivor_invoice_id: string;
  survivor_doc_number: string | null;
  confidence: number;
}

export interface ApMatchMeta {
  v: 1;
  type: "ap_match";
  kind: string; // exact_amount | amount_within_window | unmatched
  reasoning: string;
  vendor_name: string | null;
  bill_payment_id: string;
  proposed_bill_id: string | null;
  proposed_doc_number: string | null;
  amount_applied: number;
}

/** AR Aging Cleanup — in-scope invoice cleared via a NEW Receive Payment to
 *  the Uncleared Deposits clearing account. The entry's qbo_transaction_id
 *  is the INVOICE id (no payment exists yet — creating one IS the action)
 *  and to_account_id/name carry the deposit-to clearing account. */
export interface ArAgingClearMeta {
  v: 1;
  type: "ar_aging_clear";
  invoice_doc: string | null;
  customer_id: string;
  customer_name: string | null;
  year: number;
  /** True when an uploaded bank-deposit row matched this invoice's balance. */
  verified: boolean;
  deposit_rows_uploaded: number;
}

/** AR Aging Cleanup — pre-engagement year written off in one lump JE. */
export interface ArAgingWriteoffMeta {
  v: 1;
  type: "ar_aging_writeoff";
  year: number;
  invoice_count: number;
  customer_count: number;
}

export type ProposedEntryMeta =
  | UfEntryMeta
  | ArDuplicateMeta
  | ApMatchMeta
  | ArAgingClearMeta
  | ArAgingWriteoffMeta;

export function serializeMeta(meta: ProposedEntryMeta): string {
  return JSON.stringify(meta);
}

export function parseEntryMeta(
  aiReasoning: string | null | undefined
): ProposedEntryMeta | null {
  if (!aiReasoning) return null;
  try {
    const parsed = JSON.parse(aiReasoning);
    if (
      parsed?.v === 1 &&
      ["uf_match", "ar_duplicate", "ap_match", "ar_aging_clear", "ar_aging_writeoff"].includes(
        parsed.type
      )
    ) {
      return parsed;
    }
  } catch {
    /* legacy plain-text reasoning */
  }
  return null;
}

export function ufKindToDecision(kind: MatchKind): string {
  switch (kind) {
    case "exact_invoice_number":
    case "high_confidence":
      return "auto_approve";
    case "low_confidence":
      return "needs_review";
    case "unmatched":
      return "flagged";
    default:
      return "needs_review";
  }
}

export function duplicateConfidenceToDecision(confidence: number): string {
  if (confidence >= 0.9) return "auto_approve";
  if (confidence >= 0.75) return "needs_review";
  return "flagged";
}
