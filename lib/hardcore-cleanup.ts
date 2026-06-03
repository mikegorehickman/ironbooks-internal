/**
 * Hardcore BS Cleanup — Phase 1
 *
 * Detects phantom-A/R from CRM-migration messes:
 *
 *   1. Parse a CRM CSV export (Drip Jobs / Jobber / generic) — the
 *      bookkeeper's GROUND TRUTH for what jobs actually exist.
 *   2. Pull open + recent QBO invoices.
 *   3. Run duplicate detection: same customer + close-enough amount +
 *      close-enough date but the CRM only shows one real job →
 *      flag the extras as duplicates.
 *   4. Bookkeeper resolves each detected duplicate, finalize pushes
 *      the corrections to QBO (JE write-off or direct void).
 *
 * Two detection paths:
 *   A) Cross-reference (preferred): a CRM job exists → find ≥2 QBO
 *      invoices that match it. All but one are duplicates.
 *   B) Pure heuristic (fallback when no CRM job matches a cluster): if
 *      QBO has ≥2 invoices for the same customer with the same amount
 *      and dates within 14 days, AND the extra invoices have no
 *      separate payments, flag them as likely duplicates with lower
 *      confidence.
 */

import type { OpenInvoice, UFPayment } from "./qbo-balance-sheet";

// ─── TYPES ─────────────────────────────────────────────────────────────

export type CrmSource = "drip_jobs" | "jobber" | "generic";

export interface ParsedCrmJob {
  /** The CRM's own identifier (job #, estimate #, etc.) if present. */
  crm_job_id: string | null;
  job_name: string | null;
  customer_name: string;
  /** Normalized status. Defaults to "active" if we can't tell. */
  job_status: string;
  /** Total job amount (may include revisions — bookkeeper sees raw row too). */
  amount: number | null;
  /** Job creation or completion date — used for matching against QBO TxnDate. */
  job_date: string | null; // YYYY-MM-DD
  /**
   * The CRM's INVOICE ID (distinct from crm_job_id). For DripJobs the
   * Proposal Name is the lineage key across change orders, but the
   * "Invoice ID" column is what gets pushed to QBO as the invoice's
   * DocNumber on sync. Brady Brown / Clean Cut Painters caught this:
   * two of his four proposals synced to QBO (DripJobs Invoice IDs
   * 273312 / 360547 → QBO DocNumber #273312 / #360547), but the matcher
   * couldn't see the link because it only compared customer+amount, not
   * Invoice ID. Treating these as "missing in QBO" was a false positive.
   *
   * Null when the CRM export doesn't include a stable invoice id
   * (Jobber falls back to crm_job_id for this purpose).
   */
  external_invoice_id: string | null;
  /** Original CSV row so we can audit/debug. */
  raw_row: Record<string, string>;
}

export interface DetectedDuplicate {
  /** The QBO invoice we'd write off / void. */
  qbo_invoice: OpenInvoice;
  /** Index into the CRM-jobs array of the matched ground-truth job (or null when path B). */
  matched_crm_job_index: number | null;
  /** The "surviving" QBO invoice — the one we'd KEEP. */
  surviving_qbo_invoice: OpenInvoice;
  confidence: number;     // 0..1
  reasoning: string;
}

// ─── CSV PARSING ──────────────────────────────────────────────────────

/**
 * Lightweight CSV parser. Handles quoted fields with embedded commas and
 * newlines. We're not pulling in papaparse for one feature — this works
 * for any well-formed CSV export from a SaaS tool.
 */
export function parseCsv(input: string): Record<string, string>[] {
  // Strip BOM if present
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      cur.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((c) => !c || c.trim() === "")) continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (row[idx] ?? "").trim();
    });
    out.push(obj);
  }
  return out;
}

// ─── CRM-SPECIFIC NORMALIZERS ─────────────────────────────────────────

/**
 * Column-mapping per CRM. Each value is a list of headers we'll accept
 * (case-insensitive). First match wins. Order matters — put the most
 * specific header first.
 */
