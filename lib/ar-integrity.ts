/**
 * A/R integrity — is this client's Accounts Receivable actually real?
 *
 * The failure mode (All Inspired Painting, 2026-07): the client invoices out
 * of their CRM, those invoices land in QBO, the customer pays — but the
 * deposit is categorized straight to revenue instead of being APPLIED to the
 * invoice. The invoice never closes. Repeat for four years and QBO reports
 * $1.55M "owed" across 110 invoices, the oldest 1,638 days old, on a book
 * doing ~$100K/month. None of it is collectable; almost all of it is already
 * collected. It's the A/R-side twin of the deposits-booked-as-revenue
 * double-count (see lib/revenue-integrity.ts).
 *
 * These are UNMATCHED invoices, not bad debt. That distinction drives the
 * whole remediation: a write-off asserts "never collected" (wrong, hits the
 * current period, and understates revenue when the deposit already booked to
 * income). The correct instruments are (a) apply the deposit to the invoice
 * — see lib/crm-invoice-apply.ts — or (b) for prior closed fiscal years, a
 * prior-period adjustment to equity, which needs CPA sign-off. This module
 * only DIAGNOSES; it posts nothing.
 *
 * Read-only and pure: hand it open invoices + trailing revenue, get a verdict.
 */

export interface ArInvoiceLike {
  qbo_invoice_id: string;
  doc_number: string | null;
  customer_name: string | null;
  txn_date: string;
  due_date: string | null;
  balance: number;
}

export type ArVerdict = "clean" | "suspect" | "unreliable";

export interface ArCustomerRollup {
  name: string;
  total: number;
  count: number;
  oldestDays: number;
}

export interface ArIntegrityReport {
  verdict: ArVerdict;
  /** Plain-English "why" for the bookkeeper — the numbers, not adjectives. */
  reason: string;
  /** True when the verdict is anything other than clean. */
  flagged: boolean;

  totalOpen: number;
  totalCount: number;

  /** Dated before the current fiscal year — presumed closed books. These are
   *  the ones to drop from client-facing totals; the ledger fix is a
   *  prior-period adjustment, never a current-period write-off. */
  priorYearTotal: number;
  priorYearCount: number;
  /** Current fiscal year but over 90 days — the match-me-to-a-deposit pile. */
  staleTotal: number;
  staleCount: number;
  /** 90 days or newer — plausibly genuine A/R. */
  recentTotal: number;
  recentCount: number;

  oldestDays: number | null;
  oldestDate: string | null;
  /** Share of open A/R DOLLARS aged over 90 days (0–100). */
  pctOver90: number;
  /** Average monthly revenue over the trailing window, when known. */
  monthlyRevenue: number | null;
  /** Open A/R expressed as months of revenue — the "is this absurd?" ratio. */
  arToMonthlyRevenue: number | null;
  /** Client is on deposits-only recognition — QBO invoices aren't their
   *  source of truth, so open A/R is definitionally unreliable. */
  depositsOnly: boolean;

  fiscalYearStart: string;
  /** Worst offenders, biggest balance first — capped for storage. */
  topCustomers: ArCustomerRollup[];
}

// ── Thresholds. Tunable in one place; every verdict traces back here. ──
/** Over-90 share (%) that alone makes A/R untrustworthy. */
export const PCT_OVER_90_UNRELIABLE = 70;
export const PCT_OVER_90_SUSPECT = 40;
/** An invoice older than this is not being collected — it's unmatched. */
export const OLDEST_DAYS_UNRELIABLE = 365;
export const OLDEST_DAYS_SUSPECT = 180;
/** Open A/R worth more than N months of revenue is not real A/R. */
export const AR_MONTHS_UNRELIABLE = 6;
export const AR_MONTHS_SUSPECT = 3;
/** Ignore trivial balances — rounding pennies shouldn't flag a book. */
export const AR_MATERIALITY_FLOOR = 250;

const DAY_MS = 86_400_000;

