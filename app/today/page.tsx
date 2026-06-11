import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ArrowRight, Sparkles, Clock, Pause } from "lucide-react";
import { ClientFlagsWidget } from "./client-flags-widget";
import { ReclassRequestsWidget, type PendingReclassRequest } from "./reclass-requests-widget";
import { ClientInboxWidget, type InboundCommRow } from "./client-inbox-widget";
import { QboHealthAlert } from "@/components/QboHealthAlert";
import { MonthlyBsCheckButton } from "./monthly-bs-check";

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
export default async function TodayPage() {
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

  // Pull every enabled client + (for non-admins) only ones they own
  let clientsQuery = service
    .from("client_links")
    .select(
      "id, client_name, jurisdiction, state_province, assigned_bookkeeper_id, last_synced_at, daily_recon_enabled, daily_recon_paused, daily_recon_paused_reason"
    )
    .eq("is_active", true)
    .eq("daily_recon_enabled" as any, true);
  if (!isSenior) {
    clientsQuery = clientsQuery.eq("assigned_bookkeeper_id", user.id);
  }
  const { data: clients } = await clientsQuery.order("client_name");
  const eligibleClients = (clients || []) as any[];

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

    // Filter to assigned clients only when the actor isn't a senior
    if (!isSenior && pendingFlagsRaw.length > 0) {
      const assigned = new Set(eligibleClients.map((c) => c.id));
      // Also pull THIS bookkeeper's other assigned clients (not just daily-recon ones)
      // so flags from non-daily-recon clients also show up.
      const { data: ownedClients } = await service
        .from("client_links")
        .select("id")
        .eq("assigned_bookkeeper_id", user.id);
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
      .eq("status", "pending")
      .order("requested_at", { ascending: false });

    let raw = (rrRows as any[]) || [];

    if (!isSenior && raw.length > 0) {
      const { data: ownedClients } = await service
        .from("client_links")
        .select("id")
        .eq("assigned_bookkeeper_id", user.id);
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

    if (!isSenior && raw.length > 0) {
      const { data: ownedClients } = await service
        .from("client_links")
        .select("id")
        .eq("assigned_bookkeeper_id", user.id);
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

  // If nothing's enabled AND no flags AND no reclass requests AND no
  // inbound messages, show the empty state
  if (
    eligibleClients.length === 0 &&
    pendingFlags.length === 0 &&
    pendingReclassRequests.length === 0 &&
    inboundComms.length === 0
  ) {
    return (
      <AppShell>
        <TopBar title="Today" subtitle="Daily reconciliation queue" />
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
            {isSenior && (
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
      if (status === "closed") monthlyClosedCount++;
    }
  }

  // Top-line totals
  const totalPending = Array.from(pendingByClient.values()).reduce((s, n) => s + n, 0);
  const totalAnomalies = Array.from(anomaliesByClient.values()).reduce((s, n) => s + n, 0);
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

  return (
    <AppShell>
      <TopBar title="Today" subtitle={`Daily reconciliation · ${today}`} />
      <div className="px-8 py-6 max-w-5xl space-y-6">
        {/* Dead QBO connections — seniors only (they run the re-auth flow).
            Renders nothing when the fleet is healthy. */}
        {isSenior && <QboHealthAlert />}

        {/* Inbound client messages + statement uploads — top slot: a
            client sending files is usually waiting on us to act on them */}
        {inboundComms.length > 0 && <ClientInboxWidget rows={inboundComms} />}

        {/* Portal flags from clients — shown above daily recon since they're
            often more urgent (client is actively waiting for a response) */}
        {pendingFlags.length > 0 && <ClientFlagsWidget flags={pendingFlags} />}

        {/* Client reclass requests — clients flagging a category they want
            changed. Approving runs the bulk reclass + activates a bank rule. */}
        {pendingReclassRequests.length > 0 && (
          <ReclassRequestsWidget requests={pendingReclassRequests} />
        )}

        {/* Month-end at-a-glance — only show if there's at least one
            production client, otherwise just clutter. Links into
            /month-end for the bulk delivery workflow. */}
        {eligibleClients.length > 0 && (
          <Link
            href="/month-end"
            className="flex items-center gap-4 px-5 py-3 bg-gradient-to-r from-navy/[0.04] to-white rounded-2xl border border-navy/15 hover:border-navy/30 transition-colors group"
          >
            <div className="p-2 rounded-lg bg-navy/10 flex-shrink-0">
              <CheckCircle2 size={16} className="text-navy" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-bold uppercase tracking-widest text-ink-light">
                Month-end · {closingPeriodLabel}
              </div>
              <div className="text-sm font-bold text-navy mt-0.5">
                <span className="text-emerald-700">{monthlyClosedCount}</span> of {eligibleClients.length} clients closed for the period
              </div>
            </div>
            <div className="text-xs font-bold text-navy group-hover:text-teal flex items-center gap-1 flex-shrink-0">
              Open Month-End <ArrowRight size={12} />
            </div>
          </Link>
        )}

        {/* Top-line summary */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SummaryCard
            label="Auto-categorized in last 24h"
            value={totalAutoExecuted}
            icon={<CheckCircle2 className="text-emerald-600" size={20} />}
            tone="success"
          />
          <SummaryCard
            label="Pending your review"
            value={totalPending}
            icon={<Clock className="text-amber-600" size={20} />}
            tone={totalPending > 0 ? "amber" : "muted"}
          />
          <SummaryCard
            label="Anomalies flagged"
            value={totalAnomalies}
            icon={<AlertTriangle className="text-red-600" size={20} />}
            tone={totalAnomalies > 0 ? "red" : "muted"}
          />
        </div>

        {/* Per-client list */}
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-bold text-navy uppercase tracking-wider">
              Clients on daily recon ({eligibleClients.length})
            </h2>
            {isSenior && (
              <Link
                href="/admin/daily-recon"
                className="text-xs font-semibold text-teal hover:text-teal-dark"
              >
                Manage →
              </Link>
            )}
          </div>
          <ul className="divide-y divide-gray-50">
            {eligibleClients.map((c) => {
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
                      <Pill count={autoToday} label="auto" tone="emerald" />
                      <Pill count={pending} label="review" tone={pending > 0 ? "amber" : "gray"} />
                      <Pill count={anomalies} label="anomaly" tone={anomalies > 0 ? "red" : "gray"} />
                    </div>
                    <ArrowRight size={16} className="text-ink-light" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        <p className="text-xs text-ink-light text-center max-w-md mx-auto leading-relaxed">
          Auto-categorized items have already shipped to QBO at ≥95% confidence. Items in the
          review queue need your sign-off before they touch the books.
        </p>
      </div>
    </AppShell>
  );
}

function SummaryCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: "success" | "amber" | "red" | "muted";
}) {
  const accent =
    tone === "success" ? "bg-emerald-50 border-emerald-100"
    : tone === "amber" ? "bg-amber-50 border-amber-100"
    : tone === "red" ? "bg-red-50 border-red-100"
    : "bg-white border-gray-100";
  return (
    <div className={`rounded-2xl border ${accent} p-4 flex items-center gap-3`}>
      <div className="flex-shrink-0">{icon}</div>
      <div>
        <div className="text-2xl font-bold text-navy leading-none">{value}</div>
        <div className="text-xs text-ink-slate mt-1">{label}</div>
      </div>
    </div>
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
