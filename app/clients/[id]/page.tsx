import Link from "next/link";
import { FileText } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { notFound, redirect } from "next/navigation";
import { ClientProfileShell } from "./client-profile-shell";
import { deriveClientLifecycle, MACRO_STAGE_META } from "@/lib/client-lifecycle";
import { LifecyclePill } from "@/components/LifecyclePill";
import { ClientSwitcher } from "@/components/ClientSwitcher";
import {
  fetchOutstandingWork,
  fetchRecentActivity,
  fetchInternalSummary,
  fetchClientProgress,
} from "@/lib/internal-client-profile";
import { getValidToken, QBOReauthRequiredError } from "@/lib/qbo";
import { extractFormAnswers } from "@/lib/onboarding";
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
 * Default behaviour: always "last month" — the most recent completed
 * (closeable) period. A partial current month reads as wrong numbers to
 * anyone reviewing statements; This Month is one click away when the
 * bookkeeper wants in-progress activity.
 *
 * Comparison period mirrors the primary: this-month vs last-month,
 * last-month vs the month before, YTD vs prior YTD, etc. Always exactly
 * one period back, never two.
 */
function resolveDateRanges(
  rangeParam: string | undefined,
  customStart?: string,
  customEnd?: string
): { primary: DateRange; comparison: DateRange; activeKey: string } {
  const now = new Date();

  // No explicit range → default to the last completed month (the most
  // recent closeable period). A partial current month reads as "wrong
  // numbers" to anyone reviewing statements; This Month stays one click
  // away for in-progress checks.
  const key = rangeParam || "last-month";

  // Custom range from the date pickers. Comparison = the same-length
  // window immediately before. Falls through to the default if the dates
  // are missing/invalid.
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  if (key === "custom" && customStart && customEnd && ISO.test(customStart) && ISO.test(customEnd) && customStart <= customEnd) {
    const s = new Date(customStart + "T00:00:00");
    const e = new Date(customEnd + "T00:00:00");
    const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
    const priorEnd = new Date(s.getTime() - 86400000);
    const priorStart = new Date(priorEnd.getTime() - (days - 1) * 86400000);
    return {
      primary: { start: customStart, end: customEnd, label: "Custom range" },
      comparison: {
        start: priorStart.toISOString().slice(0, 10),
        end: priorEnd.toISOString().slice(0, 10),
        label: "Prior period",
      },
      activeKey: "custom",
    };
  }

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
      // Unknown key — fall back to the default (last completed month)
      return resolveDateRanges("last-month");
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
  searchParams?: Promise<{ range?: string; start?: string; end?: string }>;
}) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const ranges = resolveDateRanges(sp.range, sp.start, sp.end);
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
    .select("id, client_name, qbo_realm_id, industry, jurisdiction, state_province, status, last_synced_at, double_client_id, double_client_name, daily_recon_enabled, daily_recon_paused, daily_recon_paused_reason, daily_recon_enabled_at, cleanup_completed_at, cleanup_review_state, bs_enabled, contact_first_name, contact_last_name, client_email, client_phone, legal_business_name, trade_type, corporate_type, entity_type, fiscal_year_end, country, address_line1, address_line2, city, postal_code, annual_revenue_range, taxes_up_to_date, prior_bookkeeper, accounting_software, payroll_provider, employee_count_range, uses_business_cards, keeps_receipts, bank_connected_to_software, profile_updated_at" as any)
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
    daily_recon_enabled: boolean | null;
    daily_recon_paused: boolean | null;
    daily_recon_paused_reason: string | null;
    daily_recon_enabled_at: string | null;
    cleanup_completed_at: string | null;
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
        // Dead refresh token → bounce the user to the reconnect flow.
        // redirect() throws an internal Next.js error that the runtime
        // catches and converts into a 307 — do not swallow it.
        if (e instanceof QBOReauthRequiredError) redirect(e.reconnectUrl);
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

  // Onboarding lead linked to this client (set when the lead was converted
  // via the onboarding board). Surfaces the GHL onboarding-form answers + call
  // info on the profile so a senior can reference them without opening GHL.
  // Tolerates migration 70 not being applied yet.
  let onboarding: any = null;
  try {
    const { data: ob } = await (service as any)
      .from("onboarding_leads")
      .select(
        "won_at, ob_form_submitted_at, ob_form_payload, ob_call_time, ob_call_status, ob_call_attended_at"
      )
      .eq("client_link_id", id)
      .maybeSingle();
    if (ob) {
      onboarding = {
        won_at: ob.won_at,
        ob_form_submitted_at: ob.ob_form_submitted_at,
        ob_call_time: ob.ob_call_time,
        ob_call_status: ob.ob_call_status,
        ob_call_attended_at: ob.ob_call_attended_at,
        answers: extractFormAnswers(ob.ob_form_payload),
      };
    }
  } catch (e: any) {
    console.warn(`[client-profile ${id}] onboarding fetch failed:`, e?.message);
  }

  // BS cleanup deferred? Reuses bs_enabled (false = P&L-only / BS still owed).
  let bsCleanupOwed = false;
  try {
    const { data: bsRow } = await (service as any)
      .from("client_links").select("bs_enabled").eq("id", id).single();
    bsCleanupOwed = (bsRow as any)?.bs_enabled === false;
  } catch { /* ignore */ }

  // Precise lifecycle stage for the header pill — the unmistakable
  // "onboarding/cleanup vs in-production" signal, same source as /clients.
  let lifecycle = null;
  let macroStage: "onboarding" | "cleanup" | "production" | null = null;
  try {
    const lc = await deriveClientLifecycle(service, clientLink as any);
    lifecycle = lc.status;
    macroStage = lc.stage;
  } catch { /* non-critical */ }

  return (
    <AppShell>
      <TopBar
        title={clientLink.client_name || "Client"}
        subtitle={
          [
            clientLink.industry,
            clientLink.state_province || clientLink.jurisdiction,
          ]
            .filter(Boolean)
            .join(" · ") || "Client profile"
        }
        actions={
          <>
            {(() => {
              const isCA = String(clientLink.jurisdiction || "").toUpperCase().startsWith("CA");
              return (
                <span
                  title={isCA ? "Canada" : "United States"}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-ink-slate bg-gray-50 border border-gray-200 rounded-full px-2 py-1"
                >
                  <span className="text-base leading-none">{isCA ? "🇨🇦" : "🇺🇸"}</span>
                  {isCA ? "CA" : "US"}
                </span>
              );
            })()}
            {clientLink.qbo_realm_id && (
              <Link
                href={`/clients/${clientLink.id}/tax-export`}
                className="inline-flex items-center gap-1.5 text-xs font-bold text-white bg-teal hover:bg-teal-dark rounded-lg px-3 py-2"
                title={String(clientLink.jurisdiction || "").toUpperCase().startsWith("CA")
                  ? "Export tax documents (T2 / T2125 / GIFI)"
                  : "Export tax documents (1120 / 1120-S / 1065 / Sch C)"}
              >
                <FileText size={13} /> Export Tax Docs
              </Link>
            )}
            {macroStage && (
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ${MACRO_STAGE_META[macroStage].tone}`}
                title={MACRO_STAGE_META[macroStage].description}
              >
                {MACRO_STAGE_META[macroStage].label}
              </span>
            )}
            {lifecycle && <LifecyclePill status={lifecycle} size="md" />}
            <ClientSwitcher
              currentId={clientLink.id}
              currentName={clientLink.client_name || "Client"}
            />
          </>
        }
      />
      <ClientProfileShell
        clientLink={clientLink as any}
        actorRole={role}
        onboarding={onboarding}
        bsCleanupOwed={bsCleanupOwed}
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
          rangeStart: primaryRange.start,
          rangeEnd: primaryRange.end,
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
