"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  TrendingUp, ArrowUpCircle, AlertTriangle, Eye, CheckCircle2,
  RefreshCw, Loader2, Ban, RotateCcw, Clock, Info,
} from "lucide-react";
import type { UpgradeReport, UpgradeRow, Recommendation } from "@/lib/upgrade-signals";

const TIER_COLORS: Record<string, string> = {
  insight: "bg-teal-light text-teal",
  discipline: "bg-blue-100 text-blue-700",
  vision: "bg-violet-100 text-violet-700",
  scale: "bg-navy/10 text-navy",
};

const REC_META: Record<Recommendation, { label: string; cls: string; icon: any }> = {
  upgrade: { label: "Upgrade now", cls: "bg-emerald-100 text-emerald-800 border-emerald-200", icon: ArrowUpCircle },
  margin_low: { label: "Margin below 15%", cls: "bg-amber-100 text-amber-800 border-amber-200", icon: AlertTriangle },
  watch: { label: "Approaching cap", cls: "bg-blue-100 text-blue-800 border-blue-200", icon: Eye },
  on_track: { label: "On track", cls: "bg-gray-100 text-gray-600 border-gray-200", icon: CheckCircle2 },
  no_data: { label: "Needs data", cls: "bg-slate-100 text-slate-600 border-slate-200", icon: Info },
};

type BucketFilter = "attention" | Recommendation | "resolved";

const money0 = (cents: number, cur = "usd") =>
  `${cur === "cad" ? "CA" : ""}$${Math.round(cents / 100).toLocaleString()}`;

const compact = (cents: number) => {
  const d = cents / 100;
  if (Math.abs(d) >= 1000) return `$${(d / 1000).toFixed(Math.abs(d) >= 100_000 ? 0 : 1)}K`;
  return `$${Math.round(d)}`;
};

const monthAbbrev = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short" });
};

function tierName(t: string | null) {
  if (!t) return "Unset";
  return { insight: "Insight", discipline: "Discipline", vision: "Vision", scale: "Scale" }[t] || t;
}

