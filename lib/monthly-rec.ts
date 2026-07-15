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
import { fetchProfitAndLoss, fetchCashFlow, fetchPLDetailAll, type CashFlowData } from "./qbo-reports";
import {
  computeRevenueAdjustment,
  applyRevenueAdjustment,
  normalizeRevenueMode,
  type RevenueRecognitionMode,
} from "./revenue-recognition";
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
  fix?: "reclass" | "uf_audit" | "ar" | "profile" | "connections" | "daily_queue" | "statements";
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
  periodEnd: string, // YYYY-MM-DD
  opts?: { includeBS?: boolean; extraChecks?: MonthlyRecCheck[] } // includeBS false = P&L-only client
): Promise<MonthlyRecResult> {
  const includeBS = opts?.includeBS !== false;
  const checks: MonthlyRecCheck[] = [];

  // ── 0. Prebuilt "green light" checks from the caller (daily queue clear +
  //    statements reconciled). Built in the API route — this lib stays free of
  //    the server-only supabase import so client bundles can use its types.
  if (opts?.extraChecks?.length) checks.push(...opts.extraChecks);

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
      periodEnd,
      a.Name
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

  // ── 2. Undeposited Funds balance (BS check — skipped for P&L-only) ──
  if (includeBS) {
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
  }

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

  // ── 4 + 5. Balance-sheet hygiene (skipped for P&L-only clients) ──────
  if (includeBS) {
    // Negative bank balances — a bank account below zero usually means
    // missed transactions or a feed problem.
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

    // Opening Balance Equity — should be $0 and stay $0 after cleanup.
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
  }

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
    cogs: number;
    grossProfit: number;
    lineItems: { label: string; amount: number; group: string }[];
    /** Present when the client's revenue_recognition_mode adjusted revenue
     *  (deposits_only excludes CRM invoice-recognized income). Lets the UI /
     *  statement note the exclusion. Absent/zeroed under standard mode. */
    revenueRecognition?: { mode: RevenueRecognitionMode; excludedInvoiceRevenue: number };
  };
  /** null when the client's Balance Sheet toggle is off (P&L-only). */
  bs: {
    lines: StatementLine[];
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
  } | null;
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
  periodEnd: string,
  // false = P&L-only client (BS toggle off). revenueMode: when 'deposits_only',
  // CRM invoice-recognized income is excluded from the cash-basis P&L (only
  // actual cash receipts count) — see lib/revenue-recognition.ts.
  opts?: { includeBS?: boolean; revenueMode?: RevenueRecognitionMode }
): Promise<StatementsPreview> {
  const includeBS = opts?.includeBS !== false;
  const revenueMode = normalizeRevenueMode(opts?.revenueMode);
  const [pl, bsReport, cfs, plDetail] = await Promise.all([
    fetchProfitAndLoss(realmId, accessToken, periodStart, periodEnd),
    includeBS
      ? qboRequest<any>(
          realmId,
          accessToken,
          `/reports/BalanceSheet?end_date=${encodeURIComponent(periodEnd)}&accounting_method=Accrual&minorversion=70`
        )
      : Promise.resolve(null),
    includeBS
      ? fetchCashFlow(realmId, accessToken, periodStart, periodEnd).catch(() => null)
      : Promise.resolve(null),
    // Only pull the detail when we actually need it to exclude invoice income.
    revenueMode === "deposits_only"
      ? fetchPLDetailAll(realmId, accessToken, periodStart, periodEnd, "Cash").catch(() => null)
      : Promise.resolve(null),
  ]);

  const lines = flattenBalanceSheet(bsReport?.Rows?.Row || []);
  const find = (re: RegExp) =>
    lines.find((l) => re.test(l.label))?.amount ?? 0;

  // Revenue-recognition adjustment (no-op under standard mode).
  const revAdj = computeRevenueAdjustment(plDetail as any, revenueMode);
  const adjusted = applyRevenueAdjustment(
    {
      totalIncome: pl.totalIncome,
      cogs: pl.cogs,
      netIncome: pl.netIncome,
      lineItems: pl.lineItems.map((i) => ({ label: i.label, amount: i.amount, group: i.group })),
    },
    revAdj
  );

  return {
    pl: {
      totalIncome: adjusted.totalIncome,
      totalExpenses: pl.totalExpenses,
      netIncome: adjusted.netIncome,
      cogs: pl.cogs,
      grossProfit: adjusted.grossProfit,
      lineItems: adjusted.lineItems,
      revenueRecognition:
        revAdj.excludedInvoiceRevenue > 0
          ? { mode: revenueMode, excludedInvoiceRevenue: revAdj.excludedInvoiceRevenue }
          : undefined,
    },
    bs: includeBS
      ? {
          lines,
          totalAssets: find(/^total assets$/i),
          totalLiabilities: find(/^total liabilities$/i),
          totalEquity: find(/^total equity$/i),
        }
      : null,
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

  // ── Deterministic P&L reconciliation ──────────────────────────────────
  // Never let the LLM do the arithmetic — it was miscalling ties because it
  // only got total_income/total_expenses/net (total_expenses EXCLUDES COGS),
  // so income − total_expenses ≠ net and it flagged a false "doesn't tie".
  // Compute the identity in code + hand the AI COGS/gross-profit explicitly.
  const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
  const cogsAmt = r2(pl.cogs);
  const grossProfitAmt = r2(pl.grossProfit ?? pl.totalIncome - cogsAmt);
  const groupSum = (re: RegExp) =>
    r2(pl.lineItems.filter((l) => re.test(String(l.group || ""))).reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const otherIncomeAmt = groupSum(/other.*inc/i);
  const otherExpenseAmt = groupSum(/other.*exp/i);
  // Standard P&L identity: net = income − COGS − operating expenses (± other).
  const computedNet = r2(pl.totalIncome - cogsAmt - pl.totalExpenses + otherIncomeAmt - otherExpenseAmt);
  const plReconciles = Math.abs(computedNet - r2(pl.netIncome)) <= 1; // $1 rounding tolerance

  const compact = {
    profit_and_loss: {
      total_income: pl.totalIncome,
      cogs: cogsAmt,
      gross_profit: grossProfitAmt,
      total_operating_expenses: pl.totalExpenses, // EXCLUDES COGS
      other_income: otherIncomeAmt,
      other_expense: otherExpenseAmt,
      net_income: pl.netIncome,
      // Verified in code — do NOT re-derive the arithmetic:
      reconciliation: { computed_net: computedNet, reported_net: r2(pl.netIncome), reconciles: plReconciles },
      lines: pl.lineItems.slice(0, 120),
    },
    balance_sheet: bs
      ? {
          total_assets: bs.totalAssets,
          total_liabilities: bs.totalLiabilities,
          total_equity: bs.totalEquity,
          lines: bs.lines.slice(0, 120).map((l) => ({ label: l.label, amount: l.amount, group: l.group })),
        }
      : null,
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
- If balance_sheet is null, this client is on P&L-only service while their balance sheet cleanup finishes — review the P&L only and don't flag the missing BS.

P&L COMPOSITION — read carefully before commenting on any totals:
- The identity is: net_income = total_income − cogs − total_operating_expenses (± other_income/other_expense). "total_operating_expenses" is OPERATING EXPENSES ONLY and does NOT include COGS.
- The reconciliation has ALREADY been verified in code (see profit_and_loss.reconciliation). Do NOT re-derive the arithmetic yourself and do NOT raise a "P&L doesn't tie / math doesn't add up / net income doesn't equal…" finding when reconciliation.reconciles is true — it ties; asserting otherwise is wrong. ONLY raise a math-tie finding if reconciliation.reconciles is false, and if so quote computed_net vs reported_net.

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
    // Belt-and-suspenders: when the code-verified identity ties, drop any
    // finding that still claims the P&L math doesn't reconcile. The model
    // occasionally re-derives net from income − operating-expenses (forgetting
    // COGS is separate) and flags a phantom discrepancy — never show that to
    // the reviewer once code has confirmed the tie.
    const MATH_TIE_RE = /(does\s*n['o]?t|doesn'?t|not)\s+(tie|equal|add|reconcile|match|balance)|math\s+(doesn|does\s*n|not|error)|net\s+income\s+(does|doesn|≠|!=|isn)|p&?l\s+(doesn|does\s*n|not).*(tie|add|reconcile|equal)/i;
    const findings: SpotCheckFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings
          .filter((f: any) => f && f.note)
          .filter((f: any) => !(plReconciles && MATH_TIE_RE.test(String(f.note) + " " + String(f.area || ""))))
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
