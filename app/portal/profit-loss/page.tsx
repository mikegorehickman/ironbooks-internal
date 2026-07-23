import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchProfitAndLoss } from "@/lib/qbo-reports";
import { fetchAllAccountsIncludingInactive } from "@/lib/qbo";
import {
  resolveClosedPeriodWithRevenue,
  lastYearRange,
  ytdRange,
  thisMonthRange,
  quarterRange,
  type DateRange,
} from "@/lib/portal-data";
import { createServiceSupabase } from "@/lib/supabase";
import { PortalErrorState } from "../error-state";
import { ProfitLossClient } from "./profit-loss-client";
import { StatementSwitcher } from "../financial-statements/statement-switcher";
import { StatementReviewNotes } from "../statement-review-notes";
import { NoClosedPeriodState } from "../no-closed-period";

/**
 * Live P&L page. Defaults to the most-recently-CLOSED month ("Last month").
 *
 * The closed-period indicators sometimes point at a month that hasn't truly
 * been reconciled yet (it reports $0 income). resolveClosedPeriodWithRevenue
 * steps back one month at a time until it finds a month with real revenue —
 * so a client like Zuno never lands on an empty May when April has the books.
 *
 * Ranges pre-fetched in parallel so the period switcher is instant:
 *   - Last month     (the resolved closed period — the default)
 *   - This month     (in-progress, may be unreconciled — caveat shown)
 *   - This quarter
 *   - Year to date
 *   - Last year      (full calendar year prior)
 *
 * A sixth "Custom" range is fetched on demand client-side via
 * /api/portal/profit-loss.
 */
export const dynamic = "force-dynamic";

export default async function ProfitLossPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const service = createServiceSupabase();

  // Resolve the effective closed month (with the $0-revenue step-back) and
  // the other four ranges concurrently. resolveClosedPeriodWithRevenue already
  // fetched the P&L for the month it landed on, so we reuse it below.
  const closedPromise = resolveClosedPeriodWithRevenue(
    service,
    ctx.clientLinkId,
    ctx.qboRealmId,
    ctx.accessToken
  );

  const thisMonth = thisMonthRange();
  const quarter = quarterRange();
  const ytd = ytdRange();
  const lastYear = lastYearRange();

  const othersPromise = Promise.all([
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, thisMonth.start, thisMonth.end)),
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, quarter.start, quarter.end)),
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, ytd.start, ytd.end)),
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, lastYear.start, lastYear.end)),
  ]);

  // Chart of accounts — the parent/sub STRUCTURE so the P&L nests accounts the
  // way QuickBooks does (report amounts alone carry no hierarchy). Stable across
  // ranges, so fetched once and reused. Includes inactive accounts that still
  // carry a balance. Best-effort: [] falls back to the flat report.
  const accountsPromise = safeFetch(() =>
    fetchAllAccountsIncludingInactive(ctx.qboRealmId, ctx.accessToken)
  );

  const closed = await closedPromise;

  // No reconciled month → show the "being prepared" state instead of any
  // P&L figures (strict data-accuracy policy). Keep the statement switcher
  // so the client can still navigate between statements.
  if (!closed) {
    return (
      <div className="space-y-4">
        <StatementSwitcher active="pnl" />
        <NoClosedPeriodState />
      </div>
    );
  }

  const [thisMonthPL, quarterPL, ytdPL, lastYearPL] = await othersPromise;
  const accounts = (await accountsPromise) || [];

  const ranges: Record<string, DateRange> = {
    lastMonth: { ...closed.effectiveMonth, label: `Last month (${closed.effectiveMonth.label})` },
    thisMonth,
    quarter,
    ytd,
    lastYear,
  };

  return (
    <div className="space-y-4">
      <StatementSwitcher active="pnl" />
      <ProfitLossClient
        ranges={ranges as any}
        data={{
          lastMonth: closed.effectivePL,
          thisMonth: thisMonthPL,
          quarter: quarterPL,
          ytd: ytdPL,
          lastYear: lastYearPL,
        }}
        accounts={accounts as any}
        closedSource={closed.base.source}
      />
      {ctx.impersonating && (
        <StatementReviewNotes clientLinkId={ctx.clientLinkId} kind="pl" statementLabel="P&L" />
      )}
    </div>
  );
}

async function safeFetch<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}
