import Link from "next/link";
import { redirect } from "next/navigation";
import {
  TrendingUp, TrendingDown, AlertCircle, MessageSquare, ArrowRight,
  DollarSign, Wallet, Sparkles, CheckCircle2, Scissors,
  BarChart3, Scale, Users, FileWarning, ChevronRight,
} from "lucide-react";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchOverview, resolveClosedPeriodWithRevenue } from "@/lib/portal-data";
import { createServiceSupabase } from "@/lib/supabase";
import { NoClosedPeriodState } from "./no-closed-period";
import { fetchPublishedPackage } from "@/lib/month-end/portal-package";
import { classifyProfitLoss, marginVerdict, netMarginVerdict, type PortalPl } from "@/lib/portal-pl";
import { getOrGenerateDashboardNarrative } from "@/lib/dashboard-narrative";
import { PortalErrorState } from "./error-state";
import { MonthEndBanner } from "./month-end-banner";
import { AskAboutButton } from "./ask-about";
import { MarkdownText } from "./ask-ai/markdown-text";

/**
 * Portal Overview — the facelifted "command center".
 *
 * Pulls live QBO data (closed-month + prior-month P&L, cash, A/R, A/P) and
 * runs it through the shared `classifyProfitLoss` engine so the headline
 * numbers a contractor lives by — Income → Gross Profit → Net Profit —
 * are surfaced front and center, consistent with the P&L page.
 *
 * Visual system mirrors the P&L: gradient hero, teal AI-insight card, a
 * "where each $1 goes" proportion bar, and an "Ask Ironbooks about this"
 * affordance on the month summary.
 */
export const dynamic = "force-dynamic";

