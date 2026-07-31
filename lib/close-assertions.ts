/**
 * Two balance-sheet assertions that have to hold before a month closes.
 *
 * WHY THESE TWO, AND WHY NOW. We are moving revenue recognition to the correct
 * direction: revenue originates from INVOICES, and bank deposits MATCH to those
 * invoices rather than being categorized straight into income. That is what
 * Intuit's own guidance means by "match, don't add", and it removes the
 * deposits-as-revenue double count.
 *
 * But it moves the failure somewhere else. Under invoice-sourced revenue:
 *
 *   - an unapplied payment inflates Undeposited Funds instead of income
 *   - an unmatched deposit leaves the invoice open, inflating A/R
 *
 * Neither is created by the change — both already exist, offset today by the
 * phantom revenue the double count was producing. Switching methods makes them
 * visible, which is the point, but it means the close needs two assertions or
 * the balance sheet quietly grows forever.
 *
 *   1. Undeposited Funds is a CLEARING account. Its balance at period end must
 *      be zero. A balance means unfinished work, full stop.
 *   2. Every open invoice must be CLASSIFIED — we know why it is still open.
 *      An aged-A/R list alone is not an answer; "17 invoices over 60 days" tells
 *      a bookkeeper nothing about which ones are real.
 *
 * Pure and dependency-free so both are testable without QBO. The caller owns
 * all I/O — books-verification already has every input in hand.
 */

/** An open (balance > 0) invoice, as lib/qbo-balance-sheet returns it. */
export interface OpenInvoiceLike {
  qbo_invoice_id: string;
  doc_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  txn_date: string;
  due_date: string | null;
  total_amount: number;
  balance: number;
}

/** A deposit or other income posting seen in the period's P&L detail. */
export interface IncomePostingLike {
  txn_type: string;
  date: string;
  amount: number;
  name: string | null;
  memo: string | null;
}

/** A payment sitting in Undeposited Funds. */
export interface UfPaymentLike {
  payment_date: string;
  amount: number;
  customer_name?: string | null;
  classification?: string | null;
}

// ── 1. Undeposited Funds ─────────────────────────────────────────────────────

export interface UfAssertion {
  /** Balance at period end. */
  balance: number;
  /** True when the account is clear to the cent tolerance. */
  clear: boolean;
  /** Payments still sitting in UF at period end, oldest first. */
  stuck: UfPaymentLike[];
  /** Of those, the ones older than the staleness window. */
  stale: UfPaymentLike[];
  /** Plain-English result for the check's `detail` line. */
  summary: string;
}

/** Below this, a balance is rounding, not a real stuck payment. */
const UF_TOLERANCE = 1;
/** A payment sitting in UF longer than this stopped being "in transit". */
const UF_STALE_DAYS = 60;

/**
 * Assert Undeposited Funds is clear at period end.
 *
 * Deliberately stricter than the tolerance this replaces, which only failed at
 * $5,000 or on an old orphan — so a client could close every month with $4,900
 * of unapplied customer money and never see a red flag. UF is a clearing
 * account; there is no correct non-zero balance at a close. A known standing
 * float is handled by DISMISSING the finding, which leaves a record of who
 * decided that and why, rather than by a silent threshold nobody can see.
 */
export function assertUndepositedFundsClear(
  balance: number,
  payments: UfPaymentLike[],
  periodEnd: string
): UfAssertion {
  const clear = Math.abs(balance) < UF_TOLERANCE;
  const endMs = Date.parse(`${periodEnd}T23:59:59Z`);
  const staleCutoff = endMs - UF_STALE_DAYS * 86_400_000;

  const stuck = (payments || [])
    .filter((p) => {
      const t = Date.parse(`${p.payment_date}T00:00:00Z`);
      // A payment dated AFTER the period end isn't stuck for this close.
      return Number.isFinite(t) && t <= endMs;
    })
    .sort((a, b) => a.payment_date.localeCompare(b.payment_date));

  const stale = stuck.filter((p) => Date.parse(`${p.payment_date}T00:00:00Z`) < staleCutoff);

  const summary = clear
    ? "Undeposited Funds is clear"
    : `${money(balance)} sitting in Undeposited Funds` +
      (stuck.length ? ` across ${stuck.length} payment${stuck.length === 1 ? "" : "s"}` : "") +
      (stale.length ? `, ${stale.length} older than ${UF_STALE_DAYS} days` : "");

  return { balance, clear, stuck, stale, summary };
}

