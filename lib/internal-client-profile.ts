/**
 * Internal client profile data layer.
 *
 * Queries SNAP-side tables (not QBO) for state that bookkeepers care
 * about: outstanding work, recent activity, summary stats. QBO financial
 * data is handled separately by lib/portal-data.ts which is reused
 * verbatim by the financial tabs on /clients/[id].
 *
 * All functions take a service-role Supabase client + client_link_id so
 * they're callable from any server component without RLS surprises.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ─── OUTSTANDING WORK ───────────────────────────────────────────────────

/** A single piece of work the bookkeeper still owes this client. */
export interface OutstandingItem {
  /** Stable category — drives the icon/color in the UI. */
  category:
    | "reclass_in_review"
    | "reclass_failed"
    | "coa_in_review"
    | "coa_failed"
    | "bank_rules_pending"
    | "hardcore_cleanup_open"
    | "uf_audit_open"
    | "ar_recovery_open";
  /** Short label rendered as the card title. */
  label: string;
  /** How many items / why it's outstanding. */
  detail: string;
  /** Where clicking the card takes the bookkeeper. */
  href: string;
  /** When this item was created/last touched — drives sort order so the
   *  freshest issues bubble up. */
  occurredAt: string | null;
}

export interface OutstandingWork {
  items: OutstandingItem[];
  totalCount: number;
}

/**
 * Scan SNAP's job/queue tables for anything that needs the bookkeeper's
 * attention on this client. Returns sorted-newest-first so the top of
 * the list is the freshest fire.
 */
