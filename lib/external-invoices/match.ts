/**
 * Match QBO invoices against ingested Jobber / DripJobs CSV rows so the
 * BS Cleanup gap analyzer can distinguish:
 *
 *   - "Estimate revision" / "Progress billing" — multiple QBO invoices
 *     under one lineage key. Legit; void the OLDER if needed, keep the
 *     newer.
 *   - "Possible duplicate" — multiple QBO invoices for one customer with
 *     NO shared lineage key. Real cleanup candidate.
 *   - "Missing from QBO" — CSV says invoice should exist, QBO has none.
 *   - "No source record" — QBO has an invoice the CSV doesn't know about
 *     (manual entry, pre-Jobber, or sync drift).
 *
 * Matching strategy (per QBO invoice, best-first):
 *   1. external_invoice_id in QBO DocNumber/Memo — exact, 100% confidence
 *   2. customer + amount + date(±3 days)             — high, 95%
 *   3. customer + amount only                         — loose, manual confirm
 *
 * Inputs are kept generic (`QboInvoice` minimal shape) so the caller can
 * pull from any QBO source (live API, cached, mock).
 */

import { normalizeCustomerName, type ParsedRow } from "./parse";

export type QboInvoice = {
  Id: string;
  DocNumber?: string | null;
  CustomerRef?: { value: string; name?: string } | null;
  TotalAmt?: number | null;
  TxnDate?: string | null; // YYYY-MM-DD
  PrivateNote?: string | null;
  CustomerMemo?: { value?: string } | null;
};

export type MatchConfidence = "exact" | "high" | "loose" | "none";

export type MatchedInvoice = {
  qbo_invoice_id: string;
  qbo_doc_number: string | null;
  qbo_customer_name: string | null;
  qbo_amount: number | null;
  qbo_date: string | null;

  matched_row_id: string | null; // external_invoice_rows.id when known
  match_confidence: MatchConfidence;
  match_signal: string; // human-readable why
  lineage_key: string | null; // copied from matched row when applicable
  source: "jobber" | "dripjobs" | null;
};

export type LineageBucket = {
  lineage_key: string;
  customer_name: string;
  source: "jobber" | "dripjobs";
  qbo_invoices: MatchedInvoice[];
  csv_invoices: ParsedRow[];
  // QBO count - CSV count, signed: positive = revision orphans / dupes in QBO,
  // negative = missing-from-QBO
  delta: number;
};

export type GapAnalysis = {
  matched: MatchedInvoice[];
  // QBO invoices with no CSV match (raw QBO duplicates can still hide here)
  unmatched_qbo: MatchedInvoice[];
  // Lineage buckets — each represents a single Jobber Job # or DripJobs
  // Proposal, with its QBO and CSV invoice counts. Buckets with delta > 0
  // are the "estimate revision / progress billing" candidates the gap
  // analyzer should relabel away from "duplicate."
  buckets: LineageBucket[];
};

/**
 * Run the matching. Always returns a complete shape — even if there are
 * no CSV rows, you get back QBO invoices labeled "no source record."
 */
