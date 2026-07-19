/**
 * Books Reliability Score — the verification engine behind the monthly close.
 *
 * Runs a battery of read-only checks against QBO + SNAP state for one
 * (client, period), producing typed findings and a 0-100 score with pillar
 * breakdown and hard-fail caps. The score gates the statement send (see the
 * monthly-rec route); bookkeepers work the findings on the Close Review panel.
 *
 * Design rules:
 *  - Checks emit raw FINDINGS with stable fingerprints. Dismissals (stored in
 *    verification_dismissals, remembered across months) are applied at scoring
 *    time by pure functions — same QBO snapshot + same dismissal set = same
 *    score. Dismiss/undismiss recomputes the stored score with NO QBO calls.
 *  - Zero QBO writes. Safe to run against any live client.
 *  - Every check degrades gracefully: a failed fetch marks the check
 *    `skipped` with a reason instead of sinking the whole verification.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllAccounts, qboRequest } from "./qbo";
import {
  fetchBalancesAsOf,
  fetchOpenInvoices,
} from "./qbo-balance-sheet";
import { scanUfAudit } from "./uf-audit";
import { fetchPLDetailAll } from "./qbo-reports";
import { fetchProfitAndLossByMonth, type PLByMonthBlock } from "./qbo-pl-by-month";
import { findDuplicates } from "./qbo-dup-scan";
import { analyzeDepositsToIncome } from "./revenue-integrity";
import { computeRevenueAdjustment, normalizeRevenueMode } from "./revenue-recognition";
import { analyzeCrmInvoiceRevenue } from "./crm-invoice-revenue";
import { detectLaborDuplication, PAYROLL_ACCOUNT_NAME_REGEX } from "./payroll-double-entry";
import { normalizeAccountName } from "./account-name";

// ─── Types ───────────────────────────────────────────────────────────────

export type PillarKey =
  | "reconciliation"
  | "categorization"
  | "bs_integrity"
  | "anomalies"
  | "documentation";

export type VerificationStatus = "pass" | "warn" | "fail" | "skipped";

export interface VerificationFinding {
  /** Stable identity — used for dismissal memory across months. */
  fingerprint: string;
  severity: "warn" | "fail";
  /** One line, numbers included, plain English. */
  message: string;
  amount?: number;
  account_id?: string;
  account_name?: string;
  qbo_txn_ids?: string[];
  /** Hard findings (uncategorized, pending queue) can never be dismissed. */
  dismissable: boolean;
  /** Only an admin/lead may dismiss (e.g. a legitimately-negative sweep account). */
  senior_only?: boolean;
  /** Set at scoring time when an active dismissal matches the fingerprint. */
  dismissed?: { reason: string; by_name: string | null; at: string };
}

export interface VerificationCheck {
  key: string;
  label: string;
  pillar: PillarKey;
  status: VerificationStatus;
  /** One-line result summary. */
  detail: string;
  findings: VerificationFinding[];
  /** Which in-app tool fixes this — the UI maps it to a link. */
  fix?: "reclass" | "uf_audit" | "ar" | "profile" | "connections" | "statements" | "daily_queue" | "revenue_check";
  /** Check-specific extras (e.g. the tie-out table rows). */
  meta?: Record<string, unknown>;
  skipReason?: string;
}

export interface VerificationPillar {
  key: PillarKey;
  label: string;
  /** Normalized weight actually used (post-skip renormalization). */
  weight: number;
  score: number; // 0-100
  skipped: boolean;
}

export interface VerificationResult {
  version: 1;
  score: number; // 0-100 after caps
  band: "certified" | "minor" | "not_ready";
  hardFail: boolean;
  hardFailKeys: string[];
  pillars: VerificationPillar[];
  checks: VerificationCheck[];
  ranAt: string;
  ranBy: string;
  stats: { qboCalls: number; durationMs: number };
}

export interface DismissalRow {
  check_key: string;
  fingerprint: string;
  reason: string;
  dismissed_by_name?: string | null;
  dismissed_at: string;
  active: boolean;
}

export const SEND_MIN_SCORE = 85;

/** Checks whose failure caps the score at 79 (can never reach the send bar). */
export const HARD_FAIL_KEYS = [
  "bank_tieout",
  "cc_tieout",
  "uncategorized",
  "daily_queue_clear",
  "negative_banks",
];

const PILLAR_LABELS: Record<PillarKey, string> = {
  reconciliation: "Reconciliation",
  categorization: "Categorization",
  bs_integrity: "Balance Sheet Integrity",
  anomalies: "Anomalies",
  documentation: "Documentation",
};

/** Per-pillar weights and per-check point allocations (BS clients). */
const PILLARS_FULL: { key: PillarKey; weight: number; alloc: Record<string, number> }[] = [
  { key: "reconciliation", weight: 0.35, alloc: { bank_tieout: 50, cc_tieout: 30, undeposited_funds: 20 } },
  { key: "categorization", weight: 0.25, alloc: { uncategorized: 50, daily_queue_clear: 30, suspense_ama: 20 } },
  { key: "bs_integrity", weight: 0.2, alloc: { negative_banks: 30, negative_liabilities: 25, obe: 20, ar_ap_negative: 25 } },
  { key: "anomalies", weight: 0.15, alloc: { duplicates: 15, deposits_in_revenue: 10, crm_invoice_revenue: 15, payroll_duplication: 15, cogs_ratio: 10, net_margin: 10, mom_variance: 10, large_round_jes: 10, overdue_ar: 5 } },
  { key: "documentation", weight: 0.05, alloc: { statement_coverage: 100 } },
];

/** P&L-only clients: no BS/reconciliation/documentation pillars. */
const PILLARS_PL_ONLY: { key: PillarKey; weight: number; alloc: Record<string, number> }[] = [
  { key: "categorization", weight: 0.6, alloc: { uncategorized: 50, daily_queue_clear: 30, suspense_ama: 20 } },
  { key: "anomalies", weight: 0.4, alloc: { duplicates: 15, deposits_in_revenue: 10, crm_invoice_revenue: 15, payroll_duplication: 15, cogs_ratio: 10, net_margin: 10, mom_variance: 10, large_round_jes: 10, overdue_ar: 5 } },
];

