/**
 * Smart deposit matching for the UF audit (Mike 2026-07-18).
 *
 * The base UF scan classifies a payment as "orphan" purely because QBO has no
 * Deposit LinkedTxn on it. But the money often DID land in the bank — as an
 * unlinked bank-feed deposit — so an orphan isn't proof the cash is missing.
 * This pass matches orphan UF payments to actual bank Deposits by AMOUNT, so a
 * genuinely-deposited payment stops looking like a hole:
 *
 *   exact            — one payment == one deposit
 *   combination      — several payments sum to one deposit (bundled deposit)
 *   tax_adjusted     — CA only: deposit == payment with GST/HST stripped
 *                      (deposit recorded at the pre-tax / net amount)
 *   tax_combination  — CA only: deposit == sum of tax-stripped payments
 *
 * Pure + deterministic — no QBO/DB calls. Read-only: produces SUGGESTIONS the
 * bookkeeper verifies; it never moves money or re-classifies on its own.
 */

export interface DepositRow {
  id: string;
  date: string;            // YYYY-MM-DD
  amount: number;
  bankAccount: string | null;
}

export interface OrphanRow {
  id: string;
  date: string;            // YYYY-MM-DD
  amount: number;
  customer: string | null;
}

export interface UfDepositMatch {
  depositId: string;
  depositDate: string;
  depositAmount: number;
  bankAccount: string | null;
  paymentIds: string[];
  kind: "exact" | "combination" | "tax_adjusted" | "tax_combination";
  confidence: number;      // 0–1
  note: string;
}

// Common Canadian rates: GST 5%, HST Ontario 13%, HST Atlantic 15%.
const CA_TAX_RATES = [0.05, 0.13, 0.15];
const CENT = 0.01;
const DEFAULT_WINDOW_DAYS = 45; // deposits usually land within ~6 weeks of receipt
const PRE_DAYS = 3;             // small tolerance for a deposit dated just before the payment
const MAX_SUBSET = 6;           // bundled deposits rarely combine more than a handful
const MAX_POOL = 24;            // cap the subset-sum candidate pool per deposit (perf)

const dayNum = (d: string) => Math.floor(new Date(d + "T00:00:00Z").getTime() / 86_400_000);
const cents = (n: number) => Math.round(n * 100);

/**
 * Bounded subset-sum: find a subset of `pool` whose amounts (in cents) hit
 * `targetCents` exactly. Returns the SMALLEST such subset (fewest payments),
 * or null. DFS with a size cap + pool cap keeps it tractable on real data.
 */
function findSubset(pool: OrphanRow[], targetCents: number, tax = 0): string[] | null {
  const items = pool
    .map((p) => ({ id: p.id, c: cents(tax ? p.amount / (1 + tax) : p.amount) }))
    .filter((x) => x.c > 0 && x.c <= targetCents)
    .sort((a, b) => b.c - a.c);
  let best: string[] | null = null;
  const chosen: string[] = [];
  function dfs(start: number, remaining: number) {
    if (remaining === 0) {
      if (!best || chosen.length < best.length) best = [...chosen];
      return;
    }
    if (chosen.length >= MAX_SUBSET) return;
    for (let i = start; i < items.length; i++) {
      const it = items[i];
      if (it.c > remaining + 1) continue; // sorted desc → allow ±1¢ rounding
      chosen.push(it.id);
      dfs(i + 1, remaining - it.c);
      chosen.pop();
      if (best && best.length <= 2) break; // good enough — stop hunting once tiny
    }
  }
  dfs(0, targetCents);
  return best;
}

/**
 * Match orphan UF payments to bank deposits. Each deposit and each payment is
 * used at most once. Deposits are processed oldest-first; within each deposit
 * we try exact → combination → (CA) tax-adjusted → (CA) tax-combination.
 */
export function matchOrphansToDeposits(
  orphans: OrphanRow[],
  deposits: DepositRow[],
  opts: { region?: "CA" | "US"; windowDays?: number } = {},
): UfDepositMatch[] {
  const region = opts.region === "CA" ? "CA" : "US";
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const matches: UfDepositMatch[] = [];
  const used = new Set<string>(); // consumed payment ids

  const inWindow = (p: OrphanRow, d: DepositRow) => {
    const gap = dayNum(d.date) - dayNum(p.date);
    return gap >= -PRE_DAYS && gap <= windowDays;
  };

  for (const dep of [...deposits].sort((a, b) => a.date.localeCompare(b.date))) {
    const target = cents(dep.amount);
    if (target <= 0) continue;
    const pool = orphans
      .filter((p) => !used.has(p.id) && inWindow(p, dep))
      .sort((a, b) => Math.abs(dayNum(a.date) - dayNum(dep.date)) - Math.abs(dayNum(b.date) - dayNum(dep.date)))
      .slice(0, MAX_POOL);
    if (pool.length === 0) continue;

    const record = (ids: string[], kind: UfDepositMatch["kind"], confidence: number, note: string) => {
      ids.forEach((id) => used.add(id));
      matches.push({
        depositId: dep.id, depositDate: dep.date, depositAmount: dep.amount,
        bankAccount: dep.bankAccount, paymentIds: ids, kind, confidence, note,
      });
    };

    // 1. Exact single
    const single = pool.find((p) => Math.abs(cents(p.amount) - target) <= 1);
    if (single) { record([single.id], "exact", 0.95, `Payment $${single.amount.toFixed(2)} matches deposit exactly`); continue; }

    // 2. Combination (bundled deposit)
    const combo = findSubset(pool, target);
    if (combo && combo.length >= 2) { record(combo, "combination", 0.85, `${combo.length} payments sum to the deposit`); continue; }

    // 3 & 4. CA tax-adjusted (deposit recorded net of GST/HST)
    if (region === "CA") {
      let taxHit = false;
      for (const rate of CA_TAX_RATES) {
        const s = pool.find((p) => Math.abs(cents(p.amount / (1 + rate)) - target) <= 1);
        if (s) { record([s.id], "tax_adjusted", 0.7, `Deposit ≈ payment $${s.amount.toFixed(2)} less ${Math.round(rate * 100)}% GST/HST`); taxHit = true; break; }
        const c = findSubset(pool, target, rate);
        if (c && c.length >= 2) { record(c, "tax_combination", 0.65, `Deposit ≈ ${c.length} payments less ${Math.round(rate * 100)}% GST/HST`); taxHit = true; break; }
      }
      if (taxHit) continue;
    }
  }

  return matches;
}
