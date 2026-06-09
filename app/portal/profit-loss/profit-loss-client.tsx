"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown, AlertTriangle, X, Loader2, ChevronRight, Flag, CheckCircle2,
  Sparkles, Info, ArrowDown, TrendingUp, TrendingDown,
} from "lucide-react";
import type { ProfitLossData } from "@/lib/qbo-reports";
import { classifyProfitLoss, marginVerdict, type PortalPl, type PlBucket } from "@/lib/portal-pl";
import { AskAboutButton } from "../ask-about";

type RangeKey = "lastMonth" | "thisMonth" | "quarter" | "ytd" | "lastYear";

/**
 * Portal P&L — restructured into the four numbers a contractor lives by:
 *   Income → (−) Variable costs → (=) Gross Profit → (−) Fixed expenses
 *   → (=) Net Profit.
 *
 * Classification is done by lib/portal-pl.ts. When the QBO file lacks a
 * Cost of Goods Sold section we estimate the variable/fixed split and say so.
 *
 * Every line keeps its drill-down (click → transactions) and gains an
 * "Ask Ironbooks" affordance. The period summary has its own ask + a link
 * to the AI.
 */
export function ProfitLossClient({
  ranges,
  data,
  closedSource,
}: {
  ranges: Record<RangeKey, { label: string; start: string; end: string }>;
  data: Record<RangeKey, ProfitLossData | null>;
  closedSource: "reclass_job_closed" | "cleanup_completed" | "calendar_default";
}) {
  const [activeRange, setActiveRange] = useState<RangeKey>("lastMonth");
  const [drillLine, setDrillLine] = useState<{
    label: string;
    account_id: string;
    amount: number;
  } | null>(null);

  const pl = data[activeRange];
  const range = ranges[activeRange];
  const isThisMonth = activeRange === "thisMonth";
  const c: PortalPl | null = pl ? classifyProfitLoss(pl) : null;
  const periodLabel = `${range.label} · ${formatDate(range.start)} → ${formatDate(range.end)}`;

  return (
    <div className="space-y-6">
      {/* ── Gradient hero ───────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy to-teal-dark px-6 py-6 text-white">
        <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full bg-teal/20 blur-2xl" />
        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-xs text-white/60 uppercase tracking-wider font-semibold">Profit & Loss</div>
            <h1 className="text-3xl font-bold mt-1">How you made money</h1>
            <div className="text-sm text-white/70 mt-1">{periodLabel}</div>
          </div>
          <div className="flex bg-white/10 backdrop-blur rounded-lg p-0.5 flex-wrap self-start">
            {(["lastMonth", "thisMonth", "quarter", "ytd", "lastYear"] as RangeKey[]).map((k) => (
              <button
                key={k}
                onClick={() => setActiveRange(k)}
                className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors ${
                  activeRange === k ? "bg-white text-navy" : "text-white/75 hover:bg-white/10"
                }`}
              >
                {shortLabel(k, ranges)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* In-progress warning */}
      {isThisMonth && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 flex items-start gap-2">
          <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
          <div>
            <strong>This month is still in progress.</strong> Numbers may shift as your bookkeeper
            reconciles bank feeds and posts adjustments. For a settled picture, use{" "}
            <button onClick={() => setActiveRange("lastMonth")} className="underline font-semibold">
              {ranges.lastMonth.label}
            </button>.
          </div>
        </div>
      )}

      {!pl ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
          We couldn't load the P&L for this range. Try a different range or refresh — if it keeps
          happening, let your bookkeeper know.
        </div>
      ) : !c || c.isEmpty ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-ink-slate">
          No financial activity for this period.
        </div>
      ) : (
        <>
          {/* ── AI-style plain-English insight ──────────────────────── */}
          <InsightCard c={c} range={range} periodLabel={periodLabel} />

          {/* ── Money-flow strip ────────────────────────────────────── */}
          <FlowStrip c={c} />

          {/* ── Where each dollar goes ──────────────────────────────── */}
          <ProportionBar c={c} />

          {/* ── Detailed breakdown ──────────────────────────────────── */}
          <div className="space-y-4">
            <BucketSection
              bucket={c.income}
              accent="teal"
              periodLabel={range.label}
              onDrill={setDrillLine}
            />

            <BucketSection
              bucket={c.variableCosts}
              accent="amber"
              periodLabel={range.label}
              onDrill={setDrillLine}
              note={
                c.costSplitEstimated
                  ? "Estimated from account names — your books don't separate direct job costs from overhead yet. Your bookkeeper can set up Cost of Goods Sold for a precise gross margin."
                  : undefined
              }
              emptyNote="No direct job costs recorded for this period."
            />

            {/* Gross Profit band */}
            <ResultBand
              title="Gross Profit"
              subtitle={
                c.costSplitEstimated
                  ? "Income minus variable job costs (estimated)"
                  : "Income minus the direct cost of doing the work"
              }
              amount={c.grossProfit}
              marginPct={c.grossMarginPct}
              marginNoun="gross margin"
              tone={c.grossProfit >= 0 ? "emerald" : "red"}
            />

            <BucketSection
              bucket={c.fixedExpenses}
              accent="orange"
              periodLabel={range.label}
              onDrill={setDrillLine}
              emptyNote="No overhead expenses recorded for this period."
            />

            {c.otherIncome && (
              <BucketSection bucket={c.otherIncome} accent="teal" periodLabel={range.label} onDrill={setDrillLine} />
            )}
            {c.otherExpense && (
              <BucketSection bucket={c.otherExpense} accent="orange" periodLabel={range.label} onDrill={setDrillLine} />
            )}

            {/* Net Profit band — the bottom line */}
            <ResultBand
              title="Net Profit (what's left)"
              subtitle="After every cost and overhead expense — this is what's truly yours"
              amount={c.netProfit}
              marginPct={c.netMarginPct}
              marginNoun="net margin"
              tone={c.netProfit >= 0 ? "emerald" : "red"}
              emphasize
            />
          </div>
        </>
      )}

      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-ink-slate">
        <strong className="text-navy">Tip:</strong> Click any line to see the underlying transactions —
        vendor, date, amount, memo. Use the{" "}
        <span className="inline-flex items-center"><Sparkles size={11} className="text-teal-dark" /></span>{" "}
        question icon on any line to ask your Ironbooks team about how it's categorized, or{" "}
        <a href="/portal/ask-ai" className="text-teal-dark font-semibold underline">ask the AI</a>{" "}
        for an instant explanation.
      </div>

      {drillLine && (
        <DrillDownDrawer line={drillLine} range={range} onClose={() => setDrillLine(null)} />
      )}
    </div>
  );
}