const fmt = (n: number) =>
  `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function fingerprintFor(checkKey: string, naturalKey: string): string {
  return `${checkKey}:${naturalKey}`;
}

// ─── The pure scoring core ───────────────────────────────────────────────

/** Worst live (non-dismissed) finding decides the check status. */
function deriveStatus(check: VerificationCheck): VerificationStatus {
  if (check.status === "skipped") return "skipped";
  const live = check.findings.filter((f) => !f.dismissed);
  if (live.some((f) => f.severity === "fail")) return "fail";
  if (live.some((f) => f.severity === "warn")) return "warn";
  return "pass";
}

/** Mark findings dismissed where an active dismissal matches the fingerprint, then re-derive statuses. */
export function applyDismissals(
  checks: VerificationCheck[],
  dismissals: DismissalRow[]
): VerificationCheck[] {
  const active = new Map(dismissals.filter((d) => d.active).map((d) => [d.fingerprint, d]));
  return checks.map((c) => {
    const findings = c.findings.map((f) => {
      const d = f.dismissable ? active.get(f.fingerprint) : undefined;
      if (!d) return { ...f, dismissed: undefined };
      return { ...f, dismissed: { reason: d.reason, by_name: d.dismissed_by_name ?? null, at: d.dismissed_at } };
    });
    const next = { ...c, findings };
    next.status = deriveStatus(next);
    const dismissedCount = findings.filter((f) => f.dismissed).length;
    if (next.status === "pass" && dismissedCount > 0) {
      next.detail = `${c.detail.replace(/ — \d+ dismissed$/, "")} — ${dismissedCount} dismissed`;
    }
    return next;
  });
}

/** Pure: pillar scores + capped total from check statuses. Same inputs, same score. */
export function scoreVerification(
  checks: VerificationCheck[],
  opts: { includeBS: boolean }
): Pick<VerificationResult, "score" | "band" | "hardFail" | "hardFailKeys" | "pillars"> {
  const defs = opts.includeBS ? PILLARS_FULL : PILLARS_PL_ONLY;
  const byKey = new Map(checks.map((c) => [c.key, c]));

  const rawPillars = defs.map((p) => {
    let available = 0;
    let earned = 0;
    for (const [key, points] of Object.entries(p.alloc)) {
      const c = byKey.get(key);
      if (!c || c.status === "skipped") continue;
      available += points;
      if (c.status === "pass") earned += points;
      else if (c.status === "warn") earned += points / 2;
    }
    return {
      key: p.key,
      label: PILLAR_LABELS[p.key],
      weight: p.weight,
      score: available > 0 ? Math.round((earned / available) * 100) : 0,
      skipped: available === 0,
    };
  });

  // Renormalize weights over non-skipped pillars so an all-skipped pillar
  // (e.g. Reconciliation with zero statements) neither helps nor hurts.
  const activePillars = rawPillars.filter((p) => !p.skipped);
  const weightSum = activePillars.reduce((s, p) => s + p.weight, 0) || 1;
  let score = Math.round(
    activePillars.reduce((s, p) => s + p.score * (p.weight / weightSum), 0)
  );
  const pillars: VerificationPillar[] = rawPillars.map((p) => ({
    ...p,
    weight: p.skipped ? 0 : p.weight / weightSum,
  }));

  const failing = checks.filter((c) => c.status === "fail");
  const hardFailKeys = failing.filter((c) => HARD_FAIL_KEYS.includes(c.key)).map((c) => c.key);
  const hardFail = hardFailKeys.length > 0;
  if (hardFail) score = Math.min(score, 79);
  else if (failing.length > 0) score = Math.min(score, 94);

  const band: VerificationResult["band"] =
    score >= 95 ? "certified" : score >= SEND_MIN_SCORE ? "minor" : "not_ready";

  return { score, band, hardFail, hardFailKeys, pillars };
}

// ─── Red-flag approval gate (Mike 2026-07-17) ────────────────────────────
// "Duplicate expenses, duplicate revenue, COGS <20%/>65%, net profit
// <10%/>35% are all red flags that we need to manually approve during the
// final step of the month end." A fail finding in any of these checks
// blocks the client send until someone either fixes it (re-verify clears
// it) or explicitly approves it — the dismiss-with-reason flow, which
// records who and why. Always enforced, independent of the score gate.
export const RED_FLAG_APPROVAL_KEYS = [
  "duplicates", // duplicate expenses
  "payroll_duplication", // duplicate expenses (gross+net labor)
  "deposits_in_revenue", // duplicate revenue (deposit leg)
  "crm_invoice_revenue", // duplicate revenue (invoice leg)
  "cogs_ratio",
  "net_margin",
] as const;

export interface RedFlag {
  check_key: string;
  check_label: string;
  fingerprint: string;
  message: string;
  amount?: number;
  senior_only?: boolean;
  fix?: string;
}

/** Open (non-dismissed) fail-severity findings among the red-flag checks. */
export function openRedFlags(result: VerificationResult): RedFlag[] {
  const keys = new Set<string>(RED_FLAG_APPROVAL_KEYS as readonly string[]);
  const out: RedFlag[] = [];
  for (const c of result.checks || []) {
    if (!keys.has(c.key)) continue;
    for (const f of c.findings || []) {
      if (f.severity !== "fail" || f.dismissed) continue;
      out.push({
        check_key: c.key,
        check_label: c.label,
        fingerprint: f.fingerprint,
        message: f.message,
        amount: f.amount,
        senior_only: f.senior_only,
        fix: c.fix,
      });
    }
  }
  return out;
}

/** Recompute a stored result against the current dismissal set — no QBO. */
export function recomputeStoredVerification(
  stored: VerificationResult,
  dismissals: DismissalRow[],
  includeBS: boolean
): VerificationResult {
  const checks = applyDismissals(stored.checks, dismissals);
  const scored = scoreVerification(checks, { includeBS });
  return { ...stored, ...scored, checks };
}

// ─── The runner ──────────────────────────────────────────────────────────

interface RunParams {
  service: SupabaseClient;
  clientLinkId: string;
  realmId: string;
  accessToken: string;
  period: string; // YYYY-MM
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  includeBS: boolean;
  kind: "production_me" | "cleanup";
  ranBy: string;
}

const MAX_FINDINGS_PER_CHECK = 25;
const cap = <T,>(arr: T[]) => arr.slice(0, MAX_FINDINGS_PER_CHECK);

/**
 * Count + total the transactions that actually POST to a set of accounts in a
 * period, reliably.
 *
 * Why not fetchAccountTransactions per account: that relies on the
 * TransactionList report's `account=<id>` FILTER param, which QBO silently
 * IGNORES — so each call returns the whole period, and looping over the 3
 * default "Uncategorized Income/Expense/Asset" accounts reported ~3× the entire
 * month as "uncategorized" (the XPaint false must-fix, 2026-07-09). Instead we
 * pull the period ONCE and bucket by the account id carried on each row's
 * account column — the same trusted attribution fetchTransactionCountsForAllAccounts
 * uses for inactivation pre-flight.
 */
async function fetchActivityForAccounts(
  realmId: string,
  accessToken: string,
  accountIds: Set<string>,
  startDate: string,
  endDate: string
): Promise<{ count: number; amount: number }> {
  if (accountIds.size === 0) return { count: 0, amount: 0 };
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    columns: "tx_date,account_name,subt_nat_amount,txn_type",
    minorversion: "70",
  });
  let data: any;
  try {
    data = await qboRequest<any>(realmId, accessToken, `/reports/TransactionList?${params.toString()}`);
  } catch {
    return { count: 0, amount: 0 };
  }
  const cols: any[] = data?.Columns?.Column || [];
  let acctIdx = -1;
  let amtIdx = -1;
  cols.forEach((c, i) => {
    const title = String(c?.ColTitle || "").toLowerCase();
    const type = String(c?.ColType || "").toLowerCase();
    if (acctIdx < 0 && (title.includes("account") || type === "account")) acctIdx = i;
    if (amtIdx < 0 && (title.includes("amount") || type === "money")) amtIdx = i;
  });
  if (acctIdx < 0) return { count: 0, amount: 0 };

  let count = 0;
  let amount = 0;
  const walk = (rows: any[]) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (Array.isArray(row.ColData)) {
        const cell = row.ColData[acctIdx];
        if (cell?.id && accountIds.has(String(cell.id))) {
          count++;
          if (amtIdx >= 0) {
            const raw = String(row.ColData[amtIdx]?.value || "0").replace(/[,$ ]/g, "");
            const n = Number(raw);
            if (Number.isFinite(n)) amount += Math.abs(n);
          }
        }
      }
      if (row.Rows?.Row) walk(row.Rows.Row);
    }
  };
  walk(data?.Rows?.Row);
  return { count, amount: Math.round(amount * 100) / 100 };
}

export async function runBooksVerification(params: RunParams): Promise<VerificationResult> {
  const { service, clientLinkId, realmId, accessToken, period, periodStart, periodEnd, includeBS, kind, ranBy } = params;
  const t0 = Date.now();
  let qboCalls = 0;
  const track = <T,>(p: Promise<T>): Promise<T> => (qboCalls++, p);

  // Per-client revenue-recognition mode. deposits_only clients recognize cash
  // receipts only; the deposits-into-income check is INVERTED for them (their
  // deposits are the real revenue), so it becomes an informational note below.
  const { data: clientRow } = await (service as any)
    .from("client_links")
    .select("revenue_recognition_mode")
    .eq("id", clientLinkId)
    .maybeSingle();
  const revenueMode = normalizeRevenueMode(clientRow?.revenue_recognition_mode);

  const [py, pm] = period.split("-").map(Number);
  // Trailing window for variance: 3 prior months + the period itself.
  const trailStartDate = new Date(Date.UTC(py, pm - 1 - 3, 1));
  const trailStart = trailStartDate.toISOString().slice(0, 10);

  // Group 1 — core QBO state.
  const [accounts, balances, openInvoices] = await Promise.all([
    track(fetchAllAccounts(realmId, accessToken)),
    includeBS
      ? track(fetchBalancesAsOf(realmId, accessToken, periodEnd))
      : Promise.resolve(new Map<string, number>()),
    track(fetchOpenInvoices(realmId, accessToken).catch(() => [] as any[])),
  ]);
  const balOf = (id: string) => balances.get(String(id)) ?? 0;

  // Group 2 — reports + SNAP state (each degrades to null on failure).
  const [plDetail, plByMonth, jeQuery, stmtRows, pendingQueue] = await Promise.all([
    track(fetchPLDetailAll(realmId, accessToken, periodStart, periodEnd, "Cash").catch(() => null)),
    kind === "cleanup"
      ? Promise.resolve(null)
      : track(fetchProfitAndLossByMonth(realmId, accessToken, trailStart, periodEnd).catch(() => null)),
    track(
      qboRequest<any>(
        realmId,
        accessToken,
        `/query?query=${encodeURIComponent(
          `SELECT * FROM JournalEntry WHERE TxnDate >= '${periodStart}' AND TxnDate <= '${periodEnd}' MAXRESULTS 200`
        )}`
      ).catch(() => null)
    ),
    (service as any)
      .from("client_statements")
      .select("id, matched_qbo_account_id, matched_account_name, account_label, ending_balance, statement_end_date, created_at, status")
      .eq("client_link_id", clientLinkId)
      .eq("period_year", py)
      .eq("period_month", pm)
      .eq("status", "processed")
      .then(({ data }: any) => (data as any[]) || []),
    (service as any)
      .from("daily_review_queue")
      .select("id", { count: "exact", head: true })
      .eq("client_link_id", clientLinkId)
      .eq("decision", "pending")
      .gte("transaction_date", periodStart)
      .lte("transaction_date", periodEnd)
      .then((r: any) => r.count ?? 0),
  ]);

  const checks: VerificationCheck[] = [];
  const active = (a: any) => a.Active;

  // ── Reconciliation: bank + CC tie-outs ────────────────────────────────
  if (includeBS) {
    const stmtByAccount = new Map<string, any>();
    for (const s of stmtRows as any[]) {
      if (!s.matched_qbo_account_id || s.ending_balance == null) continue;
      const prev = stmtByAccount.get(String(s.matched_qbo_account_id));
      if (!prev || String(s.created_at) > String(prev.created_at)) {
        stmtByAccount.set(String(s.matched_qbo_account_id), s);
      }
    }

    const tieout = (accountType: "Bank" | "Credit Card", key: string, label: string) => {
      const accts = accounts.filter((a: any) => active(a) && a.AccountType === accountType);
      const rows: any[] = [];
      const findings: VerificationFinding[] = [];
      let covered = 0;
      for (const a of accts) {
        const stmt = stmtByAccount.get(String(a.Id));
        const qbo = balOf(a.Id);
        if (!stmt) {
          rows.push({ account_id: a.Id, account_name: a.Name, qbo, stmt: null, diff: null, covered: false });
          continue;
        }
        covered++;
        const s = Number(stmt.ending_balance);
        // Credit cards: QBO shows owed as positive on the BS report, but sign
        // conventions vary by feed — accept whichever orientation reconciles.
        const diff = accountType === "Credit Card" ? Math.min(Math.abs(qbo - s), Math.abs(qbo + s)) : Math.abs(qbo - s);
        rows.push({ account_id: a.Id, account_name: a.Name, qbo, stmt: s, diff, covered: true });
        if (diff > 1) {
          findings.push({
            fingerprint: fingerprintFor(key, `${a.Id}:${period}`),
            severity: diff > 100 ? "fail" : "warn",
            message: `${a.Name}: QBO ${fmt(qbo)} vs statement ${fmt(s)} — off by ${fmt(diff)}`,
            amount: diff,
            account_id: String(a.Id),
            account_name: a.Name,
            dismissable: false, // a tie-out break must be fixed, not waved through
          });
        }
      }
      const check: VerificationCheck = {
        key,
        label,
        pillar: "reconciliation",
        status: "pass",
        detail:
          accts.length === 0
            ? `No ${accountType.toLowerCase()} accounts`
            : covered === 0
            ? `No processed statements for this period (${accts.length} account${accts.length === 1 ? "" : "s"})`
            : findings.length === 0
            ? `${covered} of ${accts.length} account${accts.length === 1 ? "" : "s"} tied out to statements`
            : `${findings.length} account${findings.length === 1 ? "" : "s"} off vs statement`,
        findings: cap(findings),
        fix: "statements",
        meta: { rows },
      };
      if (accts.length > 0 && covered === 0) {
        check.status = "skipped";
        check.skipReason = "No processed statements for this period — upload/request statements to enable the tie-out.";
      }
      checks.push(check);
    };
    tieout("Bank", "bank_tieout", "Bank statement tie-out");
    tieout("Credit Card", "cc_tieout", "Credit-card statement tie-out");

    // ── Undeposited Funds ───────────────────────────────────────────────
    const ufAccounts = accounts.filter(
      (a: any) => active(a) && (a.AccountSubType === "UndepositedFunds" || /undeposited/i.test(a.Name))
    );
    const ufBalance = ufAccounts.reduce((s: number, a: any) => s + balOf(a.Id), 0);
    const ufFindings: VerificationFinding[] = [];
    let oldOrphans = 0;
    if (Math.abs(ufBalance) >= 1 && ufAccounts[0]) {
      try {
        const scan = await track(
          scanUfAudit(realmId, accessToken, String(ufAccounts[0].Id), { lookbackDays: 365 })
        );
        const cutoff = new Date(new Date(periodEnd).getTime() - 60 * 86400000).toISOString().slice(0, 10);
        oldOrphans = (scan.payments || []).filter(
          (p: any) => p.classification === "orphan" && p.payment_date <= cutoff
        ).length;
      } catch {
        /* balance-only degradation */
      }
      ufFindings.push({
        fingerprint: fingerprintFor("uf", String(ufAccounts[0].Id)),
        severity: Math.abs(ufBalance) >= 5000 || oldOrphans > 0 ? "fail" : "warn",
        message:
          `${fmt(ufBalance)} sitting in Undeposited Funds` +
          (oldOrphans > 0 ? ` — ${oldOrphans} payment${oldOrphans === 1 ? "" : "s"} older than 60 days` : ""),
        amount: ufBalance,
        account_id: ufAccounts[0] ? String(ufAccounts[0].Id) : undefined,
        dismissable: true, // a small standing float can be a known pattern
      });
    }
    checks.push({
      key: "undeposited_funds",
      label: "Undeposited Funds",
      pillar: "reconciliation",
      status: "pass",
      detail: Math.abs(ufBalance) < 1 ? "UF is clear" : `${fmt(ufBalance)} in Undeposited Funds`,
      findings: ufFindings,
      fix: "uf_audit",
      meta: { balance: ufBalance, oldOrphans },
    });
  }

  // ── Categorization ──────────────────────────────────────────────────
  {
    // Postings that actually landed in QBO's "Uncategorized Income/Expense"
    // accounts, counted straight off the period P&L detail — the SAME
    // period-scoped dataset that powers the (trusted) duplicate + deposit
    // checks. This is deliberately not a per-account TransactionList refetch:
    // that path's `account=` filter is silently IGNORED by QBO, so it returned
    // the whole period once PER uncategorized account — reporting ~3× the
    // entire month as uncategorized when nothing actually was (XPaint 972/$524k
    // and Make It Happen 1992/$1.38M, 2026-07-09). Counting off plDetail can't
    // over-count: no uncategorized postings ⇒ no matching rows ⇒ 0.
    const uncatAccounts = accounts.filter((a: any) => active(a) && /uncategor/i.test(a.Name));
    let uncatCount = 0;
    let uncatAmount = 0;
    if (plDetail) {
      const rows = plDetail.filter((r: any) => /uncategor/i.test(String(r.account || "")));
      uncatCount = rows.length;
      uncatAmount = rows.reduce((s: number, r: any) => s + Math.abs(Number(r.amount || 0)), 0);
    } else {
      // P&L detail unavailable — fall back to the id-bucketed pull (also
      // catches the Uncategorized Asset balance-sheet account).
      const uncatIds = new Set(uncatAccounts.map((a: any) => String(a.Id)));
      const a = await track(fetchActivityForAccounts(realmId, accessToken, uncatIds, periodStart, periodEnd));
      uncatCount = a.count;
      uncatAmount = a.amount;
    }
    checks.push({
      key: "uncategorized",
      label: "Uncategorized transactions",
      pillar: "categorization",
      status: "pass",
      detail:
        uncatCount === 0
          ? "Everything categorized"
          : `${uncatCount} transaction${uncatCount === 1 ? "" : "s"} (${fmt(uncatAmount)}) need a category`,
      findings:
        uncatCount === 0
          ? []
          : [
              {
                fingerprint: fingerprintFor("uncat", period),
                severity: uncatCount > 5 ? "fail" : "warn",
                message: `${uncatCount} uncategorized transaction${uncatCount === 1 ? "" : "s"} totaling ${fmt(uncatAmount)}`,
                amount: uncatAmount,
                dismissable: false,
              },
            ],
      fix: "reclass",
    });

    checks.push({
      key: "daily_queue_clear",
      label: "Daily review queue",
      pillar: "categorization",
      status: "pass",
      detail:
        pendingQueue === 0
          ? "No unresolved flagged items for the month"
          : `${pendingQueue} flagged item${pendingQueue === 1 ? "" : "s"} still pending review`,
      findings:
        pendingQueue === 0
          ? []
          : [
              {
                fingerprint: fingerprintFor("queue", period),
                severity: "fail",
                message: `${pendingQueue} daily-recon item${pendingQueue === 1 ? "" : "s"} for this month still pending a decision`,
                dismissable: false,
              },
            ],
      fix: "daily_queue",
    });

    const suspense = accounts.filter(
      (a: any) => active(a) && /ask my accountant|suspense|to be categori[sz]ed/i.test(a.Name)
    );
    const susFindings: VerificationFinding[] = [];
    for (const a of suspense) {
      const bal = includeBS ? balOf(a.Id) : Number(a.CurrentBalance || 0);
      if (Math.abs(bal) < 1) continue;
      susFindings.push({
        fingerprint: fingerprintFor("suspense", String(a.Id)),
        severity: Math.abs(bal) >= 500 ? "fail" : "warn",
        message: `${a.Name} holds ${fmt(bal)} — should be zero at close`,
        amount: bal,
        account_id: String(a.Id),
        account_name: a.Name,
        dismissable: true,
      });
    }
    checks.push({
      key: "suspense_ama",
      label: "Suspense / Ask My Accountant",
      pillar: "categorization",
      status: "pass",
      detail:
        suspense.length === 0
          ? "No suspense accounts"
          : susFindings.length === 0
          ? "All suspense accounts at zero"
          : `${susFindings.length} suspense account${susFindings.length === 1 ? "" : "s"} holding a balance`,
      findings: cap(susFindings),
      fix: "reclass",
    });
  }

  // ── Balance Sheet integrity ─────────────────────────────────────────
  if (includeBS) {
    const negBanks = accounts.filter((a: any) => active(a) && a.AccountType === "Bank" && balOf(a.Id) < -1);
    checks.push({
      key: "negative_banks",
      label: "Bank account balances",
      pillar: "bs_integrity",
      status: "pass",
      detail:
        negBanks.length === 0
          ? "No negative bank balances at month end"
          : `${negBanks.length} bank account${negBanks.length === 1 ? "" : "s"} negative at month end`,
      findings: cap(
        negBanks.map((a: any) => ({
          fingerprint: fingerprintFor("negbank", String(a.Id)),
          severity: "fail" as const,
          message: `${a.Name} was ${fmt(balOf(a.Id))} negative at ${periodEnd}`,
          amount: balOf(a.Id),
          account_id: String(a.Id),
          account_name: a.Name,
          dismissable: true,
          senior_only: true, // e.g. a real sweep account — a senior can accept it
        }))
      ),
      fix: "profile",
    });

    const LIABILITY_TYPES = new Set(["Credit Card", "Accounts Payable", "Other Current Liability", "Long Term Liability"]);
    const negLiab = accounts.filter((a: any) => active(a) && LIABILITY_TYPES.has(a.AccountType) && balOf(a.Id) < -1);
    checks.push({
      key: "negative_liabilities",
      label: "Negative liabilities",
      pillar: "bs_integrity",
      status: "pass",
      detail:
        negLiab.length === 0
          ? "No liability accounts below zero"
          : `${negLiab.length} liability account${negLiab.length === 1 ? "" : "s"} negative (overpaid or miscoded)`,
      findings: cap(
        negLiab.map((a: any) => ({
          fingerprint: fingerprintFor("negliab", String(a.Id)),
          severity: (Math.abs(balOf(a.Id)) >= 500 ? "fail" : "warn") as "warn" | "fail",
          message: `${a.Name} (${a.AccountType}) is ${fmt(balOf(a.Id))} negative — overpayment or miscoding`,
          amount: balOf(a.Id),
          account_id: String(a.Id),
          account_name: a.Name,
          dismissable: true,
        }))
      ),
      fix: "profile",
    });

    const obeAccounts = accounts.filter((a: any) => active(a) && a.AccountSubType === "OpeningBalanceEquity");
    const obeBalance = obeAccounts.reduce((s: number, a: any) => s + balOf(a.Id), 0);
    checks.push({
      key: "obe",
      label: "Opening Balance Equity",
      pillar: "bs_integrity",
      status: "pass",
      detail: Math.abs(obeBalance) < 1 ? "OBE is zero" : `${fmt(obeBalance)} sitting in OBE`,
      findings:
        Math.abs(obeBalance) < 1
          ? []
          : [
              {
                fingerprint: fingerprintFor("obe", `${obeAccounts[0]?.Id || "x"}:${Math.round(obeBalance / 100)}`),
                severity: (Math.abs(obeBalance) >= 1000 ? "fail" : "warn") as "warn" | "fail",
                message: `${fmt(obeBalance)} in Opening Balance Equity — something was posted there`,
                amount: obeBalance,
                dismissable: true,
              },
            ],
      fix: "profile",
    });

    const negAr = accounts.filter((a: any) => active(a) && a.AccountType === "Accounts Receivable" && balOf(a.Id) < -1);
    checks.push({
      key: "ar_ap_negative",
      label: "Negative A/R",
      pillar: "bs_integrity",
      status: "pass",
      detail:
        negAr.length === 0
          ? "A/R is non-negative"
          : `A/R negative — usually unapplied credits or double-applied payments`,
      findings: cap(
        negAr.map((a: any) => ({
          fingerprint: fingerprintFor("negarap", String(a.Id)),
          severity: "warn" as const,
          message: `${a.Name} is ${fmt(balOf(a.Id))} negative — unapplied credits or a double-applied payment`,
          amount: balOf(a.Id),
          account_id: String(a.Id),
          account_name: a.Name,
          dismissable: true,
        }))
      ),
      fix: "ar",
    });
  }

  // ── Anomalies ───────────────────────────────────────────────────────
  {
    if (plDetail === null) {
      checks.push({
        key: "duplicates",
        label: "Duplicate transactions",
        pillar: "anomalies",
        status: "skipped",
        detail: "P&L detail unavailable",
        skipReason: "QBO P&L detail report failed — re-run verification.",
        findings: [],
      });
    } else {
      const dups = findDuplicates(plDetail, 100);
      checks.push({
        key: "duplicates",
        label: "Duplicate transactions",
        pillar: "anomalies",
        status: "pass",
        detail:
          dups.length === 0
            ? `No likely duplicates in ${plDetail.length} postings`
            : `${dups.length} likely duplicate group${dups.length === 1 ? "" : "s"} found`,
        findings: cap(
          dups.map((d) => ({
            fingerprint: fingerprintFor("dup", d.txn_ids.join(",") || `${d.account}:${d.amount}:${d.dates.join(",")}`),
            severity: (d.severity === "high" ? "fail" : "warn") as "warn" | "fail",
            message: `${d.name || d.account}: ${d.count}× ${fmt(d.amount)} (${d.dates.join(", ")}) — ${d.note}`,
            amount: Math.abs(d.amount) * d.count,
            account_name: d.account,
            qbo_txn_ids: d.txn_ids,
            dismissable: true,
          }))
        ),
      });
    }

    // Deposits posted straight into revenue accounts — the invoice+deposit
    // double-count (Clean Your Carpets pattern). Reuses the already-fetched
    // P&L detail + COA; pure analysis, no extra QBO call.
    if (plDetail === null) {
      checks.push({
        key: "deposits_in_revenue",
        label: "Deposits booked as revenue",
        pillar: "anomalies",
        status: "skipped",
        detail: "P&L detail unavailable",
        skipReason: "QBO P&L detail report failed — re-run verification.",
        findings: [],
      });
    } else if (revenueMode === "deposits_only") {
      // Cash-deposits-only client: deposits ARE the intended revenue, so never
      // flag them. Instead surface how much CRM invoice-recognized income was
      // excluded (the duplicate leg) — informational, non-blocking.
      const adj = computeRevenueAdjustment(plDetail, "deposits_only");
      checks.push({
        key: "deposits_in_revenue",
        label: "Revenue recognition — cash deposits only",
        pillar: "anomalies",
        status: "pass",
        detail:
          adj.excludedInvoiceRevenue > 0
            ? `Recognizing actual cash deposits only. Excluded ${fmt(adj.excludedInvoiceRevenue)} of CRM invoice-recognized income this period (it duplicates the bank deposits).`
            : "Recognizing actual cash deposits only. No CRM invoice income to exclude this period.",
        findings: [],
        meta: {
          revenueMode,
          excludedInvoiceRevenue: adj.excludedInvoiceRevenue,
          excludedByAccount: adj.excludedByAccount,
        },
      });
    } else {
      const rev = analyzeDepositsToIncome(
        plDetail,
        accounts.filter(active).map((a: any) => ({ name: String(a.Name || ""), accountType: String(a.AccountType || "") }))
      );
      checks.push({
        key: "deposits_in_revenue",
        label: "Deposits booked as revenue",
        pillar: "anomalies",
        status: "pass",
        detail:
          rev.depositCount === 0
            ? "No deposits posted to income accounts"
            : `${rev.depositCount} deposit${rev.depositCount === 1 ? "" : "s"} totaling ${fmt(rev.depositTotal)} posted to income — ${rev.flagged ? "likely double-counted (book is invoice-driven)" : "review whether these are true cash sales"}`,
        findings: cap(
          rev.depositRows.map((r) => ({
            fingerprint: fingerprintFor("depinc", r.txn_id),
            // Only a flagged (invoice-driven) book fails; a cash business
            // recording sales via deposits is legitimate and merely warns.
            severity: (rev.flagged && Math.abs(r.amount) >= 1000 ? "fail" : "warn") as "warn" | "fail",
            message: `${r.date}: ${fmt(r.amount)} deposit into "${r.account}"${r.name ? ` (${r.name})` : " — no customer on the line"}. If this job was invoiced, the deposit double-counts it.`,
            amount: Math.abs(r.amount),
            account_name: r.account,
            qbo_txn_ids: [r.txn_id],
            dismissable: true, // true cash sales exist — dismissal is per-deposit
          }))
        ),
        meta: { summary: rev.reason, invoiceCount: rev.invoiceCount, invoiceTotal: rev.invoiceTotal, depositTotal: rev.depositTotal, depositNoNameTotal: rev.depositNoNameTotal },
      });
    }

    // CRM invoice double-count — the Dominion pattern, the INVERSE of the
    // check above: a field CRM (Jobber/DripJobs/…) pushes invoices that
    // recognize as income on the cash P&L, AND the bank deposits paying them
    // are separately categorized to income. Same revenue, counted twice.
    // Must be resolved before books go out: void the dupes, keep-invoice +
    // apply deposits, or set the client cash-deposits-only — all on the
    // client's Revenue Check page.
    if (plDetail === null) {
      checks.push({
        key: "crm_invoice_revenue",
        label: "CRM invoice double-count",
        pillar: "anomalies",
        status: "skipped",
        detail: "P&L detail unavailable",
        skipReason: "QBO P&L detail report failed — re-run verification.",
        findings: [],
      });
    } else if (revenueMode === "deposits_only") {
      checks.push({
        key: "crm_invoice_revenue",
        label: "CRM invoice double-count",
        pillar: "anomalies",
        status: "pass",
        detail:
          "Client is cash-deposits-only — CRM invoice income is already excluded from statements. Ledger cleanup (voiding the duplicate invoices) runs from Revenue Check.",
        findings: [],
        fix: "revenue_check",
      });
    } else {
      const incomeNames = new Set(
        accounts
          .filter((a: any) => active(a) && String(a.AccountType) === "Income")
          .map((a: any) => String(a.Name || ""))
      );
      const crm = analyzeCrmInvoiceRevenue(plDetail, incomeNames);
      const topInvoiceAccounts = Object.entries(crm.invoiceByAccount)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 3)
        .map(([name, amt]) => `${name} ${fmt(amt)}`)
        .join(", ");
      checks.push({
        key: "crm_invoice_revenue",
        label: "CRM invoice double-count",
        pillar: "anomalies",
        status: "pass",
        detail: crm.doubleCount
          ? "Invoices AND deposits both recognize material income — the same revenue is likely counted twice"
          : crm.flagged
            ? `${crm.invoiceTxnCount} invoice${crm.invoiceTxnCount === 1 ? "" : "s"} recognize ${fmt(crm.invoiceIncomeTotal)} of income; no material deposit leg alongside — review whether these should count as revenue`
            : crm.invoiceTxnCount > 0
              ? `${crm.invoiceTxnCount} invoice${crm.invoiceTxnCount === 1 ? "" : "s"} recognize ${fmt(crm.invoiceIncomeTotal)} of income (below the materiality floor)`
              : "No invoice-recognized income this period",
        findings: crm.flagged
          ? [
              {
                fingerprint: fingerprintFor("crminv", period),
                // Confirmed double-count (both legs) blocks the send; invoice
                // income with no deposit leg warns (surfaces for review — a
                // client may legitimately invoice from QBO).
                severity: (crm.doubleCount ? "fail" : "warn") as "warn" | "fail",
                message: crm.doubleCount
                  ? `${crm.invoiceTxnCount} CRM invoices recognize ${fmt(crm.invoiceIncomeTotal)} of income (${topInvoiceAccounts}) while ` +
                    `${crm.depositCount} deposits put ${fmt(crm.depositIncomeTotal)} into income accounts` +
                    `${crm.pairs.length > 0 ? ` — ${crm.pairs.length} invoice↔deposit pair${crm.pairs.length === 1 ? "" : "s"} proven` : ""}. ` +
                    `Likely the same revenue twice. Resolve on Revenue Check (void the duplicate invoices, keep-invoice + apply deposits, or set cash-deposits-only) before sending.`
                  : `${crm.invoiceTxnCount} invoices recognize ${fmt(crm.invoiceIncomeTotal)} of income (${topInvoiceAccounts}) with no separate deposit-into-income leg. ` +
                    `On a cash-basis book these are likely CRM invoices inflating revenue — verify on Revenue Check (void, keep-invoice, or set deposits-only). Dismiss if the client genuinely invoices from QBO.`,
                amount: crm.doubleCount ? Math.min(crm.invoiceIncomeTotal, crm.depositIncomeTotal) : crm.invoiceIncomeTotal,
                dismissable: true, // a rare client legitimately mixes QBO-native invoices + true cash sales
              },
            ]
          : [],
        meta: {
          invoiceTxnCount: crm.invoiceTxnCount,
          invoiceIncomeTotal: crm.invoiceIncomeTotal,
          invoiceByAccount: crm.invoiceByAccount,
          depositCount: crm.depositCount,
          depositIncomeTotal: crm.depositIncomeTotal,
          pairCount: crm.pairs.length,
          reason: crm.reason,
        },
        fix: "revenue_check",
      });
    }

    // Duplicate payroll — the BMD pattern: QBO Payroll books the GROSS
    // paycheque to a wage account, then the bank-feed net-pay e-Transfers /
    // direct-deposit debits get expensed to a SECOND labor line. Roster is
    // learned from this period's paycheque postings; any other account paying
    // those same employees via recordable txns is suspect.
    if (plDetail === null) {
      checks.push({
        key: "payroll_duplication",
        label: "Duplicate payroll postings",
        pillar: "anomalies",
        status: "skipped",
        detail: "P&L detail unavailable",
        skipReason: "QBO P&L detail report failed — re-run verification.",
        findings: [],
      });
    } else {
      const labor = detectLaborDuplication(
        plDetail.map((r: any) => ({
          account: String(r.account || ""),
          txn_type: String(r.txn_type || ""),
          name: r.name ?? null,
          amount: Number(r.amount) || 0,
          memo: r.memo ?? null,
        }))
      );
      checks.push({
        key: "payroll_duplication",
        label: "Duplicate payroll postings",
        pillar: "anomalies",
        status: "pass",
        detail: labor.flagged
          ? `Employees' pay hits ${labor.suspects.length} account${labor.suspects.length === 1 ? "" : "s"} beyond the paycheque line — up to ${fmt(labor.overstated)} may be expensed twice`
          : labor.employee_count > 0
            ? `Paycheques post to ${labor.paycheque_accounts.join(", ")}; no second labor line carries the same employees`
            : "No QBO Payroll paycheques this period",
        findings: cap(
          labor.suspects.map((sa) => {
            const laborNamed = PAYROLL_ACCOUNT_NAME_REGEX.test(sa.account);
            const types = Object.entries(sa.by_type)
              .map(([t, n]) => `${n}× ${t}`)
              .join(", ");
            return {
              fingerprint: fingerprintFor("labordup", `${period}:${sa.account}`),
              // Labor-named second lines and big totals are near-certain
              // double-counts; a small non-labor account could be legitimate
              // employee reimbursements, so it only warns.
              severity: (laborNamed || Math.abs(sa.total) >= 2500 ? "fail" : "warn") as "warn" | "fail",
              message:
                `${sa.account}: ${fmt(sa.total)} across ${sa.postings} posting${sa.postings === 1 ? "" : "s"} (${types}) ` +
                `pays ${sa.employees} payroll employee${sa.employees === 1 ? "" : "s"} whose gross paycheques already post to ` +
                `${labor.paycheque_accounts.join(", ") || "the wage account"}. Likely net pay expensed a second time — ` +
                `recategorize to Payroll Clearing, or dismiss if these are true reimbursements.`,
              amount: Math.abs(sa.total),
              account_name: sa.account,
              dismissable: true,
            };
          })
        ),
        meta: {
          paychequeAccounts: labor.paycheque_accounts,
          employeeCount: labor.employee_count,
          overstated: labor.overstated,
        },
        fix: "revenue_check",
      });
    }

    // Statement-sanity ratio bands (Mike 2026-07-17): for a painting
    // contractor, COGS outside 20–65% of revenue or net margin outside
    // 10–35% is nearly always a bookkeeping error — duplicate/missing
    // postings, misclassified labor, double-counted revenue — not a real
    // business outcome. Computed from the same cash P&L detail joined to
    // the COA by account TYPE (section strings on this report are
    // unreliable — see the "Ordinary Income/Expenses" gotcha).
    if (plDetail === null) {
      for (const [key, label] of [
        ["cogs_ratio", "COGS % of revenue"],
        ["net_margin", "Net margin"],
      ] as const) {
        checks.push({
          key,
          label,
          pillar: "anomalies",
          status: "skipped",
          detail: "P&L detail unavailable",
          skipReason: "QBO P&L detail report failed — re-run verification.",
          findings: [],
        });
      }
    } else {
      const typeByName = new Map(
        accounts.map((a: any) => [normalizeAccountName(String(a.Name || "")), String(a.AccountType || "")])
      );
      let income = 0, otherIncome = 0, cogsTotal = 0, opex = 0, otherExpense = 0, unmatched = 0;
      for (const r of plDetail as any[]) {
        const t = typeByName.get(normalizeAccountName(String(r.account || "")));
        const amt = Number(r.amount) || 0;
        if (t === "Income") income += amt;
        else if (t === "Other Income") otherIncome += amt;
        else if (t === "Cost of Goods Sold") cogsTotal += amt;
        else if (t === "Expense" || t === "Expenses") opex += amt;
        else if (t === "Other Expense") otherExpense += amt;
        else unmatched++;
      }
      // deposits_only clients: ratio against the revenue the statements
      // actually show (invoice-recognized income excluded).
      if (revenueMode === "deposits_only") {
        income -= computeRevenueAdjustment(plDetail as any, "deposits_only").excludedInvoiceRevenue;
      }
      const revenue = Math.round(income * 100) / 100;
      const net = Math.round((income + otherIncome - cogsTotal - opex - otherExpense) * 100) / 100;
      const RATIO_REVENUE_FLOOR = 2500; // off-season months are ratio noise
      const ratioMeta = {
        revenue,
        cogs: Math.round(cogsTotal * 100) / 100,
        opex: Math.round(opex * 100) / 100,
        otherIncome: Math.round(otherIncome * 100) / 100,
        otherExpense: Math.round(otherExpense * 100) / 100,
        net,
        unmatchedRows: unmatched,
        revenueMode,
      };

      if (revenue < RATIO_REVENUE_FLOOR) {
        for (const [key, label] of [
          ["cogs_ratio", "COGS % of revenue"],
          ["net_margin", "Net margin"],
        ] as const) {
          checks.push({
            key,
            label,
            pillar: "anomalies",
            status: "skipped",
            detail: `Revenue this period is ${fmt(revenue)} — below ${fmt(RATIO_REVENUE_FLOOR)}, too small for ratio checks`,
            skipReason: "Ratios on near-zero revenue are noise (off-season month).",
            findings: [],
            meta: ratioMeta,
          });
        }
      } else {
        const cogsPct = (cogsTotal / revenue) * 100;
        const cogsOut = cogsPct < 20 || cogsPct > 65;
        checks.push({
          key: "cogs_ratio",
          label: "COGS % of revenue",
          pillar: "anomalies",
          status: "pass",
          detail: `COGS is ${cogsPct.toFixed(1)}% of revenue (${fmt(cogsTotal)} on ${fmt(revenue)})${cogsOut ? " — outside the 20–65% band" : " — inside the 20–65% band"}`,
          findings: cogsOut
            ? [
                {
                  fingerprint: fingerprintFor("cogs", period),
                  severity: "fail" as const,
                  message:
                    `COGS is ${cogsPct.toFixed(1)}% of revenue (${fmt(cogsTotal)} COGS on ${fmt(revenue)} revenue) — outside the healthy 20–65% band for a painting contractor. ` +
                    (cogsPct < 20
                      ? "Low COGS usually means materials/subs/direct labor are missing or sitting in operating expenses — or revenue is double-counted."
                      : "High COGS usually means duplicate expenses (payroll double-count, duplicate bills), owner pay in COGS, or missing revenue.") +
                    " Approve with a reason if this month is genuinely unusual.",
                  amount: Math.abs(cogsTotal),
                  dismissable: true,
                },
              ]
            : [],
          meta: { ...ratioMeta, cogsPct: Math.round(cogsPct * 10) / 10 },
        });

        const netPct = (net / revenue) * 100;
        const netOut = netPct < 10 || netPct > 35;
        checks.push({
          key: "net_margin",
          label: "Net margin",
          pillar: "anomalies",
          status: "pass",
          detail: `Net ${net >= 0 ? "profit" : "loss"} is ${netPct.toFixed(1)}% of revenue (${fmt(net)} on ${fmt(revenue)})${netOut ? " — outside the 10–35% band" : " — inside the 10–35% band"}`,
          findings: netOut
            ? [
                {
                  fingerprint: fingerprintFor("margin", period),
                  severity: "fail" as const,
                  message:
                    `Net ${net >= 0 ? "profit" : "loss"} is ${netPct.toFixed(1)}% of revenue (${net < 0 ? "-" : ""}${fmt(net)} on ${fmt(revenue)}) — outside the expected 10–35% band. ` +
                    (netPct < 10
                      ? "Check for duplicate expenses (payroll double-count, duplicate charges) or missing revenue."
                      : "Check for duplicate revenue (CRM invoices + deposits both counted) or missing expenses.") +
                    " Approve with a reason if this month is genuinely unusual.",
                  amount: Math.abs(net),
                  dismissable: true,
                },
              ]
            : [],
          meta: { ...ratioMeta, netPct: Math.round(netPct * 10) / 10 },
        });
      }
    }

    // Large / round journal entries with no memo.
    const jes: any[] = jeQuery?.QueryResponse?.JournalEntry || [];
    if (jeQuery === null) {
      checks.push({
        key: "large_round_jes",
        label: "Large journal entries",
        pillar: "anomalies",
        status: "skipped",
        detail: "JE query unavailable",
        skipReason: "QBO JournalEntry query failed — re-run verification.",
        findings: [],
      });
    } else {
      const jeFindings: VerificationFinding[] = [];
      for (const je of jes) {
        const lines: any[] = je?.Line || [];
        const amounts = lines.map((l) => Math.abs(Number(l?.Amount || 0))).filter((n) => n > 0);
        const maxLine = Math.max(0, ...amounts);
        const isLarge = maxLine >= 5000;
        const isRound = amounts.some((n) => n >= 1000 && n % 1000 === 0);
        const hasMemo = !!(je?.PrivateNote || "").trim();
        if ((isLarge || isRound) && !hasMemo) {
          jeFindings.push({
            fingerprint: fingerprintFor("je", String(je.Id)),
            severity: maxLine >= 25000 ? "fail" : "warn",
            message: `JE ${je.DocNumber ? `#${je.DocNumber}` : je.Id} on ${je.TxnDate}: ${fmt(maxLine)}${isRound && !isLarge ? " (round number)" : ""} with no memo`,
            amount: maxLine,
            qbo_txn_ids: [String(je.Id)],
            dismissable: true,
          });
        }
      }
      if (jeFindings.length > 2) {
        // escalate: this many unexplained JEs at close is a fail condition
        for (const f of jeFindings) f.severity = "fail";
      }
      checks.push({
        key: "large_round_jes",
        label: "Large journal entries",
        pillar: "anomalies",
        status: "pass",
        detail:
          jeFindings.length === 0
            ? `${jes.length} JE${jes.length === 1 ? "" : "s"} in the month, none unexplained`
            : `${jeFindings.length} large/round JE${jeFindings.length === 1 ? "" : "s"} with no memo`,
        findings: cap(jeFindings),
      });
    }

    // Month-over-month variance (statistical screen, warn-only).
    if (kind === "cleanup" || plByMonth === null) {
      checks.push({
        key: "mom_variance",
        label: "Month-over-month variance",
        pillar: "anomalies",
        status: "skipped",
        detail: kind === "cleanup" ? "Skipped for cleanup months" : "Trailing P&L unavailable",
        skipReason:
          kind === "cleanup"
            ? "Pre-cleanup months aren't a trustworthy baseline."
            : "QBO P&L-by-month report failed — re-run verification.",
        findings: [],
      });
    } else {
      const varFindings: VerificationFinding[] = [];
      const monthCount = plByMonth.months.length;
      const curIdx = monthCount - 1; // last column = the period being closed
      const sections = plByMonth.blocks.filter(
        (b): b is Extract<PLByMonthBlock, { kind: "section" }> => b.kind === "section"
      );
      for (const sec of sections) {
        for (const acct of sec.accounts) {
          const cur = Math.abs(acct.values[curIdx] ?? 0);
          const priors = acct.values.slice(0, curIdx).map((v) => Math.abs(v));
          const nonzeroPriors = priors.filter((v) => v > 0.005);
          const slug = acct.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
          if (nonzeroPriors.length >= 2) {
            const avg = nonzeroPriors.reduce((a, b) => a + b, 0) / nonzeroPriors.length;
            const delta = Math.abs(cur - avg);
            if (avg > 0 && delta / avg > 0.4 && delta > 2500) {
              varFindings.push({
                fingerprint: fingerprintFor("var", `${slug}:${period}`),
                severity: "warn",
                message: `${acct.name}: ${fmt(cur)} this month vs ${fmt(avg)} average — ${Math.round((delta / avg) * 100)}% swing`,
                amount: delta,
                account_name: acct.name,
                dismissable: true,
              });
            } else if (avg > 2000 && cur < 0.005) {
              varFindings.push({
                fingerprint: fingerprintFor("var", `${slug}:${period}:gone`),
                severity: "warn",
                message: `${acct.name}: ${fmt(avg)} average in prior months but nothing this month — missing transactions?`,
                amount: avg,
                account_name: acct.name,
                dismissable: true,
              });
            }
          } else if (nonzeroPriors.length === 0 && cur > 1000) {
            varFindings.push({
              fingerprint: fingerprintFor("var", `${slug}:${period}:new`),
              severity: "warn",
              message: `${acct.name}: new account with ${fmt(cur)} this month — confirm it's coded right`,
              amount: cur,
              account_name: acct.name,
              dismissable: true,
            });
          }
        }
      }
      checks.push({
        key: "mom_variance",
        label: "Month-over-month variance",
        pillar: "anomalies",
        status: "pass",
        detail:
          varFindings.length === 0
            ? "No unusual swings vs the trailing months"
            : `${varFindings.length} account${varFindings.length === 1 ? "" : "s"} moved unusually vs trend`,
        findings: cap(varFindings),
      });
    }

    // Overdue A/R — collections signal, warn-only.
    const refEnd = new Date(periodEnd).getTime();
    const overdue = (openInvoices as any[]).filter((inv) => {
      const due = new Date(inv.due_date || inv.txn_date).getTime();
      return (refEnd - due) / 86_400_000 > 60;
    });
    const overdueTotal = overdue.reduce((s, i) => s + Number(i.balance || 0), 0);
    checks.push({
      key: "overdue_ar",
      label: "Overdue A/R (60+ days)",
      pillar: "anomalies",
      status: "pass",
      detail:
        overdue.length === 0
          ? "No invoices older than 60 days"
          : `${overdue.length} invoice${overdue.length === 1 ? "" : "s"} (${fmt(overdueTotal)}) over 60 days old`,
      findings: cap(
        overdue.slice(0, 10).map((inv: any) => ({
          fingerprint: fingerprintFor("ar", String(inv.qbo_invoice_id || inv.id || inv.doc_number || inv.txn_date)),
          severity: "warn" as const,
          message: `Invoice ${inv.doc_number ? `#${inv.doc_number}` : ""} ${inv.customer_name || ""}: ${fmt(Number(inv.balance || 0))} outstanding since ${inv.due_date || inv.txn_date}`,
          amount: Number(inv.balance || 0),
          dismissable: true,
        }))
      ),
      fix: "ar",
    });
  }

  // ── Documentation: statement coverage ───────────────────────────────
  if (includeBS) {
    const stmtAccountIds = new Set(
      (stmtRows as any[]).filter((s) => s.matched_qbo_account_id).map((s) => String(s.matched_qbo_account_id))
    );
    const covFindings: VerificationFinding[] = [];
    for (const a of accounts.filter((x: any) => active(x) && (x.AccountType === "Bank" || x.AccountType === "Credit Card"))) {
      if (stmtAccountIds.has(String(a.Id))) continue;
      covFindings.push({
        fingerprint: fingerprintFor("cov", String(a.Id)),
        severity: a.AccountType === "Bank" ? "fail" : "warn",
        message: `No ${period} statement on file for ${a.Name}`,
        account_id: String(a.Id),
        account_name: a.Name,
        dismissable: true, // "this client never provides statements for this card" — accept once, forever
      });
    }
    checks.push({
      key: "statement_coverage",
      label: "Statement coverage",
      pillar: "documentation",
      status: "pass",
      detail:
        covFindings.length === 0
          ? "A statement is on file for every bank & credit-card account"
          : `${covFindings.length} account${covFindings.length === 1 ? "" : "s"} missing a statement for ${period}`,
      findings: cap(covFindings),
      fix: "statements",
    });
  }

  // ── Apply dismissal memory + score ──────────────────────────────────
  const { data: dismissalRows } = await (service as any)
    .from("verification_dismissals")
    .select("check_key, fingerprint, reason, dismissed_at, active, dismissed_by")
    .eq("client_link_id", clientLinkId)
    .eq("active", true);
  let dismissals: DismissalRow[] = ((dismissalRows as any[]) || []).map((d) => ({
    check_key: d.check_key,
    fingerprint: d.fingerprint,
    reason: d.reason,
    dismissed_at: d.dismissed_at,
    active: d.active,
    dismissed_by_name: null,
  }));
  // Resolve dismisser names for display (best-effort).
  try {
    const ids = [...new Set(((dismissalRows as any[]) || []).map((d) => d.dismissed_by).filter(Boolean))];
    if (ids.length) {
      const { data: us } = await (service as any).from("users").select("id, full_name").in("id", ids);
      const nameById = new Map(((us as any[]) || []).map((u) => [u.id, u.full_name]));
      dismissals = dismissals.map((d, i) => ({
        ...d,
        dismissed_by_name: nameById.get(((dismissalRows as any[]) || [])[i]?.dismissed_by) || null,
      }));
    }
  } catch {
    /* names optional */
  }

  const withDismissals = applyDismissals(checks, dismissals);
  const scored = scoreVerification(withDismissals, { includeBS });

  return {
    version: 1,
    ...scored,
    checks: withDismissals,
    ranAt: new Date().toISOString(),
    ranBy,
    stats: { qboCalls, durationMs: Date.now() - t0 },
  };
}
