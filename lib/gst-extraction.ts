/**
 * GST/HST/PST extraction — the pure planner for the Canadian per-transaction
 * retrofit (2026 YTD): split embedded sales tax out of income and expenses.
 *
 * The mechanism is a LINE SPLIT that never changes a transaction's total, so
 * bank feeds/matches/reconciliations are untouched:
 *   - Income deposit line (gross) → net revenue + GST/HST Payable (+ PST
 *     Payable where the province taxes the sale — SK services, goods in
 *     BC/SK/MB). Rates come from lib/canadian-tax.ts serviceTax composition.
 *   - Taxable expense line (gross) → net expense + GST/HST Recoverable (ITCs).
 *     PST paid on purchases is NOT recoverable — it stays inside the net
 *     expense (it's a cost), which is why goods in PST provinces use
 *     gst/(1+gst+pst) rather than the full combined factor.
 *
 * Quebec is treated like HST at the combined rate (Mike 2026-07-16) but the
 * accounts are NAMED QST on the client's books ("GST/QST Payable",
 * "GST/QST Recoverable (ITRs)").
 *
 * Nova Scotia is period-aware: 15% HST before 2025-04-01, 14% after.
 *
 * All CA clients are assumed GST/HST (and PST where local) registered.
 *
 * Pure + dependency-free apart from canadian-tax.ts. Fixture-tested. Consumed
 * by the preview/apply endpoints and the /admin/gst-extraction fleet page.
 */

import { getProvinceTax } from "./canadian-tax";
import type { PLDetailRow } from "./qbo-reports";

export type GstInputKind = "goods" | "service" | "none";

/**
 * Normalize an account name for master-COA joining: live QBO names differ from
 * master names by dash variants, "&" vs "and", and stray punctuation (the same
 * brittleness the bank-rules master resolution hit). "Subcontractors – Painting"
 * and "subcontractors - painting" both normalize identically.
 */
export function normalizeAccountKey(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/[‒–—―]/g, "-")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Heuristic input-kind for an account name that has NO master-COA match —
 * mirrors migration 130's seeding rules so off-master client accounts
 * ("Telephone & Internet", "Rent - storage") still get a plan instead of
 * landing in the unknown bucket. Order matters: 'none' patterns win first
 * (never claim ITCs on payroll/insurance/meals by accident). Returns null
 * when genuinely unclassifiable — those stay "unknown" for human review.
 */
export function classifyAccountKind(name: string | null | undefined): GstInputKind | null {
  const n = normalizeAccountKey(name);
  if (!n) return null;
  // Plural-safe: \b(word)\b misses "Materials"/"Donations", so suffixes use \w*.
  if (
    /\b(payroll|wages?|salar\w*|cpp|ei|wsib|workers? comp\w*|insurance|interest|bank charges?|loans?|meals?|entertainment|draws?|dividends?|income tax\w*|gst|hst|pst|qst|sales tax\w*|penalt\w*|fines?|donation\w*|amortiz\w*|depreciat\w*|owner\w*|shareholder\w*)\b/.test(n)
  ) {
    return "none";
  }
  if (
    /\b(materials?|suppl\w*|tools?|equipment|software|phones?|telephone|internet|uniforms?|office|computers?|hardware)\b/.test(n)
  ) {
    return "goods";
  }
  if (
    /\b(subcontract\w*|fuel|advertis\w*|marketing|promotions?|rent\w*|leas\w*|storage|repairs?|maintenance|accounting|bookkeep\w*|legal|professional|training|education|coach\w*|development|travel|parking|tolls?|utilit\w*|electric\w*|hydro|water|heat|gas bill|recruit\w*|processing fees?|dues|subscriptions?|memberships?|website|hosting|freight|shipping|disposal|waste|licens\w*)\b/.test(n)
  ) {
    return "service";
  }
  return null;
}

/** Provinces whose PST applies to GOODS purchases/sales. */
const GOODS_PST = new Set(["BC", "SK", "MB"]);
/** Provinces whose PST ALSO applies to (painting) SERVICES. */
const SERVICE_PST = new Set(["SK"]);

/**
 * Purchased SERVICES that still embed PST/RST in BC & MB because the province
 * taxes services supplied to TANGIBLE personal property, plus telecom:
 *   - rentals/leases of equipment, tools, vehicles, scaffolding, lifts
 *   - repairs & maintenance OF vehicles/equipment (not of real property)
 *   - telecommunications (phone/cell/internet/data)
 * (SK taxes services outright, so it never reaches this test.)
 */
