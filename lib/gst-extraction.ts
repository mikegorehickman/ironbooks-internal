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

/** Memo stamped on every transaction the apply step edits (idempotency). */
export const GST_EXTRACTION_MEMO = "SNAP GST/HST extraction";

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

/** All tax-account names (any province variant) — used to detect already-split rows. */
export const ALL_TAX_ACCOUNT_NAMES = [
  "GST/HST Payable",
  "GST/QST Payable",
  "GST/HST Recoverable (ITCs)",
  "GST/QST Recoverable (ITRs)",
  "PST Payable",
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
 * Split a gross expense line into net + recoverable ITC, per the category's
 * input kind and the province's purchase rules:
 *   - 'none'    → no split.
 *   - 'service' → GST/HST embedded (plus SK PST on services — unrecoverable,
 *                 stays in net): ITC = gross × g / (1 + g + servicePst).
 *   - 'goods'   → in BC/SK/MB the price embeds GST+PST; only GST is
 *                 recoverable: ITC = gross × g / (1 + g + pst).
 * Rounding: ITC rounded, net absorbs the residual (net + itc === gross).
 */
export function splitExpense(gross: number, rates: ProvinceRates, kind: GstInputKind): ExpenseSplit | null {
  if (kind === "none" || !gross) return null;
  const embeddedPst =
    kind === "goods" && GOODS_PST.has(rates.province)
      ? rates.pst
      : kind === "service" && SERVICE_PST.has(rates.province)
        ? rates.pst
        : 0;
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
  };
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
  kindByAccount: Map<string, GstInputKind>
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
      const split = splitExpense(amount, rates, kind);
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
    },
  };
}
