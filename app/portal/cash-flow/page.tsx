import Link from "next/link";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchCashFlow, type CashFlowSection } from "@/lib/qbo-reports";
import {
  lastMonthRange,
  thisMonthRange,
  quarterRange,
  ytdRange,
  lastYearRange,
  type DateRange,
} from "@/lib/portal-data";
import { PortalErrorState } from "../error-state";
import { DraftStageBanner } from "../draft-stage-banner";
import { StatementSwitcher } from "../financial-statements/statement-switcher";
import { Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * /portal/cash-flow — client-facing Cash Flow Statement.
 *
 * Server-rendered with a ?range= preset switcher (links, no client JS):
 * lastMonth (default) / thisMonth / quarter / ytd / lastYear. Renders the
 * QBO CashFlow report as three section cards (operating / investing /
 * financing) under a hero showing the period's net cash change, plus the
 * beginning → ending cash walk and a plain-English insight card.
 */
export default async function CashFlowPage({
  searchParams,
}: {
  searchParams?: Promise<{ range?: string }>;
}) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  // Cash flow is derived from balance-sheet data — while the client's BS
  // cleanup is in progress (bs_enabled=false, P&L-only service) it would
  // show numbers we know are wrong. Same placeholder as the BS page.
  const service = createServiceSupabase();
  const { data: clientRow } = await service
    .from("client_links")
    .select("*")
    .eq("id", ctx.clientLinkId)
    .single();
  // Cash flow derives from the balance sheet, so gate it the same way: show
  // only once the BS has been explicitly pushed to the portal (bs_enabled=true).
  if ((clientRow as any)?.bs_enabled !== true) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold text-navy">Cash Flow</h1>
        <div className="mt-6 bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-3">
          <div className="inline-flex w-14 h-14 rounded-full bg-teal/10 items-center justify-center">
            <Sparkles size={24} className="text-teal" />
          </div>
          <h2 className="text-lg font-bold text-navy">
            We&apos;re still cleaning up your cash flow
          </h2>
          <p className="text-sm text-ink-slate max-w-md mx-auto leading-relaxed">
            Your cash flow statement is built from your balance sheet — so it
            depends on that cleanup finishing first. Your bookkeeper is still
            verifying those balances, and your Profit &amp; Loss is live and up
            to date in the meantime. We&apos;ll email you the moment your cash
            flow statement is ready.
          </p>
          <p className="text-xs text-ink-light">
            Want a status update?{" "}
            <Link href="/portal/messages" className="font-semibold text-teal-dark hover:underline">
              Ask your bookkeeper on the Messages page
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }

  const presets: Record<string, DateRange> = {
    lastMonth: lastMonthRange(),
    thisMonth: thisMonthRange(),
    quarter: quarterRange(),
    ytd: ytdRange(),
    lastYear: lastYearRange(),
  };
  const sp = (await searchParams) || {};
  const rangeKey = sp.range && presets[sp.range] ? sp.range : "lastMonth";
  const range = presets[rangeKey];

  let cf;
  let fetchError: string | null = null;
  try {
    cf = await fetchCashFlow(ctx.qboRealmId, ctx.accessToken, range.start, range.end);
  } catch (err: any) {
    fetchError = err?.message || "Could not load the cash flow report";
  }

  if (fetchError || !cf) {
    return (
      <div className="space-y-4">
        <StatementSwitcher active="cfs" />
        <div className="bg-white border border-gray-200 rounded-2xl p-10 text-center">
          <div className="text-sm font-semibold text-navy">
            Couldn&apos;t load your cash flow statement
          </div>
          <p className="text-xs text-ink-slate mt-2 max-w-md mx-auto">
            QuickBooks didn&apos;t return the report. Try again in a minute, or
            message your bookkeeper if it keeps happening.
          </p>
        </div>
      </div>
    );
  }

  const positive = cf.netCashChange >= 0;

  return (
    <div className="space-y-6">
      <DraftStageBanner clientLinkId={ctx.clientLinkId} />
      <StatementSwitcher active="cfs" />

      {/* ── Gradient hero ───────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy to-teal-dark px-6 py-6 text-white">
        <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full bg-emerald-300/15 blur-2xl" />
        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-xs text-white/60 uppercase tracking-wider font-semibold">
              Cash Flow Statement
            </div>
            <h1 className="text-3xl font-bold mt-1">Where your cash went</h1>
            <div className="text-sm text-white/70 mt-1">{range.label}</div>
          </div>
          <div className="flex-shrink-0 bg-white/10 backdrop-blur rounded-xl px-5 py-3 border border-white/15">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-white/60">
              Net cash change
            </div>
            <div
              className={`text-3xl font-bold mt-0.5 flex items-center gap-2 ${
                positive ? "text-white" : "text-red-300"
              }`}
            >
              {positive ? <TrendingUp size={22} /> : <TrendingDown size={22} />}
              {fmtSigned(cf.netCashChange)}
            </div>
            <div className="text-xs text-white/70 mt-0.5">
              {fmtMoney(cf.cashAtStart)} → {fmtMoney(cf.cashAtEnd)}
            </div>
          </div>
        </div>
      </div>

      {/* ── Period presets ──────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(presets).map(([key, r]) => (
          <Link
            key={key}
            href={key === "lastMonth" ? "/portal/cash-flow" : `/portal/cash-flow?range=${key}`}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              key === rangeKey
                ? "bg-navy text-white border-navy"
                : "bg-white text-ink-slate border-gray-200 hover:border-teal hover:text-teal-dark"
            }`}
          >
            {r.label}
          </Link>
        ))}
      </div>

      {/* ── Plain-English insight ───────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border-2 border-teal/30 bg-gradient-to-br from-teal/10 via-white to-white p-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-teal/15 flex items-center justify-center flex-shrink-0">
            <Sparkles size={18} className="text-teal-dark" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-teal-dark uppercase tracking-wider">
              In plain English
            </div>
            <p className="text-sm text-navy/85 leading-relaxed mt-1">
              {positive ? (
                <>
                  Your cash position <strong className="text-emerald-700">grew by {fmtMoney(cf.netCashChange)}</strong>{" "}
                  this period — you started with {fmtMoney(cf.cashAtStart)} and ended with{" "}
                  <strong>{fmtMoney(cf.cashAtEnd)}</strong>.
                </>
              ) : (
                <>
                  Your cash position <strong className="text-red-700">shrank by {fmtMoney(Math.abs(cf.netCashChange))}</strong>{" "}
                  this period — from {fmtMoney(cf.cashAtStart)} down to{" "}
                  <strong>{fmtMoney(cf.cashAtEnd)}</strong>.
                </>
              )}{" "}
              Day-to-day operations {cf.operating.total >= 0 ? "generated" : "consumed"}{" "}
              <strong>{fmtMoney(Math.abs(cf.operating.total))}</strong>
              {cf.financing.total !== 0 && (
                <>
                  , and financing activity (loans, credit lines, owner draws){" "}
                  {cf.financing.total >= 0 ? "added" : "took out"}{" "}
                  <strong>{fmtMoney(Math.abs(cf.financing.total))}</strong>
                </>
              )}
              . This is different from profit — profit counts invoices when they&apos;re
              earned; cash flow counts money when it actually moves.
            </p>
          </div>
        </div>
      </div>

      {/* ── Three activity sections ─────────────────────────────────── */}
      <SectionCard
        section={cf.operating}
        subtitle="Cash from running the business — collections in, bills and payroll out"
      />
      <SectionCard
        section={cf.investing}
        subtitle="Equipment, vehicles, and other asset purchases or sales"
      />
      <SectionCard
        section={cf.financing}
        subtitle="Loans, credit lines, and money moving to or from owners"
      />

      {/* ── Beginning → ending walk ─────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <div className="space-y-2 text-sm">
          <WalkRow label="Cash at beginning of period" value={cf.cashAtStart} />
          <WalkRow label="Net cash change" value={cf.netCashChange} signed />
          <div className="border-t border-gray-100 pt-2 flex items-center justify-between font-bold text-navy">
            <span>Cash at end of period</span>
            <span>{fmtMoney(cf.cashAtEnd)}</span>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-ink-slate/70 max-w-2xl">
        Built live from your QuickBooks data (indirect method). Cash includes
        bank accounts and other cash-equivalent accounts as configured in
        QuickBooks.
      </p>
    </div>
  );
}

function SectionCard({ section, subtitle }: { section: CashFlowSection; subtitle: string }) {
  const positive = section.total >= 0;
  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-navy">{titleCase(section.title)}</div>
          <div className="text-xs text-ink-slate mt-0.5">{subtitle}</div>
        </div>
        <div
          className={`text-base font-bold flex-shrink-0 ${
            positive ? "text-emerald-700" : "text-red-700"
          }`}
        >
          {fmtSigned(section.total)}
        </div>
      </div>
      {section.items.length > 0 ? (
        <ul className="divide-y divide-gray-50">
          {section.items.map((item, i) => (
            <li key={`${item.label}-${i}`} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
              <span className="text-navy/85 min-w-0 truncate">{item.label}</span>
              <span className={`flex-shrink-0 font-medium ${item.amount >= 0 ? "text-navy" : "text-red-700"}`}>
                {fmtSigned(item.amount)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-5 py-4 text-xs text-ink-slate">No activity this period.</div>
      )}
    </div>
  );
}

function WalkRow({ label, value, signed }: { label: string; value: number; signed?: boolean }) {
  return (
    <div className="flex items-center justify-between text-navy/85">
      <span>{label}</span>
      <span className={`font-medium ${signed && value < 0 ? "text-red-700" : ""}`}>
        {signed ? fmtSigned(value) : fmtMoney(value)}
      </span>
    </div>
  );
}

function fmtMoney(n: number): string {
  return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtSigned(n: number): string {
  return n < 0 ? `(${fmtMoney(n)})` : fmtMoney(n);
}
/** QBO section headers arrive ALL-CAPS ("OPERATING ACTIVITIES") — soften. */
function titleCase(s: string): string {
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
