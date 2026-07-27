import { getValidToken, QBOReauthRequiredError } from "@/lib/qbo";
import {
  fetchOverview,
  fetchBalanceSheetSummary,
  type OverviewData,
} from "@/lib/portal-data";
import { buildPeriodSnapshot, buildBalanceSheetSnapshot } from "@/lib/portal-ai";
import type {
  PlSnapshot,
  BsSnapshot,
  ArApSnapshot,
  DailyReconStats,
  PeriodBounds,
} from "./types";
import { priorPeriod, periodBounds } from "./period";
import { verifyOperationalGates } from "./operational-gates";
import { pickBestReclassJob } from "./reclass-match";
import { BUILD_CONCURRENCY } from "./constants";
import { mapPool } from "./concurrency";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = { from: (table: string) => any };

export interface BuiltPackageSnapshots {
  pl_snapshot: PlSnapshot;
  bs_snapshot: BsSnapshot;
  ar_ap_snapshot: ArApSnapshot;
  daily_recon_stats: DailyReconStats;
  reclass_job_id: string | null;
}

function plFromOverview(data: OverviewData): PlSnapshot {
  const primary = buildPeriodSnapshot(
    data.primaryMonth.start,
    data.primaryMonth.end,
    data.primaryPL
  );
  const comparison = buildPeriodSnapshot(
    data.comparisonMonth.start,
    data.comparisonMonth.end,
    data.comparisonPL
  );
  return {
    totalIncome: primary.totalIncome,
    totalExpenses: primary.totalExpenses,
    netIncome: primary.netIncome,
    comparisonIncome: comparison.totalIncome,
    comparisonExpenses: comparison.totalExpenses,
    comparisonNetIncome: comparison.netIncome,
    topIncomeLines: primary.topIncomeLines,
    topExpenseLines: primary.topExpenseLines,
  };
}

function bsFromSummary(bs: Awaited<ReturnType<typeof fetchBalanceSheetSummary>>): BsSnapshot {
  const snap = buildBalanceSheetSnapshot(bs);
  const cashOnHand = bs.accounts
    .filter((a) => a.AccountType === "Bank" || a.AccountType === "Credit Card")
    .reduce((s, a) => s + (bs.balances.get(a.Id) ?? 0), 0);
  return {
    asOfDate: snap.asOf,
    totalAssets: snap.totalAssets,
    totalLiabilities: snap.totalLiabilities,
    totalEquity: snap.totalEquity,
    cashOnHand: Math.round(cashOnHand),
    topAssets: snap.topAssets,
    topLiabilities: snap.topLiabilities,
  };
}

function arApFromOverview(data: OverviewData): ArApSnapshot {
  return {
    openARTotal: Math.round(data.openARTotal),
    openARCount: data.openARCount,
    overdueARTotal: Math.round(data.overdueARTotal),
    overdueARCount: data.overdueARCount,
    openAPTotal: Math.round(data.openAPTotal),
    openAPCount: data.openAPCount,
  };
}

async function dailyReconStatsForPeriod(
  service: Service,
  clientLinkId: string,
  period: PeriodBounds
): Promise<DailyReconStats> {
  const [{ count: cleared }, { count: autoApproved }, { count: pendingNow }] =
    await Promise.all([
      service
        .from("daily_review_queue")
        .select("id", { count: "exact", head: true })
        .eq("client_link_id", clientLinkId)
        .in("decision", ["approved", "auto_approved", "executed"])
        .gte("transaction_date", period.periodStart)
        .lte("transaction_date", period.periodEnd),
      service
        .from("daily_review_queue")
        .select("id", { count: "exact", head: true })
        .eq("client_link_id", clientLinkId)
        .eq("decision", "auto_approved")
        .gte("transaction_date", period.periodStart)
        .lte("transaction_date", period.periodEnd),
      service
        .from("daily_review_queue")
        .select("id", { count: "exact", head: true })
        .eq("client_link_id", clientLinkId)
        .eq("decision", "pending"),
    ]);

  return {
    autoCategorized: autoApproved || 0,
    exceptionsCleared: cleared || 0,
    pendingNow: pendingNow || 0,
  };
}

