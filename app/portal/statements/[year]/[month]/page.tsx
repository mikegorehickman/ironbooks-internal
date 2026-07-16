import Link from "next/link";
import { ArrowLeft, CheckCircle2, FileWarning } from "lucide-react";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { fetchPublishedPackage } from "@/lib/month-end/portal-package";
import { PortalErrorState } from "../../../error-state";
import type { PlSnapshot, BsSnapshot, ArApSnapshot } from "@/lib/month-end/types";
import { DraftReviewPanel } from "./draft-review-panel";

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

  const service = createServiceSupabase();
  const pkg = await fetchPublishedPackage(
    service,
    ctxResult.ctx.clientLinkId,
    periodYear,
    periodMonth
  );

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
  if (pkg.sentAsDraft) {
    const { data: reviewRow } = await service
      .from("statement_reviews" as any)
      .select("status")
      .eq("client_link_id", ctxResult.ctx.clientLinkId)
      .eq("period_year", periodYear)
      .eq("period_month", periodMonth)
      .maybeSingle();
    existingReviewStatus = ((reviewRow as any)?.status as any) || null;
  }

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
        <h1 className="text-2xl font-bold text-navy mt-2 flex items-center gap-3">
          {pkg.label} Statements
          {pkg.sentAsDraft && (
            <span className="text-xs font-black tracking-widest bg-amber-600 text-white px-2.5 py-1 rounded-md align-middle">
              DRAFT
            </span>
          )}
        </h1>
      </div>

      {pkg.sentAsDraft && (
        <DraftReviewPanel
          periodYear={periodYear}
          periodMonth={periodMonth}
          existingStatus={existingReviewStatus}
        />
      )}

      {pkg.aiSummary && (
        <div className="bg-gradient-to-br from-teal/10 to-teal/5 border-2 border-teal/30 rounded-2xl p-6">
          <div className="text-xs font-bold text-teal-dark uppercase tracking-wider mb-2">
            Your bookkeeper&apos;s summary
          </div>
          <div className="text-sm text-navy/85 leading-relaxed whitespace-pre-wrap">
            {pkg.aiSummary}
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-3 gap-4">
        <MetricCard label="Revenue" value={pl.totalIncome} />
        <MetricCard label="Expenses" value={pl.totalExpenses} />
        <MetricCard label="Net income" value={pl.netIncome} highlight />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="border rounded-xl p-5">
          <h2 className="font-bold text-navy mb-3">Balance sheet (as of {bs.asOfDate})</h2>
          <dl className="space-y-2 text-sm">
            <Row label="Total assets" value={bs.totalAssets} />
            <Row label="Total liabilities" value={bs.totalLiabilities} />
            <Row label="Equity" value={bs.totalEquity} />
            <Row label="Cash on hand" value={bs.cashOnHand} />
          </dl>
        </div>
        <div className="border rounded-xl p-5">
          <h2 className="font-bold text-navy mb-3">Receivables & payables</h2>
          <dl className="space-y-2 text-sm">
            <Row label="Open A/R" value={arAp.openARTotal} suffix={` (${arAp.openARCount} invoices)`} />
            <Row label="Overdue A/R" value={arAp.overdueARTotal} />
            <Row label="Open A/P" value={arAp.openAPTotal} suffix={` (${arAp.openAPCount} bills)`} />
          </dl>
        </div>
      </div>
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
    <div className={`rounded-xl border p-4 ${highlight ? "border-teal/40 bg-teal/5" : ""}`}>
      <div className="text-xs text-ink-slate uppercase tracking-wide">{label}</div>
      <div className="text-xl font-bold text-navy mt-1">
        ${Math.round(value).toLocaleString()}
      </div>
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
