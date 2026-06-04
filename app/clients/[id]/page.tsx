import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { notFound, redirect } from "next/navigation";
import { ClientProfileShell } from "./client-profile-shell";
import {
  fetchOutstandingWork,
  fetchRecentActivity,
  fetchInternalSummary,
  fetchClientProgress,
} from "@/lib/internal-client-profile";
import { getValidToken } from "@/lib/qbo";
import {
  fetchOverview,
  fetchBalanceSheetSummary,
  thisMonthRange,
  lastMonthRange,
  ytdRange,
  quarterRange,
  type DateRange,
} from "@/lib/portal-data";

/**
 * Resolve the ?range= URL param to a primary + comparison DateRange pair.
 *
 * Default behaviour: pick "last month" when we're early in the current
 * month (< 7 days elapsed). Today-is-June-1 was showing an empty P&L
 * because thisMonthRange returns a 1-day window — that's accurate but
 * useless when the bookkeeper expects to see real activity.
 *
 * Comparison period mirrors the primary: this-month vs last-month,
 * last-month vs the month before, YTD vs prior YTD, etc. Always exactly
 * one period back, never two.
 */
function resolveDateRanges(
  rangeParam: string | undefined
): { primary: DateRange; comparison: DateRange; activeKey: string } {
  const now = new Date();
  const daysIntoMonth = now.getDate();

  // No explicit range → pick a useful default. Early in the month, show
  // the just-completed month so the bookkeeper sees real numbers.
  const key =
    rangeParam || (daysIntoMonth < 7 ? "last-month" : "this-month");

  switch (key) {
    case "this-month": {
      return {
        primary: thisMonthRange(),
        comparison: lastMonthRange(),
        activeKey: "this-month",
      };
    }
    case "last-month": {
      const last = lastMonthRange();
      // Two months ago — first day to last day of (current - 2)
      const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - 1, 0);
      return {
        primary: last,
        comparison: {
          start: start.toISOString().slice(0, 10),
          end: end.toISOString().slice(0, 10),
          label: "Two months ago",
        },
        activeKey: "last-month",
      };
    }
    case "mtd":
      return {
        primary: thisMonthRange(),
        comparison: lastMonthRange(),
        activeKey: "mtd",
      };
    case "ytd": {
      const ytd = ytdRange();
      const prevYearSame = {
        start: `${now.getFullYear() - 1}-01-01`,
        end: `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
        label: "Prior YTD",
      };
      return { primary: ytd, comparison: prevYearSame, activeKey: "ytd" };
    }
    case "quarter":
      return {
        primary: quarterRange(),
        // Last quarter = quarter start - 3 months
        comparison: (() => {
          const q = quarterRange();
          const qStart = new Date(q.start);
          const lastQStart = new Date(qStart.getFullYear(), qStart.getMonth() - 3, 1);
          const lastQEnd = new Date(qStart.getFullYear(), qStart.getMonth(), 0);
          return {
            start: lastQStart.toISOString().slice(0, 10),
            end: lastQEnd.toISOString().slice(0, 10),
            label: "Last quarter",
          };
        })(),
        activeKey: "quarter",
      };
    case "last-30": {
      const end = new Date(now);
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      const compStart = new Date(start);
      compStart.setDate(compStart.getDate() - 30);
      return {
        primary: {
          start: start.toISOString().slice(0, 10),
          end: end.toISOString().slice(0, 10),
          label: "Last 30 days",
        },
        comparison: {
          start: compStart.toISOString().slice(0, 10),
          end: start.toISOString().slice(0, 10),
          label: "Previous 30 days",
        },
        activeKey: "last-30",
      };
    }
    case "last-90": {
      const end = new Date(now);
      const start = new Date(now);
      start.setDate(start.getDate() - 90);
      const compStart = new Date(start);
      compStart.setDate(compStart.getDate() - 90);
      return {
        primary: {
          start: start.toISOString().slice(0, 10),
          end: end.toISOString().slice(0, 10),
          label: "Last 90 days",
        },
        comparison: {
          start: compStart.toISOString().slice(0, 10),
          end: start.toISOString().slice(0, 10),
          label: "Previous 90 days",
        },
        activeKey: "last-90",
      };
    }
    default:
      // Unknown key — fall back to the smart default
      return resolveDateRanges(daysIntoMonth < 7 ? "last-month" : "this-month");
  }
}

/**
 * Internal client profile — the bookkeeper-facing view of a single client.
 *
 * Contrast with /portal/* (client-facing chrome, single-client tenant) and
 * /clients/[id]/match-double (single-purpose admin tool). This page is the
 * "open a client and see everything" view Mike asked for: financial
 * snapshots from QBO plus internal SNAP-side state (cleanups, rules,
 * reclasses, outstanding work).
 *
 * Architecture: this server component fetches everything Overview needs in
 * parallel and passes to a client shell that owns the tab state. Other
 * tabs (P&L / BS / Bank / Activity) lazy-load via tabbed routes underneath
 * (see /clients/[id]/{pl,bs,bank,activity}/page.tsx).
 */
export default async function ClientProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ range?: string }>;
}) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const ranges = resolveDateRanges(sp.range);
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();

  // Permission: any internal role (bookkeeper / lead / admin) can view.
  // Clients should never land here — they're scoped to /portal.
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (!role || role === "client") redirect("/portal");

  // Cast through `any` because the generated database.types.ts is stale on
  // `last_synced_at` (real column, used in lib/daily-recon.ts). Same pattern
  // used elsewhere in this codebase pending a types regen.
  const { data: clientLinkRaw } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, industry, jurisdiction, state_province, status, last_synced_at, double_client_id, double_client_name" as any)
    .eq("id", id)
    .single();

  if (!clientLinkRaw) notFound();
  const clientLink = clientLinkRaw as unknown as {
    id: string;
    client_name: string;
    qbo_realm_id: string | null;
    industry: string | null;
    jurisdiction: string | null;
    state_province: string | null;
    status: string | null;
    last_synced_at: string | null;
    double_client_id: string | null;
    double_client_name: string | null;
  };

  // Parallel-load all data for every tab so the user can switch tabs
  // without spinners. Each fetch is independent and failure-tolerant —
  // a QBO timeout on one report doesn't blank the whole page.
  //
  // QBO data only loaded when the client has a realm + a token can be
  // minted. New/disconnected clients skip the QBO calls entirely and the
  // financial tabs render an empty-state instead of crashing.
  const hasQbo = !!clientLink.qbo_realm_id;

  const primaryRange = ranges.primary;
  const comparisonRange = ranges.comparison;

  const tokenPromise: Promise<string | null> = hasQbo
    ? getValidToken(id, service as any).catch((e) => {
        console.warn(`[client-profile ${id}] token fetch failed:`, e?.message);
        return null;
      })
    : Promise.resolve(null);

  const [outstanding, activity, summary, progress, accessToken] = await Promise.all([
    fetchOutstandingWork(service, id).catch((e) => {
      console.warn(`[client-profile ${id}] outstanding work failed:`, e?.message);
      return null;
    }),
    fetchRecentActivity(service, id).catch((e) => {
      console.warn(`[client-profile ${id}] activity failed:`, e?.message);
      return [];
    }),
    fetchInternalSummary(service, id).catch((e) => {
      console.warn(`[client-profile ${id}] summary failed:`, e?.message);
      return null;
    }),
    fetchClientProgress(service, id, clientLink).catch((e) => {
      console.warn(`[client-profile ${id}] progress failed:`, e?.message);
      return null;
    }),
    tokenPromise,
  ]);

  // QBO-dependent fetches gated on having a token. Failure-tolerant so
  // the page still renders even if one report endpoint times out.
  let overview = null;
  let balanceSheet = null;
  if (accessToken && clientLink.qbo_realm_id) {
    const realmId = clientLink.qbo_realm_id;
    [overview, balanceSheet] = await Promise.all([
      fetchOverview(realmId, accessToken, primaryRange, comparisonRange).catch((e) => {
        console.warn(`[client-profile ${id}] overview QBO fetch failed:`, e?.message);
        return null;
      }),
      fetchBalanceSheetSummary(realmId, accessToken).catch((e) => {
        console.warn(`[client-profile ${id}] BS QBO fetch failed:`, e?.message);
        return null;
      }),
    ]);
  }

  return (
    <AppShell>
      <TopBar
        title={clientLink.client_name || "Client"}
        subtitle={
          [
            clientLink.industry,
            clientLink.state_province || clientLink.jurisdiction,
            clientLink.status,
          ]
            .filter(Boolean)
            .join(" · ") || "Client profile"
        }
      />
      <ClientProfileShell
        clientLink={clientLink as any}
        actorRole={role}
        overview={{
          outstanding,
          activity,
          summary,
          progress,
        }}
        financials={{
          overview,
          balanceSheet,
          primaryRangeLabel: `${primaryRange.start} → ${primaryRange.end}`,
          comparisonRangeLabel: `${comparisonRange.start} → ${comparisonRange.end}`,
          activeRangeKey: ranges.activeKey,
          hasQbo,
          // Three-state QBO health for the connection banner:
          //   - never_connected: client has no qbo_realm_id at all
          //   - token_expired:    has realm but getValidToken returned null
          //                        (refresh failed — most often 100-day
          //                        idle expiry or client revoked SNAP in QBO)
          //   - connected:        has realm AND token refresh succeeded
          qboStatus: !hasQbo
            ? ("never_connected" as const)
            : accessToken
            ? ("connected" as const)
            : ("token_expired" as const),
        }}
      />
    </AppShell>
  );
}