export function matchInvoices(
  qboInvoices: QboInvoice[],
  csvRows: ParsedRow[]
): GapAnalysis {
  const csvInvoiceRows = csvRows.filter((r) => r.row_type === "invoice");

  // Build lookup maps for the three signals
  const byExternalId = new Map<string, ParsedRow & { __rowId?: string }>();
  for (const r of csvInvoiceRows) {
    if (r.external_invoice_id) byExternalId.set(String(r.external_invoice_id), r);
  }

  // Customer+amount+date(±3) lookup — index by (customer, amount) and
  // walk date window at query time. Faster than a full O(N×M) scan.
  const byCustomerAmount = new Map<string, ParsedRow[]>();
  for (const r of csvInvoiceRows) {
    if (!r.customer_name_normalized || r.amount == null) continue;
    const key = `${r.customer_name_normalized}||${r.amount.toFixed(2)}`;
    const arr = byCustomerAmount.get(key) || [];
    arr.push(r);
    byCustomerAmount.set(key, arr);
  }

  // Customer-only fallback
  const byCustomer = new Map<string, ParsedRow[]>();
  for (const r of csvInvoiceRows) {
    if (!r.customer_name_normalized) continue;
    const arr = byCustomer.get(r.customer_name_normalized) || [];
    arr.push(r);
    byCustomer.set(r.customer_name_normalized, arr);
  }

  // Track which CSV rows have been claimed so we don't double-link
  const claimed = new Set<ParsedRow>();

  const matched: MatchedInvoice[] = [];
  const unmatched: MatchedInvoice[] = [];

  for (const inv of qboInvoices) {
    const qboCustomer = inv.CustomerRef?.name || null;
    const qboCustomerNorm = normalizeCustomerName(qboCustomer);
    const qboAmount = typeof inv.TotalAmt === "number" ? Math.round(inv.TotalAmt * 100) / 100 : null;
    const qboDate = inv.TxnDate || null;

    // ── Signal 1: external_invoice_id in DocNumber or memo ──
    let hit: { row: ParsedRow; confidence: MatchConfidence; signal: string } | null = null;
    const docFields: string[] = [];
    if (inv.DocNumber) docFields.push(inv.DocNumber);
    if (inv.PrivateNote) docFields.push(inv.PrivateNote);
    if (inv.CustomerMemo?.value) docFields.push(inv.CustomerMemo.value);
    const docHaystack = docFields.join(" | ");

    for (const [extId, row] of byExternalId) {
      if (claimed.has(row)) continue;
      if (docHaystack.includes(extId)) {
        hit = { row, confidence: "exact", signal: `external_invoice_id "${extId}" found in DocNumber/memo` };
        break;
      }
    }

    // ── Signal 2: customer + amount + date(±3) ──
    if (!hit && qboCustomerNorm && qboAmount != null) {
      const key = `${qboCustomerNorm}||${qboAmount.toFixed(2)}`;
      const candidates = byCustomerAmount.get(key) || [];
      for (const row of candidates) {
        if (claimed.has(row)) continue;
        if (!row.issue_date || !qboDate) continue;
        const days = daysBetween(row.issue_date, qboDate);
        if (Math.abs(days) <= 3) {
          hit = {
            row,
            confidence: "high",
            signal: `customer + amount match, date within ${Math.abs(days)}d`,
          };
          break;
        }
      }
    }

    // ── Signal 3: customer + amount (no date check) ──
    if (!hit && qboCustomerNorm && qboAmount != null) {
      const key = `${qboCustomerNorm}||${qboAmount.toFixed(2)}`;
      const candidates = byCustomerAmount.get(key) || [];
      for (const row of candidates) {
        if (claimed.has(row)) continue;
        hit = {
          row,
          confidence: "loose",
          signal: `customer + amount match, date outside ±3d window (loose — confirm)`,
        };
        break;
      }
    }

    // ── Signal 4 (last): customer only, ambiguous amount/date ──
    if (!hit && qboCustomerNorm) {
      const candidates = byCustomer.get(qboCustomerNorm) || [];
      for (const row of candidates) {
        if (claimed.has(row)) continue;
        // Only fall through to this if amounts are within 5% (tax differences etc.)
        if (qboAmount != null && row.amount != null) {
          const ratio = Math.abs(row.amount - qboAmount) / Math.max(Math.abs(qboAmount), 0.01);
          if (ratio <= 0.05) {
            hit = {
              row,
              confidence: "loose",
              signal: `customer match, amount within 5% — possible tax / rounding diff`,
            };
            break;
          }
        }
      }
    }

    const matchedInv: MatchedInvoice = {
      qbo_invoice_id: inv.Id,
      qbo_doc_number: inv.DocNumber || null,
      qbo_customer_name: qboCustomer,
      qbo_amount: qboAmount,
      qbo_date: qboDate,
      matched_row_id: null, // populated by caller if rows have ids
      match_confidence: hit ? hit.confidence : "none",
      match_signal: hit ? hit.signal : "No matching CSV record — manual entry, pre-export, or sync drift",
      lineage_key: hit ? hit.row.lineage_key : null,
      source: hit ? sourceOfRow(hit.row) : null,
    };

    if (hit) {
      claimed.add(hit.row);
      matched.push(matchedInv);
    } else {
      unmatched.push(matchedInv);
    }
  }

  // ── Build lineage buckets ──
  // Group every matched invoice by lineage_key + collect the corresponding
  // CSV rows so the UI can show "Job #1 — Jobber has 3, QBO has 5" plainly.
  const bucketMap = new Map<string, LineageBucket>();
  for (const mi of matched) {
    if (!mi.lineage_key) continue;
    let b = bucketMap.get(mi.lineage_key);
    if (!b) {
      b = {
        lineage_key: mi.lineage_key,
        customer_name: mi.qbo_customer_name || "",
        source: mi.source || "jobber",
        qbo_invoices: [],
        csv_invoices: [],
        delta: 0,
      };
      bucketMap.set(mi.lineage_key, b);
    }
    b.qbo_invoices.push(mi);
  }
  // Attach CSV rows to their buckets (including CSV-only ones whose QBO
  // counterpart never matched — these become "missing from QBO")
  for (const row of csvInvoiceRows) {
    if (!row.lineage_key) continue;
    let b = bucketMap.get(row.lineage_key);
    if (!b) {
      b = {
        lineage_key: row.lineage_key,
        customer_name: row.customer_name,
        source: sourceOfRow(row) || "jobber",
        qbo_invoices: [],
        csv_invoices: [],
        delta: 0,
      };
      bucketMap.set(row.lineage_key, b);
    }
    b.csv_invoices.push(row);
  }
  for (const b of bucketMap.values()) {
    b.delta = b.qbo_invoices.length - b.csv_invoices.length;
  }

  return {
    matched,
    unmatched_qbo: unmatched,
    buckets: Array.from(bucketMap.values()).sort((a, b) =>
      a.customer_name.localeCompare(b.customer_name)
    ),
  };
}

// ────────────────────────── helpers ──────────────────────────

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (isNaN(da) || isNaN(db)) return Number.POSITIVE_INFINITY;
  return Math.round((da - db) / 86_400_000);
}

function sourceOfRow(row: ParsedRow): "jobber" | "dripjobs" | null {
  // We don't store source on individual rows — but DripJobs rows have
  // an external_invoice_id while Jobber doesn't. Crude but works for the
  // matcher's purposes; the actual source is also on the parent import row.
  if (row.external_invoice_id) return "dripjobs";
  if (row.lineage_key && /^\D*\|\|\d+$/.test(row.lineage_key)) return "jobber";
  return null;
}
