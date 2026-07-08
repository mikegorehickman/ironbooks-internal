/**
 * Upgrade-signals engine — who has outgrown their service tier.
 *
 * The rule (per Mike, 2026-07-07): a client should be upgraded when they have
 * sustained monthly revenue ABOVE their tier's cap AND are healthily
 * profitable. Concretely, for the default $250 (Insight) plan → $497
 * (Discipline):
 *
 *   • Revenue: each of the last 3 consecutive closed months > $25K/mo
 *     (= a $300K/yr run rate — exactly Insight's stated cap), AND
 *   • Profit:  trailing net margin over that window ≥ 15%.
 *
 * The logic generalizes to every tier using the numeric caps in tiers.ts, so
 * Discipline→Vision (>$85K/mo) and Vision→Scale (>$250K/mo) flag the same way.
 *
 * DATA SOURCE (Mike's pick): closed monthly statements first
 * (monthly_rec_runs.statements.pl, cash-basis — free + already verified), with
 * a live-QBO trailing-12 backfill (client_run_rate_cache) filling clients that
 * don't yet have enough closed months. Closed statements win per period.
 *
 * Schema-tolerant: client_run_rate_cache and client_upgrade_actions arrive with
 * migration 105. Until then those reads degrade to empty and the dashboard runs
 * purely off closed statements (backfill + action state just don't persist).
 */

import { TIERS, type ServiceTier } from "@/app/portal/billing/tiers";
import { tierFromAmountDollars } from "@/lib/stripe-billing";

// ── Tunables (mirrored in the dashboard legend) ─────────────────────────────
export const RUN_RATE_MONTHS = 3;          // consecutive months required
export const TARGET_NET_MARGIN_PCT = 15;   // trailing net-margin gate
export const APPROACH_FRACTION = 0.8;      // "approaching" = within 20% of cap

export const TIER_ORDER: ServiceTier[] = ["insight", "discipline", "vision", "scale"];

export function tierRank(t: ServiceTier | null): number {
  return t ? TIER_ORDER.indexOf(t) : -1;
}
export function tierConfig(t: ServiceTier) {
  return TIERS.find((x) => x.key === t)!;
}
export function tierLabel(t: ServiceTier | null): string {
  if (!t) return "Unset";
  const c = tierConfig(t);
  return c?.name?.replace(/^Tier \d+ – /, "") || t;
}
export function tierFeeDollars(t: ServiceTier | null): number | null {
  return t ? tierConfig(t)?.monthlyFee ?? null : null;
}
function capCents(t: ServiceTier | null): number | null {
  return t ? tierConfig(t)?.monthlyRevenueCapCents ?? null : null;
}

/** Lowest tier whose monthly cap still contains this revenue. Above every
 *  bounded cap → scale. */
export function tierForMonthlyRevenueCents(cents: number): ServiceTier {
  for (const t of TIER_ORDER) {
    const cap = capCents(t);
    if (cap == null) return t; // scale (unbounded)
    if (cents <= cap) return t;
  }
  return "scale";
}

export type Recommendation =
  | "upgrade"        // revenue over cap for 3 straight months AND margin ≥ 15%
  | "margin_low"     // revenue qualifies but trailing margin < 15% (review, don't auto-push)
  | "watch"          // approaching the cap, not yet 3 straight months over
  | "on_track"       // comfortably within tier
  | "no_data";       // fewer than 3 months of revenue on file

export type ActionDecision =
  | "pending"
  | "upgrade_sent"
  | "upgraded"
  | "dismissed"
  | "snoozed";

export interface MonthPoint {
  period: string;       // 'YYYY-MM'
  revenueCents: number;
  netCents: number;
  marginPct: number;    // net / revenue * 100
  source: "statement" | "qbo";
  overCap: boolean;
}

export interface UpgradeRow {
  clientLinkId: string;
  company: string;
  contact: string | null;
  currency: string;             // reporting currency of the books (usd/cad)
  currentTier: ServiceTier | null;
  currentTierExplicit: boolean; // true when set on client_links, false when inferred from MRR
  currentFee: number | null;
  currentMrrCents: number;

