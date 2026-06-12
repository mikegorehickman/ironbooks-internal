/**
 * Monthly Rec — fast monthly catch-up checks for PRODUCTION clients.
 *
 * A client graduates to production (daily_recon_enabled) once their balance
 * sheet is clean and they've been through the full cleanup process. From
 * then on the monthly job is maintenance, not surgery: at the start of each
 * month the bookkeeper runs these read-only checks against the PRIOR month,
 * fixes what's flagged via deep links into the existing tools, notes any
 * concerns, and marks the month complete — target under 5 minutes.
 *
 * Every check is a cheap QBO read (account list + one TransactionList per
 * uncategorized account + open invoices). No writes, no AI cost.
 */

import { fetchAllAccounts } from "./qbo";
import {
  fetchAccountTransactions,
  fetchOpenInvoices,
} from "./qbo-balance-sheet";

export type CheckStatus = "pass" | "warn" | "fail";

export interface MonthlyRecCheck {
  key: string;
  label: string;
  status: CheckStatus;
  /** One-line plain-English result, e.g. "3 transactions ($1,204.50)". */
  detail: string;
  count?: number;
  amount?: number;
  /** Which in-app tool fixes this — the UI maps it to a link. */
  fix?: "reclass" | "uf_audit" | "ar" | "profile" | "connections";
}

export interface MonthlyRecResult {
  checks: MonthlyRecCheck[];
  /** pass when every check passes; worst status otherwise. */
  overall: CheckStatus;
}

const fmt = (n: number) =>
  `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function runMonthlyRecChecks(
  realmId: string,
  accessToken: string,
  periodStart: string, // YYYY-MM-DD
  periodEnd: string // YYYY-MM-DD
): Promise<MonthlyRecResult> {
  const checks: MonthlyRecCheck[] = [];

  const [accounts, openInvoices] = await Promise.all([
    fetchAllAccounts(realmId, accessToken),
    fetchOpenInvoices(realmId, accessToken).catch(() => []),
  ]);

  // ── 1. Uncategorized transactions in the period ──────────────────────
  // QBO's default landing spots: Uncategorized Expense / Income / Asset,
  // plus anything a bookkeeper named "uncategorized". One TransactionList
  // call per account, scoped to the month.
  const uncatAccounts = accounts.filter(
    (a) => a.Active && /uncategor/i.test(a.Name)
  );
  let uncatCount = 0;
  let uncatAmount = 0;
  for (const a of uncatAccounts) {
    const txns = await fetchAccountTransactions(
      realmId,
      accessToken,
      a.Id,
      periodStart,
      periodEnd
    );
    uncatCount += txns.length;
    uncatAmount += txns.reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0);
  }
  checks.push({
    key: "uncategorized",
    label: "Uncategorized transactions",
    status: uncatCount === 0 ? "pass" : uncatCount <= 5 ? "warn" : "fail",
    detail:
      uncatCount === 0
        ? "Everything categorized"
        : `${uncatCount} transaction${uncatCount === 1 ? "" : "s"} (${fmt(uncatAmount)}) need a category`,
    count: uncatCount,
    amount: uncatAmount,
    fix: uncatCount > 0 ? "reclass" : undefined,
  });

  // ── 2. Undeposited Funds balance ─────────────────────────────────────
  const ufAccounts = accounts.filter(
    (a) =>
      a.Active &&
      (a.AccountSubType === "UndepositedFunds" || /undeposited/i.test(a.Name))
  );
  const ufBalance = ufAccounts.reduce(
    (s, a) => s + Number(a.CurrentBalance || 0),
    0
  );
  checks.push({
    key: "undeposited_funds",
    label: "Undeposited Funds",
    status:
      Math.abs(ufBalance) < 1 ? "pass" : Math.abs(ufBalance) < 5000 ? "warn" : "fail",
    detail:
      Math.abs(ufBalance) < 1
        ? "UF is clear"
        : `${fmt(ufBalance)} sitting in Undeposited Funds`,
    amount: ufBalance,
    fix: Math.abs(ufBalance) >= 1 ? "uf_audit" : undefined,
  });

  // ── 3. Overdue A/R (60+ days) ────────────────────────────────────────
  const now = Date.now();
  const overdue = (openInvoices as any[]).filter((inv) => {
    const due = new Date(inv.due_date || inv.txn_date).getTime();
    return (now - due) / 86_400_000 > 60;
  });
  const overdueTotal = overdue.reduce((s, i) => s + Number(i.balance || 0), 0);
  checks.push({
    key: "overdue_ar",
    label: "Overdue A/R (60+ days)",
    status:
      overdue.length === 0 ? "pass" : overdueTotal < 10_000 ? "warn" : "fail",
    detail:
      overdue.length === 0
        ? "No invoices older than 60 days"
        : `${overdue.length} invoice${overdue.length === 1 ? "" : "s"} (${fmt(overdueTotal)}) over 60 days old`,
    count: overdue.length,
    amount: overdueTotal,
    fix: overdue.length > 0 ? "ar" : undefined,
  });

  // ── 4. Negative bank balances ────────────────────────────────────────
  // A bank account below zero usually means missed transactions or a feed
  // problem — worth eyes either way.
  const negativeBanks = accounts.filter(
    (a) => a.Active && a.AccountType === "Bank" && Number(a.CurrentBalance) < -1
  );
  checks.push({
    key: "negative_banks",
    label: "Bank account balances",
    status: negativeBanks.length === 0 ? "pass" : "fail",
    detail:
      negativeBanks.length === 0
        ? "No negative bank balances"
        : negativeBanks
            .map((a) => `${a.Name}: ${fmt(Number(a.CurrentBalance))} negative`)
            .join("; "),
    count: negativeBanks.length,
    fix: negativeBanks.length > 0 ? "profile" : undefined,
  });

  // ── 5. Opening Balance Equity movement ───────────────────────────────
  // OBE should be $0 and stay $0 after cleanup. Any balance means
  // something got posted to the dumping ground.
  const obe = accounts.filter(
    (a) => a.Active && a.AccountSubType === "OpeningBalanceEquity"
  );
  const obeBalance = obe.reduce((s, a) => s + Number(a.CurrentBalance || 0), 0);
  checks.push({
    key: "obe",
    label: "Opening Balance Equity",
    status: Math.abs(obeBalance) < 1 ? "pass" : "warn",
    detail:
      Math.abs(obeBalance) < 1
        ? "OBE is zero"
        : `${fmt(obeBalance)} sitting in OBE — something was posted there`,
    amount: obeBalance,
    fix: Math.abs(obeBalance) >= 1 ? "profile" : undefined,
  });

  const overall: CheckStatus = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
    ? "warn"
    : "pass";

  return { checks, overall };
}

/** Previous calendar month for a given date — the default Monthly Rec period. */
export function previousMonthPeriod(today = new Date()): {
  period: string;
  periodStart: string;
  periodEnd: string;
} {
  const y = today.getFullYear();
  const m = today.getMonth(); // 0-based; previous month = m-1
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0)); // day 0 of current month = last day of previous
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    period: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
    periodStart: iso(start),
    periodEnd: iso(end),
  };
}
