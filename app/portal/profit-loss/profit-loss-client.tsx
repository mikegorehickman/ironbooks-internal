"use client";

import { useEffect, useState } from "react";
import { ChevronDown, AlertTriangle, X, Loader2, ChevronRight } from "lucide-react";
import type { ProfitLossData } from "@/lib/qbo-reports";

type RangeKey = "lastMonth" | "thisMonth" | "quarter" | "ytd" | "lastYear";

/**
 * Accounting-standard section ordering. QBO's P&L report comes in this
 * order in the rows tree, but flattenRows loses that — so we re-impose it
 * here. Within each section, lines are sorted by descending absolute
 * amount so the most significant items appear first (vs alphabetical,
 * which buries the important stuff).
 */
const SECTION_ORDER = [
  "Income", "Revenue", "Sales",
  "Cost of Goods Sold", "COGS",
  "Gross Profit",
  "Operating Expenses", "Expenses", "Expense",
  "Operating Income", "Net Operating Income",
  "Other Income", "Other Expense", "Other Expenses",
  "Net Income", "Net Loss",
];

const SECTION_RANK = new Map(SECTION_ORDER.map((s, i) => [s.toLowerCase(), i]));

function sectionRank(name: string): number {
  const lower = name.toLowerCase();
  const exact = SECTION_RANK.get(lower);
  if (exact != null) return exact;
  // Substring match for variations like "Total Operating Expenses"
  for (const [key, rank] of SECTION_RANK) {
    if (lower.includes(key)) return rank;
  }
  return 999;
}

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

  const grouped = pl ? groupLines(pl.lineItems) : new Map();
  const isThisMonth = activeRange === "thisMonth";

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Profit & Loss</div>
          <h1 className="text-3xl font-bold text-navy mt-1">How you made money</h1>
          <div className="text-sm text-ink-slate mt-1">
            {range.label} · {formatDate(range.start)} → {formatDate(range.end)}
          </div>
        </div>
        <div className="flex bg-white border border-slate-200 rounded-lg p-0.5 flex-wrap">
          {(["lastMonth", "thisMonth", "quarter", "ytd", "lastYear"] as RangeKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setActiveRange(k)}
              className={`px-3 py-1.5 text-xs font-semibold rounded ${
                activeRange === k ? "bg-teal text-white" : "text-ink-slate hover:bg-slate-50"
              }`}
            >
              {shortLabel(k, ranges)}
            </button>
          ))}
        </div>
      </div>

      {/* In-progress warning when viewing "this month" */}
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
      ) : pl.totalIncome === 0 && pl.totalExpenses === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-ink-slate">
          No financial activity for this period.
        </div>
      ) : (
        <>
          <div className="bg-teal/5 border border-teal/30 rounded-xl p-4 text-sm text-navy/80 leading-relaxed">
            <strong className="text-teal-dark">In plain English:</strong> You earned{" "}
            <strong>{fmtMoney(pl.totalIncome)}</strong> from sales this period and spent{" "}
            <strong>{fmtMoney(pl.totalExpenses)}</strong> on costs and overhead. That leaves{" "}
            <strong>{fmtMoney(pl.netIncome)}</strong> in profit
            {pl.totalIncome > 0 && (
              <> — about <strong>{Math.round((pl.netIncome / pl.totalIncome) * 100)}¢</strong> of every dollar you brought in</>
            )}.
          </div>

          {/* Header row with column labels */}
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <div className="px-6 py-2 bg-slate-50 border-b border-slate-100 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-ink-slate">
              <span>Category / Line</span>
              <div className="flex items-center gap-6">
                <span className="w-20 text-right">Amount</span>
                <span className="w-12 text-right">% inc</span>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {Array.from(grouped.entries())
                .sort(([a], [b]) => sectionRank(a) - sectionRank(b))
                .map(([group, lines]) => {
                  const sortedLines = [...lines].sort(
                    (a: any, b: any) => Math.abs(b.amount) - Math.abs(a.amount)
                  );
                  const groupTotal = sortedLines.reduce((s: number, l: any) => s + l.amount, 0);
                  const groupPct = pl.totalIncome > 0 ? Math.round((groupTotal / pl.totalIncome) * 100) : 0;
                  return (
                    <Section
                      key={group}
                      title={group || "Other"}
                      amount={groupTotal}
                      pct={groupPct}
                      showPct={pl.totalIncome > 0}
                    >
                      {sortedLines.map((l: any, i: number) => {
                        const linePct = pl.totalIncome > 0 ? (l.amount / pl.totalIncome) * 100 : 0;
                        return (
                          <Line
                            key={i}
                            label={l.label}
                            amount={l.amount}
                            pct={linePct}
                            showPct={pl.totalIncome > 0}
                            onDrill={
                              l.account_id
                                ? () => setDrillLine({ label: l.label, account_id: l.account_id, amount: l.amount })
                                : undefined
                            }
                          />
                        );
                      })}
                    </Section>
                  );
                })}

              <div className="px-6 py-5 bg-teal/5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Bottom line</div>
                    <div className="text-2xl font-bold text-navy mt-1">Profit (what's left)</div>
                    {pl.totalIncome > 0 && (
                      <div className="text-xs text-ink-slate mt-1">
                        {Math.round((pl.netIncome / pl.totalIncome) * 100)}% profit margin
                      </div>
                    )}
                  </div>
                  <div className={`text-3xl font-bold ${pl.netIncome >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                    {fmtMoney(pl.netIncome)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-ink-slate">
        <strong className="text-navy">Tip:</strong> Click any line to see the underlying transactions —
        vendor, date, amount, memo. Or{" "}
        <a href="/portal/ask-ai" className="text-teal-dark font-semibold underline">ask the AI</a>{" "}
        any question about these numbers. The <strong>% inc</strong> column shows each line as a
        percent of total income — useful for spotting which costs are eating into your profit.
      </div>

      {drillLine && (
        <DrillDownDrawer
          line={drillLine}
          range={range}
          onClose={() => setDrillLine(null)}
        />
      )}
    </div>
  );
}

// ─── HELPERS ────────────────────────────────────────────────────────────

function shortLabel(key: RangeKey, ranges: Record<RangeKey, { label: string }>): string {
  // Strip the "(April 2026)" suffix on lastMonth so the toggle button stays short
  const full = ranges[key].label;
  if (key === "lastMonth") return "Last month";
  return full;
}

function groupLines(items: ProfitLossData["lineItems"]): Map<string, ProfitLossData["lineItems"]> {
  const m = new Map<string, ProfitLossData["lineItems"]>();
  for (const item of items) {
    const g = item.group || "Other";
    if (!m.has(g)) m.set(g, []);
    m.get(g)!.push(item);
  }
  return m;
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

function Section({ title, amount, pct, showPct, children }: { title: string; amount: number; pct: number; showPct: boolean; children: React.ReactNode }) {
  return (
    <details className="px-6 py-4 group" open>
      <summary className="flex items-center justify-between cursor-pointer list-none">
        <div className="flex items-center gap-2">
          <ChevronDown size={14} className="text-ink-slate group-open:rotate-0 -rotate-90 transition-transform" />
          <div className="font-bold text-navy">{title}</div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-lg font-bold text-navy w-20 text-right">{fmtMoney(amount)}</div>
          <div className="text-xs font-semibold text-ink-slate w-12 text-right">
            {showPct ? `${pct}%` : "—"}
          </div>
        </div>
      </summary>
      <div className="mt-3 ml-6 space-y-1.5">{children}</div>
    </details>
  );
}

function Line({
  label, amount, pct, showPct, onDrill,
}: {
  label: string; amount: number; pct: number; showPct: boolean;
  /** Optional drill-down callback. When defined the row is clickable. */
  onDrill?: () => void;
}) {
  const clickable = !!onDrill;
  return (
    <button
      type="button"
      onClick={onDrill}
      disabled={!clickable}
      className={`flex w-full items-center justify-between text-sm py-1 px-1 -mx-1 rounded ${
        clickable
          ? "cursor-pointer hover:bg-teal/5 group transition-colors"
          : "cursor-default"
      }`}
    >
      <div className="flex items-center gap-1 text-ink-slate text-left">
        {clickable && (
          <ChevronRight
            size={11}
            className="text-ink-light group-hover:text-teal-dark transition-colors"
          />
        )}
        <span className={clickable ? "group-hover:text-teal-dark" : ""}>{label}</span>
      </div>
      <div className="flex items-center gap-6">
        <div className="font-mono text-navy w-20 text-right">{fmtMoney(amount)}</div>
        <div className="text-xs text-ink-light w-12 text-right font-mono">
          {showPct ? (Math.abs(pct) >= 0.5 ? `${pct.toFixed(1)}%` : "—") : "—"}
        </div>
      </div>
    </button>
  );
}

// ─── DRILL-DOWN DRAWER ──────────────────────────────────────────────────

interface Transaction {
  txn_id: string;
  txn_type: string;
  date: string;
  doc_number: string | null;
  /** Vendor for expense accounts, customer for income accounts. */
  name: string | null;
  memo: string;
  amount: number;
  running_balance: number | null;
}

/**
 * Slide-out drawer showing every transaction that hit the clicked account
 * during the active P&L period. Fetches on open; doesn't pre-load.
 *
 * Slide-from-right pattern (not a modal) so the client can keep the
 * P&L visible behind the drawer and visually connect the drill-down
 * to the line they clicked.
 */
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

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-black/40" />
      <div
        className="w-full max-w-2xl bg-white shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between">
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
            {/* Reconciliation warning if drilled-in total doesn't match the
                P&L line total. Tolerance of $1 covers rounding. */}
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
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transactions.map((t, i) => (
                  <tr key={`${t.txn_id || i}`} className="hover:bg-slate-50">
                    <td className="px-4 py-2 text-xs text-ink-slate whitespace-nowrap">
                      {t.date}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <div className="text-navy font-medium">{t.txn_type || "—"}</div>
                      {t.doc_number && (
                        <div className="text-ink-light text-[11px]">#{t.doc_number}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <div className="text-navy">{t.name || <span className="text-ink-light italic">—</span>}</div>
                      {t.memo && (
                        <div className="text-ink-light text-[11px] truncate max-w-xs" title={t.memo}>
                          {t.memo}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-navy whitespace-nowrap">
                      {fmtMoney(t.amount)}
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
            Need to ask about a specific transaction?{" "}
            <a href="/portal/ask-ai" className="text-teal-dark font-semibold underline">
              Ask the AI
            </a>{" "}
            or reach out to your Ironbooks bookkeeper directly.
          </div>
        </div>
      </div>
    </div>
  );
}
