"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Activity,
  FileText,
  Scale,
  Banknote,
  ExternalLink,
  Loader2,
  ChevronRight,
  Settings as SettingsIcon,
  Clock,
  X as XIcon,
} from "lucide-react";
import type {
  OutstandingWork,
  ActivityEvent,
  InternalSummary,
} from "@/lib/internal-client-profile";
import type { OverviewData, BalanceSheetSummary } from "@/lib/portal-data";

type ClientLink = {
  id: string;
  client_name: string;
  qbo_realm_id: string | null;
  industry: string | null;
  jurisdiction: string | null;
  state_province: string | null;
  status: string | null;
  last_synced_at: string | null;
};

interface OverviewBundle {
  outstanding: OutstandingWork | null;
  activity: ActivityEvent[];
  summary: InternalSummary | null;
}

interface FinancialsBundle {
  /** Combined P&L (primary + comparison), banks, A/R, A/P. */
  overview: OverviewData | null;
  balanceSheet: BalanceSheetSummary | null;
  primaryRangeLabel: string;
  comparisonRangeLabel: string;
  /** False when the client hasn't connected QBO yet — financial tabs
   *  render an empty-state instead of pretending zeros. */
  hasQbo: boolean;
}

interface Props {
  clientLink: ClientLink;
  actorRole: string;
  overview: OverviewBundle;
  financials: FinancialsBundle;
}

type TabId = "overview" | "pl" | "bs" | "bank" | "activity";

const TABS: { id: TabId; label: string; icon: any }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "pl", label: "P&L", icon: FileText },
  { id: "bs", label: "Balance Sheet", icon: Scale },
  { id: "bank", label: "Bank Balances", icon: Banknote },
  { id: "activity", label: "Activity", icon: Clock },
];