// ── 2. Open A/R classification ───────────────────────────────────────────────

export type ArReason =
  /** A deposit for this amount landed but was never applied — the matcher fixes
   *  this, and these are the invoices that will close themselves. */
  | "unmatched_deposit"
  /** Another open invoice for the same customer and amount — likely the CRM and
   *  a bookkeeper both raised one. Match, don't void. */
  | "probable_duplicate"
  /** Recent enough to just be unpaid. Correct, leave it. */
  | "current"
  /** Old, and nothing explains it. This is the number that must reach zero. */
  | "unexplained";

export interface ClassifiedInvoice {
  invoice: OpenInvoiceLike;
  reason: ArReason;
  /** Days past due at period end (negative = not yet due). */
  daysOverdue: number;
  /** The deposit that probably belongs to this invoice, when reason says so. */
  evidence?: IncomePostingLike;
  note: string;
}

export interface ArAssertion {
  classified: ClassifiedInvoice[];
  counts: Record<ArReason, number>;
  totals: Record<ArReason, number>;
  /** Invoices past the aging window with no explanation — the blocking number. */
  unexplained: ClassifiedInvoice[];
  /** $ that should resolve itself once deposits are matched to invoices. */
  recoverable: number;
  summary: string;
}

/** Past this, an open invoice needs a reason rather than the benefit of doubt. */
const AR_AGING_DAYS = 60;
/** Deposit↔invoice amount match tolerance, in dollars. */
const AMOUNT_TOLERANCE = 0.02;
/** A deposit this far either side of the invoice date is a candidate. */
const DEPOSIT_WINDOW_DAYS = 120;

/**
 * Explain every open invoice.
 *
 * The ordering of tests matters and is deliberate: an unmatched deposit is
 * checked BEFORE duplicate-detection, because a duplicate pair where one side
 * was actually paid is not a duplicate — it is one real invoice and one that
 * needs matching. Getting that backwards would void real revenue.
 *
 * `current` is not a free pass, it is a statement that the invoice is too young
 * to draw a conclusion about. Only `unexplained` blocks.
 */
