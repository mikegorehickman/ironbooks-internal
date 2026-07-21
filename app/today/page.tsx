import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { Greeting } from "./greeting";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Sparkles, Pause } from "lucide-react";
import { ClientFlagsWidget } from "./client-flags-widget";
import { ReclassRequestsWidget, type PendingReclassRequest } from "./reclass-requests-widget";
import { ClientInboxWidget, type InboundCommRow } from "./client-inbox-widget";
import { CleanupDeadlinesWidget, type CleanupDeadlineRow } from "./cleanup-deadlines-widget";
import { ClientAnswersWidget } from "./client-answers-widget";
import { DuplicatesPanel } from "@/components/DuplicatesPanel";
import { getClientAnswers, type ClientAnswerRow } from "@/lib/client-answers";
import { QboHealthAlert } from "@/components/QboHealthAlert";
import { MonthlyBsCheckButton } from "./monthly-bs-check";
import { PulseBar } from "./pulse-bar";
import { FocusHero } from "./focus-hero";
import { computeTodayPriority } from "@/lib/today-priority";

export const dynamic = "force-dynamic";

/**
 * /today — Daily recon dashboard.
 *
 * SCAFFOLD. This page renders against the daily_review_queue + daily_recon_runs
 * tables created in migration 31. When no clients have daily_recon_enabled=true,
 * the page shows an empty state with a CTA to the admin panel.
 *
 * Layout: per-bookkeeper aggregate at top, per-client cards below.
 *
 * The drill-down lives at /today/[clientId].
 */
