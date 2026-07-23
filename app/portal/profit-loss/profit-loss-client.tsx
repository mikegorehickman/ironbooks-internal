"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown, AlertTriangle, X, Loader2, ChevronRight, Flag, CheckCircle2,
  Sparkles, ArrowDown, TrendingUp, TrendingDown, CalendarRange, Tag, Search,
  MessageCircleQuestion,
} from "lucide-react";
import type { ProfitLossData } from "@/lib/qbo-reports";
import { classifyProfitLoss, marginVerdict, netMarginVerdict, type PortalPl } from "@/lib/portal-pl";
import { buildPLHierarchy, type PLHierSection, type PLHierRow, type PLAccountLite } from "@/lib/pl-hierarchy";
import { AskAboutButton } from "../ask-about";

/** The five ranges the server pre-fetches. */
type FixedRangeKey = "lastMonth" | "thisMonth" | "quarter" | "ytd" | "lastYear";
/** Plus a client-side "custom" range fetched on demand. */
type RangeKey = FixedRangeKey | "custom";

/**
 * Portal P&L — restructured into the four numbers a contractor lives by:
 *   Income → (−) Cost of Goods Sold (COGS) → (=) Gross Profit → (−) Operating expenses
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
  accounts = [],
  closedSource,
}: {
  ranges: Record<FixedRangeKey, { label: string; start: string; end: string }>;
  data: Record<FixedRangeKey, ProfitLossData | null>;
  /** Chart of accounts — supplies the parent/sub STRUCTURE so the statement
   *  nests accounts the way QuickBooks does. Empty → flat fallback. */
  accounts?: PLAccountLite[];
  closedSource: "reclass_job_closed" | "cleanup_completed" | "calendar_default" | "monthly_close_sent";
}) {
  const [activeRange, setActiveRange] = useState<RangeKey>("lastMonth");
  // Show accounts that net to zero for the period (off by default — QBO's
  // "collapse rows with no balance"). Toggle mirrors the internal profile P&L.
  const [showZeros, setShowZeros] = useState(false);
  const [drillLine, setDrillLine] = useState<{
    label: string;
    account_id: string;
    amount: number;
  } | null>(null);
  // Reclass request modal — used by both the account-level "tag" buttons in
  // each BucketSection row AND the per-transaction button in the drill-down
  // drawer. The modal is rendered once at this top level so it overlays both.
  const [reclassTarget, setReclassTarget] = useState<ReclassTarget | null>(null);

  // Custom range — fetched on demand from /api/portal/profit-loss.
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [customData, setCustomData] = useState<ProfitLossData | null>(null);
  const [customRange, setCustomRange] = useState<{ start: string; end: string } | null>(null);
  const [customLoading, setCustomLoading] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

  const isCustom = activeRange === "custom";
  const isThisMonth = activeRange === "thisMonth";

  const pl: ProfitLossData | null = isCustom ? customData : data[activeRange as FixedRangeKey];
  const range: { label: string; start: string; end: string } | null = isCustom
    ? customRange
      ? { label: "Custom range", start: customRange.start, end: customRange.end }
      : null
    : ranges[activeRange as FixedRangeKey];
  const c: PortalPl | null = pl ? classifyProfitLoss(pl) : null;
  // QBO-mirroring parent/sub hierarchy for the detailed breakdown.
  const hier = pl ? buildPLHierarchy((pl.lineItems || []) as any, accounts, { showZeros }) : null;
  const periodLabel = range
    ? `${range.label} · ${formatDate(range.start)} → ${formatDate(range.end)}`
    : "Custom range — pick dates below";

  async function applyCustom() {
    if (!customStart || !customEnd) {
      setCustomError("Pick both a start and end date.");
      return;
    }
    if (customStart > customEnd) {
      setCustomError("Start date must be on or before the end date.");
      return;
    }
    setCustomLoading(true);
    setCustomError(null);
    try {
      const res = await fetch(
        `/api/portal/profit-loss?start=${customStart}&end=${customEnd}`
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setCustomData(body.profit_loss ?? null);
      setCustomRange({ start: customStart, end: customEnd });
    } catch (e: any) {
      setCustomError(e?.message || "Couldn't load that range.");
      setCustomData(null);
      setCustomRange(null);
    } finally {
      setCustomLoading(false);
    }
  }

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
            {(["lastMonth", "thisMonth", "quarter", "ytd", "lastYear", "custom"] as RangeKey[]).map((k) => (
              <button
                key={k}
                onClick={() => setActiveRange(k)}
                className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors inline-flex items-center gap-1 ${
                  activeRange === k ? "bg-white text-navy" : "text-white/75 hover:bg-white/10"
                }`}
              >
                {k === "custom" && <CalendarRange size={12} />}
                {shortLabel(k, ranges)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Notice to Reader — cash-basis framing so clients read the numbers right */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-ink-slate leading-relaxed">
        <span className="font-semibold text-navy">Notice to Reader:</span> These figures are prepared on a
        cash basis from your QuickBooks data — they don&apos;t reflect accounts receivable, accounts payable,
        or your full cash-flow cycle, and haven&apos;t been audited or reviewed. For a true read on your
        business, look at trends over at least a 90-day period rather than any single month.
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

      {/* Custom range picker */}
      {isCustom && (
        <CustomRangePicker
          start={customStart}
          end={customEnd}
          onStart={setCustomStart}
          onEnd={setCustomEnd}
          onApply={applyCustom}
          loading={customLoading}
          error={customError}
          applied={customRange}
        />
      )}

      {isCustom && customLoading ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-ink-slate">
          <Loader2 size={20} className="animate-spin mx-auto mb-2 text-teal-dark" />
          Pulling your P&L for that range…
        </div>
      ) : isCustom && !customData ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-8 text-center text-sm text-ink-slate">
          Pick a start and end date above, then hit <strong>Run</strong> to see your P&amp;L for any
          period.
        </div>
      ) : !pl || !range ? (
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

          {/* ── Detailed breakdown — mirrors your QuickBooks P&L ─────── */}
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 px-1">
              <div className="text-xs text-ink-light">
                Laid out the way it appears in QuickBooks — parent accounts with their sub-accounts.
              </div>
              <button
                type="button"
                onClick={() => setShowZeros((z) => !z)}
                className="text-xs font-semibold text-teal-dark hover:underline whitespace-nowrap flex-shrink-0"
              >
                {showZeros ? "Hide $0 accounts" : "Show $0 accounts"}
              </button>
            </div>

            {(() => {
              const secs = hier?.sections || [];
              const sec = (k: PLHierSection["key"]) => secs.find((s) => s.key === k) || null;
              const income = sec("income");
              const cogs = sec("cogs");
              const expenses = sec("expenses");
              const otherIncome = sec("other_income");
              const otherExpense = sec("other_expense");
              return (
                <>
                  {income && (
                    <HierSection section={income} income={c.totalIncome} periodLabel={range.label} onDrill={setDrillLine} onReclass={(t) => setReclassTarget(t)} range={range} />
                  )}
                  {cogs && (
                    <HierSection section={cogs} income={c.totalIncome} periodLabel={range.label} onDrill={setDrillLine} onReclass={(t) => setReclassTarget(t)} range={range} />
                  )}

                  {/* Gross Profit band */}
                  <ResultBand
                    title="Gross Profit"
                    subtitle="Income minus the direct cost of doing the work"
                    amount={c.grossProfit}
                    marginPct={c.grossMarginPct}
                    marginNoun="gross margin"
                    tone={c.grossProfit >= 0 ? "emerald" : "red"}
                  />

                  {expenses && (
                    <HierSection section={expenses} income={c.totalIncome} periodLabel={range.label} onDrill={setDrillLine} onReclass={(t) => setReclassTarget(t)} range={range} />
                  )}
                  {otherIncome && (
                    <HierSection section={otherIncome} income={c.totalIncome} periodLabel={range.label} onDrill={setDrillLine} onReclass={(t) => setReclassTarget(t)} range={range} />
                  )}
                  {otherExpense && (
                    <HierSection section={otherExpense} income={c.totalIncome} periodLabel={range.label} onDrill={setDrillLine} onReclass={(t) => setReclassTarget(t)} range={range} />
                  )}
                </>
              );
            })()}

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
        vendor, date, amount, memo. Each line also has buttons to ask your Ironbooks team a question
        about it or suggest it should be in a different category. For an instant explanation,{" "}
        <a href="/portal/ask-ai" className="text-teal-dark font-semibold underline">ask the AI</a>.
      </div>

      {drillLine && range && (
        <DrillDownDrawer
          line={drillLine}
          range={range}
          onClose={() => setDrillLine(null)}
          onReclass={(target) => setReclassTarget(target)}
        />
      )}

      {reclassTarget && (
        <ReclassRequestModal
          target={reclassTarget}
          onClose={() => setReclassTarget(null)}
        />
      )}
    </div>
  );
}

// ─── INSIGHT CARD ─────────────────────────────────────────────────────────

function InsightCard({ c, range, periodLabel }: { c: PortalPl; range: { label: string }; periodLabel: string }) {
  const gm = marginVerdict(c.grossMarginPct);
  const nm = netMarginVerdict(c.netMarginPct);
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
            <strong>{fmtMoney(c.grossProfit)}</strong>, about a{" "}
            <span className={`font-semibold ${marginText(gm.tone)}`}>{Math.round(c.grossMarginPct)}% gross margin</span> ({gm.label}).{" "}
            {c.netProfit < 0 ? (
              <>
                Overhead of <strong>{fmtMoney(c.totalFixed)}</strong> then put the period{" "}
                <strong className="text-red-700">{fmtMoney(Math.abs(c.netProfit))}</strong> under breakeven, a{" "}
                <span className={`font-semibold ${marginText(nm.tone)}`}>{Math.round(c.netMarginPct)}% net margin</span>.
                A slower stretch happens in this line of work. If it keeps up, it's worth walking
                through pricing or operating expenses with your bookkeeper.
              </>
            ) : (
              <>
                After <strong>{fmtMoney(c.totalFixed)}</strong> of overhead, you kept{" "}
                <strong className="text-emerald-700">{fmtMoney(c.netProfit)}</strong> in profit, a{" "}
                <span className={`font-semibold ${marginText(nm.tone)}`}>{Math.round(c.netMarginPct)}% net margin</span> ({nm.label}).
              </>
            )}
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
    { label: c.costSplitEstimated ? "COGS*" : "COGS", value: -c.totalVariable, op: "−", tone: "amber" as const },
    { label: "Gross Profit", value: c.grossProfit, op: "=", tone: "navy" as const, strong: true },
    { label: "Operating expenses", value: -c.totalFixed, op: "−", tone: "orange" as const },
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
        {varPct > 0 && <div className="bg-amber-400 h-full" style={{ width: `${varPct}%` }} title={`COGS ${Math.round(varPct)}¢`} />}
        {fixedPct > 0 && <div className="bg-orange-500 h-full" style={{ width: `${fixedPct}%` }} title={`Operating expenses ${Math.round(fixedPct)}¢`} />}
        {!loss && netPct > 0 && <div className="bg-emerald-500 h-full" style={{ width: `${netPct}%` }} title={`Net profit ${Math.round(netPct)}¢`} />}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-xs">
        <Legend color="bg-amber-400" label="COGS" value={`${Math.round(varPct)}¢`} />
        <Legend color="bg-orange-500" label="Operating expenses" value={`${Math.round(fixedPct)}¢`} />
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

// ─── HIERARCHY SECTION (QBO-mirroring parent/sub) ─────────────────────────

const SECTION_ACCENT: Record<PLHierSection["key"], "teal" | "amber" | "orange"> = {
  income: "teal",
  cogs: "amber",
  expenses: "orange",
  other_income: "teal",
  other_expense: "orange",
};

/**
 * One P&L section (Income / COGS / Operating Expenses / …) rendered the way
 * QuickBooks lays it out: parent accounts with their sub-accounts nested and a
 * "Total <parent>" line. Structure comes from the chart of accounts (via
 * buildPLHierarchy); leaf rows keep the portal's drill-down, "ask", and
 * "suggest a category" affordances so nothing regresses from the old buckets.
 */
function HierSection({
  section,
  income,
  periodLabel,
  onDrill,
  onReclass,
  range,
}: {
  section: PLHierSection;
  income: number;
  periodLabel: string;
  onDrill: (l: { label: string; account_id: string; amount: number }) => void;
  onReclass: (t: ReclassTarget) => void;
  range: { label: string; start: string; end: string };
}) {
  const [open, setOpen] = useState(true);
  const accentBar = { teal: "bg-teal", amber: "bg-amber-400", orange: "bg-orange-500" }[SECTION_ACCENT[section.key]];
  const leafCount = section.rows.filter((r) => !r.isTotalRow && !r.hasChildren).length;
  const sectionPct = income > 0 ? (Math.abs(section.total) / income) * 100 : 0;

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
            <div className="font-bold text-navy truncate">{section.title}</div>
            <div className="text-[11px] text-ink-light">
              {leafCount} {leafCount === 1 ? "account" : "accounts"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4 flex-shrink-0">
          <span className="font-mono text-sm font-bold text-navy">{fmtMoney(section.total)}</span>
          <span className="text-xs font-semibold text-teal-dark w-10 text-right">
            {sectionPct >= 0.5 ? `${Math.round(sectionPct)}%` : "—"}
          </span>
        </div>
      </button>

      {open && (
        <div className="px-5 pb-4">
          {section.rows.length === 0 ? (
            <div className="text-xs text-ink-light italic py-2">No accounts with a balance.</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {section.rows.map((r, i) => renderRow(r, i))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  function renderRow(r: PLHierRow, i: number) {
    const isParentHeader = r.hasChildren && !r.isTotalRow;
    const drillable = !r.isTotalRow && !r.hasChildren && !!r.accountId;
    const pad = { paddingLeft: r.depth * 18 };
    const rowPct = income > 0 ? (Math.abs(r.total) / income) * 100 : 0;

    // Parent header — name only; its amount lives on the "Total …" row (QBO).
    if (isParentHeader) {
      return (
        <div key={`${r.accountId || r.name}-${i}`} className="flex items-center gap-2 py-1.5" style={pad}>
          <span className="text-sm font-bold text-navy truncate">{r.name}</span>
        </div>
      );
    }

    // "Total <parent>" subtotal row.
    if (r.isTotalRow) {
      return (
        <div key={`${r.accountId || r.name}-${i}`} className="flex items-center justify-between gap-2 py-1.5 bg-slate-50/40" style={pad}>
          <span className="text-sm font-semibold text-ink-slate truncate">{r.name}</span>
          <div className="flex items-center gap-4 flex-shrink-0">
            <span className="font-mono text-sm font-semibold text-navy w-24 text-right">{fmtMoney(r.total)}</span>
            <span className="text-xs text-teal w-10 text-right font-mono hidden sm:block">
              {rowPct >= 0.5 ? `${rowPct.toFixed(1)}%` : "—"}
            </span>
            <span className="w-[26px]" aria-hidden />
            <span className="w-[21px] hidden sm:block" aria-hidden />
          </div>
        </div>
      );
    }

    // Leaf account row — full affordances.
    return (
      <div key={`${r.accountId || r.name}-${i}`} className="flex items-center justify-between gap-2 py-1.5 group" style={pad}>
        <button
          type="button"
          onClick={drillable ? () => onDrill({ label: r.name, account_id: r.accountId!, amount: r.total }) : undefined}
          disabled={!drillable}
          className={`flex items-center gap-1 text-sm text-left min-w-0 ${
            drillable ? "cursor-pointer hover:text-teal-dark" : "cursor-default"
          }`}
        >
          {drillable && <ChevronRight size={11} className="text-ink-light group-hover:text-teal-dark flex-shrink-0" />}
          <span className="text-ink-slate truncate">{r.name}</span>
        </button>
        <div className="flex items-center gap-4 flex-shrink-0">
          <span className="font-mono text-sm text-navy w-24 text-right">{fmtMoney(r.total)}</span>
          <span className="text-xs text-teal w-10 text-right font-mono hidden sm:block">
            {rowPct >= 0.5 ? `${rowPct.toFixed(1)}%` : "—"}
          </span>
          <AskAboutButton
            kind="pl_line"
            label={r.name}
            amount={r.total}
            period={periodLabel}
            context={{ section: section.title, account_id: r.accountId, pct_of_income: Math.round(rowPct * 10) / 10 }}
            variant="icon"
          />
          {drillable && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReclass({
                  source_account_qbo_id: r.accountId!,
                  source_account_name: r.name,
                  period_label: range.label,
                  period_start: range.start,
                  period_end: range.end,
                });
              }}
              title="Suggest a different category for this line"
              className="text-ink-light hover:text-teal-dark transition-colors p-1 rounded hover:bg-teal-light"
            >
              <Tag size={13} />
            </button>
          )}
        </div>
      </div>
    );
  }
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

function shortLabel(key: RangeKey, ranges: Record<FixedRangeKey, { label: string }>): string {
  if (key === "lastMonth") return "Last month";
  if (key === "custom") return "Custom";
  return ranges[key].label;
}

// ─── CUSTOM RANGE PICKER ──────────────────────────────────────────────────

function CustomRangePicker({
  start,
  end,
  onStart,
  onEnd,
  onApply,
  loading,
  error,
  applied,
}: {
  start: string;
  end: string;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
  onApply: () => void;
  loading: boolean;
  error: string | null;
  applied: { start: string; end: string } | null;
}) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <CalendarRange size={16} className="text-teal-dark" />
        <h3 className="text-sm font-bold text-navy">Custom date range</h3>
        {applied && (
          <span className="text-xs text-ink-light">
            Showing {formatDate(applied.start)} → {formatDate(applied.end)}
          </span>
        )}
      </div>
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <label className="text-xs font-semibold text-ink-slate">
          <span className="block uppercase tracking-wider mb-1">From</span>
          <input
            type="date"
            value={start}
            max={end || today}
            onChange={(e) => onStart(e.target.value)}
            className="w-full sm:w-44 px-3 py-2 text-sm border border-slate-200 rounded-lg text-navy focus:border-teal/50 focus:outline-none"
          />
        </label>
        <label className="text-xs font-semibold text-ink-slate">
          <span className="block uppercase tracking-wider mb-1">To</span>
          <input
            type="date"
            value={end}
            min={start || undefined}
            max={today}
            onChange={(e) => onEnd(e.target.value)}
            className="w-full sm:w-44 px-3 py-2 text-sm border border-slate-200 rounded-lg text-navy focus:border-teal/50 focus:outline-none"
          />
        </label>
        <button
          onClick={onApply}
          disabled={loading || !start || !end}
          className="px-4 py-2 bg-teal-lighter-dark text-white rounded-lg text-sm font-semibold hover:from-teal-dark hover:to-teal-dark disabled:opacity-50 inline-flex items-center gap-1.5 flex-shrink-0 transition-all"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <CalendarRange size={13} />}
          {loading ? "Loading…" : "Run"}
        </button>
      </div>
      {error && (
        <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800 flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}
      <div className="mt-3 text-[11px] text-ink-light">
        Custom ranges pull live from QuickBooks — they may include in-progress months that aren't
        fully reconciled yet.
      </div>
    </div>
  );
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
  onReclass,
}: {
  line: { label: string; account_id: string; amount: number };
  range: { label: string; start: string; end: string };
  onClose: () => void;
  onReclass: (t: ReclassTarget) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [totalAmount, setTotalAmount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [flagTxn, setFlagTxn] = useState<Transaction | null>(null);
  const [nameFilter, setNameFilter] = useState("");

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

  // Filter the loaded transactions by payee/vendor name. Lets a client click
  // into e.g. "Subcontractors" and type a name to see the total paid to that
  // specific person. Matches case-insensitively on substring.
  const nameQuery = nameFilter.trim().toLowerCase();
  const filtered = nameQuery
    ? transactions.filter((t) => (t.name || "").toLowerCase().includes(nameQuery))
    : transactions;
  const filteredTotal = filtered.reduce((s, t) => s + (t.amount || 0), 0);

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

        {/* Payee / vendor filter — "total paid to a specific person" */}
        {!loading && !error && transactions.length > 0 && (
          <div className="px-5 py-2.5 border-b border-slate-100 bg-white flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-light" />
              <input
                value={nameFilter}
                onChange={(e) => setNameFilter(e.target.value)}
                placeholder="Filter by payee / vendor name…"
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg outline-none focus:border-teal text-navy"
              />
              {nameFilter && (
                <button
                  onClick={() => setNameFilter("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-light hover:text-navy"
                  aria-label="Clear filter"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            {nameQuery && (
              <div className="text-xs text-navy whitespace-nowrap">
                <strong>{filtered.length}</strong> match{filtered.length === 1 ? "" : "es"} ·{" "}
                <strong className="text-teal-dark">{fmtMoney(filteredTotal)}</strong>
                <span className="text-ink-light"> total to “{nameFilter.trim()}”</span>
              </div>
            )}
          </div>
        )}

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
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-ink-slate">
              No transactions match “{nameFilter.trim()}” in this category.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-ink-slate sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Date</th>
                  <th className="text-left px-4 py-2 font-semibold">Type / #</th>
                  <th className="text-left px-4 py-2 font-semibold">Payee / Customer</th>
                  <th className="text-right px-4 py-2 font-semibold">Amount</th>
                  <th className="text-right px-4 py-2 font-semibold w-16">Ask</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((t, i) => (
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
                      <div className="flex items-center justify-end">
                        {/* One unified entry point: question, flag, and
                            optional re-categorize all live in one modal. */}
                        <button
                          onClick={(e) => { e.stopPropagation(); setFlagTxn(t); }}
                          title="Ask your bookkeeper about this transaction"
                          className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full border border-teal/30 text-teal-dark bg-white hover:bg-teal/5 transition-colors"
                        >
                          <MessageCircleQuestion size={12} />
                          Ask
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

type SuggestedAlternative = {
  account_id: string;
  account_name: string;
  fully_qualified_name: string;
  account_type: string;
  account_sub_type: string;
  reason: string;
};

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

  // AI-suggested alternative categories. When a suggestion is picked, the
  // submit path switches from /api/portal/transaction-flags (no-op flag for
  // bookkeeper triage) to /api/portal/reclass-request (full approval flow
  // with bulk reclass + bank rule). "None of these" or null = plain flag.
  const [suggestions, setSuggestions] = useState<SuggestedAlternative[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  // null = no choice yet; "none" = explicit "none of these"; otherwise = picked account_id
  const [pickedAlternative, setPickedAlternative] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setSuggestionsLoading(true);
      try {
        const res = await fetch("/api/portal/suggest-categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vendor_name: transaction.name,
            memo: transaction.memo,
            amount: transaction.amount,
            current_account_id: accountId,
            current_account_name: accountLabel,
          }),
        });
        const body = await res.json();
        if (cancelled) return;
        setSuggestions((body?.suggestions as SuggestedAlternative[]) || []);
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setSuggestionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [transaction.name, transaction.memo, transaction.amount, accountId, accountLabel]);

  async function submit() {
    const trimmed = note.trim();
    if (!trimmed) {
      setError("Please add a quick note so your bookkeeper knows what to look at.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const picked = pickedAlternative && pickedAlternative !== "none"
        ? suggestions.find((s) => s.account_id === pickedAlternative) || null
        : null;

      if (picked) {
        // Convert to a reclass request — bookkeeper can approve/decline in
        // /today, which runs the bulk reclass + creates a bank rule.
        const res = await fetch("/api/portal/reclass-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_account_qbo_id: accountId,
            source_account_name:   accountLabel,
            target_account_qbo_id: picked.account_id,
            target_account_name:   picked.fully_qualified_name,
            example_txn_id:        transaction.txn_id || null,
            example_txn_type:      transaction.txn_type || null,
            example_txn_date:      transaction.date || null,
            example_txn_amount:    transaction.amount,
            example_txn_memo:      transaction.memo || null,
            vendor_name:           transaction.name || null,
            period_label:          range.label,
            period_start:          range.start,
            period_end:            range.end,
            client_reason:         trimmed,
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      } else {
        // No category picked (or "None of these") — plain question. Goes
        // through ask-about, which lands in the manager's /today inbox
        // (client_communications mirror) + the client message thread.
        const res = await fetch("/api/portal/ask-about", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "transaction",
            label: `${transaction.txn_type || "Transaction"}${transaction.name ? ` — ${transaction.name}` : ""}`,
            amount: transaction.amount,
            period: range.label,
            question: trimmed,
            context: {
              account: accountLabel,
              account_id: accountId,
              date: transaction.date,
              doc_number: transaction.doc_number,
              vendor_or_customer: transaction.name,
              memo: transaction.memo,
            },
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      }

      setSubmitted(true);
    } catch (e: any) {
      setError(e?.message || "Couldn't send — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-navy/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-lg w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageCircleQuestion size={16} className="text-teal-dark" />
            <h3 className="font-bold text-navy">Ask about this transaction</h3>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy"><X size={20} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {submitted ? (
            <>
              <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                <CheckCircle2 size={18} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-emerald-900">
                  <strong className="block">
                    {pickedAlternative && pickedAlternative !== "none"
                      ? "Re-categorize request sent."
                      : "Sent to your bookkeeper."}
                  </strong>
                  <span className="text-xs">
                    {pickedAlternative && pickedAlternative !== "none"
                      ? "Your bookkeeper will review and (if approved) reclassify the matching transactions in QuickBooks."
                      : "It's on your bookkeeper's Today dashboard — they'll review and reply."}
                  </span>
                </div>
              </div>
              <button onClick={onClose} className="w-full px-4 py-2 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark">Done</button>
            </>
          ) : (
            <>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-slate mb-1">You're asking about</div>
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
                  Your question or note <span className="text-red-700">*</span>
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

              {/* AI suggested alternative categories. Picking one converts
                  the flag into a reclass request the bookkeeper can approve
                  with one click; "None of these" or leaving blank keeps it
                  as a plain flag for the bookkeeper to triage. */}
              {(suggestionsLoading || suggestions.length > 0) && (
                <div>
                  <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider flex items-center gap-1.5">
                    <Sparkles size={11} className="text-teal-dark" />
                    Suggested alternatives
                    <span className="text-[10px] font-normal text-ink-light normal-case">
                      (optional — pick one to turn this into a re-categorize request)
                    </span>
                  </label>
                  {suggestionsLoading ? (
                    <div className="mt-1 px-3 py-2 text-xs text-ink-slate flex items-center gap-2">
                      <Loader2 size={11} className="animate-spin" /> Looking at similar categories…
                    </div>
                  ) : (
                    <div className="mt-1 space-y-1">
                      {suggestions.map((s) => {
                        const checked = pickedAlternative === s.account_id;
                        return (
                          <label
                            key={s.account_id}
                            className={`flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                              checked
                                ? "border-teal-border bg-teal-light"
                                : "border-slate-200 hover:border-teal-border hover:bg-teal-light/30"
                            }`}
                          >
                            <input
                              type="radio"
                              name="suggested-alt"
                              checked={checked}
                              onChange={() => setPickedAlternative(s.account_id)}
                              className="mt-0.5"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-navy truncate">
                                {s.fully_qualified_name}
                              </div>
                              <div className="text-[11px] text-ink-slate mt-0.5">{s.reason}</div>
                            </div>
                          </label>
                        );
                      })}
                      <label
                        className={`flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                          pickedAlternative === "none"
                            ? "border-slate-400 bg-slate-50"
                            : "border-slate-200 hover:border-slate-300 hover:bg-slate-50/60"
                        }`}
                      >
                        <input
                          type="radio"
                          name="suggested-alt"
                          checked={pickedAlternative === "none"}
                          onChange={() => setPickedAlternative("none")}
                          className="mt-0.5"
                        />
                        <div className="text-sm text-ink-slate">
                          <strong>None of these</strong>
                          <span className="text-[11px] block text-ink-light">
                            Just flag for the bookkeeper to look at — they'll figure out the right category.
                          </span>
                        </div>
                      </label>
                    </div>
                  )}
                </div>
              )}

              {error && <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{error}</div>}

              <div className="flex items-center gap-2 justify-end">
                <button onClick={onClose} disabled={submitting} className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-semibold text-ink-slate hover:bg-slate-50 disabled:opacity-50">Cancel</button>
                <button
                  onClick={submit}
                  disabled={submitting || !note.trim()}
                  className="px-4 py-1.5 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {submitting ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : pickedAlternative && pickedAlternative !== "none" ? (
                    <Tag size={12} />
                  ) : (
                    <MessageCircleQuestion size={12} />
                  )}
                  {submitting
                    ? "Sending…"
                    : pickedAlternative && pickedAlternative !== "none"
                      ? "Request re-categorize"
                      : "Send to bookkeeper"}
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

// ─── RECLASS REQUEST MODAL ──────────────────────────────────────────────
//
// Client-side request to move a transaction (or a whole account) to a
// different category. Manager approves in /today; approval handler runs
// the bulk reclass + (optionally) creates a bank rule. This modal is just
// the request capture — it never writes to QBO.
//
// Entry points:
//   • Account-level button (Tag icon) in each P&L line row → opens with
//     only source account info, no example txn.
//   • Transaction-level button (Tag icon) in the drill-down → opens with
//     the txn pre-filled, including vendor + memo so the manager can match.

export type ReclassTarget = {
  source_account_qbo_id: string;
  source_account_name: string;
  example_txn_id?: string;
  example_txn_type?: string;
  example_txn_date?: string;
  example_txn_amount?: number;
  example_txn_memo?: string;
  vendor_name?: string;
  period_label: string;
  period_start: string;
  period_end: string;
};

type QboAccountOption = {
  id: string;
  name: string;
  fully_qualified_name: string;
  account_type: string;
  account_sub_type: string;
  classification: string;
};

function ReclassRequestModal({
  target,
  onClose,
}: {
  target: ReclassTarget;
  onClose: () => void;
}) {
  const [accounts, setAccounts] = useState<QboAccountOption[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [targetAccount, setTargetAccount] = useState<QboAccountOption | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the chart of accounts once when the modal opens. We deliberately
  // refetch rather than caching across sessions — accounts change rarely
  // but they DO change, and a stale list silently breaks bookkeeper trust.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAccountsLoading(true);
      setAccountsError(null);
      try {
        const res = await fetch("/api/portal/qbo-accounts");
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (cancelled) return;
        // Hide the source account from the picker — they shouldn't be able
        // to "move to itself" and the API would 400 anyway.
        setAccounts(
          (body.accounts as QboAccountOption[]).filter(
            (a) => a.id !== target.source_account_qbo_id
          )
        );
      } catch (e: any) {
        if (cancelled) return;
        setAccountsError(e?.message || "Couldn't load the category list");
      } finally {
        if (!cancelled) setAccountsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [target.source_account_qbo_id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Filter the picker results by search query. We match against the
  // fully-qualified name so the user can type "Marketing" and find
  // "Expenses:Marketing & Advertising:EDDM" the same way.
  const filteredAccounts = (() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts.slice(0, 12);
    return accounts
      .filter((a) => a.fully_qualified_name.toLowerCase().includes(q))
      .slice(0, 20);
  })();

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Please explain why this should change — your bookkeeper needs context to approve it.");
      return;
    }
    if (!targetAccount) {
      setError("Pick the category this should be moved to.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/reclass-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_account_qbo_id: target.source_account_qbo_id,
          source_account_name:   target.source_account_name,
          target_account_qbo_id: targetAccount.id,
          target_account_name:   targetAccount.fully_qualified_name,
          example_txn_id:        target.example_txn_id || null,
          example_txn_type:      target.example_txn_type || null,
          example_txn_date:      target.example_txn_date || null,
          example_txn_amount:    target.example_txn_amount ?? null,
          example_txn_memo:      target.example_txn_memo || null,
          vendor_name:           target.vendor_name || null,
          period_label:          target.period_label,
          period_start:          target.period_start,
          period_end:            target.period_end,
          client_reason:         trimmed,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSubmitted(true);
    } catch (e: any) {
      setError(e?.message || "Couldn't submit the request — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const isTxnLevel = !!target.example_txn_id;

  return (
    <div className="fixed inset-0 z-[70] bg-navy/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-lg w-full shadow-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Tag size={16} className="text-teal-dark" />
            <h3 className="font-bold text-navy">
              {isTxnLevel ? "Re-categorize this transaction" : "Suggest a different category"}
            </h3>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy"><X size={20} /></button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {submitted ? (
            <>
              <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                <CheckCircle2 size={18} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-emerald-900">
                  <strong className="block">Request sent to your bookkeeper.</strong>
                  <span className="text-xs">
                    They'll review and either approve (which reclassifies the matching
                    transactions in QuickBooks and updates the bank rule for next time)
                    or reply with questions.
                  </span>
                </div>
              </div>
              <button onClick={onClose} className="w-full px-4 py-2 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark">Done</button>
            </>
          ) : (
            <>
              {/* What's being changed */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-slate mb-1">
                  {isTxnLevel ? "Transaction you flagged" : "Category you're questioning"}
                </div>
                {isTxnLevel ? (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-navy truncate">
                        {target.example_txn_type || "Transaction"}
                        {target.vendor_name && <span className="text-ink-slate font-normal"> · {target.vendor_name}</span>}
                      </div>
                      <div className="text-ink-light truncate">
                        {target.example_txn_date}
                        {target.example_txn_memo && ` · ${target.example_txn_memo}`}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      {typeof target.example_txn_amount === "number" && (
                        <div className="font-mono font-semibold text-navy">{fmtMoney(target.example_txn_amount)}</div>
                      )}
                      <div className="text-[10px] text-ink-light">Currently in {target.source_account_name}</div>
                    </div>
                  </div>
                ) : (
                  <div className="text-navy">
                    <strong>{target.source_account_name}</strong> for {target.period_label}
                  </div>
                )}
              </div>

              {/* Target category picker */}
              <div>
                <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider">
                  Move to which category? <span className="text-red-700">*</span>
                </label>
                {targetAccount ? (
                  <div className="mt-1 flex items-center justify-between gap-2 px-3 py-2 border border-teal-border bg-teal-light rounded-lg">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-navy truncate">{targetAccount.fully_qualified_name}</div>
                      <div className="text-[10px] text-ink-light">{targetAccount.account_type} · {targetAccount.account_sub_type}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setTargetAccount(null); setSearch(""); }}
                      className="text-ink-slate hover:text-navy flex-shrink-0"
                      title="Pick a different category"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="relative mt-1">
                      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-light" />
                      <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search categories — e.g. Marketing"
                        className="w-full pl-8 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:border-teal-border focus:outline-none"
                      />
                    </div>
                    {accountsLoading ? (
                      <div className="text-xs text-ink-slate py-3 text-center">
                        <Loader2 size={12} className="inline animate-spin mr-1" />
                        Loading your categories…
                      </div>
                    ) : accountsError ? (
                      <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{accountsError}</div>
                    ) : (
                      <div className="mt-2 border border-slate-200 rounded-lg max-h-48 overflow-y-auto divide-y divide-slate-100">
                        {filteredAccounts.length === 0 ? (
                          <div className="px-3 py-3 text-xs text-ink-light italic">No match — try a different search.</div>
                        ) : filteredAccounts.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() => { setTargetAccount(a); if (error) setError(null); }}
                            className="w-full text-left px-3 py-2 hover:bg-teal-light transition-colors"
                          >
                            <div className="text-sm text-navy truncate">{a.fully_qualified_name}</div>
                            <div className="text-[10px] text-ink-light">{a.account_type} · {a.account_sub_type}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Reason */}
              <div>
                <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider">
                  Why does it belong there? <span className="text-red-700">*</span>
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => { setReason(e.target.value); if (error) setError(null); }}
                  placeholder={
                    isTxnLevel
                      ? "e.g. This USPS charge is for EDDM postcards — should be Marketing, not Postage."
                      : "e.g. Most of what's in Postage is actually EDDM marketing — let's move those out."
                  }
                  maxLength={1500}
                  rows={3}
                  className="mt-1 w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:border-teal-border focus:outline-none"
                />
                <div className="text-[11px] text-ink-light mt-1 flex items-center justify-between">
                  <span>Your bookkeeper sees this verbatim and decides whether to approve.</span>
                  <span>{reason.length} / 1500</span>
                </div>
              </div>

              {error && <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{error}</div>}

              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={onClose}
                  disabled={submitting}
                  className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-semibold text-ink-slate hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={submit}
                  disabled={submitting || !reason.trim() || !targetAccount}
                  className="px-4 py-1.5 bg-navy text-white rounded-lg text-sm font-semibold hover:bg-navy-deep disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {submitting ? <Loader2 size={12} className="animate-spin" /> : <Tag size={12} />}
                  {submitting ? "Sending…" : "Send request"}
                </button>
              </div>
              <div className="text-[11px] text-ink-light">
                Nothing changes in QuickBooks until your bookkeeper approves. On approval,
                {target.vendor_name
                  ? ` matching ${target.vendor_name} transactions in this fiscal year will be reclassified and a bank rule will be created for future imports.`
                  : ` matching transactions in this fiscal year will be reclassified and a bank rule will be created for future imports.`}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