export default async function PortalOverview() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  }
  const { ctx } = ctxResult;

  // New clients land on the onboarding wizard by default (soft gate) — send
  // them there until they've finished the required steps (form + docs).
  {
    const svc = createServiceSupabase();
    const { data: cl } = await (svc as any)
      .from("client_links")
      .select("status, cleanup_completed_at, daily_recon_enabled, portal_onboarding")
      .eq("id", ctx.clientLinkId)
      .maybeSingle();
    const { shouldShowOnboarding, onboardingRequiredDone, readOnboardingState } = await import("@/lib/portal-onboarding");
    if (cl && shouldShowOnboarding(cl) && !onboardingRequiredDone(readOnboardingState(cl))) {
      redirect("/portal/onboarding");
    }
  }

  // Resolve the most-recent fully-closed accounting period. The portal shows
  // that month by default; "this month so far" is misleading when the
  // bookkeeper hasn't reconciled it yet. resolveClosedPeriodWithRevenue also
  // steps back past any unreconciled $0-revenue month so the headline numbers
  // reflect a month that actually has books.
  const service = createServiceSupabase();
  const [closed, publishedPkg] = await Promise.all([
    resolveClosedPeriodWithRevenue(service, ctx.clientLinkId, ctx.qboRealmId, ctx.accessToken),
    fetchPublishedPackage(service, ctx.clientLinkId),
  ]);

  // No reconciled month yet → show the "being prepared" state, never
  // partial/guessed numbers. (Strict data-accuracy policy.)
  if (!closed) {
    // Onboarding home: prompt the client to add us as their QBO accountant
    // until they're connected (ctx.qboRealmId is set once QBO is linked).
    return <NoClosedPeriodState showAccountantSetup={!ctx.qboRealmId} />;
  }

  const data = await fetchOverview(
    ctx.qboRealmId,
    ctx.accessToken,
    closed.effectiveMonth,
    closed.priorMonth,
    closed.effectivePL // reuse the P&L the resolver already fetched
  );

  // Run both periods through the shared classifier so every number on this
  // page (income, gross profit, net) is internally consistent with the P&L.
  const c = classifyProfitLoss(data.primaryPL);
  const cPrior = classifyProfitLoss(data.comparisonPL);

  const incomeDelta = c.totalIncome - cPrior.totalIncome;
  const gpDelta = c.grossProfit - cPrior.grossProfit;
  const netDelta = c.netProfit - cPrior.netProfit;

  const monthLabel = publishedPkg?.label || closed.effectiveMonth.label || closed.base.closedMonthLabel;
  const monthShort = data.primaryMonth.label?.split(" ")[0] || "the month";
  const prevShort = data.comparisonMonth.label?.split(" ")[0] || "prior month";

  // Narrative resolution, in priority order:
  //   1. Bookkeeper-published month-end summary (premium, human-written) →
  //      coaching section is omitted, the human note is the whole story.
  //   2. AI-generated coaching narrative (cached per closed month) →
  //      headline + summary + coaching, painter-fluent via the brief.
  //   3. Heuristic fallback (offline-safe, no AI call) → headline + summary.
  let narrativeHeadline: string;
  let narrativeSummary: string;
  let narrativeCoaching: string | null = null;
  if (publishedPkg?.aiSummary) {
    narrativeHeadline = `${publishedPkg.label} is closed and ready`;
    narrativeSummary = publishedPkg.aiSummary;
  } else {
    const ai = await getOrGenerateDashboardNarrative(service as any, {
      clientLinkId: ctx.clientLinkId,
      clientName: ctx.clientName,
      periodLabel: monthLabel,
      periodEnd: closed.effectiveMonth.end,
      c,
      cPrior,
      data,
    });
    if (ai) {
      narrativeHeadline = ai.headline;
      narrativeSummary = ai.summary;
      narrativeCoaching = ai.coaching;
    } else {
      const fallback = buildHeuristicNarrative(c, netDelta, monthLabel, prevShort);
      narrativeHeadline = fallback.headline;
      narrativeSummary = fallback.body;
    }
  }

  // House style: no em/en dashes anywhere in client-facing narrative. Swap them
  // for a plain hyphen (covers cached narratives + the published-package path).
  const noDash = (s: string) => s.replace(/[—–]/g, "-");
  narrativeHeadline = noDash(narrativeHeadline);
  narrativeSummary = noDash(narrativeSummary);
  if (narrativeCoaching) narrativeCoaching = noDash(narrativeCoaching);

  const periodLabel = `${monthLabel}`;
  const firstName = (ctx.userFullName || "").trim().split(/\s+/)[0] || "";

  return (
    <div className="space-y-6">
      <MonthEndBanner />

      {/* ── Gradient hero ───────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy to-teal-dark px-6 py-7 text-white">
        <div className="absolute -right-12 -top-12 w-56 h-56 rounded-full bg-teal/20 blur-3xl" />
        <div className="absolute -left-8 -bottom-16 w-48 h-48 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-5">
          <div className="min-w-0">
            <div className="text-xs text-white/60 uppercase tracking-wider font-semibold">
              {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
            </div>
            <h1 className="text-3xl font-bold mt-1 leading-tight">
              Here's how your business is doing
            </h1>
            <div className="text-sm text-white/70 mt-2 flex items-center gap-2 flex-wrap">
              <CheckCircle2 size={13} className="text-emerald-300" />
              <span>
                Most recent closed month: <strong className="text-white">{monthLabel}</strong>
              </span>
              <span className="text-white/40">·</span>
              <span className="text-white/55">
                {publishedPkg
                  ? "Delivered by your Ironbooks team"
                  : closed.base.source === "reclass_job_closed"
                  ? "Reconciled and closed by your bookkeeper"
                  : closed.base.source === "cleanup_completed"
                  ? "Most recent reconciled period"
                  : "Most recent month with activity"}
              </span>
            </div>
          </div>

          {/* Net profit headline */}
          <div className="flex-shrink-0 bg-white/10 backdrop-blur rounded-xl px-5 py-3 border border-white/15">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-white/60">
              {monthShort} net profit
            </div>
            <div className={`text-3xl font-bold mt-0.5 ${c.netProfit >= 0 ? "text-white" : "text-red-300"}`}>
              {c.netProfit < 0 ? `(${fmtMoney(Math.abs(c.netProfit))})` : fmtMoney(c.netProfit)}
            </div>
            <div className="text-xs text-white/70 mt-0.5">
              {Math.round(c.netMarginPct)}% net margin
            </div>
          </div>
        </div>
      </div>

      {/* ── AI insight card ─────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border-2 border-teal/30 bg-gradient-to-br from-teal/10 via-white to-white p-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-teal/15 flex items-center justify-center flex-shrink-0">
            <Sparkles size={18} className="text-teal-dark" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-teal-dark uppercase tracking-wider">
              This month in plain English
            </div>
            <h2 className="text-lg font-bold text-navy mt-1">{narrativeHeadline}</h2>
            <div className="text-sm text-navy/80 leading-relaxed mt-1">
              <MarkdownText>{narrativeSummary}</MarkdownText>
            </div>
            {narrativeCoaching && (
              <div className="mt-4 pt-4 border-t border-teal/20">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-teal-dark">
                    What I'd focus on next
                  </span>
                </div>
                <div className="text-sm text-navy/85 leading-relaxed">
                  <MarkdownText>{narrativeCoaching}</MarkdownText>
                </div>
              </div>
            )}
            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <Link
                href="/portal/ask-ai"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-dark hover:underline"
              >
                <MessageSquare size={12} /> Ask the AI to explain more
              </Link>
              <AskAboutButton
                kind="pl_summary"
                label={`${monthLabel} — month summary`}
                period={periodLabel}
                context={{
                  income: c.totalIncome,
                  variable_costs: c.totalVariable,
                  gross_profit: c.grossProfit,
                  gross_margin_pct: Math.round(c.grossMarginPct),
                  fixed_expenses: c.totalFixed,
                  net_profit: c.netProfit,
                  net_margin_pct: Math.round(c.netMarginPct),
                  cost_split_estimated: c.costSplitEstimated,
                }}
                subtitle="We'll review your month and reply by email."
                variant="chip"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── KPI tiles: Income → Gross Profit → Net Profit ───────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          icon={DollarSign}
          accent="teal"
          label={`Money in (${monthShort})`}
          value={fmtMoney(c.totalIncome)}
          delta={signedMoney(incomeDelta, prevShort)}
          deltaPositive={incomeDelta >= 0}
          tooltip="Total invoices and sales for work completed this month."
        />
        <KpiCard
          icon={Scissors}
          accent="emerald"
          label={`Gross profit (${monthShort})`}
          value={fmtMoney(c.grossProfit)}
          sub={`${Math.round(c.grossMarginPct)}% gross margin`}
          delta={signedMoney(gpDelta, prevShort)}
          deltaPositive={gpDelta >= 0}
          tooltip={
            c.costSplitEstimated
              ? "Income minus estimated direct job costs (materials, subs, crew). Set up Cost of Goods Sold for an exact figure."
              : "Income minus the direct cost of doing the work — materials, subs, crew."
          }
        />
        <KpiCard
          icon={Wallet}
          accent={c.netProfit >= 0 ? "emerald" : "red"}
          label={`Net profit (what's left)`}
          value={fmtMoney(c.netProfit)}
          sub={`${Math.round(c.netMarginPct)}% net margin`}
          delta={signedMoney(netDelta, prevShort)}
          deltaPositive={netDelta >= 0}
          tooltip="Money in minus every cost and overhead expense. This is what's truly yours."
        />
      </div>

      {/* ── Where each $1 of income goes ────────────────────────────── */}
      {c.totalIncome > 0 && <ProportionBar c={c} />}

      {/* ── What needs your attention ───────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-navy">What needs your attention</h3>
        </div>
        <div className="space-y-3">
          {data.overdueARCount > 0 ? (
            <AttentionItem
              color="red"
              icon={AlertCircle}
              title={`${fmtMoney(data.overdueARTotal)} overdue from customers`}
              body={`${data.overdueARCount} invoice${data.overdueARCount === 1 ? "" : "s"} past due. Tap below to see who and how late.`}
              cta="See who owes you"
              href="/portal/whos-paying"
            />
          ) : (
            <AttentionItem
              color="teal"
              icon={TrendingUp}
              title="All customer payments are current"
              body="Nothing overdue — nice work staying on top of A/R."
              cta="View A/R"
              href="/portal/whos-paying"
            />
          )}
          {data.openAPTotal > 0 && (
            <AttentionItem
              color="amber"
              icon={FileWarning}
              title={`${fmtMoney(data.openAPTotal)} in unpaid bills`}
              body={`${data.openAPCount} bill${data.openAPCount === 1 ? "" : "s"} outstanding to vendors. Check what's due soon.`}
              cta="See what you owe"
              href="/portal/whats-due"
            />
          )}
          {data.openARCount === 0 && data.openAPCount === 0 && data.overdueARCount === 0 && (
            <div className="text-sm text-ink-slate italic">
              Nothing pressing. Your books look clean.
            </div>
          )}
        </div>
      </div>

      {/* ── Cash on hand ────────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <h3 className="font-bold text-navy mb-3">Cash on hand</h3>
        {data.banks.accounts.length === 0 ? (
          <div className="text-sm text-ink-slate italic">
            No bank or credit card accounts found in QuickBooks.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {data.banks.accounts.slice(0, 6).map((a) => (
                <CashTile
                  key={a.name}
                  label={a.name}
                  amount={fmtMoney(a.balance)}
                  sub={a.type === "credit_card" ? "Credit card" : "Bank"}
                  negative={a.type === "credit_card" || a.balance < 0}
                />
              ))}
            </div>
            <div className="mt-4 pt-3 border-t border-slate-100 text-xs text-ink-slate">
              Total cash available:{" "}
              <strong className="text-navy">{fmtMoney(data.banks.totalCashOnHand)}</strong>
              {data.banks.totalCreditCardDebt > 0 && (
                <>
                  {" "}· Credit card debt:{" "}
                  <strong className="text-red-700">{fmtMoney(data.banks.totalCreditCardDebt)}</strong>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Explore your books ──────────────────────────────────────── */}
      <div>
        <h3 className="font-bold text-navy mb-3">Explore your books</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <NavCard
            href="/portal/profit-loss"
            icon={BarChart3}
            title="Profit & Loss"
            body="Income, cost of goods sold, gross profit and overhead — broken down line by line."
          />
          <NavCard
            href="/portal/balance-sheet"
            icon={Scale}
            title="Balance Sheet"
            body="What you own, what you owe, and what's left over — your net worth at a glance."
          />
          <NavCard
            href="/portal/whos-paying"
            icon={Users}
            title="Who owes you"
            body="Open invoices and how late they are, customer by customer."
          />
          <NavCard
            href="/portal/whats-due"
            icon={FileWarning}
            title="What you owe"
            body="Unpaid bills to vendors and when they're due."
          />
        </div>
      </div>
    </div>
  );
}

