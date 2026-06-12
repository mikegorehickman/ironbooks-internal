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

import Anthropic from "@anthropic-ai/sdk";
import { fetchAllAccounts, qboRequest } from "./qbo";
import { fetchProfitAndLoss, fetchCashFlow, type CashFlowData } from "./qbo-reports";
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

// ─── FINANCIAL STATEMENT PREVIEW ─────────────────────────────────────────
// The close gate: before a month can be sent to the client, the bookkeeper
// reviews the actual statements (P&L for the period + Balance Sheet as of
// period end) and attests they're ready. This builds that preview from the
// same QBO reports the client-facing pages use.

export interface StatementLine {
  label: string;
  amount: number;
  group: string;
  depth: number;
}

export interface StatementsPreview {
  pl: {
    totalIncome: number;
    totalExpenses: number;
    netIncome: number;
    lineItems: { label: string; amount: number; group: string }[];
  };
  bs: {
    lines: StatementLine[];
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
  };
  cfs: CashFlowData | null;
}

/** Flatten QBO BalanceSheet report rows into display lines + totals. */
function flattenBalanceSheet(rows: any[], group = "", depth = 0, out: StatementLine[] = []): StatementLine[] {
  for (const row of rows || []) {
    const header = row?.Header?.ColData?.[0]?.value || "";
    if (row?.ColData) {
      const label = row.ColData[0]?.value;
      const amount = Number(row.ColData[1]?.value || 0);
      if (label) out.push({ label, amount, group, depth });
    }
    if (row?.Rows?.Row) {
      flattenBalanceSheet(row.Rows.Row, header || group, depth + 1, out);
    }
    if (row?.Summary?.ColData) {
      const label = row.Summary.ColData[0]?.value;
      const amount = Number(row.Summary.ColData[1]?.value || 0);
      if (label) out.push({ label, amount, group: header || group, depth });
    }
  }
  return out;
}

export async function fetchStatementsPreview(
  realmId: string,
  accessToken: string,
  periodStart: string,
  periodEnd: string
): Promise<StatementsPreview> {
  const [pl, bsReport, cfs] = await Promise.all([
    fetchProfitAndLoss(realmId, accessToken, periodStart, periodEnd),
    qboRequest<any>(
      realmId,
      accessToken,
      `/reports/BalanceSheet?end_date=${encodeURIComponent(periodEnd)}&accounting_method=Accrual&minorversion=70`
    ),
    fetchCashFlow(realmId, accessToken, periodStart, periodEnd).catch(() => null),
  ]);

  const lines = flattenBalanceSheet(bsReport?.Rows?.Row || []);
  const find = (re: RegExp) =>
    lines.find((l) => re.test(l.label))?.amount ?? 0;

  return {
    pl: {
      totalIncome: pl.totalIncome,
      totalExpenses: pl.totalExpenses,
      netIncome: pl.netIncome,
      lineItems: pl.lineItems.map((i) => ({
        label: i.label,
        amount: i.amount,
        group: i.group,
      })),
    },
    bs: {
      lines,
      totalAssets: find(/^total assets$/i),
      totalLiabilities: find(/^total liabilities$/i),
      totalEquity: find(/^total equity$/i),
    },
    cfs,
  };
}

// ─── AI SPOT CHECK ───────────────────────────────────────────────────────
// A second set of eyes before statements go to the client: Claude reviews
// the P&L / BS / CFS against painting-contractor industry standards and
// flags anything a reviewer should look at. Advisory only — never blocks
// the human attestation, just informs it.

export interface SpotCheckFinding {
  severity: "info" | "warn" | "flag";
  area: string;
  note: string;
}

export interface SpotCheckResult {
  verdict: "looks_good" | "needs_review";
  summary: string;
  findings: SpotCheckFinding[];
  model?: string;
  error?: string;
}

export async function aiSpotCheckStatements(params: {
  clientName: string;
  monthLabel: string;
  statements: StatementsPreview;
  kind: "production_me" | "cleanup";
}): Promise<SpotCheckResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const MODEL = "claude-opus-4-7";
  const { pl, bs, cfs } = params.statements;

  const compact = {
    profit_and_loss: {
      total_income: pl.totalIncome,
      total_expenses: pl.totalExpenses,
      net_income: pl.netIncome,
      lines: pl.lineItems.slice(0, 120),
    },
    balance_sheet: {
      total_assets: bs.totalAssets,
      total_liabilities: bs.totalLiabilities,
      total_equity: bs.totalEquity,
      lines: bs.lines.slice(0, 120).map((l) => ({ label: l.label, amount: l.amount, group: l.group })),
    },
    cash_flow: cfs
      ? {
          operating: cfs.operating?.total,
          investing: cfs.investing?.total,
          financing: cfs.financing?.total,
          net_change: cfs.netCashChange,
          cash_at_end: cfs.cashAtEnd,
        }
      : null,
  };

  const prompt = `You are a senior accountant reviewing monthly financial statements for a PAINTING CONTRACTOR before they go to the business owner. This is a ${params.kind === "cleanup" ? "post-cleanup sign-off" : "routine monthly close"} for "${params.clientName}", period ${params.monthLabel}.

Spot-check against painting-industry standards and general bookkeeping hygiene:
- Gross margin typically 40–60% for residential painting; materials usually 10–20% of revenue; subcontractors/labor are the biggest cost.
- Red flags: negative income accounts, Uncategorized/Ask My Accountant/Suspense balances, nonzero Opening Balance Equity, Undeposited Funds balances, negative bank balances, A/R or A/P wildly out of proportion to monthly revenue, payroll with no payroll-tax expense, equity going negative, balance sheet not balancing, sales tax payable that never changes, owner draws coded as expenses.
- Note month-over-month sanity only from what's visible (one month of data) — don't invent trends.

Statements (JSON):
${JSON.stringify(compact)}

Respond with ONLY a JSON object:
{"verdict": "looks_good" | "needs_review", "summary": "<1-2 sentences for the reviewer>", "findings": [{"severity": "info"|"warn"|"flag", "area": "<short area, e.g. Gross margin>", "note": "<specific, numbers-included observation>"}]}
Use "flag" only for things that should stop the send until checked. 0-8 findings; omit nitpicks.`;

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in response");
    const parsed = JSON.parse(match[0]);
    const findings: SpotCheckFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings
          .filter((f: any) => f && f.note)
          .slice(0, 10)
          .map((f: any) => ({
            severity: ["info", "warn", "flag"].includes(f.severity) ? f.severity : "info",
            area: String(f.area || "General").slice(0, 60),
            note: String(f.note).slice(0, 500),
          }))
      : [];
    return {
      verdict: parsed.verdict === "needs_review" ? "needs_review" : "looks_good",
      summary: String(parsed.summary || "").slice(0, 600),
      findings,
      model: MODEL,
    };
  } catch (err: any) {
    // Advisory feature — a failed spot check must never block the close.
    return {
      verdict: "needs_review",
      summary: "AI spot check unavailable — review manually.",
      findings: [],
      error: String(err?.message || err).slice(0, 300),
    };
  }
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
