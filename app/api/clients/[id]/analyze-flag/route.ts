import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, qboErrorResponse } from "@/lib/qbo";
import { fetchPLDetailAll, fetchProfitAndLoss } from "@/lib/qbo-reports";
import { findDuplicates } from "@/lib/qbo-dup-scan";
import { detectLaborDuplication } from "@/lib/payroll-double-entry";
import { analyzeCrmInvoiceRevenue } from "@/lib/crm-invoice-revenue";
import { analyzeDepositsToIncome } from "@/lib/revenue-integrity";
import { previousMonthPeriod } from "@/lib/monthly-rec";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const fmt = (n: number) =>
  `$${Math.abs(Math.round(Number(n) || 0)).toLocaleString("en-US")}`;

type Cause = {
  kind:
    | "duplicate_revenue"
    | "deposits_as_revenue"
    | "duplicate_expense"
    | "duplicate_payroll"
    | "missing_cogs"
    | "missing_revenue"
    | "bad_month";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  amount: number;
  action: string;
  /** Section on the client's Balance Sheet page that fixes it (#hash), if any. */
  fix?: string;
};

/**
 * POST /api/clients/[id]/analyze-flag  { period? | start?,end? }
 *
 * "Analyze the flag" — one call that runs every anomaly detector over the
 * period's P&L and explains WHY a KPI (gross/net margin) looks off: suspected
 * duplicate revenue, duplicate expenses, duplicate payroll, deposits booked as
 * revenue, a missing COGS setup, missing revenue, or just a genuinely unusual
 * month. Deterministic (the detectors are the analysis); read-only. Ranks the
 * likely causes by dollar impact and returns a one-line verdict.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Staff only" }, { status: 403 });
  }

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, qbo_realm_id, is_active, revenue_recognition_mode")
    .eq("id", clientLinkId)
    .maybeSingle();
  if (!client?.qbo_realm_id) {
    return NextResponse.json({ error: "Client not found or no QBO connection" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({} as any));
  const def = previousMonthPeriod();
  let period = def.period;
  let start = def.periodStart;
  let end = def.periodEnd;
  if (typeof body.period === "string" && /^\d{4}-\d{2}$/.test(body.period)) {
    period = body.period;
    const [y, m] = period.split("-").map(Number);
    start = `${period}-01`;
    end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(body.start || "") && /^\d{4}-\d{2}-\d{2}$/.test(body.end || "")) {
    start = body.start;
    end = body.end;
    period = start.slice(0, 7);
  }

  try {
    const realm = client.qbo_realm_id as string;
    const token = await getValidToken(clientLinkId, service as any);
    const [accounts, plDetail, pl] = await Promise.all([
      fetchAllAccounts(realm, token),
      fetchPLDetailAll(realm, token, start, end, "Cash"),
      fetchProfitAndLoss(realm, token, start, end),
    ]);

    const income = Number(pl.totalIncome) || 0;
    const cogs = Number(pl.cogs) || 0;
    const grossProfit = pl.grossProfit != null ? Number(pl.grossProfit) : income - cogs;
    const opex = Number(pl.totalExpenses) || 0;
    const net = Number(pl.netIncome) || 0;
    const cogsPct = income > 0 ? (cogs / income) * 100 : 0;
    const netPct = income > 0 ? (net / income) * 100 : 0;
    const grossFlag = income >= 2500 && cogs > 0.005 && (cogsPct < 20 || cogsPct > 65);
    const netFlag = income >= 2500 && (netPct < 10 || netPct > 35);

    const active = (a: any) => a.Active !== false;
    const incomeNames = new Set(
      accounts.filter((a: any) => active(a) && String(a.AccountType) === "Income").map((a: any) => String(a.Name || ""))
    );

    // ── Run every detector ──
    const crm = analyzeCrmInvoiceRevenue(plDetail as any, incomeNames);
    const depinc = analyzeDepositsToIncome(
      plDetail as any,
      accounts.filter(active).map((a: any) => ({ name: String(a.Name || ""), accountType: String(a.AccountType || "") }))
    );
    const dups = findDuplicates(plDetail as any, 100);
    const labor = detectLaborDuplication(
      (plDetail as any[]).map((r) => ({
        account: String(r.account || ""),
        txn_type: String(r.txn_type || ""),
        name: r.name ?? null,
        amount: Number(r.amount) || 0,
        memo: r.memo ?? null,
      }))
    );

    const causes: Cause[] = [];

    // Duplicate revenue (CRM invoices + deposits both recognizing income).
    if (crm.flagged) {
      const amt = Math.min(crm.invoiceIncomeTotal, crm.depositIncomeTotal) || crm.invoiceIncomeTotal;
      causes.push({
        kind: "duplicate_revenue",
        severity: "high",
        title: "Duplicate revenue (CRM invoices + deposits)",
        detail:
          `${crm.invoiceTxnCount} CRM invoices recognize ${fmt(crm.invoiceIncomeTotal)} of income while ` +
          `${crm.depositCount} deposits put ${fmt(crm.depositIncomeTotal)} into income accounts` +
          `${crm.pairs.length ? ` — ${crm.pairs.length} invoice↔deposit pair${crm.pairs.length === 1 ? "" : "s"} proven` : ""}. ` +
          `The same revenue is likely counted twice, which inflates net margin.`,
        amount: amt,
        action: "Void the duplicate invoices or set the client cash-deposits-only on Revenue Check.",
        fix: "ar",
      });
    } else if (depinc.flagged) {
      // Deposits booked straight to income on an invoice-driven book.
      causes.push({
        kind: "deposits_as_revenue",
        severity: "high",
        title: "Deposits booked as revenue",
        detail: `${depinc.depositCount} deposits totaling ${fmt(depinc.depositTotal)} posted straight into income while invoices also recognize revenue — likely double-counted.`,
        amount: depinc.depositTotal,
        action: "Match each deposit to its invoice (or void the duplicate) on Revenue Check.",
        fix: "ar",
      });
    }

    // Duplicate payroll (gross paycheque + net pay on a second labor line).
    if (labor.flagged) {
      causes.push({
        kind: "duplicate_payroll",
        severity: "high",
        title: "Duplicate payroll",
        detail:
          `${labor.employee_count} employees' pay hits ${labor.suspects.length} account${labor.suspects.length === 1 ? "" : "s"} beyond the paycheque line ` +
          `(${labor.suspects.slice(0, 2).map((s) => `${s.account} ${fmt(s.total)}`).join(", ")}) — up to ${fmt(labor.overstated)} of labor may be expensed twice.`,
        amount: labor.overstated,
        action: "Recategorize the net-pay postings to Payroll Clearing (not a second labor line).",
      });
    }

    // Duplicate expenses / transactions (same amount posted more than once).
    const dupExposure = dups
      .filter((d) => d.severity === "high" || d.severity === "medium")
      .reduce((s, d) => s + Math.abs(d.amount) * Math.max(0, d.count - 1), 0);
    if (dupExposure > 250) {
      const top = dups.filter((d) => d.severity === "high").slice(0, 2);
      causes.push({
        kind: "duplicate_expense",
        severity: dups.some((d) => d.severity === "high") ? "high" : "medium",
        title: "Duplicate expenses",
        detail:
          `${dups.length} likely duplicate group${dups.length === 1 ? "" : "s"} — about ${fmt(dupExposure)} of double-posted cost` +
          `${top.length ? ` (e.g. ${top.map((d) => `${d.name || d.account} ${d.count}× ${fmt(d.amount)}`).join(", ")})` : ""}.`,
        amount: dupExposure,
        action: "Review the duplicate groups and void the extra copies (BS cleanup → duplicate scan).",
        fix: "reconcile",
      });
    }

    // Missing COGS setup — low COGS on a book with material job-cost-like opex.
    if (income >= 2500 && cogsPct < 20) {
      const jobCostRe = /material|subcontract|sub-?contract|direct labor|job cost|paint|supplies/i;
      const jobCostInOpex = (plDetail as any[])
        .filter((r) => /expense/i.test(String(r.section || r.group || "")) && jobCostRe.test(String(r.account || "")))
        .reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0);
      if (jobCostInOpex > 1000 || cogs < 0.005) {
        causes.push({
          kind: "missing_cogs",
          severity: "medium",
          title: "Cost of Goods Sold not set up",
          detail:
            `COGS is only ${cogsPct.toFixed(0)}% of revenue` +
            (jobCostInOpex > 1000 ? ` and ~${fmt(jobCostInOpex)} of materials/subs/labor sits in operating expenses` : "") +
            ` — direct job costs likely aren't classified as COGS, which overstates gross margin.`,
          amount: jobCostInOpex,
          action: "Reclass direct job costs (materials, subs, field labor) into a COGS section.",
          fix: "reconcile",
        });
      }
    }

    // Directional fallback when a KPI is flagged but no concrete cause fired.
    if ((grossFlag || netFlag) && causes.length === 0) {
      if (netPct > 35 || cogsPct < 20) {
        causes.push({
          kind: "missing_revenue",
          severity: "medium",
          title: "Costs may be understated",
          detail: `Margin is unusually high (net ${netPct.toFixed(0)}%, COGS ${cogsPct.toFixed(0)}%) but no duplicate revenue was detected — expenses may be missing/unrecorded, or bills not yet entered.`,
          amount: 0,
          action: "Check for unentered bills and uncategorized/undeposited activity for the period.",
        });
      } else {
        causes.push({
          kind: "missing_revenue",
          severity: "medium",
          title: "Revenue may be missing",
          detail: `Margin is thin (net ${netPct.toFixed(0)}%) with no duplicate expenses or payroll detected — revenue may be under-recorded (uninvoiced jobs), or it was simply a slow month.`,
          amount: 0,
          action: "Confirm all completed jobs are invoiced/deposited before sending.",
        });
      }
    }

    causes.sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 } as const;
      if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
      return b.amount - a.amount;
    });

    const flagged = grossFlag || netFlag;
    const verdict = !flagged && causes.length === 0
      ? "No KPI flag and nothing anomalous — this looks like a clean, genuine month."
      : causes.length === 0
        ? "A KPI is outside its band, but no duplicate/structural cause was found — likely a genuinely unusual (seasonal) month. Sanity-check before sending."
        : `Most likely: ${causes[0].title.toLowerCase()}.`;

    return NextResponse.json({
      period,
      window: { start, end },
      metrics: {
        income, cogs, grossProfit, opex, net,
        cogsPct: Math.round(cogsPct * 10) / 10,
        netPct: Math.round(netPct * 10) / 10,
        grossFlag, netFlag,
      },
      causes,
      verdict,
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