// ─── HELPERS ────────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return sign + abs.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function signedMoney(delta: number, prevShort: string): string {
  return delta >= 0
    ? `+${fmtMoney(Math.abs(delta))} vs ${prevShort}`
    : `${fmtMoney(delta)} vs ${prevShort}`;
}

function buildHeuristicNarrative(
  c: PortalPl,
  netDelta: number,
  monthLabel: string,
  prevShort: string
): { headline: string; body: string } {
  const monthShort = monthLabel.split(" ")[0];

  if (c.isEmpty) {
    return {
      headline: `${monthLabel} doesn't have any activity recorded yet.`,
      body: `Nothing has posted to your books for ${monthLabel} so far. If you were working then, your bookkeeper may still be catching things up. Reach out if that doesn't sound right.`,
    };
  }

  const nm = netMarginVerdict(c.netMarginPct);
  const gm = marginVerdict(c.grossMarginPct);

  let headline: string;
  if (c.netProfit < 0) {
    headline = `In ${monthShort}, your costs came in ${fmtMoney(Math.abs(c.netProfit))} above your income.`;
  } else if (netDelta > 0) {
    headline = `${monthShort} was a solid month, up ${fmtMoney(Math.abs(netDelta))} from ${prevShort}.`;
  } else if (netDelta < 0) {
    headline = `${monthShort} stayed profitable, a little under ${prevShort}.`;
  } else {
    headline = `${monthShort} came in about even with ${prevShort}.`;
  }

  let body: string;
  if (c.netProfit < 0) {
    body =
      `You brought in ${fmtMoney(c.totalIncome)}. After ${fmtMoney(c.totalVariable)} in ` +
      `${c.costSplitEstimated ? "estimated " : ""}direct job costs, your gross profit was ` +
      `${fmtMoney(c.grossProfit)}, about a ${Math.round(c.grossMarginPct)}% gross margin. ` +
      `Overhead of ${fmtMoney(c.totalFixed)} then put the month ${fmtMoney(Math.abs(c.netProfit))} under breakeven. ` +
      `A slower month happens in this line of work. If it keeps up, it's worth walking through pricing or operating expenses with your bookkeeper.`;
  } else {
    body =
      `You brought in ${fmtMoney(c.totalIncome)}. After ${fmtMoney(c.totalVariable)} in ` +
      `${c.costSplitEstimated ? "estimated " : ""}direct job costs, your gross profit was ` +
      `${fmtMoney(c.grossProfit)}, about a ${Math.round(c.grossMarginPct)}% gross margin (${gm.label}). ` +
      `After ${fmtMoney(c.totalFixed)} of overhead, you kept ${fmtMoney(c.netProfit)} in profit, ` +
      `a ${Math.round(c.netMarginPct)}% net margin (${nm.label}).`;
  }

  return { headline, body };
}