export function ClientProfileShell({ clientLink, actorRole, overview, financials }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const canImpersonate = actorRole === "admin" || actorRole === "lead";

  // Drill-down drawer state — shared across P&L and BS tabs. Holds the
  // account the user clicked plus the date range to query. The drawer
  // itself owns the fetch + render so tabs stay focused on layout.
  const [drill, setDrill] = useState<{
    accountId: string;
    accountName: string;
    kind: "pl" | "bs";
    start: string;
    end: string;
  } | null>(null);

  return (
    <div className="px-8 py-6 max-w-7xl mx-auto space-y-6">
      {/* Top action bar — sits above the tab strip so the actions are visible
          from every tab without having to scroll back. "View as client" is
          the most-requested handoff so it gets the most-prominent slot. */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-ink-slate">
          {clientLink.last_synced_at && (
            <span className="text-xs">
              Last QBO sync:{" "}
              {new Date(clientLink.last_synced_at).toLocaleString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canImpersonate && <ViewAsClientButton clientLinkId={clientLink.id} />}
          <Link
            href={`/clients/${clientLink.id}/match-double`}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy border border-gray-200 hover:border-gray-300 bg-white px-3 py-2 rounded-lg transition-colors"
          >
            <SettingsIcon size={14} />
            Match to Double
          </Link>
        </div>
      </div>

      {/* Tab strip — top-level navigation between financial views. Tabs are
          stateful (no URL change) so we keep page state per tab without
          shuffling the address bar; switch to nested routes later if we
          want deep-link-per-tab. */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                active
                  ? "border-teal text-navy"
                  : "border-transparent text-ink-slate hover:text-navy hover:border-gray-200"
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          );
        })}
      </div>

      {activeTab === "overview" && (
        <OverviewTab clientLink={clientLink} overview={overview} />
      )}
      {activeTab === "pl" && (
        <PLTab
          financials={financials}
          clientLinkId={clientLink.id}
          onDrill={(accountId, accountName) =>
            setDrill({
              accountId,
              accountName,
              kind: "pl",
              start: financials.overview?.primaryMonth.start || "",
              end: financials.overview?.primaryMonth.end || "",
            })
          }
        />
      )}
      {activeTab === "bs" && (
        <BSTab
          financials={financials}
          clientLinkId={clientLink.id}
          onDrill={(accountId, accountName) =>
            setDrill({
              accountId,
              accountName,
              kind: "bs",
              // BS drill defaults to last 90 days of activity hitting the
              // account — gives the bookkeeper context without flooding
              // them with multi-year history on the first click.
              start: ymdDaysAgo(90),
              end: ymdToday(),
            })
          }
        />
      )}
      {activeTab === "bank" && <BankTab financials={financials} clientLinkId={clientLink.id} />}
      {activeTab === "activity" && (
        <ActivityTab activity={overview.activity} />
      )}

      {drill && (
        <DrillDrawer
          clientLinkId={clientLink.id}
          accountId={drill.accountId}
          accountName={drill.accountName}
          kind={drill.kind}
          start={drill.start}
          end={drill.end}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

// ─── OVERVIEW TAB ──────────────────────────────────────────────────────

function OverviewTab({
  clientLink,
  overview,
}: {
  clientLink: ClientLink;
  overview: OverviewBundle;
}) {
  const { outstanding, summary, activity } = overview;

  return (
    <div className="space-y-6">
      {/* Outstanding work — top-priority card. If empty we show a positive
          "all clear" state because seeing "0 outstanding items" hidden in
          a corner feels less reassuring than a deliberate empty state. */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-navy">Outstanding work</h2>
          {outstanding && outstanding.totalCount > 0 && (
            <span className="text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
              {outstanding.totalCount} item{outstanding.totalCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {outstanding && outstanding.items.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {outstanding.items.map((item, i) => (
              <Link
                key={i}
                href={item.href}
                className="group flex items-start gap-3 bg-white border border-gray-200 hover:border-amber-300 hover:shadow-sm rounded-xl p-4 transition-all"
              >
                <div className="shrink-0 mt-0.5">
                  <AlertCircle
                    size={18}
                    className={
                      item.category.includes("failed")
                        ? "text-red-500"
                        : "text-amber-500"
                    }
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-navy group-hover:text-teal">
                    {item.label}
                  </div>
                  <div className="text-xs text-ink-slate mt-0.5 truncate">
                    {item.detail}
                  </div>
                  {item.occurredAt && (
                    <div className="text-[10px] text-ink-slate/70 mt-1">
                      {new Date(item.occurredAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
                <ChevronRight
                  size={16}
                  className="shrink-0 text-ink-slate group-hover:text-teal mt-0.5"
                />
              </Link>
            ))}
          </div>
        ) : (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-800">
            ✓ Nothing outstanding — this client is up to date.
          </div>
        )}
      </section>

      {/* SNAP-side summary stats — bank rules + recent jobs. Quick numeric
          glance that complements the outstanding-work cards above. */}
      {summary && (
        <section>
          <h2 className="text-base font-bold text-navy mb-3">SNAP status</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <StatCard
              label="Active bank rules"
              value={summary.activeBankRules}
              subtext={
                summary.lastRuleExportAt
                  ? `Last exported ${new Date(summary.lastRuleExportAt).toLocaleDateString()}`
                  : "Never exported to QBO"
              }
            />
            <StatCard
              label="Recent reclass jobs"
              value={summary.recentReclassJobs.length}
              subtext={
                summary.recentReclassJobs[0]
                  ? `Latest: ${summary.recentReclassJobs[0].status}`
                  : "No reclass jobs yet"
              }
            />
            <StatCard
              label="Recent BS cleanups"
              value={summary.recentCleanups.length}
              subtext={
                summary.recentCleanups[0]
                  ? `Latest: ${summary.recentCleanups[0].status}`
                  : "No cleanups yet"
              }
            />
          </div>
          {summary.recentReclassJobs.length > 0 && (
            <div className="mt-4 bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
              {summary.recentReclassJobs.map((j) => (
                <Link
                  key={j.id}
                  href={`/reclass/${j.id}/review`}
                  className="flex items-center justify-between px-4 py-2.5 hover:bg-teal-lighter/50 transition-colors"
                >
                  <div className="text-sm">
                    <span className="font-semibold text-navy">
                      {j.workflow || "reclass"}
                    </span>
                    <span className="text-ink-slate mx-2">·</span>
                    <span className="text-ink-slate">
                      {j.sourceAccountName || "all accounts"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill status={j.status} />
                    <span className="text-xs text-ink-slate">
                      {new Date(j.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Recent activity strip — last 10 events from audit_log */}
      {activity.length > 0 && (
        <section>
          <h2 className="text-base font-bold text-navy mb-3">Recent activity</h2>
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            {activity.slice(0, 10).map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between px-4 py-2.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Activity size={13} className="text-ink-slate shrink-0" />
                  <span className="text-sm text-navy truncate">{e.label}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-ink-slate">
                    {new Date(e.occurredAt).toLocaleString()}
                  </span>
                  {e.href && (
                    <Link
                      href={e.href}
                      className="text-xs font-semibold text-teal hover:text-teal-dark"
                    >
                      View →
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── ACTIVITY TAB ──────────────────────────────────────────────────────

function ActivityTab({ activity }: { activity: ActivityEvent[] }) {
  if (activity.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-sm text-ink-slate">
        No recent SNAP activity logged for this client.
      </div>
    );
  }
  return (
    <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
      {activity.map((e) => (
        <div
          key={e.id}
          className="flex items-start justify-between px-5 py-3 hover:bg-teal-lighter/30"
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold text-navy">{e.label}</div>
            <div className="text-[11px] text-ink-slate mt-0.5 font-mono">
              {e.eventType}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            <span className="text-xs text-ink-slate">
              {new Date(e.occurredAt).toLocaleString()}
            </span>
            {e.href && (
              <Link
                href={e.href}
                className="text-xs font-semibold text-teal hover:text-teal-dark inline-flex items-center gap-1"
              >
                View <ExternalLink size={11} />
              </Link>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── FINANCIAL TABS ────────────────────────────────────────────────────

function NoQboState({ clientLinkId }: { clientLinkId: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
      <div className="text-sm font-semibold text-navy mb-1">
        QuickBooks not connected
      </div>
      <div className="text-xs text-ink-slate mb-3">
        Financial reports need a live QBO connection for this client.
      </div>
      <Link
        href={`/clients/${clientLinkId}/match-double`}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark"
      >
        Configure client settings →
      </Link>
    </div>
  );
}

function PLTab({
  financials,
  clientLinkId,
  onDrill,
}: {
  financials: FinancialsBundle;
  clientLinkId: string;
  onDrill: (accountId: string, accountName: string) => void;
}) {
  // Local UI toggle — by default we hide zero-balance accounts so the page
  // isn't a wall of "$0" rows. Bookkeepers verifying COA completeness flip
  // the toggle on; everyone else gets a clean activity-only view.
  const [showZeros, setShowZeros] = useState(false);

  if (!financials.hasQbo) return <NoQboState clientLinkId={clientLinkId} />;
  if (!financials.overview) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-sm text-amber-900">
        Couldn&apos;t fetch P&amp;L from QuickBooks. The QBO connection might have expired —
        check the client settings and try again.
      </div>
    );
  }

  const pl = financials.overview.primaryPL;
  const prev = financials.overview.comparisonPL;
  const incomeDelta = pl.totalIncome - prev.totalIncome;
  const expensesDelta = pl.totalExpenses - prev.totalExpenses;
  const niDelta = pl.netIncome - prev.netIncome;

  // ─── Full-COA merge ─────────────────────────────────────────────────
  // Build a row for every active P&L account from QBO (Revenue / Expense
  // classifications). Then merge in the P&L report's line-item amounts so
  // accounts with zero activity show as $0 instead of being invisible.
  // This is the "show full COA so we can verify completeness" half of
  // Mike's request.
  //
  // financials.balanceSheet.accounts returns ALL active accounts (quirk
  // of the underlying fetchAllAccounts call), so it's the right source
  // for both BS and P&L COA views.
  const allAccounts = financials.balanceSheet?.accounts || [];
  type PLRow = {
    accountId: string | null;
    name: string;
    accountType: string;
    classification: "Revenue" | "Expense";
    amount: number;
  };
  const rowsByAcctId = new Map<string, PLRow>();
  const rowsByName = new Map<string, PLRow>();
  for (const acct of allAccounts) {
    const cls = acct.Classification;
    if (cls !== "Revenue" && cls !== "Expense") continue;
    const row: PLRow = {
      accountId: acct.Id,
      name: acct.FullyQualifiedName || acct.Name,
      accountType: acct.AccountType,
      classification: cls as "Revenue" | "Expense",
      amount: 0,
    };
    rowsByAcctId.set(acct.Id, row);
    rowsByName.set(row.name.toLowerCase(), row);
  }
  // Merge in PL line items — match by account_id first, then label.
  // Lines that don't match (rare: deleted accounts, JE-only lines) get
  // added so the bookkeeper still sees them.
  for (const line of pl.lineItems) {
    let row: PLRow | undefined;
    if (line.account_id) row = rowsByAcctId.get(line.account_id);
    if (!row) row = rowsByName.get((line.label || "").toLowerCase());
    if (row) {
      row.amount = line.amount;
    } else {
      const cls: "Revenue" | "Expense" = /income|revenue/i.test(line.group)
        ? "Revenue"
        : "Expense";
      rowsByName.set((line.label || "").toLowerCase() + `_${Math.random()}`, {
        accountId: line.account_id,
        name: line.label || "Unknown account",
        accountType: line.group || cls,
        classification: cls,
        amount: line.amount,
      });
    }
  }

  const allRows = [...rowsByName.values()];
  const filtered = showZeros
    ? allRows
    : allRows.filter((r) => Math.abs(r.amount) >= 0.005);

  const incomeRows = filtered
    .filter((r) => r.classification === "Revenue")
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const cogsRows = filtered
    .filter(
      (r) => r.classification === "Expense" && /cost of goods sold/i.test(r.accountType)
    )
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const expenseRows = filtered
    .filter(
      (r) => r.classification === "Expense" && !/cost of goods sold/i.test(r.accountType)
    )
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const totalAccounts = allRows.length;
  const populatedAccounts = allRows.filter((r) => Math.abs(r.amount) >= 0.005).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-ink-slate">
          Range: <span className="font-semibold text-navy">{financials.primaryRangeLabel}</span>
          {" "}vs prior period {financials.comparisonRangeLabel}
          <span className="ml-3 text-ink-slate/70">
            · {populatedAccounts} of {totalAccounts} P&amp;L accounts have activity
          </span>
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-ink-slate cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showZeros}
            onChange={(e) => setShowZeros(e.target.checked)}
            className="rounded border-gray-300 text-teal focus:ring-teal"
          />
          Show zero-balance accounts
        </label>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KPICard label="Total income" value={pl.totalIncome} delta={incomeDelta} />
        <KPICard label="Total expenses" value={pl.totalExpenses} delta={expensesDelta} invertDeltaColor />
        <KPICard label="Net income" value={pl.netIncome} delta={niDelta} />
      </div>
      <PLSection title="Income" rows={incomeRows} total={pl.totalIncome} onDrill={onDrill} />
      {cogsRows.length > 0 && (
        <PLSection
          title="Cost of Goods Sold"
          rows={cogsRows}
          total={cogsRows.reduce((s, r) => s + r.amount, 0)}
          onDrill={onDrill}
        />
      )}
      <PLSection title="Expenses" rows={expenseRows} total={pl.totalExpenses} onDrill={onDrill} />
    </div>
  );
}

function PLSection({
  title,
  rows,
  total,
  onDrill,
}: {
  title: string;
  rows: Array<{ accountId: string | null; name: string; accountType: string; amount: number }>;
  total: number;
  onDrill: (accountId: string, accountName: string) => void;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-gray-50">
        <div className="text-xs font-bold uppercase text-ink-slate tracking-wide">
          {title} · {rows.length} {rows.length === 1 ? "account" : "accounts"}
        </div>
        <div className="font-mono text-sm font-bold text-navy">
          {formatCurrency(total)}
        </div>
      </div>
      <div className="divide-y divide-gray-100">
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-ink-slate text-center">
            No {title.toLowerCase()} accounts to show.
          </div>
        ) : (
          rows.map((r, i) => {
            const isZero = Math.abs(r.amount) < 0.005;
            const clickable = !!r.accountId;
            return (
              <button
                key={`${r.accountId || r.name}-${i}`}
                onClick={() => r.accountId && onDrill(r.accountId, r.name)}
                disabled={!clickable}
                className={`w-full flex items-center justify-between px-4 py-2 text-sm text-left ${
                  clickable
                    ? "hover:bg-teal-lighter/40 cursor-pointer"
                    : "cursor-default"
                } ${isZero ? "opacity-60" : ""}`}
                title={clickable ? "Click to see transactions" : "No account ID — can't drill"}
              >
                <div className="text-navy truncate pr-2 flex-1 min-w-0">
                  {r.name}
                  <span className="text-[10px] text-ink-slate ml-2 font-normal">
                    {r.accountType}
                  </span>
                </div>
                <div
                  className={`font-mono font-semibold shrink-0 ${
                    r.amount < 0 ? "text-red-600" : isZero ? "text-ink-slate" : "text-navy"
                  }`}
                >
                  {formatCurrency(r.amount)}
                </div>
                {clickable && (
                  <ChevronRight size={14} className="text-ink-slate ml-1 shrink-0" />
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function BSTab({
  financials,
  clientLinkId,
  onDrill,
}: {
  financials: FinancialsBundle;
  clientLinkId: string;
  onDrill: (accountId: string, accountName: string) => void;
}) {
  if (!financials.hasQbo) return <NoQboState clientLinkId={clientLinkId} />;
  if (!financials.balanceSheet) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-sm text-amber-900">
        Couldn&apos;t fetch the Balance Sheet from QuickBooks.
      </div>
    );
  }

  const bs = financials.balanceSheet;
  // Group by Classification + sort by absolute balance. Internal users
  // see ALL active accounts, not just top-5 like the portal — they need
  // the full picture for cleanup decisions. We carry the accountId on
  // each row so the drill-down can fire when clicked.
  type BSRow = { accountId: string; name: string; balance: number };
  const groups: Record<"Asset" | "Liability" | "Equity", BSRow[]> = {
    Asset: [],
    Liability: [],
    Equity: [],
  };
  for (const acct of bs.accounts) {
    const bal = bs.balances.get(acct.Id) ?? 0;
    if (Math.abs(bal) < 0.01) continue;
    const g = acct.Classification as keyof typeof groups;
    if (g in groups) {
      groups[g].push({
        accountId: acct.Id,
        name: acct.FullyQualifiedName || acct.Name,
        balance: bal,
      });
    }
  }
  for (const k of Object.keys(groups) as Array<keyof typeof groups>) {
    groups[k].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-ink-slate">
        <div>
          As of <span className="font-semibold text-navy">{bs.asOfDate}</span>
        </div>
        <Link
          href={`/balance-sheet/${clientLinkId}`}
          className="font-semibold text-teal hover:text-teal-dark inline-flex items-center gap-1"
        >
          Open full BS workspace <ExternalLink size={11} />
        </Link>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KPICard label="Total assets" value={bs.totalAssets} />
        <KPICard label="Total liabilities" value={bs.totalLiabilities} />
        <KPICard label="Total equity" value={bs.totalEquity} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(["Asset", "Liability", "Equity"] as const).map((g) => (
          <BSGroup key={g} title={g} rows={groups[g]} onDrill={onDrill} />
        ))}
      </div>
    </div>
  );
}

function BSGroup({
  title,
  rows,
  onDrill,
}: {
  title: string;
  rows: Array<{ accountId: string; name: string; balance: number }>;
  onDrill: (accountId: string, accountName: string) => void;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50 text-xs font-bold uppercase text-ink-slate tracking-wide">
        {title}
      </div>
      <div className="divide-y divide-gray-100 max-h-96 overflow-auto">
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-xs text-ink-slate text-center">No {title.toLowerCase()} balances</div>
        ) : (
          rows.map((r) => (
            <button
              key={r.accountId}
              onClick={() => onDrill(r.accountId, r.name)}
              className="w-full flex items-center justify-between px-4 py-2 text-sm text-left hover:bg-teal-lighter/40 transition-colors cursor-pointer"
              title="Click to see last 90 days of transactions hitting this account"
            >
              <div className="text-navy truncate pr-2 flex-1 min-w-0" title={r.name}>
                {r.name}
              </div>
              <div
                className={`font-mono font-semibold shrink-0 ${
                  r.balance < 0 ? "text-red-600" : "text-navy"
                }`}
              >
                {formatCurrency(r.balance)}
              </div>
              <ChevronRight size={14} className="text-ink-slate ml-1 shrink-0" />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function BankTab({
  financials,
  clientLinkId,
}: {
  financials: FinancialsBundle;
  clientLinkId: string;
}) {
  if (!financials.hasQbo) return <NoQboState clientLinkId={clientLinkId} />;
  if (!financials.overview) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-sm text-amber-900">
        Couldn&apos;t fetch bank balances.
      </div>
    );
  }
  const banks = financials.overview.banks;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KPICard label="Total cash" value={banks.totalCashOnHand} />
        <KPICard label="Credit card debt" value={banks.totalCreditCardDebt} invertDeltaColor />
        <KPICard
          label="Net liquidity"
          value={banks.totalCashOnHand - banks.totalCreditCardDebt}
        />
      </div>
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50 text-xs font-bold uppercase text-ink-slate tracking-wide">
          Bank accounts &amp; credit cards
        </div>
        <div className="divide-y divide-gray-100">
          {banks.accounts.length === 0 ? (
            <div className="px-4 py-6 text-sm text-ink-slate text-center">
              No bank or credit card accounts found in QBO.
            </div>
          ) : (
            banks.accounts.map((a, i) => (
              <div
                key={`${a.name}-${i}`}
                className="flex items-center justify-between px-4 py-2.5 text-sm"
              >
                <div>
                  <div className="text-navy font-semibold">{a.name}</div>
                  <div className="text-[11px] text-ink-slate">{a.type}</div>
                </div>
                <div
                  className={`font-mono font-bold ${
                    a.balance < 0 ? "text-red-600" : "text-navy"
                  }`}
                >
                  {formatCurrency(a.balance)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── UI BITS ───────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  subtext,
}: {
  label: string;
  value: number | string;
  subtext?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs uppercase tracking-wide text-ink-slate font-semibold">
        {label}
      </div>
      <div className="text-2xl font-bold text-navy mt-1">{value}</div>
      {subtext && (
        <div className="text-[11px] text-ink-slate mt-1">{subtext}</div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    complete: "bg-emerald-50 text-emerald-700",
    in_review: "bg-amber-50 text-amber-700",
    executing: "bg-blue-50 text-blue-700",
    failed: "bg-red-50 text-red-700",
    web_search_paused: "bg-purple-50 text-purple-700",
  };
  const className = styles[status] || "bg-gray-100 text-ink-slate";
  return (
    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${className}`}>
      {status}
    </span>
  );
}

function KPICard({
  label,
  value,
  delta,
  invertDeltaColor,
}: {
  label: string;
  value: number;
  delta?: number;
  /** Treat "value went up" as bad (e.g. expenses, credit card debt). */
  invertDeltaColor?: boolean;
}) {
  const hasDelta = typeof delta === "number" && Math.abs(delta) > 0.005;
  const deltaIsBad = hasDelta
    ? invertDeltaColor
      ? delta! > 0
      : delta! < 0
    : false;
  const deltaIsGood = hasDelta && !deltaIsBad;
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs uppercase tracking-wide text-ink-slate font-semibold">
        {label}
      </div>
      <div
        className={`text-2xl font-bold mt-1 font-mono ${
          value < 0 ? "text-red-600" : "text-navy"
        }`}
      >
        {formatCurrency(value)}
      </div>
      {hasDelta && (
        <div
          className={`text-[11px] mt-1 font-semibold ${
            deltaIsGood ? "text-emerald-700" : deltaIsBad ? "text-red-600" : "text-ink-slate"
          }`}
        >
          {delta! > 0 ? "▲" : "▼"} {formatCurrency(Math.abs(delta!))} vs prior period
        </div>
      )}
    </div>
  );
}

function formatCurrency(n: number): string {
  // Compact format for the dashboard. Doesn't need to be exact-cent precision
  // — bookkeepers can drill into the underlying reports for that.
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1_000)}k`;
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function ymdToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function ymdDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ─── DRILL-DOWN DRAWER ─────────────────────────────────────────────────

interface DrillTransaction {
  id: string;
  type: string;
  date: string;
  doc_number: string | null;
  name: string | null;
  memo: string;
  amount: number;
  running_balance: number | null;
  cleared?: boolean;
}

function DrillDrawer({
  clientLinkId,
  accountId,
  accountName,
  kind,
  start,
  end,
  onClose,
}: {
  clientLinkId: string;
  accountId: string;
  accountName: string;
  kind: "pl" | "bs";
  start: string;
  end: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    transactions: DrillTransaction[];
    total: number;
    truncated: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = `/api/clients/${clientLinkId}/account-transactions?account_id=${encodeURIComponent(
      accountId
    )}&start=${start}&end=${end}&kind=${kind}`;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || `Fetch failed (${r.status})`);
        return r.json();
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || "Failed to load transactions");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientLinkId, accountId, start, end, kind]);

  // Sum + check vs the parent row's expected amount so the bookkeeper can
  // spot QBO report-vs-detail reconciliation discrepancies at a glance.
  const sumOfShown = (data?.transactions || []).reduce((s, t) => s + t.amount, 0);

  return (
    <>
      {/* Backdrop — click anywhere outside the drawer to close. Tab still
          available for screen readers via the close button below. */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer — slides from the right. Wide enough to read full memos
          without scrolling, fixed-position so it overlays the tab content
          without disturbing scroll on the page behind. */}
      <div className="fixed right-0 top-0 h-full w-full md:w-[700px] bg-white shadow-2xl z-50 flex flex-col">
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-200">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-ink-slate font-bold">
              {kind === "pl" ? "P&L transactions" : "Account activity"}
            </div>
            <div className="text-sm font-bold text-navy truncate" title={accountName}>
              {accountName}
            </div>
            <div className="text-xs text-ink-slate mt-0.5">
              {start} → {end}
              {data && (
                <span className="ml-2">
                  · {data.total} transaction{data.total === 1 ? "" : "s"}
                  {data.truncated && " (showing first 500)"}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 -mt-1 -mr-1 p-2 text-ink-slate hover:text-navy hover:bg-gray-100 rounded-lg"
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="px-5 py-12 text-center text-sm text-ink-slate">
              <Loader2 className="animate-spin inline mr-2" size={14} />
              Loading transactions…
            </div>
          ) : error ? (
            <div className="m-5 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              {error}
            </div>
          ) : !data || data.transactions.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-ink-slate">
              No transactions in this range.
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {data.transactions.map((t, i) => (
                <div key={`${t.id}-${i}`} className="px-5 py-2.5 text-xs hover:bg-gray-50">
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-ink-slate shrink-0">{t.date}</span>
                      <span className="text-[10px] font-bold uppercase text-teal bg-teal-lighter/60 px-1.5 py-0.5 rounded shrink-0">
                        {t.type}
                      </span>
                      {t.doc_number && (
                        <span className="text-ink-slate shrink-0">#{t.doc_number}</span>
                      )}
                      {t.cleared && (
                        <span className="text-[10px] text-emerald-700 shrink-0">✓ cleared</span>
                      )}
                    </div>
                    <div
                      className={`font-mono font-bold shrink-0 ${
                        t.amount < 0 ? "text-red-600" : "text-navy"
                      }`}
                    >
                      {formatCurrencyExact(t.amount)}
                    </div>
                  </div>
                  <div className="text-navy">
                    {t.name && <span className="font-semibold">{t.name}</span>}
                    {t.name && t.memo && <span className="text-ink-slate"> · </span>}
                    {t.memo && <span className="text-ink-slate">{t.memo}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {data && data.transactions.length > 0 && (
          <div className="border-t border-gray-200 px-5 py-3 text-xs flex items-center justify-between bg-gray-50">
            <div className="text-ink-slate">
              Sum of shown:{" "}
              <span className="font-mono font-bold text-navy">
                {formatCurrencyExact(sumOfShown)}
              </span>
            </div>
            {data.truncated && (
              <div className="text-amber-700">
                Capped at 500 — sum may not equal the report total
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function formatCurrencyExact(n: number): string {
  // Cent-precision for the drill-down — drill view is where bookkeepers
  // verify amounts down to the penny, so the dashboard rounding doesn't
  // apply.
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function ViewAsClientButton({ clientLinkId }: { clientLinkId: string }) {
  const [loading, setLoading] = useState(false);

  async function handleViewAs() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/impersonate/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to start impersonation");
        setLoading(false);
        return;
      }
      // Open the portal in a new tab so the bookkeeper doesn't lose the
      // internal context they were just looking at.
      window.open(data.redirect || "/portal", "_blank");
    } catch (e: any) {
      alert(e?.message || "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleViewAs}
      disabled={loading}
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark border border-teal/40 hover:border-teal bg-white px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
      title="Open this client's portal in a new tab as if you were them — for QA, screenshots, or debugging what they see"
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
      View as client
    </button>
  );
}
