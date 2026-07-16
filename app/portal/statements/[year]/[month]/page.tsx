import Link from "next/link";
import { ArrowLeft, CheckCircle2, FileWarning, HelpCircle } from "lucide-react";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { fetchPublishedPackage } from "@/lib/month-end/portal-package";
import { fetchProfitAndLoss } from "@/lib/qbo-reports";
import { fetchAllAccounts } from "@/lib/qbo";
import { PortalErrorState } from "../../../error-state";
import type { PlSnapshot, BsSnapshot, ArApSnapshot } from "@/lib/month-end/types";
import { DraftReviewPanel, type PortalAccount } from "./draft-review-panel";
import { ProfitLossClient } from "../../../profit-loss/profit-loss-client";

export const dynamic = "force-dynamic";

export default async function PortalStatementsPage({
  params,
}: {
  params: Promise<{ year: string; month: string }>;
}) {
  const { year, month } = await params;
  const periodYear = Number(year);
  const periodMonth = Number(month);

  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  }
  const { ctx } = ctxResult;

  const service = createServiceSupabase();
  const pkg = await fetchPublishedPackage(service, ctx.clientLinkId, periodYear, periodMonth);

  if (!pkg) {
    return (
      <div className="space-y-4">
        <Link href="/portal" className="inline-flex items-center gap-1 text-sm text-teal-dark hover:underline">
          <ArrowLeft size={14} /> Back to overview
        </Link>
        <p className="text-ink-slate">No delivered statements found for this period.</p>
      </div>
    );
  }

  const pl = pkg.plSnapshot as unknown as PlSnapshot;
  const bs = pkg.bsSnapshot as unknown as BsSnapshot;
  const arAp = pkg.arApSnapshot as unknown as ArApSnapshot;

  // DRAFT months carry the gut-check panel; pull the client's existing
  // response (if any) so an approved month shows the thank-you state.
  let existingReviewStatus: "approved" | "questions" | "info_added" | null = null;
  let established = false;
  let accounts: PortalAccount[] = [];
  if (pkg.sentAsDraft) {
    const [{ data: reviewRow }, { data: clRow }] = await Promise.all([
      service
        .from("statement_reviews" as any)
        .select("status")
        .eq("client_link_id", ctx.clientLinkId)
        .eq("period_year", periodYear)
        .eq("period_month", periodMonth)
        .maybeSingle(),
      service.from("client_links").select("created_at").eq("id", ctx.clientLinkId).maybeSingle(),
    ]);
    existingReviewStatus = ((reviewRow as any)?.status as any) || null;
    const createdAt = (clRow as any)?.created_at ? new Date((clRow as any).created_at).getTime() : null;
    established = createdAt !== null && Date.now() - createdAt > 90 * 24 * 60 * 60 * 1000;

    // Bank / credit-card / loan accounts to LIST under the "are all your
    // accounts here?" question so the client can eyeball what we have and
    // name anything missing (Mike, 2026-07-16). Fail-soft: empty list.
    try {
      const live = await fetchAllAccounts(ctx.qboRealmId, ctx.accessToken);
      accounts = live
        .filter((a) => {
          const t = (a.AccountType || "").toLowerCase();
          const c = (a.Classification || "").toLowerCase();
          return a.Active !== false && (t === "bank" || t === "credit card" || c === "liability");
        })
        .map((a) => ({
          name: a.Name,
          kind:
            (a.AccountType || "").toLowerCase() === "bank"
              ? "Bank"
              : (a.AccountType || "").toLowerCase() === "credit card"
              ? "Credit card"
              : "Loan / liability",
        }));
    } catch {
      accounts = [];
    }
  }

  // Full P&L for the statement month, with the same clickable line-item
  // drill-down as the live P&L page (Mike, 2026-07-16). Fail-soft: if QBO
  // is unreachable, fall back to the frozen 3-number summary below.
  let livePl = null;
  try {
    livePl = await fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, pkg.periodStart, pkg.periodEnd);
  } catch {
    livePl = null;
  }
  const plRange = { label: pkg.label, start: pkg.periodStart, end: pkg.periodEnd };
  const plRanges = { lastMonth: plRange, thisMonth: plRange, quarter: plRange, ytd: plRange, lastYear: plRange };
  const plData = { lastMonth: livePl, thisMonth: null, quarter: null, ytd: null, lastYear: null };

  return (
    <div className="space-y-6">
      <Link href="/portal" className="inline-flex items-center gap-1 text-sm text-teal-dark hover:underline">
        <ArrowLeft size={14} /> Back to overview
      </Link>

      <div>
        {pkg.sentAsDraft ? (
          <div className="flex items-center gap-2 text-sm text-amber-700">
            <FileWarning size={16} />
            <span>{pkg.label} — draft, awaiting your review</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-emerald-700">
            <CheckCircle2 size={16} />
            <span>{pkg.label} — closed and ready</span>
          </div>
        )}
        <h1 className="text-2xl font-bold text-navy mt-2 flex items-center gap-3 flex-wrap">
          {pkg.label} Statements
          {pkg.sentAsDraft && (
            <span className="inline-flex items-center gap-2">
              <span className="text-xs font-black tracking-widest bg-amber-600 text-white px-2.5 py-1 rounded-md align-middle">
                DRAFT
              </span>
              <Link
                href="/portal/knowledge-base?open=draft-vs-verified"
                className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 hover:text-amber-900 hover:underline"
              >
                <HelpCircle size={13} /> What&apos;s this?
              </Link>
            </span>
          )}
        </h1>
      </div>

      {pkg.aiSummary && (
        <div className="bg-gradient-to-br from-teal/10 to-teal/5 border-2 border-teal/30 rounded-2xl p-6">
          <div className="text-xs font-bold text-teal-dark uppercase tracking-wider mb-2">
            Your bookkeeper&apos;s summary
          </div>
          <div className="text-sm text-navy/85 leading-relaxed whitespace-pre-wrap">{pkg.aiSummary}</div>
        </div>
      )}

      {/* Full P&L with clickable line-item drill-down (Mike, 2026-07-16).
          Falls back to the frozen 3-number summary if QBO is unreachable. */}
      {livePl ? (
        <ProfitLossClient ranges={plRanges} data={plData as any} closedSource="calendar_default" singleMonth />
      ) : (
        <div className="grid md:grid-cols-3 gap-4">
          <MetricCard label="Revenue" value={pl.totalIncome} />
          <MetricCard label="Expenses" value={pl.totalExpenses} />
          <MetricCard label="Net income" value={pl.netIncome} highlight />
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <div className="border rounded-xl p-5 bg-white">
          <h2 className="font-bold text-navy mb-3">Balance sheet (as of {bs.asOfDate})</h2>
          <dl className="space-y-2 text-sm">
            <Row label="Total assets" value={bs.totalAssets} />
            <Row label="Total liabilities" value={bs.totalLiabilities} />
            <Row label="Equity" value={bs.totalEquity} />
            <Row label="Cash on hand" value={bs.cashOnHand} />
          </dl>
        </div>
        <div className="border rounded-xl p-5 bg-white">
          <h2 className="font-bold text-navy mb-3">Receivables & payables</h2>
          <dl className="space-y-2 text-sm">
            <Row label="Open A/R" value={arAp.openARTotal} suffix={` (${arAp.openARCount} invoices)`} />
            <Row label="Overdue A/R" value={arAp.overdueARTotal} />
            <Row label="Open A/P" value={arAp.openAPTotal} suffix={` (${arAp.openAPCount} bills)`} />
          </dl>
        </div>
      </div>

      {/* Draft gut-check LAST — the client reads their statements first, then
          confirms below (Mike, 2026-07-15: statements on top, review under). */}
      {pkg.sentAsDraft && (
        <DraftReviewPanel
          periodYear={periodYear}
          periodMonth={periodMonth}
          existingStatus={existingReviewStatus}
          established={established}
          accounts={accounts}
        />
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-4 ${highlight ? "border-teal/40 bg-teal/5" : "bg-white"}`}>
      <div className="text-xs text-ink-slate uppercase tracking-wide">{label}</div>
      <div className="text-xl font-bold text-navy mt-1">${Math.round(value).toLocaleString()}</div>
    </div>
  );
}

function Row({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number;
  suffix?: string;
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-slate">{label}</dt>
      <dd className="font-semibold text-navy">
        ${Math.round(value).toLocaleString()}
        {suffix && <span className="font-normal text-ink-slate">{suffix}</span>}
      </dd>
    </div>
  );
}
