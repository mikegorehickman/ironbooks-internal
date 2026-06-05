/**
 * Stripe payouts CSV parser. The bookkeeper exports either:
 *
 *   - "Payouts" CSV (Dashboard → Payouts → Export). Columns vary slightly
 *     by Stripe API version but generally include:
 *       id, amount, currency, arrival_date, created, description, status
 *     `amount` is in CENTS — divide by 100. `arrival_date` is the date
 *     the funds land in the linked bank account (the date we'd expect a
 *     matching deposit in QBO).
 *
 *   - "Balance transactions" CSV (one row per charge / refund / payout
 *     leg). Has fee + net columns that the bookkeeper actually needs
 *     for reconciliation. Wider format; less common upload.
 *
 *   - "Charges" CSV (per-charge). Lower priority — what we mostly want
 *     is the payout to bank-deposit linkage.
 *
 * V1 supports Payouts CSV. Balance transactions can come later — we
 * detect via column presence + skip if we can't parse confidently.
 *
 * Pure parser — no QBO calls, no DB writes. Returns ParsedStripePayout[]
 * the start route persists as hardcore_cleanup_items.
 */

import { parseCsv } from "./hardcore-cleanup";

export interface ParsedStripePayout {
  /** Stripe payout id (po_xxx) — useful for memo + dedupe on re-upload. */
  stripe_payout_id: string;
  /** Gross payout amount, $ (NOT cents). */
  amount: number;
  /** Stripe processing fee carved out of the payout, when available. */
  fee: number | null;
  /** Net amount that hit the bank account. amount - fee. */
  net: number;
  currency: string | null;
  /** YYYY-MM-DD — date the funds landed in the bank. */
  arrival_date: string | null;
  /** When the payout was initiated (may differ from arrival by 1-2 days). */
  created_date: string | null;
  description: string;
  status: string | null;
  /** Original row for audit / debugging. */
  raw_row: Record<string, string>;
}

export interface ParseStripePayoutsResult {
  payouts: ParsedStripePayout[];
  warnings: string[];
}

/**
 * Stripe column aliases. Stripe varies these by API version + export
 * surface. Includes both the modern Dashboard export names and the
 * older CSV column names so an older export still parses.
 */
const COLS = {
  id: ["id", "Payout ID", "payout_id"],
  amount: ["amount", "Amount", "Gross", "amount_gross", "Amount (USD)"],
  fee: ["fee", "Fee", "Fees", "stripe_fee"],
  net: ["net", "Net", "Net (USD)"],
  currency: ["currency", "Currency"],
  arrival_date: [
    "arrival_date",
    "Arrival Date",
    "arrival_date (UTC)",
    "Arrival Date (UTC)",
  ],
  created: ["created", "Created", "created (UTC)", "Created (UTC)"],
  description: ["description", "Description", "Statement Descriptor"],
  status: ["status", "Status"],
};

function pick(row: Record<string, string>, candidates: string[]): string | null {
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

/** Stripe amounts are in cents on the API but the CSV exports usually
 *  decimalize them. We auto-detect: if the value looks like an integer
 *  > $10,000 we assume cents; otherwise dollars. Defensive — better to
 *  treat as dollars (likely correct) than to multiply tiny amounts by
 *  100 (catastrophic). */
function parseStripeAmount(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const cleaned = String(raw).replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  // If integer + > 10000 + no decimal point → cents
  const hasDecimal = String(cleaned).includes(".");
  if (!hasDecimal && Math.abs(n) > 10_000) {
    return Math.round((n / 100) * 100) / 100;
  }
  return Math.round(n * 100) / 100;
}

function parseStripeDate(raw: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Stripe uses ISO timestamps + sometimes plain YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // M/D/YYYY fallback
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const [, mm, dd, yy] = m;
    const yyyy = yy.length === 2 ? `20${yy}` : yy;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function parseStripePayoutsCsv(csvText: string): ParseStripePayoutsResult {
  const rows = parseCsv(csvText);
  const warnings: string[] = [];
  if (rows.length === 0) {
    return { payouts: [], warnings: ["CSV had no data rows."] };
  }
  // Confirm this looks like a payouts CSV — needs id + amount + an
  // arrival_date or created column. If columns are wildly off, surface
  // a clear warning so the bookkeeper picks the right export.
  const firstRow = rows[0];
  const detected = Object.keys(firstRow).map((k) => k.toLowerCase());
  const hasId = detected.some((d) => d === "id" || d.includes("payout"));
  const hasAmount = detected.some(
    (d) => d === "amount" || d.includes("amount") || d === "net"
  );
  const hasArrival = detected.some(
    (d) => d.includes("arrival") || d.includes("created")
  );
  if (!hasId || !hasAmount || !hasArrival) {
    warnings.push(
      `Stripe CSV header check: id=${hasId ? "✓" : "✗"} amount=${hasAmount ? "✓" : "✗"} arrival_date/created=${hasArrival ? "✓" : "✗"}. ` +
      `Expected a Stripe Payouts or Balance Transactions export. Found columns: ${Object.keys(firstRow).slice(0, 10).join(", ")}`
    );
  }

  const payouts: ParsedStripePayout[] = [];
  for (const row of rows) {
    const id = pick(row, COLS.id) || "";
    const amount = parseStripeAmount(pick(row, COLS.amount));
    if (!id && amount == null) continue; // empty row
    const fee = parseStripeAmount(pick(row, COLS.fee));
    let net = parseStripeAmount(pick(row, COLS.net));
    if (net == null && amount != null && fee != null) {
      // Net inferred from amount - fee. Stripe CSVs sometimes omit net
      // when amount already represents the net (Payouts export). We'd
      // rather not double-subtract — if there's no fee column present,
      // treat amount AS net.
      net = Math.round((amount - fee) * 100) / 100;
    }
    if (net == null) net = amount ?? 0;
    payouts.push({
      stripe_payout_id: String(id || ""),
      amount: amount ?? 0,
      fee: fee,
      net: net,
      currency: pick(row, COLS.currency),
      arrival_date: parseStripeDate(pick(row, COLS.arrival_date)),
      created_date: parseStripeDate(pick(row, COLS.created)),
      description: pick(row, COLS.description) || "",
      status: pick(row, COLS.status),
      raw_row: row,
    });
  }

  return { payouts, warnings };
}