// ─── SUB-COMPONENTS ─────────────────────────────────────────────────────

function KpiCard({
  icon: Icon, accent, label, value, sub, delta, deltaPositive, tooltip,
}: {
  icon: any;
  accent: "teal" | "emerald" | "red";
  label: string;
  value: string;
  sub?: string;
  delta: string;
  deltaPositive: boolean;
  tooltip: string;
}) {
  const accentBar = {
    teal: "bg-teal",
    emerald: "bg-emerald-500",
    red: "bg-red-500",
  }[accent];
  const iconColor = {
    teal: "text-teal-dark bg-teal/10",
    emerald: "text-emerald-700 bg-emerald-50",
    red: "text-red-700 bg-red-50",
  }[accent];
  return (
    <div className="relative bg-white border border-slate-200 rounded-2xl p-5 overflow-hidden">
      <span className={`absolute left-0 top-0 h-full w-1 ${accentBar}`} />
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${iconColor}`}>
          <Icon size={14} />
        </span>
        <span className="text-xs font-semibold text-ink-slate uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-2xl font-bold text-navy mt-2">{value}</div>
      {sub && <div className="text-xs text-ink-slate mt-0.5">{sub}</div>}
      <div className={`text-xs mt-1 ${deltaPositive ? "text-emerald-700" : "text-amber-700"}`}>
        {deltaPositive ? <TrendingUp size={11} className="inline mr-0.5" /> : <TrendingDown size={11} className="inline mr-0.5" />}
        {delta}
      </div>
      <div className="mt-3 text-[11px] text-ink-light italic leading-relaxed">{tooltip}</div>
    </div>
  );
}

function ProportionBar({ c }: { c: PortalPl }) {
  const varPct = Math.max(0, Math.min(100, (c.totalVariable / c.totalIncome) * 100));
  const fixedPct = Math.max(0, Math.min(100, (c.totalFixed / c.totalIncome) * 100));
  const netPct = Math.max(0, 100 - varPct - fixedPct);
  const loss = c.netProfit < 0;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold text-navy">Where each $1 of income goes</h3>
        <Link href="/portal/profit-loss" className="text-xs font-semibold text-teal-dark hover:underline inline-flex items-center gap-1">
          Full P&amp;L <ChevronRight size={12} />
        </Link>
      </div>
      <div className="flex h-6 rounded-full overflow-hidden bg-slate-100">
        {varPct > 0 && <div className="bg-amber-400 h-full" style={{ width: `${varPct}%` }} title={`COGS ${Math.round(varPct)}¢`} />}
        {fixedPct > 0 && <div className="bg-orange-500 h-full" style={{ width: `${fixedPct}%` }} title={`Operating expenses ${Math.round(fixedPct)}¢`} />}
        {!loss && netPct > 0 && <div className="bg-emerald-500 h-full" style={{ width: `${netPct}%` }} title={`Net profit ${Math.round(netPct)}¢`} />}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-xs">
        <Legend color="bg-amber-400" label={c.costSplitEstimated ? "COGS*" : "COGS"} value={`${Math.round(varPct)}¢`} />
        <Legend color="bg-orange-500" label="Operating expenses" value={`${Math.round(fixedPct)}¢`} />
        <Legend
          color={loss ? "bg-red-500" : "bg-emerald-500"}
          label={loss ? "Loss" : "Net profit"}
          value={loss ? `(${Math.round(Math.abs(c.netMarginPct))}¢)` : `${Math.round(netPct)}¢`}
        />
      </div>
      {c.costSplitEstimated && (
        <div className="text-[11px] text-ink-light mt-2">
          *Variable vs. fixed split is estimated from account names. Your bookkeeper can set up
          Cost of Goods Sold for an exact gross margin.
        </div>
      )}
    </div>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-sm ${color}`} />
      <span className="text-ink-slate">{label}</span>
      <span className="font-semibold text-navy">{value}</span>
    </div>
  );
}