const PST_TAXABLE_SERVICE =
  /\b(equipment|tools?|machin\w*|vehicles?|trucks?|vans?|auto\w*|fleet|trailers?|scaffold\w*|lifts?|sprayers?|compressors?|generators?|telephones?|phones?|cell\w*|mobile|internet|telecom\w*|data)\b/;

/**
 * Explicit REAL-PROPERTY / professional signals that keep a service PST-exempt
 * in BC & MB even when it matches a rent/lease/repair keyword — premises rent,
 * building maintenance, subcontracted labour on real property, professional
 * fees, advertising, insurance. Checked BEFORE the taxable list so
 * "Repairs & Maintenance - Building" stays exempt while "Vehicle Repairs" doesn't.
 */
const PST_EXEMPT_SERVICE =
  /\b(buildings?|premises|offices?|shops?|yards?|storage|warehouses?|real property|lands?|spaces?|units?|accounting|bookkeep\w*|legal|professional|consult\w*|advertis\w*|marketing|subcontract\w*|labour|labor|insurance|utilit\w*|electric\w*|hydro|water|heat|fuel|gas)\b/;

/**
 * PST/RST rate embedded in a PURCHASE, per provincial rules. This is the piece
 * that decides how much of a gross expense is recoverable: PST paid on inputs
 * is NOT an ITC (it's a cost that stays in the expense), so it must be excluded
 * from the recoverable base — ITC = gross × gst / (1 + gst + pst).
 *
 * Rules encoded (Mike 2026-07-27 — "CRA rules for what includes PST, get 95%"):
 *   - No-PST provinces (HST provinces, AB, YT/NT/NU) and QC (QST folded into
 *     the federal-equivalent rate and fully recoverable as an ITR) → 0.
 *   - SK: PST applies to goods AND services (incl. real-property construction).
 *   - BC / MB: goods always; services only when supplied to tangible personal
 *     property or telecom (see the two lists above). Real-property labour,
 *     premises rent, professional fees, advertising, insurance, fuel (motor
 *     fuel tax instead) and commercial utilities are exempt.
 *
 * Residual risk (CPA review): BC charges PST on legal services — treated exempt
 * here as immaterial for a painting contractor.
 */
export function purchasePstRate(
  rates: ProvinceRates,
  kind: GstInputKind,
  accountName?: string | null
): number {
  if (rates.pst <= 0 || kind === "none") return 0;
  // SK taxes services outright — no name discrimination needed.
  if (SERVICE_PST.has(rates.province)) return rates.pst;
  if (!GOODS_PST.has(rates.province)) return 0;
  if (kind === "goods") return rates.pst;
  const n = normalizeAccountKey(accountName);
  if (!n || PST_EXEMPT_SERVICE.test(n)) return 0;
  return PST_TAXABLE_SERVICE.test(n) ? rates.pst : 0;
}

/** Memo stamped on every transaction the apply step edits (idempotency). */
export const GST_EXTRACTION_MEMO = "SNAP GST/HST extraction";

// ── Analysis window resolution ───────────────────────────────────────────────

/** Add days to a YYYY-MM-DD date (UTC, no timezone drift). */
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Same calendar day one year earlier. */
function minusOneYear(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y - 1, m - 1, d)).toISOString().slice(0, 10);
}

export interface WindowResolution {
  start: string;
  end: string;
  /** Plain-English explanation of why this window — shown next to the client. */
  reason: string;
  /** Window would have reached further back but was clamped to one year. */
  cappedByOneYear: boolean;
  /** Window would have reached into books closed in QBO. */
  cappedByClosingDate: boolean;
  /** Start picked up where a previous separation left off (no work redone). */
  resumedFromPriorRun: boolean;
}

/**
 * Resolve the window to analyze for one client.
 *
 * Rules (Mike 2026-07-27 — "YTD, or the last time GST/HST/PST was separated,
 * but at most 1 year"):
 *   - Default to year-to-date (Jan 1 of the current year → today).
 *   - If tax was already separated through some date, resume the day after it
 *     so nothing already done is re-examined — even when that reaches back
 *     before Jan 1.
 *   - Never reach back more than ONE YEAR from today.
 *   - Never reach into a period closed in QBO (those writes would be rejected
 *     anyway, and a filed period shouldn't move).
 * An explicit start/end always wins — this only supplies the default.
 */