export function UpgradesClient({ report }: { report: UpgradeReport }) {
  const router = useRouter();
  const [bucket, setBucket] = useState<BucketFilter>("attention");
  const [tier, setTier] = useState<string>("all");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const { rows, summary, thresholds } = report;
  const isResolved = (r: UpgradeRow) => r.actionDecision === "upgraded" || r.actionDecision === "dismissed";

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (tier !== "all" && (r.currentTier || "unset") !== tier) return false;
      if (bucket === "resolved") return isResolved(r);
      if (isResolved(r)) return false;
      if (bucket === "attention") return ["upgrade", "margin_low", "watch"].includes(r.recommendation);
      return r.recommendation === bucket;
    });
  }, [rows, bucket, tier]);

  async function post(url: string, body: any, key: string) {
    setBusy((b) => ({ ...b, [key]: true }));
    setBanner(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      return data;
    } catch (e: any) {
      setBanner({ kind: "err", text: e.message });
      return null;
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  async function backfill(r: UpgradeRow) {
    const data = await post("/api/admin/upgrade-backfill", { client_link_id: r.clientLinkId }, `bf-${r.clientLinkId}`);
    if (data?.ok) { setBanner({ kind: "ok", text: `Pulled ${data.results?.[0]?.months ?? 0} months from QuickBooks for ${r.company}.` }); router.refresh(); }
    else if (data && !data.ok) setBanner({ kind: "err", text: data.results?.[0]?.error || "QBO pull failed." });
  }

  async function backfillAll() {
    const ids = rows.filter((r) => r.recommendation === "no_data").map((r) => r.clientLinkId).slice(0, 12);
    if (!ids.length) return;
    const data = await post("/api/admin/upgrade-backfill", { client_link_ids: ids }, "bf-all");
    if (data) { setBanner({ kind: "ok", text: `Backfilled ${data.refreshed}/${ids.length} clients from QuickBooks.` }); router.refresh(); }
  }

  async function act(r: UpgradeRow, decision: string) {
    const body: any = { client_link_id: r.clientLinkId, decision, target_tier: r.targetTier };
    if (decision === "snoozed") {
      const d = new Date(); d.setUTCDate(d.getUTCDate() + 30);
      body.snooze_until = d.toISOString().slice(0, 10);
    }
    const data = await post("/api/admin/upgrade-action", body, `act-${r.clientLinkId}`);
    if (data?.ok) router.refresh();
  }

  const tabs: { key: BucketFilter; label: string; count: number }[] = [
    { key: "attention", label: "Needs attention", count: summary.needsUpgrade + summary.marginLow + summary.watch },
    { key: "upgrade", label: "Upgrade now", count: summary.needsUpgrade },
    { key: "margin_low", label: "Margin < 15%", count: summary.marginLow },
    { key: "watch", label: "Approaching", count: summary.watch },
    { key: "on_track", label: "On track", count: summary.onTrack },
    { key: "no_data", label: "Needs data", count: summary.noData },
    { key: "resolved", label: "Resolved", count: rows.filter(isResolved).length },
  ];

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-navy flex items-center gap-2">
            <TrendingUp size={24} className="text-teal" />
            Upgrade Radar
          </h1>
          <p className="text-sm text-ink-slate mt-1 max-w-2xl">
            Clients who've outgrown their plan: <strong>{thresholds.runRateMonths} straight months</strong> over their
            tier's revenue cap (Insight = $25K/mo = a $300K/yr run rate) <strong>and</strong> a trailing net margin of at
            least <strong>{thresholds.targetNetMarginPct}%</strong>. Revenue is cash-basis from closed statements, backfilled
            from QuickBooks where we're short on closed months.
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <SummaryCard
          tone="emerald" label="Ready to upgrade" value={summary.needsUpgrade}
          sub={summary.monthlyUpliftDollars > 0
            ? `+$${summary.monthlyUpliftDollars.toLocaleString()}/mo · $${summary.annualUpliftDollars.toLocaleString()}/yr`
            : "revenue + margin both clear"}
        />
        <SummaryCard tone="amber" label="Revenue qualifies, margin < 15%" value={summary.marginLow} sub="scaled but not yet profitable enough" />
        <SummaryCard tone="blue" label="Approaching cap" value={summary.watch} sub="within 20% of the line" />
        <SummaryCard tone="slate" label="Needs data" value={summary.noData} sub="fewer than 3 months on file" />
      </div>

      {banner && (
        <div className={`mb-4 p-3 rounded-lg text-sm border ${banner.kind === "ok" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-800"}`}>
          {banner.text}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setBucket(t.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              bucket === t.key ? "bg-navy text-white border-navy" : "bg-white text-ink-slate border-gray-200 hover:border-gray-300"
            }`}
          >
            {t.label} <span className={bucket === t.key ? "text-white/70" : "text-ink-light"}>{t.count}</span>
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            className="text-xs font-semibold text-ink-slate border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
          >
            <option value="all">All tiers</option>
            <option value="insight">Insight ($247)</option>
            <option value="discipline">Discipline ($497)</option>
            <option value="vision">Vision ($797)</option>
            <option value="unset">Tier unset</option>
          </select>
          {summary.noData > 0 && (
            <button
              onClick={backfillAll}
              disabled={busy["bf-all"]}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal border border-teal/30 hover:bg-teal-lighter rounded-lg px-3 py-1.5"
            >
              {busy["bf-all"] ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Backfill all needing data
            </button>
          )}
        </div>
      </div>

      {/* Rows */}
      <div className="space-y-2.5">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-ink-slate text-sm border border-dashed border-gray-200 rounded-xl">
            Nothing in this view.
          </div>
        ) : (
          filtered.map((r) => (
            <UpgradeCard key={r.clientLinkId} r={r} busy={busy} onBackfill={backfill} onAct={act} />
          ))
        )}
      </div>
    </div>
  );
}

function SummaryCard({ tone, label, value, sub }: { tone: string; label: string; value: number; sub: string }) {
  const tones: Record<string, string> = {
    emerald: "border-emerald-200 bg-emerald-50",
    amber: "border-amber-200 bg-amber-50",
    blue: "border-blue-200 bg-blue-50",
    slate: "border-slate-200 bg-slate-50",
  };
  return (
    <div className={`rounded-xl border p-4 ${tones[tone]}`}>
      <div className="text-3xl font-bold text-navy">{value}</div>
      <div className="text-xs font-semibold text-ink mt-1">{label}</div>
      <div className="text-[11px] text-ink-slate mt-0.5">{sub}</div>
    </div>
  );
}

function UpgradeCard({
  r, busy, onBackfill, onAct,
}: {
  r: UpgradeRow;
  busy: Record<string, boolean>;
  onBackfill: (r: UpgradeRow) => void;
  onAct: (r: UpgradeRow, decision: string) => void;
}) {
  const meta = REC_META[r.recommendation];
  const RecIcon = meta.icon;
  const resolved = r.actionDecision === "upgraded" || r.actionDecision === "dismissed";
  const cap = r.capCents;

  return (
    <div className={`rounded-xl border bg-white p-4 ${resolved ? "opacity-60" : ""} border-gray-200`}>
      <div className="flex flex-wrap items-start gap-4">
        {/* Identity */}
        <div className="min-w-[180px] flex-1">
          <div className="flex items-center gap-2">
            <a href={`/clients/${r.clientLinkId}`} className="font-bold text-navy hover:text-teal truncate">{r.company}</a>
          </div>
          <div className="text-xs text-ink-slate mt-0.5">{r.contact || "—"}</div>
          <div className="mt-2 inline-flex items-center gap-1.5">
            <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${TIER_COLORS[r.currentTier || "scale"] || "bg-gray-100 text-gray-600"}`}>
              {tierName(r.currentTier)}{r.currentFee != null ? ` · $${r.currentFee}` : ""}
            </span>
            {!r.currentTierExplicit && r.currentTier && (
              <span className="text-[10px] text-ink-light" title="Tier inferred from billing amount, not set on the client">inferred</span>
            )}
          </div>
        </div>

        {/* Last 3 months */}
        <div className="min-w-[200px]">
          <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-1">
            Last {r.recentMonths.length || "—"} mo{cap != null ? ` · cap ${compact(cap)}/mo` : ""}
          </div>
          {r.recentMonths.length === 0 ? (
            <div className="text-xs text-ink-slate">No closed months</div>
          ) : (
            <div className="flex gap-1.5">
              {[...r.recentMonths].reverse().map((m) => (
                <div key={m.period} className={`px-2 py-1 rounded text-center ${m.overCap ? "bg-emerald-50 border border-emerald-200" : "bg-gray-50 border border-gray-100"}`}>
                  <div className="text-[10px] text-ink-slate">{monthAbbrev(m.period)}</div>
                  <div className={`text-xs font-bold ${m.overCap ? "text-emerald-700" : "text-navy"}`}>{compact(m.revenueCents)}</div>
                  <div className="text-[9px] text-ink-light" title="net margin">{m.marginPct.toFixed(0)}%</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Run-rate + margin */}
        <div className="min-w-[130px]">
          <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-1">Run rate</div>
          <div className="text-lg font-bold text-navy leading-none">{compact(r.annualizedRunRateCents)}<span className="text-xs font-normal text-ink-slate">/yr</span></div>
          <div className="text-[11px] text-ink-slate mt-1">
            margin <strong className={r.trailingMarginPct >= 15 ? "text-emerald-700" : "text-amber-700"}>{r.trailingMarginPct.toFixed(0)}%</strong>
            {r.streakOverCap > 0 && <> · <strong>{r.streakOverCap}mo</strong> streak</>}
          </div>
          <div className="text-[10px] text-ink-light mt-0.5">
            {r.dataSource === "qbo" ? "live QBO" : r.dataSource === "mixed" ? "stmt + QBO" : r.dataSource === "statement" ? "statements" : "no data"}
          </div>
        </div>

        {/* Recommendation + action */}
        <div className="min-w-[190px] flex flex-col items-end gap-2">
          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border ${meta.cls}`}>
            <RecIcon size={13} /> {meta.label}
          </span>
          {r.targetTier && (r.recommendation === "upgrade" || r.recommendation === "margin_low") && (
            <div className="text-xs text-ink-slate">
              → <strong className="text-navy">{tierName(r.targetTier)}</strong>
              {r.targetFee != null && <> ${r.targetFee}</>}
              {r.recommendation === "upgrade" && r.monthlyUpliftDollars > 0 && (
                <span className="text-emerald-700 font-semibold"> (+${r.monthlyUpliftDollars}/mo)</span>
              )}
            </div>
          )}

          {resolved ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-ink-slate capitalize">{r.actionDecision}</span>
              <button onClick={() => onAct(r, "pending")} disabled={busy[`act-${r.clientLinkId}`]} className="inline-flex items-center gap-1 text-[11px] text-ink-slate hover:text-navy">
                <RotateCcw size={11} /> Reopen
              </button>
            </div>
          ) : r.recommendation === "no_data" ? (
            <button
              onClick={() => onBackfill(r)}
              disabled={busy[`bf-${r.clientLinkId}`]}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-teal hover:bg-teal-dark rounded-lg px-3 py-1.5"
            >
              {busy[`bf-${r.clientLinkId}`] ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Backfill from QuickBooks
            </button>
          ) : (r.recommendation === "upgrade" || r.recommendation === "margin_low" || r.recommendation === "watch") ? (
            <div className="flex items-center gap-1.5">
              <button onClick={() => onAct(r, "upgraded")} disabled={busy[`act-${r.clientLinkId}`]} className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded-md px-2 py-1">
                <CheckCircle2 size={12} /> Upgraded
              </button>
              <button onClick={() => onAct(r, "snoozed")} disabled={busy[`act-${r.clientLinkId}`]} className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-slate border border-gray-200 hover:bg-gray-50 rounded-md px-2 py-1" title="Snooze 30 days">
                <Clock size={12} /> Snooze
              </button>
              <button onClick={() => onAct(r, "dismissed")} disabled={busy[`act-${r.clientLinkId}`]} className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-slate border border-gray-200 hover:bg-gray-50 rounded-md px-2 py-1">
                <Ban size={12} /> Dismiss
              </button>
            </div>
          ) : (
            r.actionDecision === "snoozed" && r.snoozeUntil ? (
              <span className="text-[11px] text-ink-light">snoozed to {r.snoozeUntil}</span>
            ) : null
          )}
        </div>
      </div>
    </div>
  );
}