function AttentionItem({
  color, icon: Icon, title, body, cta, href,
}: { color: "red" | "amber" | "teal"; icon: any; title: string; body: string; cta: string; href: string }) {
  const colors = {
    red: "bg-red-50 border-red-200 text-red-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    teal: "bg-teal/5 border-teal/30 text-teal-dark",
  }[color];
  return (
    <div className={`flex items-start gap-3 p-3 border rounded-lg ${colors}`}>
      <Icon size={16} className="mt-0.5 flex-shrink-0" />
      <div className="flex-1">
        <div className="font-semibold text-sm">{title}</div>
        <div className="text-xs mt-0.5 opacity-80">{body}</div>
      </div>
      <Link href={href} className="text-xs font-semibold flex items-center gap-1 hover:underline whitespace-nowrap">
        {cta} <ArrowRight size={11} />
      </Link>
    </div>
  );
}

function CashTile({ label, amount, sub, negative }: { label: string; amount: string; sub: string; negative?: boolean }) {
  return (
    <div>
      <div className="text-xs text-ink-slate truncate" title={label}>{label}</div>
      <div className={`text-xl font-bold ${negative ? "text-red-700" : "text-navy"}`}>{amount}</div>
      <div className="text-[11px] text-ink-light">{sub}</div>
    </div>
  );
}

function NavCard({
  href, icon: Icon, title, body,
}: { href: string; icon: any; title: string; body: string }) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 bg-white border border-slate-200 rounded-2xl p-4 hover:border-teal/40 hover:shadow-sm transition-all"
    >
      <span className="w-9 h-9 rounded-lg bg-teal/10 text-teal-dark flex items-center justify-center flex-shrink-0 group-hover:bg-teal/15">
        <Icon size={16} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-navy flex items-center gap-1">
          {title}
          <ChevronRight size={14} className="text-ink-light group-hover:text-teal-dark group-hover:translate-x-0.5 transition-transform" />
        </div>
        <div className="text-xs text-ink-slate mt-0.5 leading-relaxed">{body}</div>
      </div>
    </Link>
  );
}
