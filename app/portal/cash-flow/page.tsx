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
import { StatementSwitcher } from "../financial-statements/statement-switcher";
import { Sparkles } from "lucide-react";
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
        <div className="mt-6 bg-white border border-cardline rounded-2xl p-8 text-center space-y-3">
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
        <div className="bg-white border border-cardline rounded-2xl p-10 text-center">
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
      <StatementSwitcher active="cfs" />

      {/* ── Header — quiet, light; no dark hero ─────────────────────── */}
      <header className="flex items-end justify-between gap-5 flex-wrap">
        <div className="min-w-0">
          <div className="font-brand text-[11px] uppercase tracking-[0.14em] text-teal-dark">Cash Flow</div>
          <h1 className="font-brand text-3xl font-semibold text-navy leading-none mt-1.5">Where your cash went</h1>
          <div className="text-sm text-ink-slate mt-2">{range.label}</div>
        </div>
        <div className="inline-flex gap-0.5 bg-white border border-cardline rounded-xl p-1 flex-wrap">
          {Object.entries(presets).map(([key, r]) => (
            <Link
              key={key}
              href={key === "lastMonth" ? "/portal/cash-flow" : `/portal/cash-flow?range=${key}`}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                key === rangeKey ? "bg-teal text-white" : "text-ink-slate hover:bg-hairline"
              }`}
            >
              {r.label}
            </Link>
          ))}
        </div>
      </header>

      {/* ── Cash walk: start + change = end, one connected strip ─────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 rounded-2xl border border-cardline bg-white overflow-hidden">
        {[
          { label: "Cash at start", value: cf.cashAtStart, op: "", net: false, neg: cf.cashAtStart < 0, note: range.label },
          { label: "Net change", value: cf.netCashChange, op: "+", net: false, neg: cf.netCashChange < 0, note: positive ? "cash grew" : "cash shrank" },
          { label: "Cash at end", value: cf.cashAtEnd, op: "=", net: true, neg: cf.cashAtEnd < 0, note: "what's in the bank" },
        ].map((s) => (
          <div key={s.label} className={`relative px-5 py-4 border-t border-hairline sm:border-t-0 sm:border-l first:border-l-0 ${s.net ? "bg-teal-lighter" : ""}`}>
            {s.op && (
              <span className="hidden sm:flex absolute -left-[9px] top-1/2 -translate-y-1/2 w-[18px] h-[18px] items-center justify-center rounded-full bg-canvas border border-cardline text-ink-light text-[11px] font-bold z-10">{s.op}</span>
            )}
            <div className={`font-brand text-[10px] uppercase tracking-[0.1em] ${s.net ? "text-teal-dark" : "text-ink-light"}`}>{s.label}</div>
            <div className={`text-[22px] font-bold mt-2 tabular-nums leading-none ${s.net ? "text-teal-dark" : s.neg ? "text-rust" : "text-navy"}`}>{fmtSigned(s.value)}</div>
            <div className="text-[11.5px] text-ink-slate mt-1.5">{s.note}</div>
          </div>
        ))}
      </div>

      {/* ── Plain-English insight ───────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border border-teal-border bg-teal-lighter p-5">
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
                  Your cash position <strong className="text-rust">shrank by {fmtMoney(Math.abs(cf.netCashChange))}</strong>{" "}
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

      <p className="text-[11px] text-ink-light max-w-2xl">
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
    <div className="bg-white rounded-2xl border border-cardline overflow-hidden">
      <div className="px-5 py-3.5 border-b border-hairline flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-navy">{titleCase(section.title)}</div>
          <div className="text-xs text-ink-slate mt-0.5">{subtitle}</div>
        </div>
        <div
          className={`text-base font-bold flex-shrink-0 tabular-nums ${
            positive ? "text-teal-dark" : "text-rust"
          }`}
        >
          {fmtSigned(section.total)}
        </div>
      </div>
      {section.items.length > 0 ? (
        <ul className="divide-y divide-hairline">
          {section.items.map((item, i) => (
            <li key={`${item.label}-${i}`} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
              <span className="text-navy/85 min-w-0 truncate">{item.label}</span>
              <span className={`flex-shrink-0 font-medium ${item.amount >= 0 ? "text-navy" : "text-rust"}`}>
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