// ─── INSIGHT CARD ─────────────────────────────────────────────────────────

function InsightCard({ c, range, periodLabel }: { c: PortalPl; range: { label: string }; periodLabel: string }) {
  const gm = marginVerdict(c.grossMarginPct);
  const nm = marginVerdict(c.netMarginPct);
  return (
    <div className="relative overflow-hidden rounded-2xl border-2 border-teal/30 bg-gradient-to-br from-teal/10 via-white to-white p-5">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-teal/15 flex items-center justify-center flex-shrink-0">
          <Sparkles size={18} className="text-teal-dark" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-teal-dark uppercase tracking-wider">In plain English</div>
          <p className="text-sm text-navy/85 leading-relaxed mt-1">
            You brought in <strong>{fmtMoney(c.totalIncome)}</strong>. After{" "}
            <strong>{fmtMoney(c.totalVariable)}</strong> in {c.costSplitEstimated ? "estimated " : ""}
            direct job costs, your <strong>gross profit</strong> was{" "}
            <strong>{fmtMoney(c.grossProfit)}</strong> — a{" "}
            <span className={`font-semibold ${marginText(gm.tone)}`}>{Math.round(c.grossMarginPct)}% gross margin</span> ({gm.label}).
            Take out <strong>{fmtMoney(c.totalFixed)}</strong> of overhead and you're left with{" "}
            <strong className={c.netProfit >= 0 ? "text-emerald-700" : "text-red-700"}>{fmtMoney(c.netProfit)}</strong>{" "}
            in net profit — a{" "}
            <span className={`font-semibold ${marginText(nm.tone)}`}>{Math.round(c.netMarginPct)}% net margin</span>.
          </p>
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <a
              href="/portal/ask-ai"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-dark hover:underline"
            >
              <Sparkles size={12} /> Ask the AI to go deeper
            </a>
            <AskAboutButton
              kind="pl_summary"
              label={`${range.label} Profit & Loss`}
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
              variant="chip"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── MONEY-FLOW STRIP ───────────────────────────────────────────────────

function FlowStrip({ c }: { c: PortalPl }) {
  const steps = [
    { label: "Income", value: c.totalIncome, op: "", tone: "teal" as const },
    { label: c.costSplitEstimated ? "Variable costs*" : "Variable costs", value: -c.totalVariable, op: "−", tone: "amber" as const },
    { label: "Gross Profit", value: c.grossProfit, op: "=", tone: "navy" as const, strong: true },
    { label: "Fixed expenses", value: -c.totalFixed, op: "−", tone: "orange" as const },
    { label: "Net Profit", value: c.netProfit, op: "=", tone: c.netProfit >= 0 ? ("emerald" as const) : ("red" as const), strong: true },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
      {steps.map((s, i) => (
        <div
          key={s.label}
          className={`relative rounded-xl border p-3 ${flowTileClass(s.tone)} ${s.strong ? "ring-1 ring-inset ring-current/10" : ""}`}
        >
          {s.op && (
            <div className="absolute -left-2 top-1/2 -translate-y-1/2 hidden md:flex w-4 h-4 items-center justify-center text-ink-light text-sm font-bold bg-[#FAFAF7] rounded-full">
              {s.op}
            </div>
          )}
          <div className="text-[10px] uppercase tracking-wider font-semibold opacity-70">{s.label}</div>
          <div className={`text-lg font-bold mt-0.5 ${flowValueClass(s.tone)}`}>
            {s.value < 0 ? `(${fmtMoney(Math.abs(s.value))})` : fmtMoney(s.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── PROPORTION BAR (where each income dollar goes) ────────────────────────

function ProportionBar({ c }: { c: PortalPl }) {
  if (c.totalIncome <= 0) return null;
  const varPct = Math.max(0, Math.min(100, (c.totalVariable / c.totalIncome) * 100));
  const fixedPct = Math.max(0, Math.min(100, (c.totalFixed / c.totalIncome) * 100));
  const netPct = Math.max(0, 100 - varPct - fixedPct);
  const loss = c.netProfit < 0;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold text-navy">Where each $1 of income goes</h3>
        <span className="text-xs text-ink-light">per dollar earned</span>
      </div>
      <div className="flex h-6 rounded-full overflow-hidden bg-slate-100">
        {varPct > 0 && <div className="bg-amber-400 h-full" style={{ width: `${varPct}%` }} title={`Variable costs ${Math.round(varPct)}¢`} />}
        {fixedPct > 0 && <div className="bg-orange-500 h-full" style={{ width: `${fixedPct}%` }} title={`Fixed expenses ${Math.round(fixedPct)}¢`} />}
        {!loss && netPct > 0 && <div className="bg-emerald-500 h-full" style={{ width: `${netPct}%` }} title={`Net profit ${Math.round(netPct)}¢`} />}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-xs">
        <Legend color="bg-amber-400" label="Variable costs" value={`${Math.round(varPct)}¢`} />
        <Legend color="bg-orange-500" label="Fixed expenses" value={`${Math.round(fixedPct)}¢`} />
        <Legend
          color={loss ? "bg-red-500" : "bg-emerald-500"}
          label={loss ? "Loss" : "Net profit"}
          value={loss ? `(${Math.round(Math.abs(c.netMarginPct))}¢)` : `${Math.round(netPct)}¢`}
        />
      </div>
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

// ─── BUCKET SECTION ─────────────────────────────────────────────────────

function BucketSection({
  bucket,
  accent,
  periodLabel,
  onDrill,
  note,
  emptyNote,
}: {
  bucket: PlBucket;
  accent: "teal" | "amber" | "orange";
  periodLabel: string;
  onDrill: (l: { label: string; account_id: string; amount: number }) => void;
  note?: string;
  emptyNote?: string;
}) {
  const [open, setOpen] = useState(true);
  const accentBar = { teal: "bg-teal", amber: "bg-amber-400", orange: "bg-orange-500" }[accent];
  const kind = bucket.key === "income" || bucket.key === "otherIncome" ? "pl_line" : "pl_line";

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-50/60 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className={`w-1.5 h-8 rounded-full ${accentBar} flex-shrink-0`} />
          <ChevronDown size={15} className={`text-ink-slate transition-transform ${open ? "" : "-rotate-90"}`} />
          <div className="text-left min-w-0">
            <div className="font-bold text-navy truncate">{bucket.label}</div>
            <div className="text-[11px] text-ink-light">
              {bucket.lines.length} {bucket.lines.length === 1 ? "line" : "lines"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-5 flex-shrink-0">
          <div className="text-lg font-bold text-navy">{fmtMoney(bucket.total)}</div>
          <div className="text-xs font-semibold text-ink-slate w-12 text-right">
            {bucket.pctOfIncome > 0 ? `${Math.round(bucket.pctOfIncome)}%` : "—"}
          </div>
        </div>
      </button>

      {open && (
        <div className="px-5 pb-4">
          {note && (
            <div className="mb-3 flex items-start gap-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <Info size={12} className="mt-0.5 flex-shrink-0" />
              <span>{note}</span>
            </div>
          )}
          {bucket.lines.length === 0 ? (
            <div className="text-xs text-ink-light italic py-2">{emptyNote || "No items."}</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {bucket.lines.map((l, i) => {
                const drillable = !!l.account_id;
                return (
                  <div key={i} className="flex items-center justify-between gap-2 py-1.5 group">
                    <button
                      type="button"
                      onClick={drillable ? () => onDrill({ label: l.label, account_id: l.account_id!, amount: l.amount }) : undefined}
                      disabled={!drillable}
                      className={`flex items-center gap-1 text-sm text-left min-w-0 ${
                        drillable ? "cursor-pointer hover:text-teal-dark" : "cursor-default"
                      }`}
                    >
                      {drillable && <ChevronRight size={11} className="text-ink-light group-hover:text-teal-dark flex-shrink-0" />}
                      <span className="text-ink-slate truncate">{l.label}</span>
                    </button>
                    <div className="flex items-center gap-4 flex-shrink-0">
                      <span className="font-mono text-sm text-navy w-24 text-right">{fmtMoney(l.amount)}</span>
                      <span className="text-xs text-ink-light w-10 text-right font-mono hidden sm:block">
                        {l.pctOfIncome >= 0.5 ? `${l.pctOfIncome.toFixed(1)}%` : "—"}
                      </span>
                      <AskAboutButton
                        kind={kind}
                        label={l.label}
                        amount={l.amount}
                        period={periodLabel}
                        context={{ section: bucket.label, account_id: l.account_id, pct_of_income: Math.round(l.pctOfIncome * 10) / 10 }}
                        variant="icon"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── RESULT BAND (Gross Profit / Net Profit) ──────────────────────────────

function ResultBand({
  title,
  subtitle,
  amount,
  marginPct,
  marginNoun,
  tone,
  emphasize,
}: {
  title: string;
  subtitle: string;
  amount: number;
  marginPct: number;
  marginNoun: string;
  tone: "emerald" | "red";
  emphasize?: boolean;
}) {
  const grad = emphasize
    ? tone === "emerald"
      ? "from-emerald-600 to-teal-dark text-white"
      : "from-red-600 to-red-700 text-white"
    : tone === "emerald"
    ? "from-emerald-50 to-white text-navy border border-emerald-200"
    : "from-red-50 to-white text-navy border border-red-200";
  const amountColor = emphasize ? "text-white" : tone === "emerald" ? "text-emerald-700" : "text-red-700";
  const subColor = emphasize ? "text-white/80" : "text-ink-slate";

  return (
    <div className={`rounded-2xl bg-gradient-to-r ${grad} px-6 py-5`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {tone === "emerald" ? <TrendingUp size={16} className={emphasize ? "text-white" : "text-emerald-700"} /> : <TrendingDown size={16} className={emphasize ? "text-white" : "text-red-700"} />}
            <div className={`font-bold ${emphasize ? "text-white text-lg" : "text-navy"}`}>{title}</div>
          </div>
          <div className={`text-xs mt-0.5 ${subColor}`}>{subtitle}</div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className={`font-bold ${emphasize ? "text-3xl" : "text-2xl"} ${amountColor}`}>{fmtMoney(amount)}</div>
          <div className={`text-xs ${subColor}`}>{Math.round(marginPct)}% {marginNoun}</div>
        </div>
      </div>
    </div>
  );
}

// ─── HELPERS ────────────────────────────────────────────────────────────

function shortLabel(key: RangeKey, ranges: Record<RangeKey, { label: string }>): string {
  if (key === "lastMonth") return "Last month";
  return ranges[key].label;
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return sign + abs.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function flowTileClass(tone: "teal" | "amber" | "orange" | "navy" | "emerald" | "red"): string {
  return {
    teal: "border-teal/30 bg-teal/5",
    amber: "border-amber-200 bg-amber-50",
    orange: "border-orange-200 bg-orange-50",
    navy: "border-slate-300 bg-slate-50",
    emerald: "border-emerald-200 bg-emerald-50",
    red: "border-red-200 bg-red-50",
  }[tone];
}

function flowValueClass(tone: "teal" | "amber" | "orange" | "navy" | "emerald" | "red"): string {
  return {
    teal: "text-teal-dark",
    amber: "text-amber-700",
    orange: "text-orange-700",
    navy: "text-navy",
    emerald: "text-emerald-700",
    red: "text-red-700",
  }[tone];
}

function marginText(tone: "emerald" | "teal" | "amber" | "red"): string {
  return {
    emerald: "text-emerald-700",
    teal: "text-teal-dark",
    amber: "text-amber-700",
    red: "text-red-700",
  }[tone];
}

// ─── DRILL-DOWN DRAWER ──────────────────────────────────────────────────

interface Transaction {
  txn_id: string;
  txn_type: string;
  date: string;
  doc_number: string | null;
  name: string | null;
  memo: string;
  amount: number;
  running_balance: number | null;
}

function DrillDownDrawer({
  line,
  range,
  onClose,
}: {
  line: { label: string; account_id: string; amount: number };
  range: { label: string; start: string; end: string };
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [totalAmount, setTotalAmount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [flagTxn, setFlagTxn] = useState<Transaction | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/portal/account-transactions?account_id=${encodeURIComponent(line.account_id)}&start=${range.start}&end=${range.end}`
        );
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (cancelled) return;
        setTransactions(body.transactions || []);
        setTruncated(!!body.truncated);
        setTotalCount(body.total_count || 0);
        setTotalAmount(body.total_amount || 0);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || "Couldn't load transactions");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [line.account_id, range.start, range.end]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-navy/40 backdrop-blur-sm" />
      <div
        className="w-full max-w-2xl bg-white shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between bg-gradient-to-r from-teal/5 to-white">
          <div className="min-w-0">
            <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">
              Transactions in
            </div>
            <h3 className="font-bold text-navy text-lg">{line.label}</h3>
            <div className="text-xs text-ink-slate mt-0.5">
              {range.label} · P&L total: <strong className="text-navy">{fmtMoney(line.amount)}</strong>
              {totalCount > 0 && (
                <span className="text-ink-light"> · {totalCount} transaction{totalCount === 1 ? "" : "s"}</span>
              )}
            </div>
            {!loading && totalCount > 0 && Math.abs(totalAmount - line.amount) > 1 && !truncated && (
              <div className="text-[11px] text-amber-700 mt-1 flex items-center gap-1">
                <AlertTriangle size={11} />
                Transactions sum to {fmtMoney(totalAmount)} — differs from P&L total by{" "}
                {fmtMoney(line.amount - totalAmount)}. Ask your bookkeeper if this looks wrong.
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy flex-shrink-0">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-8 text-center text-ink-slate text-sm">
              <Loader2 size={20} className="animate-spin mx-auto mb-2 text-teal-dark" />
              Loading transactions…
            </div>
          ) : error ? (
            <div className="m-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
              {error}
            </div>
          ) : transactions.length === 0 ? (
            <div className="p-8 text-center text-sm text-ink-slate">
              No transactions found for this period. The total may include adjustments
              or carry-overs not shown as discrete transactions.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-ink-slate sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Date</th>
                  <th className="text-left px-4 py-2 font-semibold">Type / #</th>
                  <th className="text-left px-4 py-2 font-semibold">Payee / Customer</th>
                  <th className="text-right px-4 py-2 font-semibold">Amount</th>
                  <th className="text-right px-4 py-2 font-semibold w-16">Ask / Flag</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transactions.map((t, i) => (
                  <tr key={`${t.txn_id || i}`} className="hover:bg-slate-50">
                    <td className="px-4 py-2 text-xs text-ink-slate whitespace-nowrap">{t.date}</td>
                    <td className="px-4 py-2 text-xs">
                      <div className="text-navy font-medium">{t.txn_type || "—"}</div>
                      {t.doc_number && <div className="text-ink-light text-[11px]">#{t.doc_number}</div>}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <div className="text-navy">{t.name || <span className="text-ink-light italic">—</span>}</div>
                      {t.memo && (
                        <div className="text-ink-light text-[11px] truncate max-w-xs" title={t.memo}>{t.memo}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-navy whitespace-nowrap">{fmtMoney(t.amount)}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-0.5">
                        <AskAboutButton
                          kind="transaction"
                          label={`${t.txn_type || "Transaction"}${t.name ? ` — ${t.name}` : ""}`}
                          amount={t.amount}
                          period={range.label}
                          context={{
                            account: line.label,
                            account_id: line.account_id,
                            date: t.date,
                            doc_number: t.doc_number,
                            vendor_or_customer: t.name,
                            memo: t.memo,
                          }}
                          variant="icon"
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); setFlagTxn(t); }}
                          title="Flag this transaction for your bookkeeper to review"
                          className="text-ink-light hover:text-amber-600 transition-colors p-1 rounded hover:bg-amber-50"
                        >
                          <Flag size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {truncated && (
            <div className="px-4 py-3 bg-amber-50 border-t border-amber-200 text-xs text-amber-900">
              Showing the most recent 500 transactions. {totalCount - 500} more not shown —
              ask your bookkeeper for a full export if you need them.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50">
          <div className="text-[11px] text-ink-light">
            Want this line explained?{" "}
            <a href="/portal/ask-ai" className="text-teal-dark font-semibold underline">Ask the AI</a>{" "}
            or use the question icon to reach your Ironbooks bookkeeper.
          </div>
        </div>
      </div>

      {flagTxn && (
        <FlagTransactionModal
          transaction={flagTxn}
          accountId={line.account_id}
          accountLabel={line.label}
          range={range}
          onClose={() => setFlagTxn(null)}
        />
      )}
    </div>
  );
}

// ─── FLAG TRANSACTION MODAL ─────────────────────────────────────────────

function FlagTransactionModal({
  transaction,
  accountId,
  accountLabel,
  range,
  onClose,
}: {
  transaction: Transaction;
  accountId: string;
  accountLabel: string;
  range: { label: string; start: string; end: string };
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = note.trim();
    if (!trimmed) {
      setError("Please add a quick note so your bookkeeper knows what to look at.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/transaction-flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qbo_txn_id: transaction.txn_id || null,
          qbo_txn_type: transaction.txn_type || null,
          qbo_account_id: accountId,
          account_label: accountLabel,
          txn_date: transaction.date || null,
          txn_amount: transaction.amount,
          txn_doc_number: transaction.doc_number,
          txn_vendor_or_customer: transaction.name,
          txn_memo: transaction.memo,
          period_label: range.label,
          period_start: range.start,
          period_end: range.end,
          client_note: trimmed,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSubmitted(true);
    } catch (e: any) {
      setError(e?.message || "Couldn't send the flag — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-navy/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-lg w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Flag size={16} className="text-amber-600" />
            <h3 className="font-bold text-navy">Flag this transaction</h3>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy"><X size={20} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {submitted ? (
            <>
              <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                <CheckCircle2 size={18} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-emerald-900">
                  <strong className="block">Sent to your bookkeeper.</strong>
                  <span className="text-xs">They'll review the transaction and reply.</span>
                </div>
              </div>
              <button onClick={onClose} className="w-full px-4 py-2 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark">Done</button>
            </>
          ) : (
            <>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-slate mb-1">You're flagging</div>
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="font-semibold text-navy">
                      {transaction.txn_type || "Transaction"}
                      {transaction.doc_number && <span className="text-ink-light"> #{transaction.doc_number}</span>}
                    </div>
                    <div className="text-ink-slate truncate">{transaction.date} · {transaction.name || "—"}</div>
                    {transaction.memo && <div className="text-ink-light italic truncate" title={transaction.memo}>{transaction.memo}</div>}
                  </div>
                  <div className="text-right flex-shrink-0 ml-2">
                    <div className="font-mono font-semibold text-navy">{fmtMoney(transaction.amount)}</div>
                    <div className="text-[10px] text-ink-light">{accountLabel}</div>
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider">
                  What looks wrong? <span className="text-red-700">*</span>
                </label>
                <textarea
                  value={note}
                  onChange={(e) => { setNote(e.target.value); if (error) setError(null); }}
                  placeholder="e.g. This was for the Hudson job, not general overhead. Or: I don't recognize this vendor — can you check?"
                  maxLength={1500}
                  rows={4}
                  className="mt-1 w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:border-teal/50 focus:outline-none"
                />
                <div className="text-[11px] text-ink-light mt-1 flex items-center justify-between">
                  <span>Your bookkeeper sees this exact note + the transaction details.</span>
                  <span>{note.length} / 1500</span>
                </div>
              </div>

              {error && <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{error}</div>}

              <div className="flex items-center gap-2 justify-end">
                <button onClick={onClose} disabled={submitting} className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-semibold text-ink-slate hover:bg-slate-50 disabled:opacity-50">Cancel</button>
                <button
                  onClick={submit}
                  disabled={submitting || !note.trim()}
                  className="px-4 py-1.5 bg-amber-500 text-white rounded-lg text-sm font-semibold hover:bg-amber-600 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {submitting ? <Loader2 size={12} className="animate-spin" /> : <Flag size={12} />}
                  {submitting ? "Sending…" : "Send to bookkeeper"}
                </button>
              </div>
              <div className="text-[11px] text-ink-light">Nothing changes in QuickBooks. Your bookkeeper reviews and decides what to do.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
