import Link from "next/link";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { resolvePortalContextAllowNoQbo } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { FileText } from "lucide-react";
import { fetchNoticeForPeriod } from "@/lib/statement-notices-server";
import { fetchPublishedPackage } from "@/lib/month-end/portal-package";
import { PortalErrorState } from "../../../error-state";
import type { PlSnapshot, BsSnapshot, ArApSnapshot } from "@/lib/month-end/types";

export const dynamic = "force-dynamic";

export default async function PortalStatementsPage({
  params,
}: {
  params: Promise<{ year: string; month: string }>;
}) {
  const { year, month } = await params;
  const periodYear = Number(year);
  const periodMonth = Number(month);

  const ctxResult = await resolvePortalContextAllowNoQbo();
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

  // This period's Notice to Reader, read-only (the P&L carries the reply box).
  // Fail-soft: pre-migration environments simply show no card.
  const notice = await fetchNoticeForPeriod(
    service,
    ctxResult.ctx.clientLinkId,
    periodYear,
    periodMonth
  ).catch(() => null);

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

  return (
    <div className="space-y-6">
      <Link href="/portal" className="inline-flex items-center gap-1 text-sm text-teal-dark hover:underline">
        <ArrowLeft size={14} /> Back to overview
      </Link>

      <div>
        <div className="flex items-center gap-2 text-sm text-emerald-700">
          <CheckCircle2 size={16} />
          <span>{pkg.label} — closed and ready</span>
        </div>
        <h1 className="text-2xl font-bold text-navy mt-2">{pkg.label} Statements</h1>
      </div>

      {notice && (
        <div className="bg-white border border-cardline rounded-2xl p-6">
          <div className="text-xs font-bold text-teal-dark uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <FileText size={13} />
            Notice to Reader
            {notice.sent_by_name ? <span className="normal-case font-semibold text-ink-slate tracking-normal">· from {notice.sent_by_name}</span> : null}
          </div>
          <div className="text-sm text-navy/85 leading-relaxed whitespace-pre-wrap space-y-3">
            <div>{notice.boilerplate_body}</div>
            {notice.ai_body && <div>{notice.ai_body}</div>}
            {notice.custom_body && <div>{notice.custom_body}</div>}
          </div>
          <div className="text-xs text-ink-slate mt-3">
            To reply, open your <a href="/portal/profit-loss" className="text-teal-dark font-semibold hover:underline">Profit &amp; Loss</a> — the notice there has a reply box.
          </div>
        </div>
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