/**
 * Start of the client's CURRENT fiscal year. Anything dated before this sits
 * in a closed year. `fiscalYearEnd` is free text on client_links ("12-31",
 * "December 31", "Dec"); we parse a month out of it and fall back to the
 * calendar year, which is right for the overwhelming majority of painters.
 */
export function currentFiscalYearStart(
  fiscalYearEnd: string | null | undefined,
  asOf: Date = new Date()
): string {
  const fyeMonth = parseFyeMonth(fiscalYearEnd); // 1–12, the month the year ENDS
  const y = asOf.getUTCFullYear();
  if (!fyeMonth || fyeMonth === 12) return `${y}-01-01`;
  // FY starts the month after it ends. If we're past that start this calendar
  // year we're in the FY that began this year; otherwise it began last year.
  const startMonth = (fyeMonth % 12) + 1;
  const startedThisYear = asOf.getUTCMonth() + 1 >= startMonth;
  const startYear = startedThisYear ? y : y - 1;
  return `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
}

function parseFyeMonth(fye: string | null | undefined): number | null {
  if (!fye) return null;
  const s = String(fye).trim().toLowerCase();
  const names = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const named = names.findIndex((n) => s.startsWith(n) || s.includes(` ${n}`) || s.includes(`-${n}`));
  if (named >= 0) return named + 1;
  // "12-31", "12/31", "2026-12-31" → take the month component.
  const m = s.match(/(?:^|\D)(\d{1,2})\s*[-/]\s*\d{1,2}\s*$/);
  if (m) {
    const mm = parseInt(m[1], 10);
    if (mm >= 1 && mm <= 12) return mm;
  }
  return null;
}

/** Age of an invoice in days, measured from its transaction date (not due
 *  date — we're asking "how long has this been sitting", not "how late"). */
function ageDays(inv: ArInvoiceLike, asOf: Date): number {
  const t = new Date(inv.txn_date).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((asOf.getTime() - t) / DAY_MS));
}

export function analyzeArIntegrity(params: {
  invoices: ArInvoiceLike[];
  /** Trailing average monthly revenue, if we could fetch it. */
  monthlyRevenue?: number | null;
  /** client_links.revenue_recognition_mode === "deposits_only" */
  depositsOnly?: boolean;
  fiscalYearEnd?: string | null;
  asOf?: Date;
}): ArIntegrityReport {
  const asOf = params.asOf || new Date();
  const fiscalYearStart = currentFiscalYearStart(params.fiscalYearEnd, asOf);
  const fyStartMs = new Date(`${fiscalYearStart}T00:00:00Z`).getTime();
  const depositsOnly = !!params.depositsOnly;

  const open = (params.invoices || []).filter((i) => Math.abs(i.balance || 0) >= 0.005);

  let totalOpen = 0;
  let priorYearTotal = 0, priorYearCount = 0;
  let staleTotal = 0, staleCount = 0;
  let recentTotal = 0, recentCount = 0;
  let over90Total = 0;
  let oldestDays: number | null = null;
  let oldestDate: string | null = null;

  const byCustomer = new Map<string, ArCustomerRollup>();

  for (const inv of open) {
    const bal = inv.balance || 0;
    const age = ageDays(inv, asOf);
    const txnMs = new Date(inv.txn_date).getTime();
    totalOpen += bal;

    if (oldestDays === null || age > oldestDays) {
      oldestDays = age;
      oldestDate = inv.txn_date;
    }
    if (age > 90) over90Total += bal;

    if (Number.isFinite(txnMs) && txnMs < fyStartMs) {
      priorYearTotal += bal;
      priorYearCount++;
    } else if (age > 90) {
      staleTotal += bal;
      staleCount++;
    } else {
      recentTotal += bal;
      recentCount++;
    }

    const name = (inv.customer_name || "(no customer)").trim();
    const roll = byCustomer.get(name) || { name, total: 0, count: 0, oldestDays: 0 };
    roll.total += bal;
    roll.count++;
    roll.oldestDays = Math.max(roll.oldestDays, age);
    byCustomer.set(name, roll);
  }

  const pctOver90 = totalOpen > 0 ? (over90Total / totalOpen) * 100 : 0;
  const monthlyRevenue =
    params.monthlyRevenue != null && params.monthlyRevenue > 0 ? params.monthlyRevenue : null;
  const arToMonthlyRevenue = monthlyRevenue ? totalOpen / monthlyRevenue : null;

  const topCustomers = [...byCustomer.values()].sort((a, b) => b.total - a.total).slice(0, 15);

  // ── Verdict ──
  let verdict: ArVerdict = "clean";
  const why: string[] = [];

  if (totalOpen < AR_MATERIALITY_FLOOR) {
    verdict = "clean";
  } else {
    const unreliableHits: string[] = [];
    const suspectHits: string[] = [];

    if (pctOver90 >= PCT_OVER_90_UNRELIABLE)
      unreliableHits.push(`${Math.round(pctOver90)}% of open A/R is over 90 days`);
    else if (pctOver90 >= PCT_OVER_90_SUSPECT)
      suspectHits.push(`${Math.round(pctOver90)}% of open A/R is over 90 days`);

    if (oldestDays != null && oldestDays > OLDEST_DAYS_UNRELIABLE)
      unreliableHits.push(`the oldest invoice is ${oldestDays.toLocaleString()} days old`);
    else if (oldestDays != null && oldestDays > OLDEST_DAYS_SUSPECT)
      suspectHits.push(`the oldest invoice is ${oldestDays} days old`);

    if (arToMonthlyRevenue != null && arToMonthlyRevenue > AR_MONTHS_UNRELIABLE)
      unreliableHits.push(`open A/R is ${arToMonthlyRevenue.toFixed(1)}× monthly revenue`);
    else if (arToMonthlyRevenue != null && arToMonthlyRevenue > AR_MONTHS_SUSPECT)
      suspectHits.push(`open A/R is ${arToMonthlyRevenue.toFixed(1)}× monthly revenue`);

    // Deposits-only says outright that QBO invoices aren't the source of
    // truth. Paired with any real aging, that's decisive.
    if (depositsOnly && pctOver90 >= PCT_OVER_90_SUSPECT)
      unreliableHits.push("this client is on deposits-only revenue recognition (QBO invoices aren't their source of truth)");
    else if (depositsOnly) suspectHits.push("this client is on deposits-only revenue recognition");

    if (unreliableHits.length > 0) {
      verdict = "unreliable";
      why.push(...unreliableHits, ...suspectHits);
    } else if (suspectHits.length > 0) {
      verdict = "suspect";
      why.push(...suspectHits);
    }
  }

  let reason: string;
  if (verdict === "clean") {
    reason =
      totalOpen < AR_MATERIALITY_FLOOR
        ? "No material open A/R."
        : `Open A/R ages normally${oldestDays != null ? ` (oldest ${oldestDays} days)` : ""} — nothing suggesting unmatched invoices.`;
  } else {
    const lead = verdict === "unreliable" ? "A/R is not trustworthy" : "A/R looks questionable";
    reason =
      `${lead}: ${joinList(why)}. ` +
      `Invoices this old are almost certainly already collected but never matched to their deposits — ` +
      `they are unmatched invoices, not bad debt.`;
  }

  return {
    verdict,
    reason,
    flagged: verdict !== "clean",
    totalOpen: round2(totalOpen),
    totalCount: open.length,
    priorYearTotal: round2(priorYearTotal),
    priorYearCount,
    staleTotal: round2(staleTotal),
    staleCount,
    recentTotal: round2(recentTotal),
    recentCount,
    oldestDays,
    oldestDate,
    pctOver90: Math.round(pctOver90 * 10) / 10,
    monthlyRevenue: monthlyRevenue != null ? round2(monthlyRevenue) : null,
    arToMonthlyRevenue: arToMonthlyRevenue != null ? Math.round(arToMonthlyRevenue * 10) / 10 : null,
    depositsOnly,
    fiscalYearStart,
    topCustomers: topCustomers.map((c) => ({ ...c, total: round2(c.total) })),
  };
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