const COLUMN_MAPS: Record<CrmSource, Record<keyof Omit<ParsedCrmJob, "raw_row">, string[]>> = {
  drip_jobs: {
    // "Proposal Name" contains the stable proposal/deal/job ID (e.g.
    // "Proposal #1804108", "Deal #2353039", "Job #1741744"). We extract
    // the number via extractProposalId(). This is the SAME ID across
    // a proposal's lifecycle (proposal → deal → job), so multiple CRM
    // rows with the same ID are the same logical project even if their
    // amounts differ — that's a revision/change order, not a duplicate.
    crm_job_id: ["Proposal Name", "Job ID", "JobID", "Estimate #", "Estimate Number", "ID"],
    job_name: ["Proposal Name", "Job Name", "Job Title", "Title", "Description"],
    customer_name: ["Customer", "Customer Name", "Client", "Client Name"],
    job_status: ["Status", "Job Status"],
    amount: ["Total", "Amount", "Job Total", "Estimate Total", "Invoice Total"],
    job_date: ["Date", "Created", "Created At", "Estimate Date", "Job Date"],
    // DripJobs's "Invoice ID" column is the value that lands in QBO as
    // the invoice DocNumber when the CRM syncs. Brady Brown's data
    // confirms this: DripJobs Invoice IDs 273312 / 360547 appear as QBO
    // DocNumbers #273312 / #360547. Used by reconcileCrmAgainstQbo to
    // do a direct-lookup match before falling back to fuzzy matching.
    external_invoice_id: ["Invoice ID", "Invoice #", "Invoice Number"],
  },
  jobber: {
    crm_job_id: ["Job #", "Job Number", "Invoice #", "ID"],
    job_name: ["Title", "Job Title", "Description"],
    customer_name: ["Client", "Client Name", "Customer"],
    job_status: ["Status", "Job Status"],
    amount: ["Total", "Job Total", "Invoiced Amount", "Amount"],
    job_date: ["Created", "Date Created", "Start Date", "Job Date", "Date"],
    // For Jobber the same number serves as both lineage key and QBO
    // DocNumber — set the same candidates so the engine can do a
    // DocNumber lookup off external_invoice_id without special-casing.
    external_invoice_id: ["Invoice #", "Job #", "Job Number"],
  },
  generic: {
    // QBO A/R Aging Detail uses "Num" / "Doc Num". QBO Open Invoices uses
    // "Transaction Type" + "Num". Customer column in QBO exports is most
    // commonly "Name" (singular, A/R Aging) or "Customer" (Open Invoices).
    // "Source Name" appears on QBO Transaction Detail by Account. "Customer:Job"
    // is QBO's old "name:sub-customer" composite.
    crm_job_id: ["Job ID", "ID", "Number", "#", "Num", "Doc Num", "Proposal Name", "Invoice #", "Document Number"],
    job_name: ["Title", "Description", "Memo", "Memo/Description", "Job", "Proposal Name"],
    customer_name: [
      "Customer",
      "Customer Name",
      "Client",
      "Client Name",
      "Name",
      "Source Name",
      "Customer:Job",
      "Customer/Project",
      "Project",
      "Bill To",
      "Payer",
    ],
    job_status: ["Status", "Type", "Transaction Type"],
    amount: ["Amount", "Total", "Open Balance", "Balance", "Value"],
    job_date: ["Date", "Created", "Transaction Date", "Txn Date", "Due Date"],
    external_invoice_id: ["Invoice #", "Invoice Number", "Document Number", "Doc Num", "Num"],
  },
};

/**
 * Pull the stable numeric ID out of a field that may be wrapped in a
 * lifecycle prefix like "Proposal #1804108" or "Deal #2353039" or
 * "Job #1741744" — DripJobs uses the same number across the proposal →
 * deal → job lifecycle, so we want the bare number for grouping.
 *
 * "Proposal #1804108" → "1804108"
 * "Deal #2353039"     → "2353039"
 * "Job #1741744"      → "1741744"
 * "2298836"           → "2298836"
 * "Some title"        → null (no extractable id)
 */
