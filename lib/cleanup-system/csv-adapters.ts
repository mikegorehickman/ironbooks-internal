/**
 * Declarative CSV adapters — bank, Stripe, Jobber, DripJobs.
 * Deterministic parsing; AI never sets amounts.
 */

import type { CanonicalRecord, ImportSource } from "./types";

type ColumnMap = Record<string, string>;

const ADAPTERS: Record<ImportSource, { columns: ColumnMap; dateFormat?: string }> = {
  stripe: {
    columns: {
      external_id: "id",
      date: "created_utc",
      payer_raw: "description",
      gross_amount: "gross",
      fee_amount: "fee",
      net_amount: "net",
      reference: "payment_intent",
      payout_id: "automatic_payout_id",
    },
  },
  bank: {
    columns: {
      external_id: "transaction_id",
      date: "date",
      payer_raw: "description",
      gross_amount: "amount",
      net_amount: "amount",
      reference: "reference",
    },
  },
  jobber: {
    columns: {
      external_id: "invoice_id",
      date: "invoice_date",
      payer_raw: "client_name",
      gross_amount: "total",
      net_amount: "total",
      reference: "job_number",
    },
  },
  drip_jobs: {
    columns: {
      external_id: "invoice_id",
      date: "invoice_date",
      payer_raw: "customer_name",
      gross_amount: "amount",
      net_amount: "amount",
      reference: "proposal_name",
    },
  },
  loan_statement: {
    columns: {
      external_id: "payment_id",
      date: "payment_date",
      payer_raw: "lender",
      gross_amount: "payment_amount",
      // Lender statements usually break out the interest portion — capture it
      // in the fee_amount slot (matched fuzzily: "interest", "interest_amount",
      // "interest_paid"). The loans module uses it for EXACT P&I splits instead
      // of estimating. principal = gross − fee.
      fee_amount: "interest",
      net_amount: "payment_amount",
      reference: "account_number",
    },
  },
};

function parseCsvRows(input: string): Record<string, string>[] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { cur.push(field.trim()); field = ""; i++; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      cur.push(field.trim()); field = "";
      if (cur.some((c) => c.length > 0)) rows.push(cur);
      cur = []; i++; continue;
    }
    field += ch; i++;
  }
  if (field || cur.length > 0) { cur.push(field.trim()); rows.push(cur); }

  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = row[idx] || ""; });
    return obj;
  });
}

function findColumn(row: Record<string, string>, colName: string): string {
  const key = colName.toLowerCase().replace(/\s+/g, "_");
  if (row[key] !== undefined) return row[key];
  // Fuzzy: try partial match
  const found = Object.keys(row).find((k) => k.includes(key) || key.includes(k));
  return found ? row[found] : "";
}

function parseAmount(val: string): number | null {
  if (!val) return null;
  const cleaned = val.replace(/[$,]/g, "").trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function normalizeDate(val: string): string | null {
  if (!val) return null;
  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function parseCsvToCanonical(
  source: ImportSource,
  csvText: string
): CanonicalRecord[] {
  const adapter = ADAPTERS[source];
  if (!adapter) throw new Error(`Unknown source: ${source}`);

  const rows = parseCsvRows(csvText);
  const records: CanonicalRecord[] = [];

  for (const row of rows) {
    const externalId = findColumn(row, adapter.columns.external_id);
    if (!externalId) continue;

    const gross = parseAmount(findColumn(row, adapter.columns.gross_amount || ""));
    const fee = parseAmount(findColumn(row, adapter.columns.fee_amount || "")) || 0;
    const net = parseAmount(findColumn(row, adapter.columns.net_amount || ""));
    const tax = parseAmount(findColumn(row, adapter.columns.tax_amount || "")) || 0;

    records.push({
      source,
      external_id: externalId,
      date: normalizeDate(findColumn(row, adapter.columns.date || "")),
      payer_raw: findColumn(row, adapter.columns.payer_raw || "") || null,
      payer_normalized: null,
      gross_amount: gross,
      fee_amount: fee,
      tax_amount: tax,
      net_amount: net ?? (gross !== null ? gross - fee - tax : null),
      reference: findColumn(row, adapter.columns.reference || "") || null,
      payout_id: findColumn(row, adapter.columns.payout_id || "") || null,
      currency: source === "stripe" ? "USD" : "CAD",
      type: null,
    });
  }

  return records;
}

export async function importRecords(
  service: any,
  clientLinkId: string,
  runId: string,
  records: CanonicalRecord[]
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const rec of records) {
    const idempotencyKey = `${rec.source}:${rec.external_id}:${rec.date || "nodate"}`;
    const { error } = await service.from("imported_records").insert({
      client_link_id: clientLinkId,
      run_id: runId,
      source: rec.source,
      external_id: rec.external_id,
      record_date: rec.date,
      payer_raw: rec.payer_raw,
      payer_normalized: rec.payer_normalized,
      gross_amount: rec.gross_amount,
      fee_amount: rec.fee_amount,
      tax_amount: rec.tax_amount,
      net_amount: rec.net_amount,
      reference: rec.reference,
      payout_id: rec.payout_id,
      currency: rec.currency,
      record_type: rec.type,
      raw_row: rec,
      idempotency_key: idempotencyKey,
    } as any);

    if (error) {
      if (error.code === "23505") skipped++;
      else throw new Error(`Import failed: ${error.message}`);
    } else {
      imported++;
    }
  }

  return { imported, skipped };
}