export async function fetchOutstandingWork(
  service: SupabaseClient,
  clientLinkId: string
): Promise<OutstandingWork> {
  const items: OutstandingItem[] = [];

  // Reclass jobs in review or failed. "in_review" means discovery finished
  // and is waiting on the bookkeeper to approve/reject. "failed" means
  // execution errored out — needs investigation.
  const { data: reclassJobs } = await service
    .from("reclass_jobs")
    .select("id, status, workflow, source_account_name, date_range_start, date_range_end, ai_completed_at, created_at")
    .eq("client_link_id", clientLinkId)
    .in("status", ["in_review", "web_search_paused", "failed"])
    .order("created_at", { ascending: false });

  for (const j of (reclassJobs || []) as any[]) {
    const isFailed = j.status === "failed";
    items.push({
      category: isFailed ? "reclass_failed" : "reclass_in_review",
      label: isFailed ? "Reclass job failed" : "Reclass awaiting review",
      detail: `${j.workflow || "reclass"} · ${j.source_account_name || "all accounts"} · ${j.date_range_start || "?"} → ${j.date_range_end || "?"}`,
      href: `/reclass/${j.id}/review`,
      occurredAt: j.ai_completed_at || j.created_at,
    });
  }

  // COA cleanup jobs same pattern.
  const { data: coaJobs } = await service
    .from("coa_jobs")
    .select("id, status, created_at, error_message")
    .eq("client_link_id", clientLinkId)
    .in("status", ["in_review", "failed"])
    .order("created_at", { ascending: false });

  for (const j of (coaJobs || []) as any[]) {
    const isFailed = j.status === "failed";
    items.push({
      category: isFailed ? "coa_failed" : "coa_in_review",
      label: isFailed ? "COA cleanup failed" : "COA cleanup awaiting review",
      detail: isFailed
        ? (j.error_message || "Check job for details").slice(0, 120)
        : "Bookkeeper review pending",
      href: `/jobs/${j.id}/review`,
      occurredAt: j.created_at,
    });
  }

  // Pending bank rules (discovered but bookkeeper hasn't approved yet).
  // Grouped so we don't spam the list with 30 individual rules.
  const { count: pendingRulesCount } = await service
    .from("bank_rules")
    .select("id", { count: "exact", head: true })
    .eq("client_link_id", clientLinkId)
    .eq("status", "pending");

  if (pendingRulesCount && pendingRulesCount > 0) {
    // Find the most-recent discovery job so we link to the right review page.
    const { data: latestJob } = await service
      .from("rule_discovery_jobs")
      .select("id, created_at")
      .eq("client_link_id", clientLinkId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    items.push({
      category: "bank_rules_pending",
      label: `${pendingRulesCount} bank rule${pendingRulesCount === 1 ? "" : "s"} pending approval`,
      detail: "Review and activate or reject",
      href: latestJob ? `/rules/${(latestJob as any).id}/review` : "/clients",
      occurredAt: (latestJob as any)?.created_at || null,
    });
  }

  // Hardcore BS cleanup runs that aren't done. Status field varies — we
  // treat anything not 'complete' or 'cancelled' as still open. Wrapped
  // in try/catch because this table may not exist on older deploys.
  try {
    const { data: hardcoreRuns } = await service
      .from("hardcore_cleanup_runs")
      .select("id, status, created_at")
      .eq("client_link_id", clientLinkId)
      .not("status", "in", "(complete,cancelled)")
      .order("created_at", { ascending: false });

    for (const r of (hardcoreRuns || []) as any[]) {
      items.push({
        category: "hardcore_cleanup_open",
        label: "Hardcore BS cleanup in progress",
        detail: `Status: ${r.status || "running"}`,
        href: `/balance-sheet/${clientLinkId}/hardcore-cleanup`,
        occurredAt: r.created_at,
      });
    }
  } catch {
    // hardcore_cleanup_runs missing → migration 41 not yet applied. Ignore.
  }

  // UF audit + A/R recovery jobs — both tables may or may not exist
  // depending on what's deployed. Best-effort, never throw.
  try {
    const { data: ufAudits } = await service
      .from("uf_audit_runs")
      .select("id, status, created_at")
      .eq("client_link_id", clientLinkId)
      .not("status", "in", "(complete,cancelled,finalized)")
      .order("created_at", { ascending: false });

    for (const a of (ufAudits || []) as any[]) {
      items.push({
        category: "uf_audit_open",
        label: "UF audit in progress",
        detail: `Status: ${a.status || "running"}`,
        href: `/balance-sheet/${clientLinkId}/uf-audit`,
        occurredAt: a.created_at,
      });
    }
  } catch {
    /* table not present */
  }

  try {
    const { data: arJobs } = await service
      .from("uncat_income_jobs")
      .select("id, status, created_at")
      .eq("client_link_id", clientLinkId)
      .not("status", "in", "(complete,cancelled,finalized)")
      .order("created_at", { ascending: false });

    for (const a of (arJobs || []) as any[]) {
      items.push({
        category: "ar_recovery_open",
        label: "A/R recovery in progress",
        detail: `Status: ${a.status || "running"}`,
        href: `/ar-recovery/${a.id}/review`,
        occurredAt: a.created_at,
      });
    }
  } catch {
    /* table not present */
  }

  // Sort newest-first so the freshest fires are at the top.
  items.sort((a, b) => {
    const ta = a.occurredAt ? Date.parse(a.occurredAt) : 0;
    const tb = b.occurredAt ? Date.parse(b.occurredAt) : 0;
    return tb - ta;
  });

  return { items, totalCount: items.length };
}

// ─── RECENT ACTIVITY ────────────────────────────────────────────────────

export interface ActivityEvent {
  id: string;
  eventType: string;
  occurredAt: string;
  /** Best-effort human label derived from event_type. */
  label: string;
  /** Where to jump for context (null if we can't infer). */
  href: string | null;
  payload: any;
}

/**
 * Last N audit_log entries scoped to this client. We have no FK from
 * audit_log → client_link_id, so we filter on request_payload->>client_link_id
 * (or fields like reclass_job_id that resolve back to this client). This
 * is best-effort — some events won't carry the client ID and will be missed,
 * but the ones we do surface are the bookkeeper-meaningful ones.
 */
export async function fetchRecentActivity(
  service: SupabaseClient,
  clientLinkId: string,
  limit = 25
): Promise<ActivityEvent[]> {
  const { data } = await service
    .from("audit_log")
    .select("id, event_type, occurred_at, request_payload")
    .filter("request_payload->>client_link_id", "eq", clientLinkId)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  return ((data || []) as any[]).map((row) => ({
    id: row.id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    label: humanizeEventType(row.event_type),
    href: inferActivityHref(row.event_type, row.request_payload, clientLinkId),
    payload: row.request_payload,
  }));
}

function humanizeEventType(t: string): string {
  // event_type values are snake_case. Split + title-case for display.
  if (!t) return "Activity";
  return t
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferActivityHref(
  eventType: string,
  payload: any,
  clientLinkId: string
): string | null {
  if (!payload) return null;
  if (payload.reclass_job_id) return `/reclass/${payload.reclass_job_id}/review`;
  if (payload.coa_job_id) return `/jobs/${payload.coa_job_id}/review`;
  if (payload.discovery_job_id) return `/rules/${payload.discovery_job_id}/review`;
  if (eventType.includes("bank_rules") || eventType.includes("rule_")) {
    return `/clients/${clientLinkId}`; // landing here is fine if no specific job
  }
  return null;
}

// ─── INTERNAL SUMMARY STATS ────────────────────────────────────────────

export interface InternalSummary {
  /** Total bank_rules with status='active'. */
  activeBankRules: number;
  /** Most recent pushed_to_qbo_at across all rules — when this client's
   *  rule library was last exported to QBO. Null if never exported. */
  lastRuleExportAt: string | null;
  /** Last 5 completed reclass jobs for the activity strip. */
  recentReclassJobs: Array<{
    id: string;
    status: string;
    workflow: string | null;
    createdAt: string;
    sourceAccountName: string | null;
  }>;
  /** Last 5 completed COA cleanups. */
  recentCleanups: Array<{
    id: string;
    status: string;
    createdAt: string;
  }>;
}

// ─── CLIENT PROGRESS FLOW ──────────────────────────────────────────────

/** Per-stage status: drives the colored card in the flow chart. */
export type ProgressStageStatus =
  | "complete"     // all good (emerald)
  | "in_progress"  // started but not done (amber)
  | "blocked"      // failed / stuck (red)
  | "not_started"  // gray
  | "skipped";     // intentionally not applicable (e.g. Stripe not required)

export interface ProgressStage {
  key:
    | "setup"
    | "coa"
    | "reclass"
    | "rules"
    | "stripe"
    | "bs"
    | "signoff"
    | "production"
    | "close";
  label: string;
  status: ProgressStageStatus;
  /** One-line summary rendered under the label. */
  detail: string;
  /** Where clicking the card sends the bookkeeper. null = no useful link. */
  href: string | null;
}

/** The ONE thing to do next for this client — drives the Continue banner. */
export interface NextAction {
  stageKey: ProgressStage["key"];
  label: string;
  /** One line: what to actually do. */
  detail: string;
  /** Button text. */
  cta: string;
  href: string | null;
  phase: "setup" | "cleanup" | "production";
}

export interface ClientProgress {
  stages: ProgressStage[];
  /** 0-100 % of applicable (non-skipped) stages that are "complete". */
  percentComplete: number;
  /** First not-done stage, resolved to a concrete action. null = all done. */
  nextAction: NextAction | null;
}

/**
 * Snapshot the client's lifecycle for the Overview tab's flow chart.
 * Returns a stable 6-stage progression. Each stage's status reflects
 * the most-recent SNAP-side state, not point-in-time accuracy — we want
 * the bookkeeper to see "this client needs X next", not perfect telemetry.
 */
export async function fetchClientProgress(
  service: SupabaseClient,
  clientLinkId: string,
  clientLink: {
    qbo_realm_id: string | null;
    industry: string | null;
    double_client_id: string | null;
    daily_recon_enabled?: boolean | null;
    daily_recon_paused?: boolean | null;
    cleanup_completed_at?: string | null;
    cleanup_review_state?: string | null;
  }
): Promise<ClientProgress> {
  const stages: ProgressStage[] = [];

  // ── 1. Setup ────────────────────────────────────────────────────────
  // Setup = QBO connected + industry set + Double matched. Missing any
  // of these blocks downstream features. We don't require Portal since
  // many clients don't get a portal user.
  const setupChecks = [
    { name: "QBO", ok: !!clientLink.qbo_realm_id },
    { name: "Industry", ok: !!clientLink.industry },
    {
      name: "Double",
      ok:
        !!clientLink.double_client_id &&
        !clientLink.double_client_id.startsWith("pending_"),
    },
  ];
  const setupOkCount = setupChecks.filter((c) => c.ok).length;
  const setupMissing = setupChecks.filter((c) => !c.ok).map((c) => c.name);
  stages.push({
    key: "setup",
    label: "Setup",
    status:
      setupOkCount === setupChecks.length
        ? "complete"
        : setupOkCount === 0
        ? "not_started"
        : "in_progress",
    detail:
      setupOkCount === setupChecks.length
        ? "QBO + industry + Double linked"
        : `Missing: ${setupMissing.join(", ")}`,
    href: null, // fixed on this page (details card + Double matcher below)
  });

  // ── 2. COA Cleanup ──────────────────────────────────────────────────
  // Done when ≥1 coa_job has status='complete'. "In progress" if there's
  // an open job. "Blocked" if there's a failed one.
  const { data: coaJobs } = await service
    .from("coa_jobs")
    .select("id, status, created_at")
    .eq("client_link_id", clientLinkId)
    .order("created_at", { ascending: false });

  const coaList = (coaJobs || []) as any[];
  const coaComplete = coaList.filter((j) => j.status === "complete").length;
  const coaOpen = coaList.filter(
    (j) => j.status === "in_review" || j.status === "executing"
  ).length;
  const coaFailed = coaList.filter((j) => j.status === "failed").length;
  stages.push({
    key: "coa",
    label: "COA Cleanup",
    // Block only when the LATEST job failed — an old failed run that was later
    // re-done (newer complete) shouldn't keep the stage red. (coaList is
    // ordered created_at desc, so [0] is the most recent.)
    status: coaList[0]?.status === "failed"
      ? "blocked"
      : coaOpen > 0
      ? "in_progress"
      : coaComplete > 0
      ? "complete"
      : "not_started",
    detail:
      coaComplete > 0
        ? `${coaComplete} cleanup${coaComplete === 1 ? "" : "s"} done${coaOpen > 0 ? ` · ${coaOpen} in review` : ""}`
        : coaOpen > 0
        ? `${coaOpen} in progress`
        : coaFailed > 0
        ? `${coaFailed} failed — needs retry`
        : "Not started",
    // No job yet → start one with this client preselected (the /clients
    // fallback forced a re-find of the client you were already viewing).
    href: coaList[0] ? `/jobs/${coaList[0].id}/review` : `/jobs/new?client=${clientLinkId}`,
  });

  // ── 3. Reclass / Categorization ─────────────────────────────────────
  // Same logic as COA. Note: reclass_jobs status includes
  // "web_search_paused" which counts as in-progress.
  const { data: reclassJobs } = await service
    .from("reclass_jobs")
    .select("id, status, created_at")
    .eq("client_link_id", clientLinkId)
    .order("created_at", { ascending: false });

  const rcList = (reclassJobs || []) as any[];
  const rcComplete = rcList.filter((j) => j.status === "complete").length;
  const rcOpen = rcList.filter(
    (j) =>
      j.status === "in_review" ||
      j.status === "executing" ||
      j.status === "web_search_paused"
  ).length;
  const rcFailed = rcList.filter((j) => j.status === "failed").length;
  stages.push({
    key: "reclass",
    label: "Reclass",
    // Block only when the LATEST reclass failed — older failed runs (e.g.
    // watchdog-killed) that were later re-completed shouldn't keep the stage
    // red and stop the client moving to production. (rcList is created_at desc.)
    status: rcList[0]?.status === "failed"
      ? "blocked"
      : rcOpen > 0
      ? "in_progress"
      : rcComplete > 0
      ? "complete"
      : "not_started",
    detail:
      rcComplete > 0
        ? `${rcComplete} job${rcComplete === 1 ? "" : "s"} done${rcOpen > 0 ? ` · ${rcOpen} in review` : ""}`
        : rcOpen > 0
        ? `${rcOpen} in progress`
        : rcFailed > 0
        ? `${rcFailed} failed — investigate`
        : "Not started",
    href: rcList[0] ? `/reclass/${rcList[0].id}/review` : `/reclass/new?client=${clientLinkId}`,
  });

  // ── 4. Bank Rules ───────────────────────────────────────────────────
  // Done = ≥1 active rule. We don't require a magic threshold (e.g. "10
  // rules") because different clients have different vendor mix.
  const { count: activeRulesCount } = await service
    .from("bank_rules")
    .select("id", { count: "exact", head: true })
    .eq("client_link_id", clientLinkId)
    .eq("status", "active");
  const { count: pendingRulesCount } = await service
    .from("bank_rules")
    .select("id", { count: "exact", head: true })
    .eq("client_link_id", clientLinkId)
    .eq("status", "pending");
  const { data: latestDiscovery } = await service
    .from("rule_discovery_jobs")
    .select("id")
    .eq("client_link_id", clientLinkId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const active = activeRulesCount ?? 0;
  const pending = pendingRulesCount ?? 0;
  stages.push({
    key: "rules",
    label: "Bank Rules",
    status: pending > 0
      ? "in_progress"
      : active > 0
      ? "complete"
      : "not_started",
    detail:
      active > 0
        ? `${active} active${pending > 0 ? ` · ${pending} pending review` : ""}`
        : pending > 0
        ? `${pending} pending approval`
        : "No rules yet",
    href: latestDiscovery
      ? `/rules/${(latestDiscovery as any).id}/review`
      : `/rules/new?client=${clientLinkId}`,
  });

  // ── 5. Stripe ───────────────────────────────────────────────────────
  // Same source of truth as the cleanup board: stripe_connection_status +
  // stripe_request_sent_at + the "not required" flag. Fetched here (not
  // threaded from the page) so a missing column degrades this one stage,
  // never the whole profile.
  let stripeStatus: string | null = null;
  let stripeRequestedAt: string | null = null;
  let stripeNotRequired = false;
  try {
    const { data: sRow } = await (service as any)
      .from("client_links")
      .select("stripe_connection_status, stripe_request_sent_at, stripe_not_required")
      .eq("id", clientLinkId)
      .maybeSingle();
    stripeStatus = sRow?.stripe_connection_status ?? null;
    stripeRequestedAt = sRow?.stripe_request_sent_at ?? null;
    stripeNotRequired = !!sRow?.stripe_not_required;
  } catch {
    /* stage degrades to not_started */
  }
  const stripeConnected = stripeStatus === "connected";
  stages.push({
    key: "stripe",
    label: "Stripe",
    status: stripeNotRequired
      ? "skipped"
      : stripeConnected
      ? "complete"
      : stripeStatus === "pending" || stripeRequestedAt
      ? "in_progress"
      : "not_started",
    detail: stripeNotRequired
      ? "Marked not required"
      : stripeConnected
      ? "Connected — payouts visible"
      : stripeStatus === "pending" || stripeRequestedAt
      ? "Connect request sent — waiting on the client"
      : "Send the client a Stripe connect request (Clients board), or mark not required",
    href: stripeConnected ? `/stripe-recon/new?client=${clientLinkId}` : `/clients`,
  });

  // ── 6. BS Cleanup ───────────────────────────────────────────────────
  // Mirrors the cleanup board: any bank_recon_jobs row = started; latest
  // row complete = done.
  let bsLatest: { id: string; status: string } | null = null;
  try {
    const { data: bsRow } = await (service as any)
      .from("bank_recon_jobs")
      .select("id, status")
      .eq("client_link_id", clientLinkId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    bsLatest = bsRow || null;
  } catch {
    /* stage degrades to not_started */
  }
  stages.push({
    key: "bs",
    label: "BS Cleanup",
    status: !bsLatest
      ? "not_started"
      : bsLatest.status === "complete"
      ? "complete"
      : "in_progress",
    detail: !bsLatest
      ? "Balance-sheet reconciliation not started"
      : bsLatest.status === "complete"
      ? "Balance sheet reconciled"
      : "Reconciliation in progress",
    href: `/balance-sheet/${clientLinkId}/cleanup`,
  });

  // ── 7. Statements sign-off ──────────────────────────────────────────
  // cleanup_completed_at is THE graduation stamp (set when a manager
  // approves + sends the cleanup statements); cleanup_review_state
  // "in_review" = submitted and waiting on the manager.
  const cleanupDone = !!clientLink.cleanup_completed_at;
  const signoffInReview = clientLink.cleanup_review_state === "in_review";
  stages.push({
    key: "signoff",
    label: "Sign-off",
    status: cleanupDone ? "complete" : signoffInReview ? "in_progress" : "not_started",
    detail: cleanupDone
      ? `Cleanup signed off ${new Date(clientLink.cleanup_completed_at!).toLocaleDateString()}`
      : signoffInReview
      ? "Submitted — awaiting manager review"
      : "Submit statements for manager sign-off on the Cleanup board",
    href: `/cleanup`,
  });

  // ── 8. Production (daily recon) ─────────────────────────────────────
  // Enrolled = daily_recon_enabled; "fired" = ≥1 recon audit event in 14d
  // (guards against "enabled but the engine never runs" — LT Woodworks).
  const enrolled = clientLink.daily_recon_enabled === true;
  const dailyReconPaused = clientLink.daily_recon_paused === true;
  const { count: recentReconCount } = await service
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .filter("request_payload->>client_link_id", "eq", clientLinkId)
    .ilike("event_type", "%recon%")
    .gte("occurred_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());
  const reconFired = (recentReconCount ?? 0) > 0;
  stages.push({
    key: "production",
    label: "Production",
    status: dailyReconPaused
      ? "blocked"
      : enrolled
      ? reconFired
        ? "complete"
        : "in_progress"
      : "not_started",
    detail: dailyReconPaused
      ? "Daily recon paused — needs unpause"
      : enrolled
      ? reconFired
        ? "Daily recon live · fired in last 14d"
        : "Enrolled — engine hasn't fired yet"
      : "Move to production to start daily recon",
    // Enrolled → their daily queue; not enrolled → the panel below.
    href: enrolled ? `/today/${clientLinkId}` : "#move-to-production",
  });

  // ── 9. Month Close ──────────────────────────────────────────────────
  // Done = a completed production month-end in the last 35 days (a
  // calendar month + slack) on monthly_rec_runs — the actual close path.
  let lastClose: { period: string; completed_at: string } | null = null;
  try {
    const { data: closeRow } = await (service as any)
      .from("monthly_rec_runs")
      .select("period, completed_at")
      .eq("client_link_id", clientLinkId)
      .eq("kind", "production_me")
      .eq("status", "complete")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    lastClose = closeRow || null;
  } catch {
    /* stage degrades below */
  }
  const closeRecent =
    !!lastClose?.completed_at &&
    Date.now() - new Date(lastClose.completed_at).getTime() < 35 * 24 * 60 * 60 * 1000;
  stages.push({
    key: "close",
    label: "Month Close",
    status: closeRecent ? "complete" : lastClose ? "in_progress" : "not_started",
    detail: closeRecent
      ? `${lastClose!.period} closed ${new Date(lastClose!.completed_at).toLocaleDateString()}`
      : lastClose
      ? `Last close ${lastClose.period} — none in the last 35 days`
      : cleanupDone
      ? "First month-end close pending"
      : "First close comes after cleanup sign-off",
    href: `/production`,
  });

  // ── Next action: the FIRST stage that still needs a human ───────────
  const NEXT_COPY: Record<
    ProgressStage["key"],
    { phase: NextAction["phase"]; start: string; going: string }
  > = {
    setup: { phase: "setup", start: "Fix setup below", going: "Fix setup below" },
    coa: { phase: "cleanup", start: "Start COA cleanup", going: "Open COA job" },
    reclass: { phase: "cleanup", start: "Start reclass", going: "Open reclass job" },
    rules: { phase: "cleanup", start: "Generate bank rules", going: "Review bank rules" },
    stripe: { phase: "cleanup", start: "Open Clients board", going: "Open Clients board" },
    bs: { phase: "cleanup", start: "Start BS Cleanup", going: "Open BS Cleanup" },
    signoff: { phase: "cleanup", start: "Open Cleanup board", going: "Open Cleanup board" },
    production: { phase: "production", start: "Move to production", going: "Open Today queue" },
    close: { phase: "production", start: "Open Production board", going: "Open Production board" },
  };
  const next = stages.find((s) => s.status !== "complete" && s.status !== "skipped") || null;
  const nextAction: NextAction | null = next
    ? {
        stageKey: next.key,
        label: next.label,
        detail: next.detail,
        cta: next.status === "not_started" ? NEXT_COPY[next.key].start : NEXT_COPY[next.key].going,
        href: next.href,
        phase: NEXT_COPY[next.key].phase,
      }
    : null;

  const applicable = stages.filter((s) => s.status !== "skipped");
  const completed = applicable.filter((s) => s.status === "complete").length;
  return {
    stages,
    percentComplete: Math.round((completed / Math.max(1, applicable.length)) * 100),
    nextAction,
  };
}

export async function fetchInternalSummary(
  service: SupabaseClient,
  clientLinkId: string
): Promise<InternalSummary> {
  const [rulesCount, lastExport, reclassJobs, coaJobs] = await Promise.all([
    service
      .from("bank_rules")
      .select("id", { count: "exact", head: true })
      .eq("client_link_id", clientLinkId)
      .eq("status", "active"),
    service
      .from("bank_rules")
      .select("pushed_to_qbo_at")
      .eq("client_link_id", clientLinkId)
      .not("pushed_to_qbo_at", "is", null)
      .order("pushed_to_qbo_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    service
      .from("reclass_jobs")
      .select("id, status, workflow, created_at, source_account_name")
      .eq("client_link_id", clientLinkId)
      .order("created_at", { ascending: false })
      .limit(5),
    service
      .from("coa_jobs")
      .select("id, status, created_at")
      .eq("client_link_id", clientLinkId)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  return {
    activeBankRules: rulesCount.count ?? 0,
    lastRuleExportAt: (lastExport.data as any)?.pushed_to_qbo_at ?? null,
    recentReclassJobs: ((reclassJobs.data || []) as any[]).map((r) => ({
      id: r.id,
      status: r.status,
      workflow: r.workflow,
      createdAt: r.created_at,
      sourceAccountName: r.source_account_name,
    })),
    recentCleanups: ((coaJobs.data || []) as any[]).map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.created_at,
    })),
  };
}