export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ viewas?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();

  // Determine actor's role + filter to their clients (admins/leads see all)
  const { data: actor } = await service
    .from("users")
    .select("id, full_name, role")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isAdmin = (actor as any)?.role === "admin";
  // First name for the Home greeting ("Good morning, Lisa").
  const firstName = String((actor as any)?.full_name || "").trim().split(/\s+/)[0] || "";

  // Seniors can view /today AS any bookkeeper (?viewas=<user_id>) — every
  // client-scoped widget below narrows to that bookkeeper's clients.
  const viewAs = isSenior && params?.viewas ? String(params.viewas) : null;
  // The user whose client list scopes the page: bookkeepers always
  // themselves; seniors default to everyone unless viewing-as.
  const scopeUserId = !isSenior ? user.id : viewAs;

  // Pull every enabled client + (for non-admins) only ones they own
  let clientsQuery = service
    .from("client_links")
    .select(
      "id, client_name, jurisdiction, state_province, assigned_bookkeeper_id, last_synced_at, daily_recon_enabled, daily_recon_paused, daily_recon_paused_reason"
    )
    .eq("is_active", true)
    .eq("daily_recon_enabled" as any, true);
  if (scopeUserId) {
    clientsQuery = clientsQuery.eq("assigned_bookkeeper_id", scopeUserId);
  }
  const { data: clients } = await clientsQuery.order("client_name");
  const eligibleClients = (clients || []) as any[];

  // Manager-rejected work bounced back to this bookkeeper to rework — both
  // cleanup (client_links.cleanup_review_state='failed_review') and production
  // closes (monthly_rec_runs.status='failed_review'). Top of "Your work".
  let rejectedQuery = service
    .from("client_links")
    .select("id, client_name, cleanup_review_notes, cleanup_review_rejected_at, assigned_bookkeeper_id")
    .eq("is_active", true)
    .eq("cleanup_review_state" as any, "failed_review");
  if (scopeUserId) rejectedQuery = rejectedQuery.eq("assigned_bookkeeper_id", scopeUserId);
  const { data: rejectedCleanupRows } = await rejectedQuery.order("cleanup_review_rejected_at", { ascending: false });

  const { data: rejectedRunRows } = await (service as any)
    .from("monthly_rec_runs")
    .select("client_link_id, period, review_notes, rejected_at, client_links!inner(client_name, assigned_bookkeeper_id, is_active)")
    .eq("status", "failed_review")
    .order("rejected_at", { ascending: false });

  // ── "This week" wins — home should show progress, not only pressure. ──
  // Scoped like everything else: bookkeepers see their own wins, seniors see
  // the team's (or one bookkeeper's via view-as). Defensive: zero on error.
  const weekAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();
  let winCloses = 0, winCleanups = 0, winDupCount = 0, winDupTotal = 0;
  try {
    let closesQ = (service as any).from("monthly_rec_runs")
      .select("id", { count: "exact", head: true })
      .eq("status", "complete").gte("completed_at", weekAgoIso);
    if (scopeUserId) closesQ = closesQ.eq("completed_by", scopeUserId);
    let cleanupsQ = (service as any).from("client_links")
      .select("id", { count: "exact", head: true })
      .gte("cleanup_completed_at", weekAgoIso);
    if (scopeUserId) cleanupsQ = cleanupsQ.eq("cleanup_completed_by", scopeUserId);
    let dupsQ = (service as any).from("dup_findings")
      .select("amount").eq("status", "resolved").gte("resolved_at", weekAgoIso);
    if (scopeUserId) dupsQ = dupsQ.eq("resolved_by", scopeUserId);
    const [c1, c2, d] = await Promise.all([closesQ, cleanupsQ, dupsQ]);
    winCloses = c1.count || 0;
    winCleanups = c2.count || 0;
    const dupRows = (d.data as any[]) || [];
    winDupCount = dupRows.length;
    winDupTotal = dupRows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0);
  } catch { /* wins are decoration — never break the page */ }
  const hasWins = winCloses + winCleanups + winDupCount > 0;

  const rejectedForRework: any[] = [
    ...((rejectedCleanupRows || []) as any[]).map((r) => ({
      id: r.id,
      client_name: r.client_name,
      note: r.cleanup_review_notes,
      kind: "Cleanup",
    })),
    ...(((rejectedRunRows || []) as any[])
      .filter((r) => {
        const cl = r.client_links || {};
        if (!cl.is_active) return false;
        return !scopeUserId || cl.assigned_bookkeeper_id === scopeUserId;
      })
      .map((r) => ({
        id: r.client_link_id,
        client_name: r.client_links?.client_name || "Client",
        note: r.review_notes,
        kind: `Close ${r.period}`,
      }))),
  ];

  // ─── Client answers to ask-client transaction questions ───
  // The client picked an account in their portal; the bookkeeper confirms
  // (default) or applies an alternative. Scoped like every other widget.
  let clientAnswers: ClientAnswerRow[] = [];
  try {
    clientAnswers = await getClientAnswers(service, { scopeUserId });
  } catch {
    clientAnswers = [];
  }

  // Manager approvals, statement approvals, and escalations all moved to
  // Production → Approvals (/approvals) — no senior queues are fetched here.

  // ─── Portal transaction flags from clients ───
  // These are independent of daily-recon enrollment — surface them even
  // when no clients are on daily recon. Bookkeepers see flags for their
  // own clients; admins/leads see all pending flags.
  let pendingFlagsRaw: any[] = [];
  try {
    let flagsQuery = service
      .from("portal_transaction_flags" as any)
      .select(
        "id, client_link_id, submitted_by, submitted_at, qbo_txn_id, qbo_txn_type, qbo_account_id, account_label, txn_date, txn_amount, txn_doc_number, txn_vendor_or_customer, txn_memo, period_label, period_start, period_end, client_note, status"
      )
      .in("status", ["pending", "in_review"])
      .order("submitted_at", { ascending: false });
    const { data: flags } = await flagsQuery;
    pendingFlagsRaw = (flags as any[]) || [];

    // Filter to the scoped bookkeeper's clients (self for bookkeepers,
    // the viewed-as bookkeeper for seniors using the selector)
    if (scopeUserId && pendingFlagsRaw.length > 0) {
      const assigned = new Set(eligibleClients.map((c) => c.id));
      const { data: ownedClients } = await service
        .from("client_links")
        .select("id")
        .eq("assigned_bookkeeper_id", scopeUserId);
      for (const c of (ownedClients as any[] | null) || []) assigned.add(c.id);
      pendingFlagsRaw = pendingFlagsRaw.filter((f) => assigned.has(f.client_link_id));
    }
  } catch {
    pendingFlagsRaw = [];
  }

  // Enrich flags with client + submitter names so the UI doesn't have to
  // make another round-trip.
  let pendingFlags: any[] = [];
  if (pendingFlagsRaw.length > 0) {
    const clientIds = Array.from(new Set(pendingFlagsRaw.map((f) => f.client_link_id)));
    const submitterIds = Array.from(new Set(pendingFlagsRaw.map((f) => f.submitted_by).filter(Boolean)));
    const [{ data: cn }, { data: sn }] = await Promise.all([
      clientIds.length > 0
        ? service.from("client_links").select("id, client_name").in("id", clientIds)
        : Promise.resolve({ data: [] }),
      submitterIds.length > 0
        ? service.from("users").select("id, full_name, email").in("id", submitterIds)
        : Promise.resolve({ data: [] }),
    ]);
    const clientNameById = new Map(((cn as any[]) || []).map((c) => [c.id, c.client_name]));
    const submitterById = new Map(
      ((sn as any[]) || []).map((u) => [u.id, { full_name: u.full_name, email: u.email }])
    );
    pendingFlags = pendingFlagsRaw.map((f) => ({
      ...f,
      client_name: clientNameById.get(f.client_link_id) || "(unknown client)",
      submitter_name: submitterById.get(f.submitted_by)?.full_name || "",
      submitter_email: submitterById.get(f.submitted_by)?.email || "",
    }));
  }

  // ─── Client reclass requests ───
  // Mirror the portal flag fetch: pending requests across all clients
  // for seniors, scoped to assigned_bookkeeper_id for bookkeepers. We
  // enrich with client_name + requester here so the widget doesn't have
  // to re-fetch.
  let pendingReclassRequests: PendingReclassRequest[] = [];
  try {
    const { data: rrRows } = await service
      .from("client_reclass_requests" as any)
      .select(
        "id, client_link_id, requested_by, requested_at, " +
        "source_account_qbo_id, source_account_name, target_account_qbo_id, target_account_name, " +
        "example_txn_id, vendor_name, client_reason, status"
      )
      // failed = an approve attempt errored or matched zero transactions.
      // Those stay in the queue (decline with a note, or retry) — hiding
      // them left the client without an answer forever.
      .in("status", ["pending", "failed"])
      .order("requested_at", { ascending: false });

    let raw = (rrRows as any[]) || [];

    if (scopeUserId && raw.length > 0) {
      const { data: ownedClients } = await service
        .from("client_links")
        .select("id")
        .eq("assigned_bookkeeper_id", scopeUserId);
      const ownedIds = new Set(((ownedClients as any[]) || []).map((c) => c.id));
      raw = raw.filter((r) => ownedIds.has(r.client_link_id));
    }

    if (raw.length > 0) {
      const clientIds = Array.from(new Set(raw.map((r) => r.client_link_id)));
      const requesterIds = Array.from(new Set(raw.map((r) => r.requested_by).filter(Boolean)));
      const [{ data: cn }, { data: un }] = await Promise.all([
        clientIds.length > 0
          ? service.from("client_links").select("id, client_name").in("id", clientIds)
          : Promise.resolve({ data: [] }),
        requesterIds.length > 0
          ? service.from("users").select("id, full_name, email").in("id", requesterIds)
          : Promise.resolve({ data: [] }),
      ]);
      const clientNameById = new Map(((cn as any[]) || []).map((c) => [c.id, c.client_name]));
      const userById = new Map(
        ((un as any[]) || []).map((u) => [u.id, { full_name: u.full_name, email: u.email }])
      );
      pendingReclassRequests = raw.map((r) => ({
        ...r,
        client_name: clientNameById.get(r.client_link_id) || "(unknown client)",
        requester_name: userById.get(r.requested_by)?.full_name || "",
        requester_email: userById.get(r.requested_by)?.email || "",
      })) as PendingReclassRequest[];
    }
  } catch {
    pendingReclassRequests = [];
  }

  // ─── Inbound client messages + statement uploads ───
  // Unread from_client rows in client_communications. Same scoping rules
  // as flags: seniors see everything, bookkeepers see assigned clients.
  // Rows clear when the bookkeeper opens /clients/[id]/messages (which
  // marks them read). try/catch so /today survives pre-migration envs.
  let inboundComms: InboundCommRow[] = [];
  try {
    const { data: commRows } = await service
      .from("client_communications" as any)
      .select("id, client_link_id, sender_user_id, body, attachments, created_at")
      .eq("direction", "from_client")
      .is("read_at", null)
      .order("created_at", { ascending: false })
      .limit(50);
    let raw = (commRows as any[]) || [];

    if (scopeUserId && raw.length > 0) {
      const { data: ownedClients } = await service
        .from("client_links")
        .select("id")
        .eq("assigned_bookkeeper_id", scopeUserId);
      const ownedIds = new Set(((ownedClients as any[]) || []).map((c) => c.id));
      raw = raw.filter((r) => ownedIds.has(r.client_link_id));
    }

    if (raw.length > 0) {
      const commClientIds = Array.from(new Set(raw.map((r) => r.client_link_id)));
      const commSenderIds = Array.from(new Set(raw.map((r) => r.sender_user_id).filter(Boolean)));
      const [{ data: cn }, { data: sn }] = await Promise.all([
        service.from("client_links").select("id, client_name").in("id", commClientIds),
        commSenderIds.length > 0
          ? service.from("users").select("id, full_name, email").in("id", commSenderIds)
          : Promise.resolve({ data: [] }),
      ]);
      const clientNameById = new Map(((cn as any[]) || []).map((c) => [c.id, c.client_name]));
      const senderById = new Map(
        ((sn as any[]) || []).map((u) => [u.id, u.full_name || u.email || ""])
      );
      inboundComms = raw.map((r) => ({
        id: r.id,
        client_link_id: r.client_link_id,
        client_name: clientNameById.get(r.client_link_id) || "(unknown client)",
        sender_name: senderById.get(r.sender_user_id) || "",
        body: r.body,
        attachments: Array.isArray(r.attachments) ? r.attachments : [],
        created_at: r.created_at,
      }));
    }
  } catch {
    inboundComms = [];
  }

  // ─── Cleanup assignments + deadlines ───
  // Active clients still in cleanup, scoped to the viewed bookkeeper.
  // Past-deadline rows render red. Seniors with no view-as see everyone's.
  let cleanupDeadlines: CleanupDeadlineRow[] = [];
  let allBookkeepers: { id: string; full_name: string }[] = [];
  try {
    let cq = service
      .from("client_links")
      .select("id, client_name, due_date, assigned_bookkeeper_id, daily_recon_enabled, cleanup_review_state, latest_closed_period")
      .eq("is_active", true)
      .is("cleanup_completed_at", null)
      .not("assigned_bookkeeper_id", "is", null);
    if (scopeUserId) cq = cq.eq("assigned_bookkeeper_id", scopeUserId);
    const { data: cleanupClients } = await cq.order("due_date", { ascending: true, nullsFirst: false });
    // A client only counts as an OPEN cleanup assignment if it's still actually
    // in cleanup. Drop ones that are no longer the bookkeeper's to-do even if
    // cleanup_completed_at was never stamped (promoted via a non-signoff path,
    // or statements already delivered):
    //   • daily_recon_enabled  → graduated to production
    //   • latest_closed_period → statements have been SENT to the client
    //                            (the auto-dismiss-on-send signal)
    //   • cleanup_review_state in_review/complete → in/past manager sign-off
    const raw = ((cleanupClients as any[]) || []).filter(
      (c) =>
        c.daily_recon_enabled !== true &&
        !c.latest_closed_period &&
        c.cleanup_review_state !== "in_review" &&
        c.cleanup_review_state !== "complete"
    );
    // Internal team only — clients (role 'client') never appear in the
    // "view as" picker; they have no access to /today at all.
    const { data: bks } = await service
      .from("users")
      .select("id, full_name, role")
      .eq("is_active", true)
      .in("role", ["admin", "lead", "bookkeeper", "viewer"]);
    const bkById = new Map(((bks as any[]) || []).map((b) => [b.id, b.full_name]));
    allBookkeepers = ((bks as any[]) || [])
      .filter((b) => b.full_name)
      .map((b) => ({ id: b.id, full_name: b.full_name }));
    const todayStr = new Date().toISOString().slice(0, 10);
    cleanupDeadlines = raw.map((c) => ({
      client_link_id: c.id,
      client_name: c.client_name,
      due_date: c.due_date ? String(c.due_date).slice(0, 10) : null,
      overdue: !!c.due_date && String(c.due_date).slice(0, 10) < todayStr,
      bookkeeper_name: bkById.get(c.assigned_bookkeeper_id) || null,
    }));
  } catch {
    cleanupDeadlines = [];
  }

  // If nothing's enabled AND no flags AND no reclass requests AND no
  // inbound messages AND no statement approvals, show the empty state
  if (
    eligibleClients.length === 0 &&
    pendingFlags.length === 0 &&
    pendingReclassRequests.length === 0 &&
    clientAnswers.length === 0 &&
    inboundComms.length === 0
  ) {
    return (
      <AppShell>
        <TopBar title={<Greeting name={firstName} />} subtitle="Production daily review — clients on auto-recon" />
        <div className="px-8 py-12 max-w-2xl">
          <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center space-y-4">
            <div className="inline-flex w-16 h-16 rounded-full bg-teal-lighter items-center justify-center">
              <Sparkles className="text-teal" size={28} />
            </div>
            <h2 className="text-xl font-bold text-navy">No clients on daily recon yet</h2>
            <p className="text-sm text-ink-slate max-w-md mx-auto leading-relaxed">
              The daily reconciliation system is scaffolded but no clients are enrolled. An admin
              can enable pilot clients from the admin panel — once enrolled, their daily AI
              categorizations + flagged items will appear here.
            </p>
            {isAdmin && (
              <Link
                href="/admin/daily-recon"
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white font-semibold px-5 py-2.5 rounded-lg"
              >
                Open admin panel
                <ArrowRight size={14} />
              </Link>
            )}
          </div>
        </div>
      </AppShell>
    );
  }

  const clientIds = eligibleClients.map((c) => c.id);

  // Pull pending queue counts per client
  const { data: queueRows } = await service
    .from("daily_review_queue" as any)
    .select("client_link_id, decision, anomaly_flags, created_at")
    .in("client_link_id", clientIds);

  const pendingByClient = new Map<string, number>();
  const anomaliesByClient = new Map<string, number>();
  for (const row of ((queueRows as any[]) || [])) {
    if (row.decision === "pending") {
      pendingByClient.set(row.client_link_id, (pendingByClient.get(row.client_link_id) || 0) + 1);
      const flags = Array.isArray(row.anomaly_flags) ? row.anomaly_flags : [];
      if (flags.length > 0) {
        anomaliesByClient.set(
          row.client_link_id,
          (anomaliesByClient.get(row.client_link_id) || 0) + flags.length
        );
      }
    }
  }

  // Most recent run per client (for "last synced X ago" subtitle)
  const { data: runs } = await service
    .from("daily_recon_runs" as any)
    .select("client_link_id, run_at, auto_executed, status")
    .in("client_link_id", clientIds)
    .order("run_at", { ascending: false });

  const latestRunByClient = new Map<string, any>();
  const autoExecuted24h = new Map<string, number>();
  const now = Date.now();
  for (const r of ((runs as any[]) || [])) {
    if (!latestRunByClient.has(r.client_link_id)) latestRunByClient.set(r.client_link_id, r);
    if (now - new Date(r.run_at).getTime() < 24 * 3600 * 1000) {
      autoExecuted24h.set(
        r.client_link_id,
        (autoExecuted24h.get(r.client_link_id) || 0) + (r.auto_executed || 0)
      );
    }
  }

  // ─── Monthly-close status for the current closing period ───
  // Default period = previous calendar month (the one bookkeepers
  // normally close in the first week of the new month). Detection:
  // any cleanup_runs row with workflow_mode=monthly_close AND
  // period_lock_date inside that month. Most recent wins on ties.
  // We use this to power the smart MonthlyBsCheckButton states
  // (Closed ✓ / Resume / Start) so the bookkeeper sees at a glance
  // which clients still owe a close for the current period.
  const closeNow = new Date();
  const closingYear = closeNow.getMonth() === 0 ? closeNow.getFullYear() - 1 : closeNow.getFullYear();
  const closingMonth = (closeNow.getMonth() + 11) % 12;
  const closingPeriodStart = `${closingYear}-${String(closingMonth + 1).padStart(2, "0")}-01`;
  const closingPeriodEnd = new Date(closingYear, closingMonth + 1, 0).toISOString().slice(0, 10);
  const closingPeriodLabel = new Date(closingYear, closingMonth, 1).toLocaleDateString("en-US", { month: "short" });

  type CloseStatus = "closed" | "in_progress" | "not_started";
  const monthlyByClient = new Map<string, { status: CloseStatus; runId: string }>();
  let monthlyClosedCount = 0;
  if (clientIds.length > 0) {
    const { data: mr } = await service
      .from("cleanup_runs")
      .select("id, client_link_id, status, period_lock_date" as any)
      .in("client_link_id", clientIds)
      .eq("workflow_mode" as any, "monthly_close")
      .gte("period_lock_date", closingPeriodStart)
      .lte("period_lock_date", closingPeriodEnd)
      .order("started_at", { ascending: false });
    for (const r of (mr as any[]) || []) {
      if (monthlyByClient.has(r.client_link_id)) continue;
      const status: CloseStatus = r.status === "complete" ? "closed" : "in_progress";
      monthlyByClient.set(r.client_link_id, { status, runId: r.id });
    }

    // The pulse-bar "N/M closed" chip counts the CANONICAL close
    // (monthly_rec_runs — the /production board's Completed column it
    // links to), not the cleanup_runs catch-up flow above.
    try {
      const closingPeriod = `${closingYear}-${String(closingMonth + 1).padStart(2, "0")}`;
      const { count } = await (service as any)
        .from("monthly_rec_runs")
        .select("client_link_id", { count: "exact", head: true })
        .eq("period", closingPeriod)
        .eq("kind", "production_me")
        .eq("status", "complete")
        .in("client_link_id", clientIds);
      monthlyClosedCount = count || 0;
    } catch {
      /* pre-migration env — chip shows 0 */
    }
  }

  // Top-line totals
  const totalPending = Array.from(pendingByClient.values()).reduce((s, n) => s + n, 0);
  const totalAutoExecuted = Array.from(autoExecuted24h.values()).reduce((s, n) => s + n, 0);

  // Sort clients: paused first, then by pending count desc, then by name
  eligibleClients.sort((a, b) => {
    if (!!b.daily_recon_paused !== !!a.daily_recon_paused) {
      return b.daily_recon_paused ? -1 : 1;
    }
    const ap = pendingByClient.get(a.id) || 0;
    const bp = pendingByClient.get(b.id) || 0;
    if (bp !== ap) return bp - ap;
    return (a.client_name || "").localeCompare(b.client_name || "");
  });

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // Priority model — the "Focus now" hero + pulse-bar counts, computed over
  // the data already fetched above (no extra queries).
  const clientNameById = new Map<string, string>(
    eligibleClients.map((c) => [c.id, c.client_name])
  );
  const todayStr = new Date().toISOString().slice(0, 10);
  const { hero, counts } = computeTodayPriority({
    eligibleClients,
    pendingFlags,
    pendingReclassRequests,
    inboundComms,
    cleanupDeadlines,
    pendingByClient,
    anomaliesByClient,
    clientNameById,
    totalPending,
    todayStr,
  });
  // Cleanup deadlines belong to "Your work" only when the page is scoped to a
  // single bookkeeper (themselves, or a senior viewing-as). For a senior
  // viewing the whole fleet, cleanup lives in the Team band instead — so
  // don't count it toward the personal "Your work" total in that case.
  const workCount =
    rejectedForRework.length +
    pendingFlags.length +
    pendingReclassRequests.length +
    clientAnswers.length +
    inboundComms.length +
    (scopeUserId ? cleanupDeadlines.length : 0);
  const viewAsName = viewAs
    ? allBookkeepers.find((b) => b.id === viewAs)?.full_name || "bookkeeper"
    : null;

  // Today is an action queue, not a directory — only surface clients that
  // actually need attention (queued review items, anomalies, or a paused
  // feed). The full client list lives on /clients.
  const clientsNeedingReview = eligibleClients.filter(
    (c) =>
      c.daily_recon_paused ||
      (pendingByClient.get(c.id) || 0) > 0 ||
      (anomaliesByClient.get(c.id) || 0) > 0
  );

  return (
    <AppShell>
      <TopBar title={<Greeting name={firstName} />} subtitle={`Production daily review · ${today}`} />
      <div className="px-8 py-6 max-w-5xl space-y-5">
        {/* Your day, one sentence — everything below is detail on this line. */}
        <p className="text-sm text-ink-slate -mt-2">
          {workCount > 0 ? (
            <>
              <span className="font-bold text-navy">{workCount}</span> thing{workCount === 1 ? "" : "s"} need{workCount === 1 ? "s" : ""} you
            </>
          ) : (
            <span className="font-semibold text-teal-dark">You&apos;re clear — nothing needs you right now</span>
          )}
          {rejectedForRework.length > 0 && (
            <> · <span className="font-bold text-rust">{rejectedForRework.length}</span> sent back</>
          )}
          {eligibleClients.length > 0 && (
            <> · <span className="font-bold text-navy">{monthlyClosedCount}</span>/{eligibleClients.length} closed · {closingPeriodLabel}</>
          )}
        </p>

        {/* Pulse bar — time-pressure at a glance + month-end status + view-as */}
        <PulseBar
          counts={counts}
          isSenior={isSenior}
          monthlyClosedCount={monthlyClosedCount}
          totalClients={eligibleClients.length}
          closingPeriodLabel={closingPeriodLabel}
          bookkeepers={allBookkeepers}
          viewAs={viewAs}
        />

        {/* This week's wins — progress, not just pressure. Hides when empty. */}
        {hasWins && (
          <p className="text-[12.5px] text-ink-slate flex items-center gap-1.5 -mt-2">
            <span className="w-1.5 h-1.5 rounded-full bg-teal inline-block" />
            <span className="font-bold uppercase tracking-wider text-[10.5px] text-ink-light mr-1">Past 7 days</span>
            {winCloses > 0 && (
              <><span className="font-bold text-teal-dark">{winCloses}</span> book{winCloses === 1 ? "" : "s"} closed</>
            )}
            {winCleanups > 0 && (
              <>{winCloses > 0 && <span className="text-ink-light">·</span>} <span className="font-bold text-teal-dark">{winCleanups}</span> cleanup{winCleanups === 1 ? "" : "s"} finished</>
            )}
            {winDupCount > 0 && (
              <>{winCloses + winCleanups > 0 && <span className="text-ink-light">·</span>} <span className="font-bold text-teal-dark">${Math.round(winDupTotal).toLocaleString()}</span> in duplicates cleared</>
            )}
          </p>
        )}

        {/* Dead QBO connections — seniors only. Sits right up top so a broken
            connection (which silently blocks recon) is impossible to miss.
            Renders nothing when the fleet is healthy. */}
        {isSenior && <QboHealthAlert />}

        {/* Focus now — the single most important thing, computed. */}
        <FocusHero
          hero={hero}
          autoExecuted={totalAutoExecuted}
          dueSoon={counts.dueToday + counts.dueSoon}
        />

        {/* ── YOUR WORK ── the logged-in person's actionable queue ── */}
        <section id="work" className="space-y-4 scroll-mt-4">
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">
            {workCount > 0 ? `Your work · ${workCount} to act on` : "Your work"}
          </h2>
          {workCount === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 px-5 py-6 text-sm text-ink-slate">
              Nothing waiting on you right now.
            </div>
          ) : (
            <div className="space-y-4">
              {/* Manager-rejected cleanups to rework — highest priority. */}
              {rejectedForRework.length > 0 && (
                <div className="rounded-2xl border border-red-200 bg-red-50/60 p-4">
                  <div className="text-sm font-bold text-red-800 mb-2">
                    Sent back — needs rework ({rejectedForRework.length})
                  </div>
                  <div className="space-y-2">
                    {rejectedForRework.map((r, i) => (
                      <Link
                        key={`${r.id}-${i}`}
                        href={r.kind === "Cleanup" ? `/clients/${r.id}?tab=cleanup` : `/production`}
                        className="block rounded-lg border border-red-200 bg-white px-3 py-2 hover:border-red-400 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-navy">{r.client_name}</span>
                          <span className="text-[11px] text-red-700 font-semibold">{r.kind} · Failed review →</span>
                        </div>
                        {r.note && (
                          <p className="text-xs text-ink-slate mt-0.5">
                            <span className="font-semibold">Manager:</span> {r.note}
                          </p>
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {/* Client-waiting items first (a human is blocked on a reply),
                  then your cleanup deadlines. Each widget self-manages its
                  resolve state and hides at zero rows. */}
              {pendingFlags.length > 0 && <ClientFlagsWidget flags={pendingFlags} />}
              {pendingReclassRequests.length > 0 && (
                <ReclassRequestsWidget requests={pendingReclassRequests} />
              )}
              {clientAnswers.length > 0 && <ClientAnswersWidget rows={clientAnswers} />}
              {inboundComms.length > 0 && <ClientInboxWidget rows={inboundComms} />}
              {scopeUserId && cleanupDeadlines.length > 0 && (
                <CleanupDeadlinesWidget rows={cleanupDeadlines} showBookkeeper={false} />
              )}
              {/* Duplicate findings — LAST in the stack and capped to the top 5
                  by $ exposure. An admin's fleet-wide list can run 300+ rows,
                  which used to bury the whole Home screen; the full list lives
                  on the fleet page. Hides itself when empty. */}
              <DuplicatesPanel
                clientIds={scopeUserId ? eligibleClients.map((c: any) => c.id) : null}
                maxRows={5}
                viewAllHref={isAdmin ? "/admin/duplicates" : undefined}
              />
            </div>
          )}
        </section>

        {/* ── CLIENTS NEEDING REVIEW ── action queue, not a directory ── */}
        {clientsNeedingReview.length > 0 && (
        <section id="clients" className="scroll-mt-4">
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-bold text-navy uppercase tracking-wider">
              Needs review today ({clientsNeedingReview.length})
            </h2>
            <Link
              href="/clients"
              className="text-xs font-semibold text-teal hover:text-teal-dark"
            >
              All clients →
            </Link>
          </div>
          <ul className="divide-y divide-gray-50">
            {clientsNeedingReview.map((c) => {
              const pending = pendingByClient.get(c.id) || 0;
              const anomalies = anomaliesByClient.get(c.id) || 0;
              const autoToday = autoExecuted24h.get(c.id) || 0;
              const lastRun = latestRunByClient.get(c.id);
              const lastRunAgo = lastRun ? formatAgo(lastRun.run_at) : "never";

              return (
                <li key={c.id}>
                  <Link
                    href={`/today/${c.id}`}
                    className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-navy">{c.client_name}</span>
                        <span className="text-xs text-ink-light">
                          {c.jurisdiction} · {c.state_province || "—"}
                        </span>
                        {c.daily_recon_paused && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700"
                            title={c.daily_recon_paused_reason || "Paused"}
                          >
                            <Pause size={9} />
                            PAUSED
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-slate mt-0.5">
                        Last run {lastRunAgo}
                        {lastRun?.status === "failed" && (
                          <span className="text-red-600 ml-2">· last run failed</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <MonthlyBsCheckButton
                        clientLinkId={c.id}
                        monthlyCloseStatus={monthlyByClient.get(c.id)?.status || "not_started"}
                        existingRunId={monthlyByClient.get(c.id)?.runId || null}
                        periodLabel={closingPeriodLabel}
                      />
                      <Pill count={anomalies} label="anomaly" tone={anomalies > 0 ? "red" : "gray"} />
                      <Pill count={pending} label="review" tone={pending > 0 ? "amber" : "gray"} />
                      <Pill count={autoToday} label="auto" tone="emerald" />
                    </div>
                    <ArrowRight size={16} className="text-ink-light" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
        </section>
        )}

        {/* ── TEAM ── senior oversight queues, walled off from personal work ── */}
        {isSenior &&
          (viewAsName ? (
            <div className="bg-white rounded-2xl border border-gray-100 px-5 py-4 text-sm text-ink-slate">
              Viewing <span className="font-semibold text-navy">{viewAsName}</span>&apos;s work ·{" "}
              <Link href="/today" className="font-semibold text-teal hover:text-teal-dark">
                exit to team queues
              </Link>
            </div>
          ) : (
            <section id="team" className="space-y-4 scroll-mt-4">
              <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Team</h2>
              {cleanupDeadlines.length > 0 && (
                <CleanupDeadlinesWidget rows={cleanupDeadlines} showBookkeeper={true} />
              )}
              {cleanupDeadlines.length === 0 && (
                <div className="bg-white rounded-2xl border border-gray-100 px-5 py-6 text-sm text-ink-slate">
                  No cleanup deadlines. Manager approvals &amp; statement sign-offs live on the{" "}
                  <Link href="/approvals" className="font-semibold text-teal hover:text-teal-dark">
                    Approvals page
                  </Link>
                  .
                </div>
              )}
            </section>
          ))}

        <p className="text-xs text-ink-light text-center max-w-md mx-auto leading-relaxed">
          Auto items are already in QuickBooks; review items need your sign-off first.
        </p>
      </div>
    </AppShell>
  );
}

function Pill({ count, label, tone }: { count: number; label: string; tone: "emerald" | "amber" | "red" | "gray" }) {
  const styles =
    tone === "emerald" ? "bg-emerald-50 text-emerald-700 border-emerald-100"
    : tone === "amber" ? "bg-amber-50 text-amber-700 border-amber-100"
    : tone === "red" ? "bg-red-50 text-red-700 border-red-100"
    : "bg-gray-50 text-ink-slate border-gray-100";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${styles}`}>
      <span className="font-bold">{count}</span>
      <span className="opacity-70">{label}</span>
    </span>
  );
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}