export async function buildPackageSnapshots(
  service: Service,
  clientLinkId: string,
  periodRef: { periodYear: number; periodMonth: number }
): Promise<BuiltPackageSnapshots> {
  const period = periodBounds(periodRef);
  const prior = periodBounds(priorPeriod(periodRef));

  const { data: client } = await service
    .from("client_links")
    .select("qbo_realm_id, qbo_refresh_token")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id || !client?.qbo_refresh_token) {
    throw new Error("QBO not connected for this client");
  }

  let token: string;
  try {
    token = await getValidToken(clientLinkId, service as any);
  } catch (err) {
    if (err instanceof QBOReauthRequiredError) {
      throw new Error("QBO reauthorization required");
    }
    throw err;
  }

  const overview = await fetchOverview(
    client.qbo_realm_id,
    token,
    {
      start: period.periodStart,
      end: period.periodEnd,
      label: period.label,
    },
    {
      start: prior.periodStart,
      end: prior.periodEnd,
      label: prior.label,
    }
  );

  const bs = await fetchBalanceSheetSummary(
    client.qbo_realm_id,
    token,
    period.periodEnd
  );

  const { data: jobs } = await service
    .from("reclass_jobs")
    .select("id, status, date_range_start, date_range_end")
    .eq("client_link_id", clientLinkId)
    .eq("status", "complete")
    .lte("date_range_start", period.periodEnd)
    .gte("date_range_end", period.periodStart);

  const reclassJob = pickBestReclassJob((jobs || []) as any[], period);
  const dailyStats = await dailyReconStatsForPeriod(service, clientLinkId, period);

  return {
    pl_snapshot: plFromOverview(overview),
    bs_snapshot: bsFromSummary(bs),
    ar_ap_snapshot: arApFromOverview(overview),
    daily_recon_stats: dailyStats,
    reclass_job_id: reclassJob?.id || null,
  };
}

export async function upsertDraftPackage(
  service: Service,
  clientLinkId: string,
  periodRef: { periodYear: number; periodMonth: number },
  createdBy: string,
  options?: { skipGateCheck?: boolean; forceRebuild?: boolean }
): Promise<{ packageId: string; created: boolean }> {
  const period = periodBounds(periodRef);

  if (!options?.skipGateCheck) {
    const gates = await verifyOperationalGates(service, clientLinkId, period);
    if (!gates.ok) {
      throw new Error(`Not ready to build: ${gates.blockReasons.join(", ")}`);
    }
  }

  const { data: existing } = await service
    .from("month_end_packages")
    .select("id, status, ai_summary_reviewed")
    .eq("client_link_id", clientLinkId)
    .eq("period_year", period.periodYear)
    .eq("period_month", period.periodMonth)
    .maybeSingle();

  if (existing?.status === "sent") {
    throw new Error("Package already sent for this period");
  }

  if (
    existing &&
    ["sending", "summary_pending"].includes(existing.status) &&
    !options?.forceRebuild
  ) {
    throw new Error(`Package is ${existing.status} — wait or run stale recovery`);
  }

  if (existing?.status === "ready_to_send" && !options?.forceRebuild) {
    throw new Error("Package already approved — use force_rebuild to refresh snapshots");
  }

  const snapshots = await buildPackageSnapshots(service, clientLinkId, periodRef);
  const now = new Date().toISOString();

  const row = {
    client_link_id: clientLinkId,
    period_year: period.periodYear,
    period_month: period.periodMonth,
    period_start: period.periodStart,
    period_end: period.periodEnd,
    status: "draft",
    pl_snapshot: snapshots.pl_snapshot,
    bs_snapshot: snapshots.bs_snapshot,
    ar_ap_snapshot: snapshots.ar_ap_snapshot,
    daily_recon_stats: snapshots.daily_recon_stats,
    reclass_job_id: snapshots.reclass_job_id,
    created_by: createdBy,
    ai_summary_reviewed: false,
    ai_summary_reviewed_by: null,
    ai_summary_reviewed_at: null,
    send_error: null,
    updated_at: now,
    ...(options?.forceRebuild ? { ai_summary: null } : {}),
  };

  if (existing?.id) {
    const { error } = await service
      .from("month_end_packages")
      .update(row as any)
      .eq("id", existing.id)
      .not("status", "eq", "sent");
    if (error) throw new Error(error.message);
    return { packageId: existing.id, created: false };
  }

  const { data: inserted, error } = await service
    .from("month_end_packages")
    .insert(row as any)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { packageId: inserted.id, created: true };
}

export async function buildPackagesBulk(
  service: Service,
  clientLinkIds: string[],
  periodRef: { periodYear: number; periodMonth: number },
  createdBy: string,
  options?: { skipGateCheck?: boolean; forceRebuild?: boolean }
): Promise<Array<{ clientLinkId: string; packageId?: string; ok: boolean; error?: string }>> {
  return mapPool(clientLinkIds, BUILD_CONCURRENCY, async (clientLinkId) => {
    try {
      const { packageId } = await upsertDraftPackage(
        service,
        clientLinkId,
        periodRef,
        createdBy,
        options
      );
      return { clientLinkId, packageId, ok: true };
    } catch (err: any) {
      return {
        clientLinkId,
        ok: false,
        error: err?.message || "Build failed",
      };
    }
  });
}