export function resolveExtractionWindow(opts: {
  today: string;
  /** Last date through which GST/HST/PST is already separated, if known. */
  lastSeparatedThrough?: string | null;
  /** QBO books-closed-through date, if set. */
  closingDate?: string | null;
  explicitStart?: string | null;
  explicitEnd?: string | null;
}): WindowResolution {
  const { today, lastSeparatedThrough, closingDate, explicitStart, explicitEnd } = opts;
  const end = explicitEnd || today;

  if (explicitStart) {
    return {
      start: explicitStart,
      end,
      reason: `Custom window ${explicitStart} → ${end}`,
      cappedByOneYear: false,
      cappedByClosingDate: false,
      resumedFromPriorRun: false,
    };
  }

  const yearStart = `${today.slice(0, 4)}-01-01`;
  const oneYearFloor = minusOneYear(today);
  const closedFloor = closingDate ? addDays(closingDate, 1) : null;

  // Where we'd like to start: after the last separation, else the start of the year.
  const resumed = !!lastSeparatedThrough;
  let start = resumed ? addDays(lastSeparatedThrough!, 1) : yearStart;
  const wanted = start;

  // Apply the floors — the latest floor wins.
  let cappedByOneYear = false;
  let cappedByClosingDate = false;
  if (start < oneYearFloor) {
    start = oneYearFloor;
    cappedByOneYear = true;
  }
  if (closedFloor && start < closedFloor) {
    start = closedFloor;
    cappedByClosingDate = true;
  }

  // A resume point in the future of `end` means there's nothing left to do.
  if (start > end) {
    return {
      start,
      end,
      reason: `Nothing to analyze — already separated through ${lastSeparatedThrough}`,
      cappedByOneYear,
      cappedByClosingDate,
      resumedFromPriorRun: resumed,
    };
  }

  let reason: string;
  if (resumed && start === wanted) {
    reason = `Resumes the day after ${lastSeparatedThrough}, the last date tax was separated`;
  } else if (cappedByClosingDate) {
    reason = `Starts after the QBO closing date (${closingDate}) — closed books aren't touched`;
  } else if (cappedByOneYear) {
    reason = "Clamped to one year back — the furthest this tool will reach";
  } else {
    reason = `Year to date — no earlier tax separation found`;
  }

  return { start, end, reason, cappedByOneYear, cappedByClosingDate, resumedFromPriorRun: resumed };
}

const r2 = (n: number) => Math.round((n || 0) * 100) / 100;

export interface ProvinceRates {
  province: string;
  /** Federal component (GST or HST) — the recoverable/collectible-to-CRA rate. */
  gstHst: number;
  /** Provincial component (PST/RST) where separately filed. QST is folded into
   *  gstHst per Mike's "treat Quebec like HST, call it QST". */
  pst: number;
  /** True when this is Quebec (accounts get QST names). */
  isQuebec: boolean;
}

/**
 * Effective rates for a province at a transaction date. NS HST was 15% before
 * 2025-04-01, 14% after. Unknown/US provinces → null (caller skips).
 */
export function ratesFor(province: string | null | undefined, dateISO: string): ProvinceRates | null {
  const p = getProvinceTax(province);
  if (!p) return null;
  let gstHst = p.rates.hst ?? p.rates.gst ?? 0;
  if (p.code === "NS" && dateISO && dateISO < "2025-04-01") gstHst = 0.15;
  if (p.code === "QC") {
    // Combined GST+QST treated as one HST-like rate.
    gstHst = (p.rates.gst ?? 0) + (p.rates.qst ?? 0);
  }
  const pst = p.rates.pst ?? p.rates.rst ?? 0;
  return { province: p.code, gstHst, pst, isQuebec: p.code === "QC" };
}

/** Account names the splits post to — QST-labeled for Quebec clients. */
export function taxAccountNamesFor(province: string | null | undefined): {
  payable: string;
  recoverable: string;
  pstPayable: string;
} {
  const qc = (province || "").toUpperCase() === "QC";
  return {
    payable: qc ? "GST/QST Payable" : "GST/HST Payable",
    recoverable: qc ? "GST/QST Recoverable (ITRs)" : "GST/HST Recoverable (ITCs)",
    pstPayable: "PST Payable",
  };
}

/** All tax-account names (any province variant) — used to detect already-split
 *  rows. Includes the "Collected" fallbacks used when QBO's built-in
 *  agency-linked account owns the primary name (it rejects direct postings —
 *  "Tax Liability Account" 400, proven live on Maple City). */
export const ALL_TAX_ACCOUNT_NAMES = [
  "GST/HST Payable",
  "GST/QST Payable",
  "GST/HST Recoverable (ITCs)",
  "GST/QST Recoverable (ITRs)",
  "PST Payable",
  "GST/HST Collected",
  "GST/QST Collected",
  "PST Collected",
  "GST/HST Recoverable (ITCs) - SNAP",
  "GST/QST Recoverable (ITRs) - SNAP",
];

