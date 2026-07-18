"use client";

import { useEffect, useState, Fragment } from "react";
import { Loader2, CalendarRange, AlertTriangle } from "lucide-react";
import type { ProfitLossByMonth } from "@/lib/qbo-pl-by-month";

function fmt(n: number): string {
  const r = Math.round(n);
  const s = Math.abs(r).toLocaleString("en-US");
  return r < 0 ? `-$${s}` : `$${s}`;
}

/** amount as a whole-% of that column's income, or "—" when income is ~0. */
function pctOfIncome(v: number, income: number): string {
  if (!(Math.abs(income) > 0)) return "—";
  return `${Math.round((v / income) * 100)}%`;
}

// Ratios on a near-zero-revenue month are noise; don't flag them.
const RATIO_REVENUE_FLOOR = 2500;
// A per-account month must clear this $ to count as a spike (ignore rounding).
const SPIKE_MIN_DOLLARS = 750;

/** GP/NP KPI bands — identical to the month-end red-flag gate: COGS 20–65%
 *  of revenue (→ gross margin 35–80%), net margin 10–35%. */
function marginOutOfBand(kind: "gross" | "net", value: number, income: number): boolean {
  if (!(income >= RATIO_REVENUE_FLOOR)) return false;
  const m = (value / income) * 100;
  return kind === "gross" ? m < 35 || m > 80 : m < 10 || m > 35;
}

/** Flag a month whose value is ≥2× the account's average across the OTHER
 *  months (and materially large) — the "labor ballooned this month" tell. */
function spikeFlags(values: number[]): boolean[] {
  const n = values.length;
  const abs = values.map((v) => Math.abs(v));
  return values.map((_, i) => {
    if (n < 2) return false;
    const others = abs.filter((_, j) => j !== i);
    const otherAvg = others.reduce((a, b) => a + b, 0) / Math.max(1, others.length);
    const cur = abs[i];
    return cur >= SPIKE_MIN_DOLLARS && otherAvg > 0 && cur >= otherAvg * 2;
  });
}

/** One amount cell: dollar figure on top, % of income beneath, amber when
 *  flagged (a KPI break or a month-over-month spike). */
function Cell({
  value,
  income,
  flag,
  weight,
  tone,
}: {
  value: number;
  income: number;
  flag?: boolean;
  weight?: "normal" | "semibold" | "bold";
  tone?: string; // text color class for the amount
}) {
  const w = weight === "bold" ? "font-bold" : weight === "semibold" ? "font-semibold" : "";
  return (
    <td className={`px-4 py-1.5 text-right align-top ${flag ? "bg-amber-100/70" : ""}`}>
      <div className={`font-mono ${w} ${tone || "text-navy"}`}>{fmt(value)}</div>
      <div className={`font-mono text-[10px] ${flag ? "text-amber-700 font-semibold" : "text-ink-light"}`}>
        {pctOfIncome(value, income)}
      </div>
    </td>
  );
}

/**
 * Month-by-month comparative P&L: account column, one column per month (last
 * 3, current is month-to-date), and a Total column. Every cell shows the
 * amount + its % of income; Gross Profit / Net Income are flagged amber when
 * their margin leaves the KPI band, and any single account month that spikes
 * ≥2× its other months (e.g. labor ballooning) is highlighted too.
 */