  monthsAvailable: number;
  recentMonths: MonthPoint[];   // most-recent first, up to RUN_RATE_MONTHS
  streakOverCap: number;        // consecutive most-recent months over cap
  avgMonthlyRevenueCents: number;   // over the trailing window
  annualizedRunRateCents: number;   // avgMonthly * 12
  trailingMarginPct: number;        // blended net/revenue over the window
  capCents: number | null;

  recommendation: Recommendation;
  targetTier: ServiceTier | null;
  targetFee: number | null;
  monthlyUpliftDollars: number;     // targetFee - currentFee (0 unless upgrade/margin_low)

  // review workflow (migration 105)
  actionDecision: ActionDecision;
  actionNote: string | null;
  snoozeUntil: string | null;

  dataSource: "statement" | "qbo" | "mixed" | "none";
  lastRefreshedAt: string | null;   // newest qbo-cache refresh, if any
}

export interface UpgradeReport {
  rows: UpgradeRow[];
  summary: {
    total: number;
    needsUpgrade: number;
    marginLow: number;
    watch: number;
    onTrack: number;
    noData: number;
    monthlyUpliftDollars: number;   // sum across needsUpgrade rows
    annualUpliftDollars: number;
  };
  thresholds: {
    runRateMonths: number;
    targetNetMarginPct: number;
    approachFraction: number;
  };
}