export interface IncomeSplit {
  gross: number;
  net: number;
  gstHst: number; // → payable account
  pst: number; // → PST Payable (0 outside BC/SK/MB sale-tax cases)
}

/**
 * Split a gross income amount (a deposit line into an income account) into
 * net + tax components at the province's SERVICE rates. Painting labor:
 * BC/MB PST does not apply; SK PST does; HST provinces are single-rate.
 * Rounding: components are rounded, net absorbs the residual so
 * net + gstHst + pst === gross to the cent. Sign-safe (refund lines split too).
 */
export function splitIncome(gross: number, rates: ProvinceRates): IncomeSplit {
  const servicePst = SERVICE_PST.has(rates.province) ? rates.pst : 0;
  const totalRate = rates.gstHst + servicePst;
  if (totalRate <= 0 || !gross) return { gross: r2(gross), net: r2(gross), gstHst: 0, pst: 0 };
  const netRaw = gross / (1 + totalRate);
  const gstHst = r2(netRaw * rates.gstHst);
  const pst = servicePst > 0 ? r2(netRaw * servicePst) : 0;
  const net = r2(gross - gstHst - pst);
  return { gross: r2(gross), net, gstHst, pst };
}

export interface ExpenseSplit {
  gross: number;
  net: number; // stays in the expense account (includes unrecoverable PST)
  itc: number; // → recoverable account
}

/**
 * Split a gross expense line into net + recoverable ITC. Only the GST/HST
 * portion is recoverable; any PST/RST embedded in the price is a cost and stays
 * inside the net expense — so the recoverable base excludes it:
 *   ITC = gross × gst / (1 + gst + embeddedPst)
 * `embeddedPst` comes from purchasePstRate(), which encodes the provincial
 * rules (SK taxes services; BC/MB tax goods + services to tangible property /
 * telecom; everywhere else 0). Pass the account name so those rules can apply —
 * omitting it falls back to goods-only PST.
 * Rounding: ITC rounded, net absorbs the residual (net + itc === gross).
 */
export function splitExpense(
  gross: number,
  rates: ProvinceRates,
  kind: GstInputKind,
  accountName?: string | null
): ExpenseSplit | null {
  if (kind === "none" || !gross) return null;
  const embeddedPst = purchasePstRate(rates, kind, accountName);
  const g = rates.gstHst;
  if (g <= 0) return null;
  const itc = r2((gross * g) / (1 + g + embeddedPst));
  const net = r2(gross - itc);
  if (itc === 0) return null;
  return { gross: r2(gross), net, itc };
}

// ── Per-client extraction plan (drives preview + apply) ──────────────────────

export interface DepositLinePlan {
  txn_id: string;
  date: string;
  account: string;
  customer: string | null;
  split: IncomeSplit;
}

export interface ExpenseLinePlan {
  txn_id: string;
  txn_type: string;
  date: string;
  account: string;
  vendor: string | null;
  kind: GstInputKind;
  split: ExpenseSplit;
}

export interface ExtractionPlan {
  province: string;
  accounts: ReturnType<typeof taxAccountNamesFor>;
  deposits: DepositLinePlan[];
  expenses: ExpenseLinePlan[];
  totals: {
    incomeGross: number;
    incomeNet: number;
    gstHstCollected: number;
    pstCollected: number;
    expenseGross: number;
    itcTotal: number;
  };
  skipped: {
    alreadySplitTxns: number;
    nonRecoverableLines: number;
    /** Expense accounts we couldn't classify — surfaced for review, never guessed. */
    unknownAccounts: string[];
    /** Expense lines skipped because their vendor is excluded (no ITC). */
    excludedVendorLines: number;
  };
  /** ITC per vendor (largest first) — the review surface for spotting
   *  unregistered small suppliers before the expense-side apply. */
  vendorItcSummary: Array<{ vendor: string; lines: number; itc: number }>;
}

/** Expense-family txn types whose lines we split (posting rows on the P&L detail). */
const EXPENSE_TYPES = /^(expense|check|cash expense|credit card expense|credit card credit|bill|purchase)$/i;
const isDeposit = (t: string | null | undefined) => /^deposit$/i.test((t || "").trim());

/**
 * Build the full per-line plan for one client from cash-basis P&L detail.
 * - incomeAccounts: the client's real income account names (summary P&L) —
 *   only deposits into those are split.
 * - kindByAccount: gst_input_kind keyed by normalizeAccountKey(account name)
 *   (master-COA seeds + heuristic fallbacks — the caller builds it); expense
 *   accounts missing from it are collected as unknown (no split).
 * - Idempotency: any txn that already has a line in a tax account is skipped
 *   entirely (the apply also re-checks the memo marker server-side).
 */
