import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import Link from "next/link";
import {
  Plus,
  ArrowRight,
  Flag,
  CheckCircle2,
  Zap,
  AlertTriangle,
  Timer,
  Wifi,
  CreditCard,
  Clock,
} from "lucide-react";
import { DashboardCharts, type WeeklyPoint, type BookkeeperPoint } from "./dashboard-charts";

export const dynamic = "force-dynamic";

const ACTIVE_STATUSES = ["draft", "in_review", "pending_lisa", "approved", "executing"];

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  in_review: "In Review",
  pending_lisa: "Flagged for Senior",
  approved: "Ready to Execute",
  executing: "Executing",
};

function daysBetween(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function daysUntil(iso: string): number {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86400000);
}

export default async function DashboardPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const service = createServiceSupabase();

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000).toISOString();
  const fourteenDaysFromNow = new Date(now.getTime() + 14 * 86400000).toISOString();
  const eightWeeksAgo = new Date(now.getTime() - 56 * 86400000).toISOString();

  const [
    profileRes,
    clientsRes,
    qboExpiryRes,
    allCoaRes,
    allReclassRes,
    completedMonthRes,
    eightWeeksRes,
    bookkeepersRes,
    stripeCountRes,
    assignedClientsRes,
    pendingStripeTokensRes,
    recentStripeConnectionsRes,
    readyForCleanupRes,
    activeCleanupClientsRes,
  ] = await Promise.all([
    service.from("users").select("role, full_name").eq("id", user!.id).single(),

    service
      .from("client_list_view")
      .select("id, client_name, status, is_active, last_cleanup_at")
      .eq("is_active", true),

    service
      .from("client_links")
      .select("id, client_name, qbo_token_expires_at")
      .eq("is_active", true)
      .not("qbo_token_expires_at", "is", null)
      .lte("qbo_token_expires_at", fourteenDaysFromNow),

    service
      .from("coa_jobs")
      .select("id, status, created_at, updated_at, bookkeeper_id, client_link_id, client_links!client_link_id(client_name)")
      .in("status", ACTIVE_STATUSES),

    service
      .from("reclass_jobs")
      .select("id, status, created_at, updated_at, bookkeeper_id, client_link_id, client_links!client_link_id(client_name)")
      .in("status", ACTIVE_STATUSES),

    // Completed this month — used for stats + per-bookkeeper chart
    service
      .from("coa_jobs")
      .select("id, client_link_id, bookkeeper_id, created_at, execution_completed_at")
      .eq("status", "complete")
      .not("execution_completed_at", "is", null)
      .gte("updated_at", startOfMonth),

    // Completed last 8 weeks — weekly trend charts
    service
      .from("coa_jobs")
      .select("id, bookkeeper_id, created_at, execution_completed_at")
      .eq("status", "complete")
      .not("execution_completed_at", "is", null)
      .gte("execution_completed_at", eightWeeksAgo),

    service
      .from("users")
      .select("id, full_name")
      .eq("is_active", true)
      .in("role", ["admin", "lead", "bookkeeper"])
      .order("full_name"),

    service
      .from("client_links")
      .select("id", { count: "exact", head: true })
      .eq("stripe_connection_status", "connected")
      .eq("is_active", true),

    // Assigned clients for junior view — ordered by due date soonest first
    service
      .from("client_links")
      .select("id, client_name, due_date, status")
      .eq("assigned_bookkeeper_id", user!.id)
      .eq("is_active", true)
      .order("due_date", { ascending: true }),

    // Outstanding Stripe Connect requests: unused tokens for clients whose
    // connection status is still pending. We order by created_at so the
    // oldest (most overdue) requests surface first.
    service
      .from("stripe_connect_tokens")
      .select("id, client_link_id, created_at, expires_at, used_at, client_links!inner(client_name, stripe_connection_status, is_active)")
      .is("used_at", null)
      .order("created_at", { ascending: true }),

    // Recently connected clients (last 14 days) — the "good news" section.
    service
      .from("client_links")
      .select("id, client_name, stripe_connected_at")
      .eq("stripe_connection_status", "connected")
      .eq("is_active", true)
      .not("stripe_connected_at", "is", null)
      .gte("stripe_connected_at", new Date(now.getTime() - 14 * 86400000).toISOString())
      .order("stripe_connected_at", { ascending: false }),

    // STRIPE-CONNECTED CLIENTS READY FOR CLEANUP.
    // The full list of clients who:
    //   1. Have Stripe connected (so the deterministic Stripe API
    //      reconciliation path is unlocked)
    //   2. AND either have never been marked complete, or were marked
    //      complete BEFORE they connected Stripe (so the existing
    //      cleanup didn't get the Stripe-side data)
    // We exclude clients with an active cleanup separately (next query)
    // so they don't appear here while a bookkeeper is already on it.
    service
      .from("client_links")
      .select(
        "id, client_name, jurisdiction, state_province, stripe_connected_at, cleanup_completed_at, assigned_bookkeeper_id, due_date"
      )
      .eq("stripe_connection_status", "connected")
      .eq("is_active", true)
      .not("stripe_connected_at", "is", null)
      .order("stripe_connected_at", { ascending: false }),

    // Active in-flight cleanups — used to filter clients out of the
    // Ready-for-Cleanup widget when work is already underway. Includes
    // every non-terminal status so a client with a failed job (which
    // blocks new jobs via the concurrency guard) doesn't show up here
    // either — that needs senior attention, not a fresh start.
    service
      .from("coa_jobs")
      .select("client_link_id, status")
      .in("status", ["draft", "in_review", "pending_lisa", "approved", "executing", "failed"]),

  ]);

  const profile = profileRes.data;
  const isSenior = profile && ["admin", "lead"].includes(profile.role);
  const isAdmin = profile?.role === "admin";
  const isJunior = profile?.role === "bookkeeper";

  // Flagged counts — senior only, second round-trip is fine since it's conditional
  let flaggedCounts = { coa: 0, reclass: 0, stripe: 0 };
  if (isSenior) {
    const [coaFlagRes, reclassFlagRes, stripeFlagRes] = await Promise.all([
      service
        .from("coa_actions")
        .select("id, coa_jobs!inner(id, users!bookkeeper_id(id))")
        .eq("action", "flag")
        .eq("executed", false),
      service
        .from("reclassifications")
        .select("id, reclass_jobs!reclass_job_id!inner(id, users!bookkeeper_id(id))")
        .eq("decision", "flagged"),
      service
        .from("stripe_recon_matches")
        .select("id, stripe_recon_jobs!inner(id, users!bookkeeper_id(id))")
        .eq("decision", "flagged")
        .eq("executed", false),
    ]);
    flaggedCounts = {
      coa: (coaFlagRes.data || []).filter((r: any) => r.coa_jobs).length,
      reclass: (reclassFlagRes.data || []).filter((r: any) => r.reclass_jobs).length,
      stripe: (stripeFlagRes.data || []).filter((r: any) => r.stripe_recon_jobs).length,
    };
  }

  // ─── Derive everything in JS ───

  const bookkeepers = bookkeepersRes.data || [];
  const bkById = new Map(bookkeepers.map((b) => [b.id, b.full_name]));

  const allCoaJobs = (allCoaRes.data || []).map((j) => ({
    ...j,
    jobType: "coa" as const,
    href: `/jobs/${j.id}/review`,
    clientName: (j as any).client_links?.client_name || "Unknown",
  }));
  const allReclassJobs = (allReclassRes.data || []).map((j) => ({
    ...j,
    jobType: "reclass" as const,
    href: `/reclass/${j.id}/review`,
    clientName: (j as any).client_links?.client_name || "Unknown",
  }));
  const allActiveJobs = [...allCoaJobs, ...allReclassJobs];

  const myJobs = allActiveJobs.filter((j) => j.bookkeeper_id === user!.id);

  // Map client_link_id → active job for the junior "resume vs start" CTA
  const activeJobByClientId = new Map<string, { href: string; status: string; jobType: string }>();
  for (const job of allActiveJobs) {
    if (!activeJobByClientId.has((job as any).client_link_id)) {
      activeJobByClientId.set((job as any).client_link_id, {
        href: job.href,
        status: job.status,
        jobType: job.jobType,
      });
    }
  }

  const myAssignedClients = (assignedClientsRes.data || []) as {
    id: string;
    client_name: string;
    due_date: string | null;
    status: string;
  }[];

  const stalledJobs = allActiveJobs.filter((j) => {
    const ref = j.updated_at || j.created_at;
    return ref && ref < sevenDaysAgo;
  });

  const clients = clientsRes.data || [];
  const clientsNeedingCleanup = clients
    .filter((c) => {
      if (c.status === "churned" || c.status === "onboarding") return false;
      if (!c.last_cleanup_at) return true;
      return c.last_cleanup_at < ninetyDaysAgo;
    })
    .slice(0, 12);

  const qboExpiring = (qboExpiryRes.data || []).sort(
    (a, b) => new Date(a.qbo_token_expires_at!).getTime() - new Date(b.qbo_token_expires_at!).getTime()
  );

  // Stats
  const activeJobsCount = allActiveJobs.length;
  // Dedupe by client_link_id — only the most recent completion per client counts
  const completedThisMonthAll = completedMonthRes.data || [];
  const seenClientIds = new Set<string>();
  const completedThisMonthJobs = completedThisMonthAll.filter((j) => {
    if (!j.client_link_id || seenClientIds.has(j.client_link_id)) return false;
    seenClientIds.add(j.client_link_id);
    return true;
  });
  const completedThisMonth = completedThisMonthJobs.length;
  const stripeConnected = stripeCountRes.count || 0;

  // ─── Stripe Connect status (senior-only card) ───
  // Outstanding requests: unused tokens where the client_link is still pending.
  // Recent connections: the friendly "X just connected" list.
  interface PendingStripeRequest {
    client_link_id: string;
    client_name: string;
    created_at: string;
    expires_at: string;
    daysOutstanding: number;
    daysUntilExpiry: number;
    isExpired: boolean;
  }
  const pendingRaw = (pendingStripeTokensRes.data || []) as any[];
  // One row per client — keep oldest unused token per client (most overdue).
  //
  // Only show clients whose status is explicitly 'pending'. The generate-link
  // endpoint sets the status when a link is sent; the OAuth callback flips it
  // to 'connected' on completion; disconnect resets it to 'not_set'. So a
  // disconnected client with a stale unused token won't appear here (correct
  // — the bookkeeper would generate a fresh link if they wanted to retry).
  const pendingByClient = new Map<string, PendingStripeRequest>();
  for (const row of pendingRaw) {
    const cl = row.client_links;
    if (!cl) continue;
    if (cl.is_active === false) continue;
    if (cl.stripe_connection_status !== "pending") continue;
    if (pendingByClient.has(row.client_link_id)) continue; // we sorted asc, oldest first
    const created = row.created_at as string | null;
    const expires = row.expires_at as string;
    if (!created) continue;
    pendingByClient.set(row.client_link_id, {
      client_link_id: row.client_link_id,
      client_name: cl.client_name,
      created_at: created,
      expires_at: expires,
      daysOutstanding: daysBetween(created),
      daysUntilExpiry: daysUntil(expires),
      isExpired: new Date(expires).getTime() < now.getTime(),
    });
  }
  const pendingStripeRequests = Array.from(pendingByClient.values()).sort(
    (a, b) => b.daysOutstanding - a.daysOutstanding
  );

  const recentStripeConnections = ((recentStripeConnectionsRes.data || []) as Array<{
    id: string;
    client_name: string;
    stripe_connected_at: string;
  }>).map((c) => ({
    ...c,
    daysAgo: daysBetween(c.stripe_connected_at),
  }));

  // "New" badge if any client connected in the past 48h
  const hasFreshStripeConnection = recentStripeConnections.some((c) => c.daysAgo <= 2);

  // ─── Stripe-Connected, Ready for Cleanup ───
  //
  // Bookkeepers were missing newly-connected Stripe clients because the
  // "recent connections" panel surfaces every connection regardless of
  // cleanup status (great or not, work to do or not). This widget is
  // narrower: clients with Stripe connected AND no cleanup yet (or whose
  // most recent cleanup predates the Stripe connection, meaning the
  // existing cleanup didn't benefit from Stripe data) AND no active
  // in-flight job. Sorted with most-recent-connection-first so the
  // freshest opportunities float to the top.
  const activeCleanupClientIds = new Set(
    (activeCleanupClientsRes.data || [])
      .map((j: any) => j.client_link_id)
      .filter(Boolean)
  );
  // Cast through unknown because cleanup_completed_at + due_date aren't in
  // the regenerated supabase types yet (added by migration 19, types
  // haven't been re-pulled). Runtime shape is correct.
  const readyForCleanup = ((readyForCleanupRes.data || []) as unknown as Array<{
    id: string;
    client_name: string;
    jurisdiction: string;
    state_province: string | null;
    stripe_connected_at: string;
    cleanup_completed_at: string | null;
    assigned_bookkeeper_id: string | null;
    due_date: string | null;
  }>)
    .filter((c) => {
      // Skip clients with active in-flight work — those already show up
      // in the senior work queue, no need to nag.
      if (activeCleanupClientIds.has(c.id)) return false;
      // If never completed, definitely ready.
      if (!c.cleanup_completed_at) return true;
      // If connected AFTER last completion, the prior cleanup didn't
      // have Stripe data — they're ready for a fresh pass.
      return (
        new Date(c.stripe_connected_at).getTime() >
        new Date(c.cleanup_completed_at).getTime()
      );
    })
    .map((c) => ({
      ...c,
      daysSinceConnection: daysBetween(c.stripe_connected_at),
      hasPriorCleanup: !!c.cleanup_completed_at,
    }));


  // Avg minutes per cleanup = (execution_completed_at - created_at) in minutes
  function elapsedMinutes(job: { created_at: string | null; execution_completed_at: string | null }): number | null {
    if (!job.created_at || !job.execution_completed_at) return null;
    const diff = new Date(job.execution_completed_at).getTime() - new Date(job.created_at).getTime();
    return Math.round(diff / 60000);
  }

  const allMinutes = completedThisMonthJobs.map(elapsedMinutes).filter((m): m is number => m !== null);
  const avgMinutesThisMonth =
    allMinutes.length > 0 ? Math.round(allMinutes.reduce((a, b) => a + b, 0) / allMinutes.length) : null;

  // ─── Chart data ───

  // Build 8 weekly buckets, oldest first
  const weekBuckets: { label: string; start: number; end: number }[] = [];
  const thisMonday = new Date(now);
  thisMonday.setDate(thisMonday.getDate() - ((thisMonday.getDay() + 6) % 7)); // ISO Monday
  thisMonday.setHours(0, 0, 0, 0);
  for (let i = 7; i >= 0; i--) {
    const start = new Date(thisMonday.getTime() - i * 7 * 86400000);
    const end = new Date(start.getTime() + 7 * 86400000);
    weekBuckets.push({
      label: start.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      start: start.getTime(),
      end: end.getTime(),
    });
  }

  const eightWeeksJobs = eightWeeksRes.data || [];
  const weeklyData: WeeklyPoint[] = weekBuckets.map((w) => {
    const weekJobs = eightWeeksJobs.filter((j) => {
      const t = new Date(j.execution_completed_at!).getTime();
      return t >= w.start && t < w.end;
    });
    const mins = weekJobs.map(elapsedMinutes).filter((m): m is number => m !== null);
    return {
      week: w.label,
      jobs: weekJobs.length,
      avgMinutes: mins.length > 0 ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
    };
  });

  const bookkeepersData: BookkeeperPoint[] = bookkeepers
    .map((bk) => {
      const bkJobs = completedThisMonthJobs.filter((j) => j.bookkeeper_id === bk.id);
      const mins = bkJobs.map(elapsedMinutes).filter((m): m is number => m !== null);
      return {
        name: bk.full_name.split(" ")[0],
        cleanups: bkJobs.length,
        avgMinutes: mins.length > 0 ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
      };
    })
    .filter((bk) => bk.cleanups > 0);

  // Team workload — only bookkeepers with any activity
  const completedByBk = new Map<string, number>();
  for (const j of completedMonthRes.data || []) {
    completedByBk.set(j.bookkeeper_id, (completedByBk.get(j.bookkeeper_id) || 0) + 1);
  }
  const teamWorkload = bookkeepers
    .map((bk) => {
      const bkJobs = allActiveJobs.filter((j) => j.bookkeeper_id === bk.id);
      const stalled = bkJobs.filter((j) => {
        const ref = j.updated_at || j.created_at;
        return ref && ref < sevenDaysAgo;
      }).length;
      return {
        ...bk,
        inFlight: bkJobs.length,
        stalled,
        completedMonth: completedByBk.get(bk.id) || 0,
      };
    })
    .filter((bk) => bk.inFlight > 0 || bk.completedMonth > 0);

  const totalFlagged = flaggedCounts.coa + flaggedCounts.reclass + flaggedCounts.stripe;
  const hasAttentionItems =
    qboExpiring.length > 0 || stalledJobs.length > 0 || clientsNeedingCleanup.length > 0;

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <AppShell>
      <TopBar
        title="Dashboard"
        subtitle={today}
        actions={
          <Link
            href="/jobs/new"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg"
          >
            <Plus size={16} />
            New Cleanup
          </Link>
        }
      />

      <div className="px-8 py-6 space-y-6">

        {/* ─── Stats strip ─── */}
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: "Active Jobs", value: activeJobsCount, icon: Zap, color: "#2D7A75" },
            { label: "Completed This Month", value: completedThisMonth, icon: CheckCircle2, color: "#10B981" },
            {
              label: "Avg Minutes Per Cleanup",
              value: avgMinutesThisMonth !== null ? `${avgMinutesThisMonth}m` : "—",
              icon: Timer,
              color: "#0891B2",
            },
            { label: "Stripe Connected", value: stripeConnected, icon: Wifi, color: "#7C3AED" },
          ].map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.label} className="p-5 rounded-xl bg-white border border-gray-200">
                <div className="flex items-start justify-between mb-3">
                  <div className="p-2 rounded-lg" style={{ backgroundColor: `${s.color}15` }}>
                    <Icon size={18} style={{ color: s.color }} />
                  </div>
                </div>
                <div className="text-2xl font-bold tracking-tight text-navy">{s.value}</div>
                <div className="text-sm mt-1 text-ink-slate">{s.label}</div>
              </div>
            );
          })}
        </div>

        {/* ─── Charts ─── */}
        <DashboardCharts weeklyData={weeklyData} bookkeepersData={bookkeepersData} />

        {/* ─── New Stripe Connections — Ready for Cleanup ───
            Surfaces every client who has connected Stripe AND doesn't
            have an active cleanup AND either never had a cleanup or
            connected AFTER their last one (so the existing cleanup
            didn't benefit from Stripe data). Sorted newest-connection
            first so fresh opportunities are visible immediately. */}
        {readyForCleanup.length > 0 && (
          <div className="rounded-xl bg-white border border-gray-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 bg-teal-lighter">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-teal-light">
                    <CreditCard size={16} className="text-teal-dark" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-navy">
                      New Stripe Clients Ready to Start
                    </h2>
                    <p className="text-xs text-ink-slate mt-0.5">
                      {readyForCleanup.length} client{readyForCleanup.length !== 1 ? "s" : ""} connected Stripe and are ready for their first cleanup.
                    </p>
                  </div>
                </div>
                <span className="rounded-full bg-navy text-white text-xs font-bold px-2.5 py-1">
                  {readyForCleanup.length}
                </span>
              </div>
            </div>
            <div className="divide-y divide-gray-100">
              {readyForCleanup.slice(0, 12).map((c) => {
                const assignee = c.assigned_bookkeeper_id
                  ? bkById.get(c.assigned_bookkeeper_id) || "Unknown"
                  : null;
                const isFresh = c.daysSinceConnection <= 2;
                return (
                  <Link
                    key={c.id}
                    href={`/jobs/new?client=${c.id}`}
                    className="flex items-center gap-4 px-5 py-3 hover:bg-teal-light/40 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-navy">
                          {c.client_name}
                        </span>
                        <span className="text-[10px] font-bold uppercase tracking-wider text-ink-light">
                          {c.jurisdiction}
                          {c.state_province ? ` · ${c.state_province}` : ""}
                        </span>
                        {isFresh && (
                          <span className="rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5">
                            New
                          </span>
                        )}
                        {c.hasPriorCleanup && (
                          <span className="rounded-full bg-gray-100 text-ink-slate text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5">
                            Re-cleanup
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-slate mt-0.5 flex items-center gap-3 flex-wrap">
                        <span className="flex items-center gap-1">
                          <Clock size={11} />
                          Connected{" "}
                          {c.daysSinceConnection === 0
                            ? "today"
                            : `${c.daysSinceConnection}d ago`}
                        </span>
                        {assignee && (
                          <span>
                            Assigned to <span className="font-semibold text-navy">{assignee}</span>
                          </span>
                        )}
                        {!assignee && (
                          <span className="text-amber-700 font-semibold">Unassigned</span>
                        )}
                      </div>
                    </div>
                    <ArrowRight size={14} className="text-ink-light flex-shrink-0" />
                  </Link>
                );
              })}
              {readyForCleanup.length > 12 && (
                <div className="px-5 py-3 text-xs text-ink-slate bg-gray-50">
                  + {readyForCleanup.length - 12} more — see the{" "}
                  <Link href="/clients" className="text-teal font-semibold hover:underline">
                    full clients list
                  </Link>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── My Clients (junior) / My Work Queue (senior+admin) ─── */}
        {isJunior ? (
          <div className="rounded-xl bg-white border border-gray-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200">
              <h2 className="text-base font-bold text-navy">My Clients</h2>
              <p className="text-xs text-ink-slate mt-0.5">
                {myAssignedClients.length === 0
                  ? "No clients assigned to you yet"
                  : `${myAssignedClients.length} client${myAssignedClients.length !== 1 ? "s" : ""} assigned · sorted by due date`}
              </p>
            </div>
            {myAssignedClients.length === 0 ? (
              <div className="px-5 py-8 text-center">
                <CheckCircle2 size={22} className="text-teal mx-auto mb-2" />
                <p className="text-sm text-ink-slate">Check back soon — your manager will assign clients here.</p>
              </div>
            ) : (
              <div>
                {myAssignedClients.map((c) => {
                  const activeJob = activeJobByClientId.get(c.id);
                  const daysLeft = c.due_date
                    ? Math.ceil((new Date(c.due_date).getTime() - Date.now()) / 86400000)
                    : null;
                  const isOverdue = daysLeft !== null && daysLeft < 0;
                  const isDueSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 1;

                  return (
                    <div
                      key={c.id}
                      className="flex items-center px-5 py-3.5 border-b border-gray-100 last:border-0"
                    >
                      <div className="rounded-lg flex items-center justify-center font-bold text-sm flex-shrink-0 mr-4 w-9 h-9 bg-teal-light text-teal">
                        {c.client_name.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm text-navy">{c.client_name}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {daysLeft !== null && (
                            <span
                              className={`text-[11px] font-semibold ${
                                isOverdue
                                  ? "text-red-600"
                                  : isDueSoon
                                  ? "text-amber-600"
                                  : "text-ink-slate"
                              }`}
                            >
                              {isOverdue
                                ? `Overdue by ${Math.abs(daysLeft)}d`
                                : daysLeft === 0
                                ? "Due today"
                                : daysLeft === 1
                                ? "Due tomorrow"
                                : `Due ${new Date(c.due_date!).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                            </span>
                          )}
                          {activeJob && (
                            <span className="text-[11px] text-ink-slate">
                              · {activeJob.jobType === "coa" ? "COA" : "Reclass"} in progress
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex-shrink-0">
                        {activeJob ? (
                          <Link
                            href={activeJob.href}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-teal hover:text-teal-dark"
                          >
                            Resume <ArrowRight size={12} />
                          </Link>
                        ) : (
                          <Link
                            href={`/jobs/new?client=${c.id}`}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-navy hover:text-teal"
                          >
                            Start <ArrowRight size={12} />
                          </Link>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl bg-white border border-gray-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200">
              <h2 className="text-base font-bold text-navy">My Work Queue</h2>
              <p className="text-xs text-ink-slate mt-0.5">
                {myJobs.length === 0
                  ? "Nothing in progress — start a new cleanup or resume a stalled job below"
                  : `${myJobs.length} job${myJobs.length !== 1 ? "s" : ""} in progress`}
              </p>
            </div>
            {myJobs.length === 0 ? (
              <div className="px-5 py-8 text-center">
                <CheckCircle2 size={22} className="text-teal mx-auto mb-2" />
                <p className="text-sm text-ink-slate">Start a new cleanup or pick up a stalled job below.</p>
              </div>
            ) : (
              <div>
                {myJobs.map((job) => {
                  const ref = job.updated_at || job.created_at;
                  const daysOld = ref ? daysBetween(ref) : null;
                  const isStalled = daysOld !== null && daysOld >= 7;
                  return (
                    <Link
                      key={job.id}
                      href={job.href}
                      className="flex items-center px-5 py-3.5 hover:bg-teal-lighter transition-colors border-b border-gray-100 last:border-0"
                    >
                      <div className="rounded-lg flex items-center justify-center font-bold text-sm flex-shrink-0 mr-4 w-9 h-9 bg-teal-light text-teal">
                        {job.clientName.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm text-navy">{job.clientName}</div>
                        <div className="text-xs text-ink-slate mt-0.5">
                          {job.jobType === "coa" ? "COA Cleanup" : "Reclassify"} ·{" "}
                          {STATUS_LABEL[job.status] || job.status}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {isStalled ? (
                          <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                            Stalled {daysOld}d
                          </span>
                        ) : daysOld !== null ? (
                          <span className="text-xs text-ink-slate">
                            {daysOld === 0 ? "Today" : `${daysOld}d ago`}
                          </span>
                        ) : null}
                        <ArrowRight size={14} className="text-ink-light" />
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ─── Needs Attention ─── */}
        {hasAttentionItems && (
          <div className="rounded-xl bg-white border border-gray-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200">
              <h2 className="text-base font-bold text-navy">Needs Attention</h2>
              <p className="text-xs text-ink-slate mt-0.5">Expiring QBO tokens, stalled jobs, and clients overdue for cleanup</p>
            </div>

            {/* QBO token expiry */}
            {qboExpiring.length > 0 && (
              <div className="border-b border-gray-100">
                <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-100 flex items-center gap-2">
                  <AlertTriangle size={12} className="text-amber-600" />
                  <span className="text-[11px] font-bold text-amber-800 uppercase tracking-wide">
                    QBO Token Expiring Soon
                  </span>
                </div>
                {qboExpiring.map((c) => {
                  const days = daysUntil(c.qbo_token_expires_at!);
                  return (
                    <div
                      key={c.id}
                      className="flex items-center justify-between px-5 py-3 border-b border-gray-50 last:border-0"
                    >
                      <span className="text-sm font-medium text-navy">{c.client_name}</span>
                      <span
                        className={`text-xs font-semibold ${
                          days <= 0
                            ? "text-red-700"
                            : days <= 3
                            ? "text-red-600"
                            : "text-amber-700"
                        }`}
                      >
                        {days <= 0 ? "Expired" : `Expires in ${days}d`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Stalled jobs */}
            {stalledJobs.length > 0 && (
              <div className="border-b border-gray-100">
                <div className="px-5 py-2.5 bg-gray-50 border-b border-gray-100">
                  <span className="text-[11px] font-bold text-ink-slate uppercase tracking-wide">
                    Stalled Jobs · {stalledJobs.length}
                  </span>
                </div>
                {stalledJobs.slice(0, 8).map((job) => {
                  const ref = job.updated_at || job.created_at;
                  const daysOld = ref ? daysBetween(ref) : 0;
                  const bkName = bkById.get(job.bookkeeper_id) || "Unknown";
                  return (
                    <Link
                      key={job.id}
                      href={job.href}
                      className="flex items-center px-5 py-3 hover:bg-teal-lighter transition-colors border-b border-gray-50 last:border-0"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm text-navy">{job.clientName}</div>
                        <div className="text-xs text-ink-slate mt-0.5">
                          {job.jobType === "coa" ? "COA Cleanup" : "Reclassify"} ·{" "}
                          {STATUS_LABEL[job.status] || job.status} · {bkName}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-amber-700">
                          Stalled {daysOld}d
                        </span>
                        <ArrowRight size={13} className="text-ink-light" />
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}

            {/* Clients with no recent cleanup */}
            {clientsNeedingCleanup.length > 0 && (
              <div>
                <div className="px-5 py-2.5 bg-gray-50 border-b border-gray-100">
                  <span className="text-[11px] font-bold text-ink-slate uppercase tracking-wide">
                    No Cleanup in 90+ Days · {clientsNeedingCleanup.length}
                  </span>
                </div>
                {clientsNeedingCleanup.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center px-5 py-3 border-b border-gray-50 last:border-0"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm text-navy">{c.client_name}</div>
                      <div className="text-xs text-ink-slate mt-0.5">
                        {c.last_cleanup_at
                          ? `Last cleanup ${daysBetween(c.last_cleanup_at)}d ago`
                          : "Never cleaned up"}
                      </div>
                    </div>
                    <Link
                      href={`/jobs/new?client=${c.id}`}
                      className="text-xs font-semibold text-teal hover:text-teal-dark flex items-center gap-1"
                    >
                      Start <ArrowRight size={12} />
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── Flagged for Senior Review ─── (senior / admin only) */}
        {isSenior && (
          <div
            className={`rounded-xl border overflow-hidden ${
              totalFlagged > 0 ? "bg-amber-50 border-amber-200" : "bg-white border-gray-200"
            }`}
          >
            <div className="px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={`p-2 rounded-lg ${totalFlagged > 0 ? "bg-amber-100" : "bg-gray-100"}`}
                >
                  <Flag
                    size={16}
                    className={totalFlagged > 0 ? "text-amber-600" : "text-ink-slate"}
                  />
                </div>
                <div>
                  <h2 className="text-base font-bold text-navy">Flagged for Senior Review</h2>
                  <p className="text-xs text-ink-slate mt-0.5">
                    {totalFlagged === 0
                      ? "Nothing in the queue — all clear"
                      : `${totalFlagged} item${totalFlagged !== 1 ? "s" : ""} waiting`}
                  </p>
                </div>
              </div>
              {totalFlagged > 0 && (
                <Link
                  href="/approvals"
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-800 hover:text-amber-900"
                >
                  Review All <ArrowRight size={14} />
                </Link>
              )}
            </div>
            {totalFlagged > 0 && (
              <div className="border-t border-amber-200 px-5 py-3 flex items-center gap-3">
                {flaggedCounts.coa > 0 && (
                  <span className="text-xs font-semibold bg-white border border-amber-200 rounded-md px-2.5 py-1 text-amber-800">
                    {flaggedCounts.coa} COA
                  </span>
                )}
                {flaggedCounts.reclass > 0 && (
                  <span className="text-xs font-semibold bg-white border border-amber-200 rounded-md px-2.5 py-1 text-amber-800">
                    {flaggedCounts.reclass} Reclass
                  </span>
                )}
                {flaggedCounts.stripe > 0 && (
                  <span className="text-xs font-semibold bg-white border border-amber-200 rounded-md px-2.5 py-1 text-amber-800">
                    {flaggedCounts.stripe} Stripe
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* ─── Stripe Connections ─── (senior only) */}
        {isSenior && (pendingStripeRequests.length > 0 || recentStripeConnections.length > 0) && (
          <div className="rounded-xl bg-white border border-gray-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-teal-light">
                  <CreditCard size={16} className="text-teal-dark" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-navy flex items-center gap-2">
                    Stripe Connections
                    {hasFreshStripeConnection && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 uppercase tracking-wide">
                        New
                      </span>
                    )}
                  </h2>
                  <p className="text-xs text-ink-slate mt-0.5">
                    {pendingStripeRequests.length > 0
                      ? `${pendingStripeRequests.length} outstanding · ${recentStripeConnections.length} recent`
                      : `${recentStripeConnections.length} recent connection${recentStripeConnections.length === 1 ? "" : "s"}`}
                  </p>
                </div>
              </div>
              <span className="text-xs font-semibold text-teal-dark">
                {stripeConnected} total connected
              </span>
            </div>

            {/* Outstanding requests */}
            {pendingStripeRequests.length > 0 && (
              <div className="border-b border-gray-100">
                <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-100 flex items-center gap-2">
                  <Clock size={12} className="text-amber-600" />
                  <span className="text-[11px] font-bold text-amber-800 uppercase tracking-wide">
                    Outstanding requests · {pendingStripeRequests.length}
                  </span>
                </div>
                {pendingStripeRequests.slice(0, 10).map((r) => {
                  const status = r.isExpired
                    ? { color: "text-red-700", label: "Expired — generate new link" }
                    : r.daysUntilExpiry <= 2
                    ? { color: "text-red-600", label: `${r.daysUntilExpiry}d left` }
                    : { color: "text-amber-700", label: `${r.daysUntilExpiry}d left` };
                  return (
                    <div
                      key={r.client_link_id}
                      className="flex items-center justify-between px-5 py-3 border-b border-gray-50 last:border-0"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-navy truncate">{r.client_name}</div>
                        <div className="text-[11px] text-ink-slate">
                          Sent {r.daysOutstanding === 0 ? "today" : `${r.daysOutstanding}d ago`}
                        </div>
                      </div>
                      <span className={`text-xs font-semibold ${status.color} flex-shrink-0`}>
                        {status.label}
                      </span>
                    </div>
                  );
                })}
                {pendingStripeRequests.length > 10 && (
                  <div className="px-5 py-2 text-[11px] text-ink-slate">
                    + {pendingStripeRequests.length - 10} more
                  </div>
                )}
              </div>
            )}

            {/* Recent connections */}
            {recentStripeConnections.length > 0 && (
              <div>
                <div className="px-5 py-2.5 bg-emerald-50 border-b border-emerald-100 flex items-center gap-2">
                  <CheckCircle2 size={12} className="text-emerald-600" />
                  <span className="text-[11px] font-bold text-emerald-800 uppercase tracking-wide">
                    Recently connected · last 14 days
                  </span>
                </div>
                {recentStripeConnections.slice(0, 10).map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between px-5 py-3 border-b border-gray-50 last:border-0"
                  >
                    <div className="text-sm font-medium text-navy truncate">{c.client_name}</div>
                    <span className="text-xs font-semibold text-emerald-700 flex-shrink-0">
                      {c.daysAgo === 0 ? "Today" : c.daysAgo === 1 ? "Yesterday" : `${c.daysAgo}d ago`}
                    </span>
                  </div>
                ))}
                {recentStripeConnections.length > 10 && (
                  <div className="px-5 py-2 text-[11px] text-ink-slate">
                    + {recentStripeConnections.length - 10} more
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ─── Team Workload ─── (admin only) */}
        {isAdmin && teamWorkload.length > 0 && (
          <div className="rounded-xl bg-white border border-gray-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200">
              <h2 className="text-base font-bold text-navy">Team Workload</h2>
              <p className="text-xs text-ink-slate mt-0.5">Bookkeepers with active or recent jobs</p>
            </div>
            <div
              className="grid px-5 py-2.5 text-[10px] font-bold uppercase tracking-wider text-ink-slate bg-gray-50 border-b border-gray-100"
              style={{ gridTemplateColumns: "1fr 80px 80px 110px" }}
            >
              <div>Bookkeeper</div>
              <div className="text-right">In Flight</div>
              <div className="text-right">Stalled</div>
              <div className="text-right">Done This Month</div>
            </div>
            {teamWorkload.map((bk) => (
              <div
                key={bk.id}
                className="grid px-5 py-3 items-center border-b border-gray-50 last:border-0"
                style={{ gridTemplateColumns: "1fr 80px 80px 110px" }}
              >
                <div className="flex items-center gap-2">
                  <div className="rounded-full flex items-center justify-center font-bold text-[10px] flex-shrink-0 w-7 h-7 bg-teal-light text-teal">
                    {bk.full_name.charAt(0)}
                  </div>
                  <span className="text-sm font-medium text-navy">{bk.full_name}</span>
                </div>
                <div className="text-right text-sm font-semibold text-navy">{bk.inFlight || "—"}</div>
                <div className="text-right">
                  {bk.stalled > 0 ? (
                    <span className="text-sm font-semibold text-amber-700">{bk.stalled}</span>
                  ) : (
                    <span className="text-sm text-ink-slate">—</span>
                  )}
                </div>
                <div className="text-right text-sm font-semibold text-teal">
                  {bk.completedMonth || "—"}
                </div>
              </div>
            ))}
          </div>
        )}

      </div>
    </AppShell>
  );
}