// ── period helpers ──────────────────────────────────────────────────────────
function isPrevMonth(newer: string, older: string): boolean {
  // true when `older` is exactly one calendar month before `newer` ('YYYY-MM')
  const [ny, nm] = newer.split("-").map(Number);
  const [oy, om] = older.split("-").map(Number);
  const nIdx = ny * 12 + (nm - 1);
  const oIdx = oy * 12 + (om - 1);
  return nIdx - oIdx === 1;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Safe read: returns fallback if the table/columns don't exist yet. */
async function safe<T>(p: any, fallback: T): Promise<T> {
  try {
    const { data } = await p;
    return (data ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export interface ComputeOpts {
  /** Only evaluate clients currently on these tiers. Default: all bounded
   *  tiers (everything except scale). */
  tiers?: ServiceTier[];
  /** Include clients whose current tier can't be determined. Default true —
   *  they're evaluated against the Insight cap. */
  includeUnsetTier?: boolean;
}

export async function computeUpgradeSignals(
  service: any,
  opts: ComputeOpts = {}
): Promise<UpgradeReport> {
  const [clientsRaw, subsRaw, runsRaw, cacheRaw, actionsRaw] = await Promise.all([
    safe<any[]>(
      service
        .from("client_links")
        .select("id, client_name, legal_business_name, contact_first_name, contact_last_name, service_tier, is_active")
        .eq("is_active", true),
      []
    ),
    safe<any[]>(service.from("billing_subscriptions").select("*"), []),
    safe<any[]>(
      service
        .from("monthly_rec_runs")
        .select("client_link_id, period, status, statements")
        .eq("status", "complete"),
      []
    ),
    safe<any[]>(service.from("client_run_rate_cache").select("*"), []),
    safe<any[]>(service.from("client_upgrade_actions").select("*"), []),
  ]);

  const subByClient = new Map<string, any>((subsRaw || []).map((s) => [s.client_link_id, s]));
  const actionByClient = new Map<string, any>((actionsRaw || []).map((a) => [a.client_link_id, a]));

  // period → point, per client. Closed statements first (authoritative + free),
  // then QBO cache fills any period we don't already have.
  type Raw = { revenueCents: number; netCents: number; source: "statement" | "qbo"; refreshedAt: string | null };
  const monthsByClient = new Map<string, Map<string, Raw>>();
  const ensure = (id: string) => {
    let m = monthsByClient.get(id);
    if (!m) { m = new Map(); monthsByClient.set(id, m); }
    return m;
  };

  for (const r of runsRaw || []) {
    const pl = r?.statements?.pl;
    if (!pl) continue;
    const revenue = Number(pl.totalIncome ?? r.statements?.totalIncome ?? 0);
    const net = Number(pl.netIncome ?? r.statements?.netIncome ?? 0);
    if (!r.period) continue;
    ensure(r.client_link_id).set(r.period, {
      revenueCents: Math.round(revenue * 100),
      netCents: Math.round(net * 100),
      source: "statement",
      refreshedAt: null,
    });
  }
  for (const c of cacheRaw || []) {
    const m = ensure(c.client_link_id);
    if (m.has(c.period)) continue; // closed statement wins
    m.set(c.period, {
      revenueCents: Number(c.revenue_cents || 0),
      netCents: Number(c.net_income_cents || 0),
      source: "qbo",
      refreshedAt: c.refreshed_at || null,
    });
  }

  const wantTiers = opts.tiers ?? (["insight", "discipline", "vision"] as ServiceTier[]);
  const includeUnset = opts.includeUnsetTier ?? true;

  const rows: UpgradeRow[] = [];

  for (const c of clientsRaw || []) {
    const sub = subByClient.get(c.id);
    const mrrCents = sub ? (sub.manual_mrr_cents ?? sub.mrr_cents ?? 0) : 0;

    let currentTier: ServiceTier | null = (c.service_tier as ServiceTier) || null;
    let explicit = !!c.service_tier;
    if (!currentTier && mrrCents > 0) {
      currentTier = tierFromAmountDollars(mrrCents / 100);
      explicit = false;
    }
    // Filtering: skip scale (nothing above it) and tiers not requested.
    if (currentTier === "scale") continue;
    if (currentTier && !wantTiers.includes(currentTier)) continue;
    if (!currentTier && !includeUnset) continue;

    // Evaluate an unset-tier client against Insight (the entry plan).
    const evalTier: ServiceTier = currentTier ?? "insight";
    const cap = capCents(evalTier);

    const monthMap = ensure(c.id);
    const allMonths = [...monthMap.entries()]
      .map(([period, v]) => ({ period, ...v }))
      .sort((a, b) => (a.period < b.period ? 1 : -1)); // newest first

    const monthsAvailable = allMonths.length;
    const company = c.legal_business_name || c.client_name || "—";
    const contact = [c.contact_first_name, c.contact_last_name].filter(Boolean).join(" ") || null;
    const currency = (sub?.currency as string) || "usd";
    const action = actionByClient.get(c.id);
    const actionDecision: ActionDecision = (action?.decision as ActionDecision) || "pending";

    // Trailing window = up to RUN_RATE_MONTHS most-recent months.
    const window = allMonths.slice(0, RUN_RATE_MONTHS);
    const recentMonths: MonthPoint[] = window.map((m) => ({
      period: m.period,
      revenueCents: m.revenueCents,
      netCents: m.netCents,
      marginPct: m.revenueCents > 0 ? round2((m.netCents / m.revenueCents) * 100) : 0,
      source: m.source,
      overCap: cap != null && m.revenueCents > cap,
    }));

    const trailingRev = window.reduce((s, m) => s + m.revenueCents, 0);
    const trailingNet = window.reduce((s, m) => s + m.netCents, 0);
    const avgMonthly = window.length ? Math.round(trailingRev / window.length) : 0;
    const trailingMarginPct = trailingRev > 0 ? round2((trailingNet / trailingRev) * 100) : 0;

    // Streak: consecutive most-recent calendar months over cap.
    let streak = 0;
    for (let i = 0; i < allMonths.length; i++) {
      const m = allMonths[i];
      if (cap == null || m.revenueCents <= cap) break;
      if (i > 0 && !isPrevMonth(allMonths[i - 1].period, m.period)) break; // calendar gap
      streak++;
    }

    // Revenue trigger: 3 straight most-recent months each over cap.
    const revenueOver = cap != null && streak >= RUN_RATE_MONTHS;
    const marginHealthy = trailingMarginPct >= TARGET_NET_MARGIN_PCT;
    const overInWindow = recentMonths.filter((m) => m.overCap).length;
    const approaching =
      cap != null &&
      !revenueOver &&
      (avgMonthly >= APPROACH_FRACTION * cap || overInWindow >= 2);

    let recommendation: Recommendation;
    if (monthsAvailable < RUN_RATE_MONTHS) recommendation = "no_data";
    else if (revenueOver && marginHealthy) recommendation = "upgrade";
    else if (revenueOver && !marginHealthy) recommendation = "margin_low";
    else if (approaching) recommendation = "watch";
    else recommendation = "on_track";

    // Target tier: the next tier up, but jump straight to the tier the run-rate
    // actually implies if that's higher (e.g. an Insight client already past
    // Discipline's cap → Vision).
    let targetTier: ServiceTier | null = null;
    if (recommendation === "upgrade" || recommendation === "margin_low") {
      const nextIdx = Math.min(tierRank(evalTier) + 1, TIER_ORDER.length - 1);
      const implied = tierForMonthlyRevenueCents(avgMonthly);
      targetTier = tierRank(implied) > nextIdx ? implied : TIER_ORDER[nextIdx];
    }

    const currentFee = tierFeeDollars(currentTier);
    const targetFee = tierFeeDollars(targetTier);
    const uplift =
      recommendation === "upgrade" && currentFee != null && targetFee != null
        ? targetFee - currentFee
        : 0;

    const sources = new Set(recentMonths.map((m) => m.source));
    const dataSource: UpgradeRow["dataSource"] =
      monthsAvailable === 0 ? "none" : sources.size > 1 ? "mixed" : [...sources][0] || "none";
    const lastRefreshedAt =
      allMonths.map((m) => m.refreshedAt).filter(Boolean).sort().reverse()[0] || null;

    rows.push({
      clientLinkId: c.id,
      company,
      contact,
      currency,
      currentTier,
      currentTierExplicit: explicit,
      currentFee,
      currentMrrCents: mrrCents,
      monthsAvailable,
      recentMonths,
      streakOverCap: streak,
      avgMonthlyRevenueCents: avgMonthly,
      annualizedRunRateCents: avgMonthly * 12,
      trailingMarginPct,
      capCents: cap,
      recommendation,
      targetTier,
      targetFee,
      monthlyUpliftDollars: uplift,
      actionDecision,
      actionNote: action?.note || null,
      snoozeUntil: action?.snooze_until || null,
      dataSource,
      lastRefreshedAt,
    });
  }

  // Sort: upgrade candidates first (by run-rate desc), then margin-low, watch,
  // no-data, on-track. Resolved/dismissed sink within their bucket.
  const bucketRank: Record<Recommendation, number> = {
    upgrade: 0, margin_low: 1, watch: 2, no_data: 3, on_track: 4,
  };
  const isResolved = (r: UpgradeRow) => r.actionDecision === "upgraded" || r.actionDecision === "dismissed";
  rows.sort((a, b) => {
    if (isResolved(a) !== isResolved(b)) return isResolved(a) ? 1 : -1;
    if (bucketRank[a.recommendation] !== bucketRank[b.recommendation])
      return bucketRank[a.recommendation] - bucketRank[b.recommendation];
    return b.annualizedRunRateCents - a.annualizedRunRateCents;
  });

  const active = rows.filter((r) => !isResolved(r));
  const count = (rec: Recommendation) => active.filter((r) => r.recommendation === rec).length;
  const monthlyUplift = active
    .filter((r) => r.recommendation === "upgrade")
    .reduce((s, r) => s + r.monthlyUpliftDollars, 0);

  return {
    rows,
    summary: {
      total: rows.length,
      needsUpgrade: count("upgrade"),
      marginLow: count("margin_low"),
      watch: count("watch"),
      onTrack: count("on_track"),
      noData: count("no_data"),
      monthlyUpliftDollars: monthlyUplift,
      annualUpliftDollars: monthlyUplift * 12,
    },
    thresholds: {
      runRateMonths: RUN_RATE_MONTHS,
      targetNetMarginPct: TARGET_NET_MARGIN_PCT,
      approachFraction: APPROACH_FRACTION,
    },
  };
}
