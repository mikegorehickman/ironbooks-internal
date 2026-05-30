/**
 * Parsers for Jobber and DripJobs invoice exports.
 *
 * Both produce the same `ParsedRow[]` shape so the matcher doesn't care
 * which source it came from. The lineage_key is the column that lets us
 * later identify "two QBO invoices that share a single estimate / job"
 * vs "two QBO invoices that are real duplicates."
 *
 * Jobber export (.xlsx)
 *   Columns: Client name | Date | Type | Total $ | Check # | Method |
 *            Job # | Postal code | Paid - Tax $ | Open
 *   Lineage key: `Job #` (small integer, scoped per customer)
 *   No standalone invoice number → matching to QBO leans on
 *   (customer + amount + date).
 *
 * DripJobs export (.csv)
 *   Columns: Status | Customer | Proposal Name | Invoice ID |
 *            Amount | Paid | Balance | Date
 *   Lineage key: `Proposal Name` ("Proposal #1804108" etc.)
 *   Has a stable `Invoice ID` — if the bookkeeper put that in QBO's
 *   memo/DocNumber on creation, the matcher can do exact joins.
 */

import * as XLSX from "xlsx";

export type ExternalSource = "jobber" | "dripjobs";

export type ParsedRow = {
  customer_name: string;
  customer_name_normalized: string;
  lineage_key: string | null;
  external_invoice_id: string | null;
  row_type: "invoice" | "payment" | "deposit" | "refund" | "unknown";
  amount: number | null;
  issue_date: string | null; // YYYY-MM-DD
  status: string | null;
  raw_row: Record<string, unknown>;
};

export type ParseResult = {
  source: ExternalSource;
  rows: ParsedRow[];
  invoice_count: number;
  warnings: string[];
};

// ────────────────────────── helpers ──────────────────────────

export function normalizeCustomerName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "number") {
    // Excel serial date — xlsx already converts when cellDates: true, but
    // defensive in case it slips through.
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    const yyyy = String(d.y).padStart(4, "0");
    const mm = String(d.m).padStart(2, "0");
    const dd = String(d.d).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    // Try ISO first
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    // Try M/D/YYYY or M/D/YYYY HH:MM:SS
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
      const mm = m[1].padStart(2, "0");
      const dd = m[2].padStart(2, "0");
      return `${m[3]}-${mm}-${dd}`;
    }
    // Last resort: let JS try
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function parseAmount(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Math.round(v * 100) / 100;
  if (typeof v === "string") {
    // Strip "$", commas, surrounding whitespace; handle parens-as-negative
    let s = v.trim().replace(/[$,]/g, "");
    let neg = false;
    if (s.startsWith("(") && s.endsWith(")")) {
      neg = true;
      s = s.slice(1, -1);
    }
    const n = Number(s);
    if (isNaN(n)) return null;
    return Math.round((neg ? -n : n) * 100) / 100;
  }
  return null;
}

function classifyJobberType(type: string | null | undefined): ParsedRow["row_type"] {
  if (!type) return "unknown";
  const t = type.toLowerCase();
  if (t.includes("invoice")) return "invoice";
  if (t.includes("payment")) return "payment";
  if (t.includes("deposit")) return "deposit";
  if (t.includes("refund")) return "refund";
  return "unknown";
}

// ────────────────────────── Jobber ──────────────────────────

export function parseJobberXlsx(buf: ArrayBuffer): ParseResult {
  const wb = XLSX.read(buf, { cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    return { source: "jobber", rows: [], invoice_count: 0, warnings: ["Workbook has no sheets"] };
  }
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: true,
  });

  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  let invoiceCount = 0;

  for (const r of raw) {
    const customer = (r["Client name"] as string | null) ?? "";
    const date = parseDate(r["Date"]);
    const type = classifyJobberType(r["Type"] as string | null);
    const amount = parseAmount(r["Total $"]);
    // Job # may be parsed as number or string — coerce to string for lineage key
    const jobNoRaw = r["Job #"];
    const jobNo = jobNoRaw == null || jobNoRaw === "" ? null : String(jobNoRaw);
    const status = (r["Open"] as string | null) || null;

    if (!customer && !date && !amount) continue; // empty row

    if (type === "unknown") {
      warnings.push(`Unrecognized Type "${r["Type"]}" for ${customer || "(no customer)"} on ${date || "(no date)"}`);
    }

    const parsed: ParsedRow = {
      customer_name: customer,
      customer_name_normalized: normalizeCustomerName(customer),
      // Lineage key only meaningful when combined with customer. We scope
      // by storing "customer_normalized||job" so two customers' Job #1
      // don't collide in the matcher.
      lineage_key: jobNo ? `${normalizeCustomerName(customer)}||${jobNo}` : null,
      external_invoice_id: null, // Jobber export lacks per-invoice id
      row_type: type,
      amount,
      issue_date: date,
      status,
      raw_row: r,
    };
    rows.push(parsed);
    if (type === "invoice") invoiceCount++;
  }

  return { source: "jobber", rows, invoice_count: invoiceCount, warnings };
}

// ────────────────────────── DripJobs ──────────────────────────

export function parseDripJobsCsv(text: string): ParseResult {
  // xlsx.read with type:'string' handles CSV just as well as the dedicated
  // papaparse path — avoids adding a dep for one parser.
  const wb = XLSX.read(text, { type: "string" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    return { source: "dripjobs", rows: [], invoice_count: 0, warnings: ["CSV has no sheets"] };
  }
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: false, // CSV values come in as strings — let the field parsers coerce
  });

  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  let invoiceCount = 0;

  for (const r of raw) {
    const customer = (r["Customer"] as string | null) ?? "";
    const date = parseDate(r["Date"]);
    const amount = parseAmount(r["Amount"]);
    const proposal = (r["Proposal Name"] as string | null) || null;
    const invoiceId = r["Invoice ID"] == null ? null : String(r["Invoice ID"]);
    const status = (r["Status"] as string | null) || null;

    if (!customer && !date && !amount) continue;

    // DripJobs invoice rows don't have an explicit Type column — every
    // row is an invoice. (Payments are in a different export.)
    const type: ParsedRow["row_type"] = "invoice";

    const parsed: ParsedRow = {
      customer_name: customer,
      customer_name_normalized: normalizeCustomerName(customer),
      lineage_key: proposal ? `${normalizeCustomerName(customer)}||${proposal.trim()}` : null,
      external_invoice_id: invoiceId,
      row_type: type,
      amount,
      issue_date: date,
      status,
      raw_row: r,
    };
    rows.push(parsed);
    invoiceCount++;
  }

  return { source: "dripjobs", rows, invoice_count: invoiceCount, warnings };
}

/**
 * Parse a file buffer. Auto-detects xlsx vs csv from the buffer signature
 * so the upload endpoint can accept either source without explicit type
 * hints from the client.
 */
export function parseExternalInvoiceFile(
  filename: string,
  buffer: ArrayBuffer
): ParseResult {
  const lower = filename.toLowerCase();
  // ZIP magic = xlsx; otherwise treat as CSV/text.
  const bytes = new Uint8Array(buffer.slice(0, 4));
  const isXlsx =
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

  if (isXlsx || lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return parseJobberXlsx(buffer);
  }
  // CSV — decode and treat as DripJobs
  const text = new TextDecoder("utf-8").decode(buffer);
  return parseDripJobsCsv(text);
}