export function buildExtractionPlan(
  plDetail: PLDetailRow[] | null | undefined,
  province: string,
  incomeAccounts: Set<string>,
  kindByAccount: Map<string, GstInputKind>,
  opts?: {
    /** Vendors (normalized via normalizeAccountKey) whose expense lines get NO
     *  ITC split — unregistered small suppliers ("Ryan") charge no tax, so
     *  claiming 13/113 on their lines over-claims. Income side unaffected. */
    excludeVendors?: Set<string>;
  }
): ExtractionPlan | null {
  const probeRates = ratesFor(province, "2026-01-01");
  if (!probeRates) return null;
  const accounts = taxAccountNamesFor(province);

  const rows = plDetail || [];
  const taxAcctLc = new Set(ALL_TAX_ACCOUNT_NAMES.map((a) => normalizeAccountKey(a)));
  const incomeLc = new Set([...incomeAccounts].map((a) => normalizeAccountKey(a)));

  // Idempotency: txns already carrying a tax-account line.
  const alreadySplitTxnIds = new Set(
    rows.filter((r) => taxAcctLc.has(normalizeAccountKey(r.account))).map((r) => r.txn_id)
  );

  const deposits: DepositLinePlan[] = [];
  const expenses: ExpenseLinePlan[] = [];
  const unknown = new Set<string>();
  let nonRecoverable = 0;
  let excludedVendorLines = 0;
  const excludeVendors = opts?.excludeVendors;

  for (const row of rows) {
    if (!row.txn_id || alreadySplitTxnIds.has(row.txn_id)) continue;
    const rates = ratesFor(province, row.date);
    if (!rates) continue;
    const acctLc = normalizeAccountKey(row.account);
    const amount = Number(row.amount) || 0;
    if (!amount) continue;

    if (isDeposit(row.txn_type) && incomeLc.has(acctLc)) {
      const split = splitIncome(amount, rates);
      if (split.gstHst !== 0 || split.pst !== 0) {
        deposits.push({ txn_id: row.txn_id, date: row.date, account: row.account, customer: row.name ?? null, split });
      }
      continue;
    }

    if (EXPENSE_TYPES.test((row.txn_type || "").trim())) {
      const kind = kindByAccount.get(acctLc);
      if (kind === undefined) {
        if (row.account) unknown.add(row.account);
        continue;
      }
      if (kind === "none") {
        nonRecoverable++;
        continue;
      }
      // Excluded vendor (unregistered small supplier — no tax embedded).
      if (excludeVendors && row.name && excludeVendors.has(normalizeAccountKey(row.name))) {
        excludedVendorLines++;
        continue;
      }
      const split = splitExpense(amount, rates, kind, row.account);
      if (split) {
        expenses.push({
          txn_id: row.txn_id,
          txn_type: row.txn_type,
          date: row.date,
          account: row.account,
          vendor: row.name ?? null,
          kind,
          split,
        });
      } else {
        nonRecoverable++;
      }
    }
  }

  const totals = {
    incomeGross: r2(deposits.reduce((s, d) => s + d.split.gross, 0)),
    incomeNet: r2(deposits.reduce((s, d) => s + d.split.net, 0)),
    gstHstCollected: r2(deposits.reduce((s, d) => s + d.split.gstHst, 0)),
    pstCollected: r2(deposits.reduce((s, d) => s + d.split.pst, 0)),
    expenseGross: r2(expenses.reduce((s, e) => s + e.split.gross, 0)),
    itcTotal: r2(expenses.reduce((s, e) => s + e.split.itc, 0)),
  };

  // ITC by vendor, largest first — the "is this vendor actually registered?"
  // review surface (a person-named vendor with ITCs is the tell).
  const byVendor = new Map<string, { lines: number; itc: number }>();
  for (const e of expenses) {
    const v = (e.vendor || "(no vendor)").trim() || "(no vendor)";
    const g = byVendor.get(v) || { lines: 0, itc: 0 };
    g.lines++;
    g.itc = r2(g.itc + Math.abs(e.split.itc));
    byVendor.set(v, g);
  }
  const vendorItcSummary = [...byVendor.entries()]
    .map(([vendor, g]) => ({ vendor, ...g }))
    .sort((a, b) => b.itc - a.itc);

  return {
    province,
    accounts,
    deposits,
    expenses,
    totals,
    skipped: {
      alreadySplitTxns: alreadySplitTxnIds.size,
      nonRecoverableLines: nonRecoverable,
      unknownAccounts: [...unknown].sort(),
      excludedVendorLines,
    },
    vendorItcSummary,
  };
}