export function PLByMonthView({ clientLinkId }: { clientLinkId: string }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<(ProfitLossByMonth & { start?: string; end?: string }) | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    fetch(`/api/clients/${clientLinkId}/pl-by-month?months=3`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
        return b;
      })
      .then((b) => alive && setData(b))
      .catch((e) => alive && setError(e?.message || "Failed to load"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [clientLinkId]);

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
        <Loader2 className="animate-spin text-teal mx-auto" size={24} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-sm text-amber-900">
        Couldn&apos;t load the month-by-month P&amp;L: {error}
      </div>
    );
  }
  if (!data || data.months.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-6 text-sm text-ink-slate text-center">
        No P&amp;L data for the last 3 months.
      </div>
    );
  }

  const months = data.months;
  const colCount = months.length;

  // Income per month + overall — the denominator for every % of income.
  const incomeBlock = data.blocks.find(
    (b) => b.kind === "section" && /income/i.test(b.title) && !/other|cost of goods|cogs/i.test(b.title)
  ) as Extract<(typeof data.blocks)[number], { kind: "section" }> | undefined;
  const incomePerMonth: number[] = incomeBlock ? incomeBlock.totals : months.map(() => 0);
  const totalIncome = incomeBlock ? incomeBlock.total : 0;

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900 flex items-start gap-1.5">
        <AlertTriangle size={13} className="text-amber-600 mt-0.5 shrink-0" />
        <span>
          <strong>Amber cells</strong> are worth a look — a KPI break (gross margin outside 35–80%,
          net margin outside 10–35%) or a single month that spiked to ≥2× the account&apos;s other
          months. Every cell also shows its % of income.
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs uppercase tracking-wide text-ink-slate">
              <th className="text-left font-bold px-4 py-2.5">Account</th>
              {months.map((m) => (
                <th key={m.title} className="text-right font-bold px-4 py-2.5 whitespace-nowrap">
                  {m.title}
                </th>
              ))}
              <th className="text-right font-bold px-4 py-2.5 bg-gray-100 whitespace-nowrap">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.blocks.map((block, bi) => {
              if (block.kind === "section") {
                return (
                  <Fragment key={bi}>
                    <tr className="bg-slate-50/70 border-t border-gray-200">
                      <td
                        colSpan={colCount + 2}
                        className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-slate"
                      >
                        {block.title}
                      </td>
                    </tr>
                    {block.accounts.map((a) => {
                      const flags = spikeFlags(a.values);
                      return (
                        <tr key={a.name} className="border-t border-gray-50 hover:bg-gray-50/50">
                          <td className="px-4 py-1.5 text-navy align-top">{a.name}</td>
                          {a.values.map((v, i) => (
                            <Cell key={i} value={v} income={incomePerMonth[i]} flag={flags[i]} tone="text-ink-slate" />
                          ))}
                          <Cell value={a.total} income={totalIncome} weight="semibold" />
                        </tr>
                      );
                    })}
                    <tr className="border-t border-gray-200 bg-white">
                      <td className="px-4 py-1.5 font-bold text-navy align-top">{block.totalLabel}</td>
                      {block.totals.map((v, i) => (
                        <Cell key={i} value={v} income={incomePerMonth[i]} weight="bold" />
                      ))}
                      <Cell value={block.total} income={totalIncome} weight="bold" />
                    </tr>
                  </Fragment>
                );
              }
              // summary line: Gross Profit / Net Operating Income / Net Income
              const isGross = /gross profit/i.test(block.title);
              const isNet = /net (income|loss|earnings)/i.test(block.title);
              const kind: "gross" | "net" | null = isGross ? "gross" : isNet ? "net" : null;
              const niTone = isNet
                ? block.total >= 0
                  ? "text-emerald-700"
                  : "text-red-600"
                : "text-navy";
              return (
                <tr
                  key={bi}
                  className={`border-t-2 ${isNet ? "border-navy bg-navy/5" : "border-gray-200 bg-gray-50/60"}`}
                >
                  <td className={`px-4 py-2 font-bold align-top ${isNet ? "text-navy" : "text-ink-slate"}`}>
                    {block.title}
                  </td>
                  {block.values.map((v, i) => (
                    <Cell
                      key={i}
                      value={v}
                      income={incomePerMonth[i]}
                      flag={kind ? marginOutOfBand(kind, v, incomePerMonth[i]) : false}
                      weight="bold"
                      tone={niTone}
                    />
                  ))}
                  <Cell
                    value={block.total}
                    income={totalIncome}
                    flag={kind ? marginOutOfBand(kind, block.total, totalIncome) : false}
                    weight="bold"
                    tone={niTone}
                  />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.start && data.end && (
        <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-ink-light flex items-center gap-1.5">
          <CalendarRange size={12} /> {data.start} → {data.end} · last 3 complete months
        </div>
      )}
    </div>
  );
}