function extractProposalId(raw: string | null): string | null {
  if (!raw) return null;
  // Strip lifecycle prefix + optional "#"; capture the digits.
  const m = String(raw).match(/(?:^|\s)(?:proposal|deal|job|estimate|invoice)?\s*#?\s*(\d{3,})\b/i);
  return m ? m[1] : null;
}

function pickField(row: Record<string, string>, candidates: string[]): string | null {
  // Build a lowercased-key index once per row
  const lower = new Map<string, string>();
  for (const k of Object.keys(row)) {
    lower.set(k.toLowerCase().trim(), row[k]);
  }
  for (const c of candidates) {
    const v = lower.get(c.toLowerCase().trim());
    if (v != null && v !== "") return v;
  }
  return null;
}

function parseAmount(raw: string | null): number | null {
  if (!raw) return null;
  // Strip currency symbols, commas, parentheses-as-negative
  const cleaned = raw.replace(/[,$\s]/g, "");
  const parenMatch = cleaned.match(/^\((.+)\)$/);
  const n = Number(parenMatch ? "-" + parenMatch[1] : cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  // Accept ISO, M/D/YYYY, YYYY-MM-DD, DD-MM-YYYY (the latter we just hand to Date)
  const trimmed = raw.trim();
  // Try ISO date first
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  // M/D/YYYY
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const [_, mm, dd, yy] = m;
    const yyyy = yy.length === 2 ? `20${yy}` : yy;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  // Fallback to Date parser
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function normalizeCrmRows(rows: Record<string, string>[], crm: CrmSource): ParsedCrmJob[] {
  const map = COLUMN_MAPS[crm];
  const out: ParsedCrmJob[] = [];
  for (const row of rows) {
    const customer = pickField(row, map.customer_name);
    if (!customer) continue; // skip rows without a customer — can't match anything
    const rawId = pickField(row, map.crm_job_id);
    // Extract the numeric/stable portion (handles "Proposal #X", "Deal #X").
    // Fall back to the raw value if nothing parses (e.g. a UUID).
    const cleanId = extractProposalId(rawId) || rawId;
    // Capture the CRM's invoice id (distinct from crm_job_id for DripJobs;
    // identical for Jobber). Used by reconcileCrmAgainstQbo to do a
    // DocNumber lookup against QBO before falling back to fuzzy matching.
    const rawInvoiceId = pickField(row, map.external_invoice_id);
    const cleanInvoiceId =
      rawInvoiceId == null
        ? null
        : extractProposalId(rawInvoiceId) || rawInvoiceId.trim() || null;
    out.push({
      crm_job_id: cleanId,
      job_name: pickField(row, map.job_name),
      customer_name: customer,
      job_status: pickField(row, map.job_status) || "active",
      amount: parseAmount(pickField(row, map.amount)),
      job_date: parseDate(pickField(row, map.job_date)),
      external_invoice_id: cleanInvoiceId,
      raw_row: row,
    });
  }
  return out;
}

// ─── DUPLICATE DETECTION ──────────────────────────────────────────────

// Tighter tolerances after seeing real Drip Jobs data — clients have
// PLENTY of legitimate same-customer-different-amount invoices (change
// orders, progress billings, multiple proposals). Loose matching turns
// those into false-positive duplicates.
const AMOUNT_TOLERANCE = 0.50;     // dollars — just rounding tolerance
const DATE_WINDOW_DAYS = 90;       // window for Path A (CRM → QBO match) —
                                   // wide because CRM proposal date vs QBO
                                   // posting date can drift
const DUPLICATE_CLUSTER_WINDOW_DAYS = 30; // narrower window for Path B
                                          // (pure-heuristic clustering)
const NAME_MATCH_LOOSE = true;     // accept "John Smith" === "John Smith Painting"

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (!Number.isFinite(da) || !Number.isFinite(db)) return 9999;
  return Math.abs((da - db) / 86_400_000);
}

function customerNamesMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const na = a.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  if (na === nb) return true;
  if (!NAME_MATCH_LOOSE) return false;
  // One contains the other (for "John Smith" vs "John Smith Painting")
  if (na.length >= 6 && nb.includes(na)) return true;
  if (nb.length >= 6 && na.includes(nb)) return true;
  return false;
}

export interface DetectDuplicatesInput {
  crmJobs: ParsedCrmJob[];
  qboInvoices: OpenInvoice[];
}

export interface DetectDuplicatesResult {
  duplicates: DetectedDuplicate[];
  /** QBO invoices we found a clean 1:1 CRM match for (= legitimate). */
  legitimateInvoiceIds: Set<string>;
  /** Invoices that didn't match any CRM job — surfaced for the bookkeeper
   *  but NOT auto-flagged in Phase 1 (they belong in "stale A/R" in
   *  Phase 2). Returned for stats only. */
  unmatchedInvoiceIds: Set<string>;
  /** Per-customer summary: CRM job count vs QBO invoice count. Helps the
   *  bookkeeper see "Customer X has 8 invoices but only 2 jobs in the CRM"
   *  at a glance before drilling in. */
  customerSummary: Array<{
    customer_key: string;       // canonical key (customer_id when available)
    customer_name: string;
    crm_job_count: number;
    qbo_invoice_count: number;
    qbo_total: number;
    excess_invoices: number;    // qbo - crm, if positive
  }>;
}

function normalizeName(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stronger name-similarity check that handles common business suffixes
 *  ("LLC", "Inc", "Painting", "Construction") so "John Smith" matches
 *  "John Smith Painting LLC". Returns true if either name fully contains
 *  the other after stripping suffixes. */
function loosenedNameMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // Strip common business suffixes/descriptors
  const SUFFIXES = /\b(inc|llc|corp|corporation|ltd|limited|llp|lp|co|company|the|painting|painters|construction|builders|contractors|services|group|holdings|enterprises|industries|pros|professional|solutions|renovations|remodeling|homes|design)\b/g;
  const stripA = a.replace(SUFFIXES, " ").replace(/\s+/g, " ").trim();
  const stripB = b.replace(SUFFIXES, " ").replace(/\s+/g, " ").trim();
  if (stripA && stripA === stripB) return true;
  if (NAME_MATCH_LOOSE && stripA.length >= 4 && stripB.length >= 4) {
    if (a.includes(b) || b.includes(a)) return true;
    if (stripA.includes(stripB) || stripB.includes(stripA)) return true;
  }
  return false;
}

export function detectDuplicates(input: DetectDuplicatesInput): DetectDuplicatesResult {
  const duplicates: DetectedDuplicate[] = [];
  const legitimate = new Set<string>();
  const unmatched = new Set<string>();

  // ─── Group QBO invoices by customer ───
  // Prefer customer_id when present (QBO can have two customers with the
  // same display name but different IDs — name-only grouping merges them
  // incorrectly). Fall back to normalized name.
  const byCustomer = new Map<string, OpenInvoice[]>();
  const customerDisplayName = new Map<string, string>(); // key → friendly name
  for (const inv of input.qboInvoices) {
    const idKey = inv.customer_id ? `id:${inv.customer_id}` : null;
    const nameKey = normalizeName(inv.customer_name);
    const key = idKey || (nameKey ? `name:${nameKey}` : null);
    if (!key) continue;
    if (!byCustomer.has(key)) {
      byCustomer.set(key, []);
      customerDisplayName.set(key, inv.customer_name || "(no customer)");
    }
    byCustomer.get(key)!.push(inv);
  }

  // ─── Resolve each CRM job to a QBO customer bucket ───
  // CRM data rarely has the QBO customer_id, so we have to match by name.
  // Build a name index of QBO customer keys for fast loose-match lookup.
  const qboNameIndex: { key: string; normalized: string }[] = [];
  for (const [key] of byCustomer) {
    const inv = byCustomer.get(key)![0];
    qboNameIndex.push({
      key,
      normalized: normalizeName(inv.customer_name),
    });
  }

  function findQboCustomerKeyForCrm(crmName: string): string | null {
    const normCrm = normalizeName(crmName);
    if (!normCrm) return null;
    // Try exact first
    const exact = qboNameIndex.find((q) => q.normalized === normCrm);
    if (exact) return exact.key;
    // Then loose
    const loose = qboNameIndex.find((q) => loosenedNameMatch(q.normalized, normCrm));
    return loose ? loose.key : null;
  }

  // ── Pre-pass: detect CRM revision series ──
  // Multiple CRM rows for the same customer + same proposal_id at
  // DIFFERENT amounts are revisions/change orders. They are NOT
  // duplicates of each other in QBO either — each amount has its own
  // invoice. Mark these so Path A can match each separately without
  // false-flagging.
  const revisionSeries = new Map<string, ParsedCrmJob[]>(); // key = customer+proposal_id
  for (const job of input.crmJobs) {
    if (!job.crm_job_id || !job.customer_name) continue;
    const k = `${normalizeName(job.customer_name)}|${job.crm_job_id}`;
    if (!revisionSeries.has(k)) revisionSeries.set(k, []);
    revisionSeries.get(k)!.push(job);
  }
  const revisionKeys = new Set<string>();
  for (const [k, jobs] of revisionSeries) {
    if (jobs.length < 2) continue;
    const amounts = new Set(jobs.map((j) => (j.amount != null ? j.amount.toFixed(2) : null)));
    if (amounts.size > 1) revisionKeys.add(k);
  }

  // ── Path A: cross-reference each CRM job → find matching QBO invoices ──
  const matchedQboIds = new Set<string>();
  const crmCountByCustomer = new Map<string, number>();

  input.crmJobs.forEach((job, jobIdx) => {
    if (!job.customer_name) return;
    const customerKey = findQboCustomerKeyForCrm(job.customer_name);
    if (customerKey) {
      crmCountByCustomer.set(customerKey, (crmCountByCustomer.get(customerKey) || 0) + 1);
    }
    if (!customerKey) return;
    const candidates = byCustomer.get(customerKey) || [];

    // Filter to amount + date window. AMOUNT_TOLERANCE is now $0.50,
    // so only true same-amount invoices match.
    const matched = candidates.filter((inv) => {
      if (job.amount != null && Math.abs(inv.total_amount - job.amount) > AMOUNT_TOLERANCE) return false;
      if (job.job_date && daysBetween(inv.txn_date, job.job_date) > DATE_WINDOW_DAYS) return false;
      return true;
    });

    if (matched.length === 0) return; // no QBO invoices for this CRM job
    if (matched.length === 1) {
      legitimate.add(matched[0].qbo_invoice_id);
      matchedQboIds.add(matched[0].qbo_invoice_id);
      return;
    }

    // 2+ QBO invoices match this single CRM row at the SAME amount.
    // That's a true duplicate — survivor is most-recent.
    const sorted = [...matched].sort((a, b) => {
      const c = b.txn_date.localeCompare(a.txn_date);
      if (c !== 0) return c;
      return a.qbo_invoice_id.localeCompare(b.qbo_invoice_id);
    });
    const survivor = sorted[0];
    legitimate.add(survivor.qbo_invoice_id);
    matchedQboIds.add(survivor.qbo_invoice_id);
    const isRevisionSeries = job.crm_job_id
      ? revisionKeys.has(`${normalizeName(job.customer_name)}|${job.crm_job_id}`)
      : false;
    for (let i = 1; i < sorted.length; i++) {
      const dup = sorted[i];
      duplicates.push({
        qbo_invoice: dup,
        matched_crm_job_index: jobIdx,
        surviving_qbo_invoice: survivor,
        // Slightly lower confidence when the CRM job is part of a revision
        // series — the dup might actually be another revision the CRM
        // export missed.
        confidence: isRevisionSeries ? 0.78 : 0.92,
        reasoning:
          (isRevisionSeries
            ? `⚠ This proposal has multiple CRM rows at different amounts (revision series). `
            : "") +
          `CRM job ${job.crm_job_id ? `#${job.crm_job_id} ` : ""}for ${job.customer_name}` +
          (job.job_date ? ` on ${job.job_date}` : "") +
          ` matches ${sorted.length} QBO invoices at the SAME amount ($${job.amount?.toFixed(2)}). ` +
          `Keeping ${survivor.doc_number || survivor.qbo_invoice_id}, flagging ${dup.doc_number || dup.qbo_invoice_id}.`,
      });
      matchedQboIds.add(dup.qbo_invoice_id);
    }
  });

  // ── Path B: heuristic on QBO-only clusters (no CRM match) ──
  // Conservative — requires EXACT same amount (just rounding tolerance)
  // AND tight date window (30 days). Different-amount invoices for the
  // same customer are NOT clustered — those are change orders or
  // progress billings, not duplicates.
  for (const [_, invoices] of byCustomer) {
    const unattributed = invoices.filter((inv) => !matchedQboIds.has(inv.qbo_invoice_id));
    if (unattributed.length < 2) {
      for (const inv of unattributed) unmatched.add(inv.qbo_invoice_id);
      continue;
    }
    // Cluster by EXACT amount (within rounding) + tight date window.
    const used = new Set<string>();
    for (let i = 0; i < unattributed.length; i++) {
      if (used.has(unattributed[i].qbo_invoice_id)) continue;
      const cluster: OpenInvoice[] = [unattributed[i]];
      used.add(unattributed[i].qbo_invoice_id);
      for (let j = i + 1; j < unattributed.length; j++) {
        if (used.has(unattributed[j].qbo_invoice_id)) continue;
        // EXACT amount match (rounding tolerance only). Different amounts
        // are different jobs — never cluster them.
        if (Math.abs(unattributed[i].total_amount - unattributed[j].total_amount) > AMOUNT_TOLERANCE) continue;
        if (daysBetween(unattributed[i].txn_date, unattributed[j].txn_date) > DUPLICATE_CLUSTER_WINDOW_DAYS) continue;
        cluster.push(unattributed[j]);
        used.add(unattributed[j].qbo_invoice_id);
      }
      if (cluster.length < 2) {
        unmatched.add(unattributed[i].qbo_invoice_id);
        continue;
      }
      const sorted = [...cluster].sort((a, b) => b.txn_date.localeCompare(a.txn_date));
      const survivor = sorted[0];
      // Confidence depends on whether the customer has ANY CRM rows. If
      // none, the cluster could be a legitimate billing pattern we don't
      // know about — keep confidence low.
      const customerKey = unattributed[i].customer_id
        ? `id:${unattributed[i].customer_id}`
        : `name:${normalizeName(unattributed[i].customer_name)}`;
      const crmRowsForCustomer = crmCountByCustomer.get(customerKey) || 0;
      const confidence = crmRowsForCustomer > 0 ? 0.65 : 0.5;
      for (let k = 1; k < sorted.length; k++) {
        const dup = sorted[k];
        duplicates.push({
          qbo_invoice: dup,
          matched_crm_job_index: null,
          surviving_qbo_invoice: survivor,
          confidence,
          reasoning:
            `Heuristic match — QBO has ${cluster.length} invoices for ${dup.customer_name || "this customer"} at EXACTLY $${dup.total_amount.toFixed(2)} within ${DUPLICATE_CLUSTER_WINDOW_DAYS} days. ` +
            (crmRowsForCustomer > 0
              ? `CRM has ${crmRowsForCustomer} job(s) for this customer but none match this amount — possible CRM-sync dupes.`
              : `No CRM rows for this customer to confirm — could be a duplicate OR a legitimate split billing.`) +
            ` Verify before write-off.`,
        });
      }
    }
  }

  // Track strict 0-match invoices for stats
  for (const inv of input.qboInvoices) {
    if (!matchedQboIds.has(inv.qbo_invoice_id) && !duplicates.some((d) => d.qbo_invoice.qbo_invoice_id === inv.qbo_invoice_id)) {
      unmatched.add(inv.qbo_invoice_id);
    }
  }

  // ─── Customer summary ───
  // For each QBO customer, count CRM jobs vs QBO invoices. Bookkeeper
  // sees "Customer X: 8 invoices, 2 jobs — 6 excess" at the top of the
  // review and knows where to look.
  const summary: DetectDuplicatesResult["customerSummary"] = [];
  for (const [key, invs] of byCustomer) {
    const crmCount = crmCountByCustomer.get(key) || 0;
    const qboTotal = invs.reduce((s, i) => s + (i.balance || i.total_amount || 0), 0);
    summary.push({
      customer_key: key,
      customer_name: customerDisplayName.get(key) || "(no customer)",
      crm_job_count: crmCount,
      qbo_invoice_count: invs.length,
      qbo_total: Math.round(qboTotal * 100) / 100,
      excess_invoices: Math.max(0, invs.length - crmCount),
    });
  }
  summary.sort((a, b) => b.excess_invoices - a.excess_invoices || b.qbo_total - a.qbo_total);

  return {
    duplicates,
    legitimateInvoiceIds: legitimate,
    unmatchedInvoiceIds: unmatched,
    customerSummary: summary,
  };
}

export { customerNamesMatch };

// ════════════════════════════════════════════════════════════════════════════
// V2 — Unified CRM-Driven Reconciliation
// ════════════════════════════════════════════════════════════════════════════
// Mike's vision: the CRM is source of truth. For each completed CRM job,
// validate both sides of QBO:
//   (a) A/R: matching QBO invoice exists, no duplicates
//   (b) UF deposits: a deposit was received covering this job
// Then surface 4 buckets of "needs action":
//   1. Duplicates       → existing logic, kept verbatim
//   2. Missing invoice  → CRM job complete, no QBO invoice (push new one)
//   3. Unmatched job    → CRM job complete, no UF deposit (still unpaid?)
//   4. Unmatched UF     → UF deposit, no CRM job (ask client what it's for)
// Plus a 5th informational bucket:
//   uf_matches          → CRM job ↔ UF deposit reconciled (1:1 or 1:N)
//
// V1 ships the matching engine + UI; QBO writes for missing_invoice and
// unmatched_uf land in V2.

/** A single CRM job matched to a UF deposit (1:1 or part of an N:1 group). */
export interface UfMatch {
  uf_payment_id: string;
  uf_payment_date: string;
  uf_payment_amount: number;
  uf_customer_name: string | null;
  /** CRM jobs covered by this deposit. Length 1 = 1:1 match. Length > 1 =
   *  bulk deposit (1 deposit, N jobs summing to amount within tolerance). */
  crm_job_ids: string[];
  /** Match quality 0..1. 1.0 = exact amount + same customer + tight date. */
  confidence: number;
  /** Why we matched. Surfaced to the bookkeeper. */
  reasoning: string;
}

/** A CRM job we couldn't find anything for on the deposit side. */
export interface UnmatchedJob {
  crm_job_id: string;
  customer_name: string;
  amount: number;
  job_date: string | null;
  reasoning: string;
}

/** A UF deposit with no CRM job match. Candidates for ask-client email. */
export interface UnmatchedUf {
  uf_payment_id: string;
  uf_customer_name: string | null;
  uf_payment_amount: number;
  uf_payment_date: string;
  memo: string;
  reasoning: string;
}

/** A CRM job that's complete but has no corresponding QBO invoice. */
export interface MissingInvoice {
  crm_job_id: string;
  customer_name: string;
  amount: number;
  job_date: string | null;
  job_name: string | null;
  reasoning: string;
}

export interface ReconcileInput {
  crmJobs: ParsedCrmJob[];
  qboInvoices: OpenInvoice[];
  ufPayments: UFPayment[];
  /** Window for UF↔job matching. Deposits older than this from the job
   *  date are considered unrelated. Default 90 days. */
  ufWindowDays?: number;
  /** Amount tolerance for UF matches. Default $0.50 — same as duplicate
   *  detection — keeps the matcher strict. */
  amountTolerance?: number;
  /** Max N for bulk-deposit matching. Larger N = exponential search blowup.
   *  Default 6 covers most real-world cases (one check pays off 2-6 jobs). */
  maxBulkN?: number;
}

export interface ReconcileResult extends DetectDuplicatesResult {
  /** UF deposits successfully matched to one or more CRM jobs. */
  ufMatches: UfMatch[];
  /** CRM jobs with no UF deposit found. May still be legitimately unpaid. */
  unmatchedJobs: UnmatchedJob[];
  /** UF deposits we couldn't tie to any CRM job. Ask the client. */
  unmatchedUf: UnmatchedUf[];
  /** CRM jobs that have no QBO invoice at all. */
  missingInvoices: MissingInvoice[];
}

/**
 * Reconcile a CRM job list against QBO open invoices AND UF deposits.
 *
 * Delegates duplicate-invoice detection to the existing detectDuplicates
 * (so V1 keeps working unchanged) and adds three new buckets on top.
 *
 * Strategy:
 *   1. Run detectDuplicates → get duplicates + legitimate invoice IDs.
 *   2. For each CRM job not covered by detectDuplicates' duplicate cluster,
 *      check if it has a matching QBO invoice. If not → missing_invoice.
 *   3. For each CRM job (whether or not it has an invoice), try to find
 *      a UF deposit covering it. First try 1:1 amount-equality matches,
 *      then 1:N bulk-deposit matches via subset-sum.
 *   4. Leftover UF deposits → unmatched_uf (ask client).
 *   5. CRM jobs with no UF match → unmatched_job.
 */
export function reconcileCrmAgainstQbo(input: ReconcileInput): ReconcileResult {
  const {
    crmJobs,
    qboInvoices,
    ufPayments,
    ufWindowDays = 90,
    amountTolerance = 0.5,
    maxBulkN = 6,
  } = input;

  // ─── 1. Duplicates (existing engine) ─────────────────────────────────────
  const baseResult = detectDuplicates({ crmJobs, qboInvoices });

  // ─── 2. Missing invoices ────────────────────────────────────────────────
  // For each CRM job, check if any QBO invoice could be the canonical one.
  // We don't require exact amount match here (change orders are legitimate);
  // we only require a customer match within a 180-day window. If found,
  // the CRM job is "represented" in QBO. If not, it's missing.
  //
  // We deliberately leave duplicates out of "represented" — a CRM job that
  // matches a known-duplicate cluster IS represented (just messily).
  const missingInvoices: MissingInvoice[] = [];
  const representedCrmJobIds = new Set<string>();
  /**
   * CRM job key → matching QBO invoice (by DocNumber match against the
   * CRM's external_invoice_id). When present, the UI displays the link
   * and downstream classification (UF matching, unmatched_job) skips
   * the row — it's already represented in QBO regardless of UF state.
   *
   * Brady Brown / Clean Cut Painters: DripJobs Invoice IDs 273312 and
   * 360547 sync to QBO as DocNumbers #273312 / #360547 — without this
   * pass, both proposals showed up as "unmatched deposit" false
   * positives because Brady has no UF deposits, hiding the one truly
   * missing proposal (DripJobs Invoice ID 346549).
   */
  const docNumberMatches = new Map<string, OpenInvoice>();

  // Build a customer-bucketed index of QBO invoices for fast lookup.
  const invByCustomerNorm = new Map<string, OpenInvoice[]>();
  // Also index by DocNumber for the direct-lookup pass below.
  const invByDocNumber = new Map<string, OpenInvoice>();
  for (const inv of qboInvoices) {
    const key = normalizeName(inv.customer_name);
    if (key) {
      const bucket = invByCustomerNorm.get(key) || [];
      bucket.push(inv);
      invByCustomerNorm.set(key, bucket);
    }
    if (inv.doc_number) {
      // DocNumbers are short numeric strings; case doesn't matter but
      // we normalize whitespace + casing for safety.
      invByDocNumber.set(String(inv.doc_number).trim().toUpperCase(), inv);
    }
  }

  // ─── 2a. DocNumber direct match (NEW — runs before everything else) ─────
  // For each CRM job with an external_invoice_id, look up the QBO invoice
  // by DocNumber. If found, the job is represented in QBO at the highest
  // possible confidence — we can short-circuit all the fuzzy fallbacks.
  for (const job of crmJobs) {
    if (!job.external_invoice_id) continue;
    const docKey = String(job.external_invoice_id).trim().toUpperCase();
    if (!docKey) continue;
    const hit = invByDocNumber.get(docKey);
    if (hit) {
      const jobKey = job.crm_job_id || `name:${job.customer_name}`;
      docNumberMatches.set(jobKey, hit);
      representedCrmJobIds.add(jobKey);
    }
  }

  for (const job of crmJobs) {
    const isCompletedish =
      !job.job_status ||
      /complet|paid|closed|done|finished|invoiced/i.test(job.job_status);
    if (!isCompletedish) continue;
    if (!job.customer_name || job.amount == null) continue;

    const jobKey = job.crm_job_id || `name:${job.customer_name}`;

    // Already DocNumber-matched in pass 2a → represented, skip fallback.
    if (representedCrmJobIds.has(jobKey)) continue;

    // Try exact match first
    const norm = normalizeName(job.customer_name);
    let bucket = invByCustomerNorm.get(norm) || [];

    // Loosened match — handles "John Smith" vs "John Smith Painting LLC"
    if (bucket.length === 0) {
      for (const [k, v] of invByCustomerNorm.entries()) {
        if (loosenedNameMatch(k, norm)) {
          bucket = bucket.concat(v);
        }
      }
    }

    if (bucket.length === 0) {
      missingInvoices.push({
        crm_job_id: jobKey,
        customer_name: job.customer_name,
        amount: job.amount,
        job_date: job.job_date,
        job_name: job.job_name,
        reasoning: `No QBO invoice for "${job.customer_name}" anywhere in the open A/R, and the CRM's Invoice ID ${job.external_invoice_id || "(missing)"} doesn't match any QBO DocNumber. Either the invoice was never pushed from the CRM, or it was already paid + closed (only OpenInvoices fetched).`,
      });
    } else {
      representedCrmJobIds.add(jobKey);
    }
  }

  // ─── 3. UF deposit matching ─────────────────────────────────────────────
  // Bucket BOTH sides by customer-normalized key so we only try matches
  // within a customer. Cross-customer matching is too risky (one customer's
  // $500 check would erroneously clear another customer's $500 invoice).
  const ufByCustomerNorm = new Map<string, UFPayment[]>();
  for (const uf of ufPayments) {
    if (uf.already_applied) continue;
    const key = normalizeName(uf.customer_name);
    // "no customer" UF deposits go into a special bucket — they can't be
    // 1:1 matched but might be 1:N. For V1 we just dump them to unmatched_uf.
    const bucket = ufByCustomerNorm.get(key) || [];
    bucket.push(uf);
    ufByCustomerNorm.set(key, bucket);
  }

  const jobsByCustomerNorm = new Map<string, ParsedCrmJob[]>();
  for (const job of crmJobs) {
    if (!job.customer_name || job.amount == null) continue;
    const isCompletedish =
      !job.job_status ||
      /complet|paid|closed|done|finished|invoiced/i.test(job.job_status);
    if (!isCompletedish) continue;
    // Skip jobs already DocNumber-matched to a QBO invoice — they're
    // represented in QBO independently of UF state. Including them in
    // the UF match pool produces the false-positive unmatched_job rows
    // we saw on Brady Brown (his synced invoices were flagged as
    // "no deposit found" when in reality QBO had them already).
    const jobKey = job.crm_job_id || `name:${job.customer_name}`;
    if (docNumberMatches.has(jobKey)) continue;
    const key = normalizeName(job.customer_name);
    const bucket = jobsByCustomerNorm.get(key) || [];
    bucket.push(job);
    jobsByCustomerNorm.set(key, bucket);
  }

  const ufMatches: UfMatch[] = [];
  const consumedJobIds = new Set<string>();
  const consumedUfIds = new Set<string>();

  // Walk every UF customer bucket — for each UF deposit, try 1:1 then 1:N
  // against that customer's unconsumed jobs.
  for (const [customerKey, ufs] of ufByCustomerNorm.entries()) {
    if (!customerKey) continue; // skip blank-customer bucket — handled below
    const jobs = (jobsByCustomerNorm.get(customerKey) || []).slice();
    // Also try loosened match — customer name might differ slightly between
    // CRM and QBO ("John Smith" vs "Smith, John").
    if (jobs.length === 0) {
      for (const [k, v] of jobsByCustomerNorm.entries()) {
        if (loosenedNameMatch(k, customerKey)) {
          jobs.push(...v);
        }
      }
    }
    if (jobs.length === 0) continue;

    for (const uf of ufs) {
      if (consumedUfIds.has(uf.qbo_payment_id)) continue;

      // ── 1:1 exact-amount match ──
      const oneToOne = jobs.find(
        (j) =>
          !consumedJobIds.has(jobIdKey(j)) &&
          Math.abs((j.amount || 0) - uf.amount) < amountTolerance &&
          withinDays(uf.date, j.job_date, ufWindowDays)
      );
      if (oneToOne) {
        ufMatches.push({
          uf_payment_id: uf.qbo_payment_id,
          uf_payment_date: uf.date,
          uf_payment_amount: uf.amount,
          uf_customer_name: uf.customer_name,
          crm_job_ids: [jobIdKey(oneToOne)],
          confidence: 0.95,
          reasoning: `1:1 match — UF deposit $${uf.amount.toFixed(2)} on ${uf.date} matches CRM job "${oneToOne.job_name || oneToOne.crm_job_id}" amount within tolerance.`,
        });
        consumedJobIds.add(jobIdKey(oneToOne));
        consumedUfIds.add(uf.qbo_payment_id);
        continue;
      }

      // ── 1:N bulk-deposit match via subset-sum ──
      const candidates = jobs.filter(
        (j) =>
          !consumedJobIds.has(jobIdKey(j)) &&
          withinDays(uf.date, j.job_date, ufWindowDays)
      );
      const subset = findSubsetSum(candidates, uf.amount, amountTolerance, maxBulkN);
      if (subset && subset.length > 1) {
        ufMatches.push({
          uf_payment_id: uf.qbo_payment_id,
          uf_payment_date: uf.date,
          uf_payment_amount: uf.amount,
          uf_customer_name: uf.customer_name,
          crm_job_ids: subset.map(jobIdKey),
          confidence: 0.78,
          reasoning: `Bulk deposit — UF $${uf.amount.toFixed(2)} on ${uf.date} appears to cover ${subset.length} jobs (sum within tolerance). Confirm in the multi-select before finalizing.`,
        });
        for (const j of subset) consumedJobIds.add(jobIdKey(j));
        consumedUfIds.add(uf.qbo_payment_id);
      }
    }
  }

  // ─── 4. Unmatched UF ────────────────────────────────────────────────────
  const unmatchedUf: UnmatchedUf[] = [];
  for (const uf of ufPayments) {
    if (uf.already_applied) continue;
    if (consumedUfIds.has(uf.qbo_payment_id)) continue;
    unmatchedUf.push({
      uf_payment_id: uf.qbo_payment_id,
      uf_customer_name: uf.customer_name,
      uf_payment_amount: uf.amount,
      uf_payment_date: uf.date,
      memo: uf.memo,
      reasoning: uf.customer_name
        ? `No CRM job for "${uf.customer_name}" matches $${uf.amount.toFixed(2)} within ${ufWindowDays}d of ${uf.date}.`
        : `Deposit has no customer assigned and no CRM job matched. Likely needs client confirmation.`,
    });
  }

  // ─── 5. Unmatched CRM jobs (no UF deposit) ─────────────────────────────
  const unmatchedJobs: UnmatchedJob[] = [];
  for (const job of crmJobs) {
    if (!job.customer_name || job.amount == null) continue;
    const isCompletedish =
      !job.job_status ||
      /complet|paid|closed|done|finished|invoiced/i.test(job.job_status);
    if (!isCompletedish) continue;
    if (consumedJobIds.has(jobIdKey(job))) continue;
    unmatchedJobs.push({
      crm_job_id: job.crm_job_id || `name:${job.customer_name}`,
      customer_name: job.customer_name,
      amount: job.amount,
      job_date: job.job_date,
      reasoning: `Job completed in CRM but no matching deposit in Undeposited Funds. Either: still pending payment, paid via channel not yet deposited, or payment was applied directly (not via UF).`,
    });
  }

  return {
    ...baseResult,
    missingInvoices,
    ufMatches,
    unmatchedJobs,
    unmatchedUf,
  };
}

// ─── Helpers for V2 ────────────────────────────────────────────────────────

/** Stable per-job key — prefers CRM's own ID, falls back to a synthetic
 *  key built from customer name + amount + date. Mirrors the convention
 *  in detectDuplicates so the same job is identified consistently. */
function jobIdKey(job: ParsedCrmJob): string {
  return job.crm_job_id || `synth:${normalizeName(job.customer_name)}:${job.amount}:${job.job_date}`;
}

/** True when `a` and `b` are within `days` of each other. Either being
 *  null returns true (don't punish missing dates). */
function withinDays(
  a: string | null | undefined,
  b: string | null | undefined,
  days: number
): boolean {
  if (!a || !b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (isNaN(ta) || isNaN(tb)) return true;
  const diffDays = Math.abs(ta - tb) / (1000 * 60 * 60 * 24);
  return diffDays <= days;
}

/**
 * Find a subset of jobs whose amounts sum to `target` within tolerance.
 * Brute-force exhaustive search up to `maxN` (default 6) — bigger N gets
 * exponentially expensive (2^N combinations) and the bookkeeper would
 * rather see "we couldn't auto-match" than wait 30 seconds.
 *
 * Returns the FIRST subset found (not necessarily optimal). For accuracy
 * we sort candidates by amount descending so the greedy bias picks
 * "biggest jobs first" which usually matches real deposit patterns
 * (one big check covers a few large jobs, not 47 tiny ones).
 */
function findSubsetSum(
  candidates: ParsedCrmJob[],
  target: number,
  tolerance: number,
  maxN: number
): ParsedCrmJob[] | null {
  if (candidates.length === 0) return null;
  // Sort biggest-first for the greedy bias mentioned above
  const sorted = [...candidates].sort((a, b) => (b.amount || 0) - (a.amount || 0));

  // Try all subset sizes from 2 to min(maxN, candidates.length)
  for (let size = 2; size <= Math.min(maxN, sorted.length); size++) {
    const found = combinationsSum(sorted, size, target, tolerance);
    if (found) return found;
  }
  return null;
}

/** Recursive helper: pick `size` items from `pool` whose amounts sum to
 *  `target` ± tolerance. Returns the first matching combination or null. */
function combinationsSum(
  pool: ParsedCrmJob[],
  size: number,
  target: number,
  tolerance: number,
  start = 0,
  current: ParsedCrmJob[] = []
): ParsedCrmJob[] | null {
  if (current.length === size) {
    const sum = current.reduce((s, j) => s + (j.amount || 0), 0);
    return Math.abs(sum - target) < tolerance ? current.slice() : null;
  }
  for (let i = start; i < pool.length; i++) {
    current.push(pool[i]);
    const found = combinationsSum(pool, size, target, tolerance, i + 1, current);
    if (found) return found;
    current.pop();
  }
  return null;
}