export function classifyOpenInvoices(
  invoices: OpenInvoiceLike[],
  incomePostings: IncomePostingLike[],
  periodEnd: string
): ArAssertion {
  const endMs = Date.parse(`${periodEnd}T23:59:59Z`);

  // Deposit-shaped income postings only. An invoice posting is the invoice
  // itself and must never be treated as evidence that it was paid.
  const deposits = (incomePostings || []).filter((p) =>
    /deposit|payment|sales receipt|transfer/i.test(p.txn_type || "")
  );
  const claimed = new Set<IncomePostingLike>();

  const classified: ClassifiedInvoice[] = [];

  // Same customer + same balance = duplicate candidates. Built once.
  const byCustomerAmount = new Map<string, OpenInvoiceLike[]>();
  for (const inv of invoices || []) {
    const k = `${(inv.customer_id || inv.customer_name || "?").toString().toLowerCase()}|${inv.balance.toFixed(2)}`;
    const list = byCustomerAmount.get(k) || [];
    list.push(inv);
    byCustomerAmount.set(k, list);
  }

  for (const inv of invoices || []) {
    const dueMs = Date.parse(`${inv.due_date || inv.txn_date}T00:00:00Z`);
    const daysOverdue = Math.floor((endMs - dueMs) / 86_400_000);

    // (a) Is there an unclaimed deposit that matches this invoice's balance?
    const invMs = Date.parse(`${inv.txn_date}T00:00:00Z`);
    const match = deposits.find((d) => {
      if (claimed.has(d)) return false;
      if (Math.abs(Math.abs(d.amount) - inv.balance) > AMOUNT_TOLERANCE) return false;
      const dMs = Date.parse(`${d.date}T00:00:00Z`);
      if (!Number.isFinite(dMs)) return false;
      if (Math.abs(dMs - invMs) > DEPOSIT_WINDOW_DAYS * 86_400_000) return false;
      // Same customer, when both sides name one. A bare bank memo has no payee,
      // so absence is not disqualifying — the amount + window still counts.
      const inName = (inv.customer_name || "").toLowerCase().trim();
      const dName = (d.name || "").toLowerCase().trim();
      if (inName && dName && !dName.includes(inName) && !inName.includes(dName)) return false;
      return true;
    });
    if (match) {
      claimed.add(match);
      classified.push({
        invoice: inv,
        reason: "unmatched_deposit",
        daysOverdue,
        evidence: match,
        note:
          `${money(Math.abs(match.amount))} ${match.txn_type} on ${match.date} matches this invoice's balance ` +
          `but was never applied to it — applying it closes the invoice and removes the double-counted revenue.`,
      });
      continue;
    }

    // (b) Another open invoice, same customer, same amount.
    const k = `${(inv.customer_id || inv.customer_name || "?").toString().toLowerCase()}|${inv.balance.toFixed(2)}`;
    if ((byCustomerAmount.get(k) || []).length > 1) {
      classified.push({
        invoice: inv,
        reason: "probable_duplicate",
        daysOverdue,
        note:
          `Another open invoice for ${inv.customer_name || "this customer"} carries the same ${money(inv.balance)} balance — ` +
          `likely raised twice. Match the payment to one; do not void without checking.`,
      });
      continue;
    }

    // (c) Too young to conclude anything.
    if (daysOverdue <= AR_AGING_DAYS) {
      classified.push({
        invoice: inv,
        reason: "current",
        daysOverdue,
        note: daysOverdue < 0 ? "Not yet due" : `${daysOverdue} days past due — within the ${AR_AGING_DAYS}-day window`,
      });
      continue;
    }

    // (d) Old and unexplained.
    classified.push({
      invoice: inv,
      reason: "unexplained",
      daysOverdue,
      note:
        `${daysOverdue} days past due with no matching deposit and no duplicate — confirm with the client ` +
        `whether this was paid, is still collectible, or is bad debt.`,
    });
  }

  const counts = { unmatched_deposit: 0, probable_duplicate: 0, current: 0, unexplained: 0 } as Record<ArReason, number>;
  const totals = { unmatched_deposit: 0, probable_duplicate: 0, current: 0, unexplained: 0 } as Record<ArReason, number>;
  for (const c of classified) {
    counts[c.reason]++;
    totals[c.reason] = round2(totals[c.reason] + c.invoice.balance);
  }

  const unexplained = classified.filter((c) => c.reason === "unexplained");
  const recoverable = totals.unmatched_deposit;

  const summary =
    classified.length === 0
      ? "No open invoices"
      : `${classified.length} open invoice${classified.length === 1 ? "" : "s"}: ` +
        `${counts.unmatched_deposit} with an unapplied deposit (${money(recoverable)}), ` +
        `${counts.probable_duplicate} probable duplicate${counts.probable_duplicate === 1 ? "" : "s"}, ` +
        `${counts.current} current, ` +
        `${counts.unexplained} unexplained (${money(totals.unexplained)})`;

  return { classified, counts, totals, unexplained, recoverable, summary };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function money(n: number): string {
  const v = Math.abs(n);
  return `${n < 0 ? "-" : ""}$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
