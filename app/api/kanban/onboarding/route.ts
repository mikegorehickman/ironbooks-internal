import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/kanban/onboarding
 *
 * Returns clients grouped by onboarding stage. Stage is derived from live
 * job state — no separate status column to keep in sync.
 *
 * Query params:
 *   bookkeeper_id  — filter by assigned bookkeeper (optional)
 *   page           — 0-indexed page per column (default 0)
 *   limit          — cards per column (default 20, max 50)
 *
 * Stages (priority top-down — first matching wins):
 *   awaiting_stripe     stripe_request_sent_at set, not yet connected
 *   coa_in_progress     active or failed COA job
 *   reclass_in_progress active or failed reclass job (COA done)
 *   review              cleanup_review_state='in_review' (senior pending)
 *   bs_cleanup          any reclass complete (regardless of stripe state) and
 *                       no newer reclass currently active/failed. Stripe is
 *                       parallel work — once reclass + bank rules are done,
 *                       the client is ready to start BS Cleanup.
 *   needs_cleanup       no active jobs
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const bookkeeperFilter = searchParams.get("bookkeeper_id") || null;
  const page = Math.max(0, parseInt(searchParams.get("page") || "0", 10));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));
  const offset = page * limit;

  const service = createServiceSupabase();

  // Pull all active onboarding clients (cleanup not yet complete, not on hold)
  let query = service
    .from("client_links")
    .select("*")
    .eq("is_active", true)
    .is("cleanup_completed_at", null);

  if (bookkeeperFilter) {
    query = query.eq("assigned_bookkeeper_id", bookkeeperFilter);
  }

  const { data: clients, error } = await query.order("client_name");
  if (error) return NextResponse.json({ error: `client_links query: ${error.message}` }, { status: 500 });

  // Filter on_hold in JS — new column may not be in PostgREST schema cache yet
  const activeClients = (clients || []).filter((c: any) => !c.kanban_on_hold);
  if (!activeClients.length) return NextResponse.json({ columns: emptyColumns() });

  const clientIds = activeClients.map((c) => c.id);

  // Most recent COA job per client
  const { data: coaJobs } = await service
    .from("coa_jobs")
    .select("id, client_link_id, status, created_at, updated_at, bookkeeper_id")
    .in("client_link_id", clientIds)
    .order("created_at", { ascending: false });

  // Most recent reclass job per client
  const { data: reclassJobs } = await service
    .from("reclass_jobs")
    .select("id, client_link_id, status, created_at, updated_at, bookkeeper_id")
    .in("client_link_id", clientIds)
    .order("created_at", { ascending: false });

  // Most recent stripe connect token per client (for attribution)
  const { data: stripeTokens } = await service
    .from("stripe_connect_tokens")
    .select("client_link_id, created_at, created_by")
    .in("client_link_id", clientIds)
    .order("created_at", { ascending: false });

  const latestStripeToken = new Map<string, any>();
  for (const t of stripeTokens || []) {
    if (!latestStripeToken.has(t.client_link_id)) latestStripeToken.set(t.client_link_id, t);
  }

  // Most recent stripe-recon job per client — drives the BS-stage
  // gate ("stripe done OR not required").
  const stripeReconQuery: any = await (service as any)
    .from("stripe_recon_jobs")
    .select("client_link_id, status, created_at")
    .in("client_link_id", clientIds)
    .order("created_at", { ascending: false });
  const stripeReconJobs: any[] = stripeReconQuery.data || [];
  const latestStripeRecon = new Map<string, any>();
  for (const j of stripeReconJobs) {
    if (!latestStripeRecon.has(j.client_link_id))
      latestStripeRecon.set(j.client_link_id, j);
  }

  // Most recent bank_recon_jobs per client — used to differentiate
  // "BS not started" vs "BS in progress" on the kanban card subtitle.
  const bankReconQuery: any = await (service as any)
    .from("bank_recon_jobs")
    .select("client_link_id, status, created_at")
    .in("client_link_id", clientIds)
    .order("created_at", { ascending: false });
  const bankReconJobs: any[] = bankReconQuery.data || [];
  const latestBankRecon = new Map<string, any>();
  for (const j of bankReconJobs) {
    if (!latestBankRecon.has(j.client_link_id))
      latestBankRecon.set(j.client_link_id, j);
  }

  // Note counts per client
  const { data: noteCounts } = await service
    .from("client_notes")
    .select("client_link_id")
    .in("client_link_id", clientIds);

  // Bank-rule counts — drives the "Sign-off only" vs "Needs bank rules"
  // next-step chip and the step-3 checklist state on the cleanup board.
  const { data: ruleRows } = await service
    .from("bank_rules")
    .select("client_link_id")
    .in("client_link_id", clientIds);
  const ruleCountMap = new Map<string, number>();
  for (const r of (ruleRows as any[]) || []) {
    ruleCountMap.set(r.client_link_id, (ruleCountMap.get(r.client_link_id) || 0) + 1);
  }

  // Bookkeeper names
  const { data: bookkeepers } = await service
    .from("users")
    .select("id, full_name, avatar_url")
    .eq("is_active", true);

  const bkById = new Map((bookkeepers || []).map((b) => [b.id, b]));

  // Build lookup maps (first entry = most recent due to order desc)
  const latestCoa = new Map<string, any>();
  for (const j of coaJobs || []) {
    if (!latestCoa.has(j.client_link_id)) latestCoa.set(j.client_link_id, j);
  }
  const latestReclass = new Map<string, any>();
  for (const j of reclassJobs || []) {
    if (!latestReclass.has(j.client_link_id)) latestReclass.set(j.client_link_id, j);
  }
  const noteCountMap = new Map<string, number>();
  for (const n of noteCounts || []) {
    noteCountMap.set(n.client_link_id, (noteCountMap.get(n.client_link_id) || 0) + 1);
  }

  const ACTIVE_STATUSES = new Set(["pending", "executing", "in_review"]);

  const columns: Record<string, any[]> = {
    needs_cleanup: [],
    coa_in_progress: [],
    reclass_in_progress: [],
    awaiting_stripe: [],
    manual_cleanup: [],
    bs_cleanup: [],
    review: [],
  };

  // Build a per-client "has any completed reclass" map so a later failed
  // reclass (e.g., killed by the watchdog) doesn't block a client whose
  // earlier reclass actually shipped.
  const hasCompleteReclassByClient = new Map<string, boolean>();
  for (const j of reclassJobs || []) {
    if (j.status === "complete") hasCompleteReclassByClient.set(j.client_link_id, true);
  }

  // Latest completed COA job per client — used as fallback range for the
  // one-click cleanup-PDF link before the client is fully marked complete.
  // (Same fallback `complete-cleanup` uses, so the dates match.)
  const completeCoaRangeQuery: any = await (service as any)
    .from("coa_jobs")
    .select("client_link_id, date_range_start, date_range_end, execution_completed_at, manual_cleanup_items")
    .in("client_link_id", clientIds)
    .eq("status", "complete")
    .order("execution_completed_at", { ascending: false });
  const completeCoaRange = new Map<string, { start: string | null; end: string | null }>();
  // Auto-fed manual-cleanup detail: the most recent completed COA job's
  // QBO-limitation items, surfaced on the "Manual cleanup (QBO)" card.
  const manualItemsByClient = new Map<string, any[]>();
  for (const j of (completeCoaRangeQuery.data || []) as any[]) {
    if (!completeCoaRange.has(j.client_link_id)) {
      completeCoaRange.set(j.client_link_id, {
        start: j.date_range_start,
        end: j.date_range_end,
      });
      if (Array.isArray(j.manual_cleanup_items) && j.manual_cleanup_items.length) {
        manualItemsByClient.set(j.client_link_id, j.manual_cleanup_items);
      }
    }
  }

  for (const client of activeClients) {
    const coa = latestCoa.get(client.id);
    const reclass = latestReclass.get(client.id);
    const bankRecon = latestBankRecon.get(client.id);
    const bk = client.assigned_bookkeeper_id ? bkById.get(client.assigned_bookkeeper_id) : null;
    const stripeConnected = client.stripe_connection_status === "connected";
    const stripePending = client.stripe_connection_status === "pending";
    const stripeNotRequired = !!(client as any).stripe_not_required;
    const token = latestStripeToken.get(client.id);

    // Does the client have ANY completed reclass run (not just the latest)?
    // Used to make BS Cleanup reachable even if a later reclass failed.
    const hasCompleteReclass = !!hasCompleteReclassByClient.get(client.id);
    const latestReclassActive = reclass && ACTIVE_STATUSES.has(reclass.status);

    // BS status — if there's already a bank_recon_jobs row we surface
    // it as "in progress"; otherwise "ready to start." Used in the
    // card subtitle.
    const bsInProgress = bankRecon && bankRecon.status !== "complete";

    // One-click cleanup-PDF href — prefer the persisted cleanup_range_*,
    // fall back to the most recent completed COA job's range so the
    // bookkeeper can still download a report mid-onboarding.
    const rangeStart =
      (client as any).cleanup_range_start ||
      completeCoaRange.get(client.id)?.start ||
      null;
    const rangeEnd =
      (client as any).cleanup_range_end ||
      completeCoaRange.get(client.id)?.end ||
      null;
    const cleanupPdfHref =
      rangeStart && rangeEnd
        ? `/api/reports/cleanup/${client.id}?start=${rangeStart}&end=${rangeEnd}`
        : null;

    const card = {
      id: client.id,
      client_name: client.client_name,
      jurisdiction: client.jurisdiction,
      state_province: client.state_province,
      // Show stripe badge if detected, pending, or connected
      stripe_detected: client.stripe_detected || stripePending || stripeConnected,
      stripe_connected: stripeConnected,
      stripe_pending: stripePending,
      stripe_request_sent_at: client.stripe_request_sent_at,
      stripe_link_sent_by: token ? (bkById.get(token.created_by)?.full_name ?? null) : null,
      stripe_link_sent_at: token?.created_at ?? null,
      stripe_not_required: stripeNotRequired,
      bs_recon_started: !!bankRecon,
      bs_recon_in_progress: !!bsInProgress,
      ask_client_email_sent_at: (client as any).ask_client_email_sent_at || null,
      stripe_request_sent_confirmed_at: (client as any).stripe_request_sent_confirmed_at || null,
      cleanup_pdf_href: cleanupPdfHref,
      due_date: client.due_date,
      note_count: noteCountMap.get(client.id) || 0,
      bookkeeper: bk ? { id: bk.id, full_name: bk.full_name, avatar_url: bk.avatar_url } : null,
      latest_coa_job: coa ? { id: coa.id, status: coa.status } : null,
      latest_reclass_job: reclass ? { id: reclass.id, status: reclass.status } : null,
      bank_rule_count: ruleCountMap.get(client.id) || 0,
      has_complete_reclass: hasCompleteReclass,
      manual_cleanup_needed: !!(client as any).manual_cleanup_needed,
      manual_cleanup_notes: (client as any).manual_cleanup_notes || null,
      manual_cleanup_items: manualItemsByClient.get(client.id) || [],
    };

    // ── PRIORITY 1: senior review (submitted, awaiting admin/lead) ──
    if ((client as any).cleanup_review_state === "in_review") {
      columns.review.push(card);
      continue;
    }

    // ── PRIORITY 1.5: manual cleanup needed in QBO (flagged, blocking) ──
    // Set when a COA job left QBO-limitation hand-work, or manually by a
    // bookkeeper. Surfaces in its own column so it doesn't hide in a pipeline
    // phase. Cleared via the manual-cleanup PATCH (Resolve).
    if (card.manual_cleanup_needed) {
      columns.manual_cleanup.push(card);
      continue;
    }

    // ── PRIORITY 2: active COA (must finish before anything else) ──
    if (coa && ACTIVE_STATUSES.has(coa.status)) {
      columns.coa_in_progress.push(card);
      continue;
    }

    // ── PRIORITY 3: BS cleanup ──
    // Once ANY reclass has completed AND no newer reclass is currently
    // active, the client is ready for BS work. Stripe is parallel — a
    // pending stripe link no longer blocks BS Cleanup.
    if (hasCompleteReclass && !latestReclassActive) {
      // BS-cleanup deferral: a manager can defer BS (bs_enabled=false /
      // P&L-only). Deferred clients drop off the cleanup board — they're done
      // with pre-production cleanup work and carry a "BS owed" badge on the
      // dashboard instead of nagging in the BS column.
      if ((client as any).bs_enabled !== false) {
        columns.bs_cleanup.push(card);
      }
      continue;
    }

    // ── PRIORITY 4: awaiting stripe (link sent, not yet connected) ──
    // Skipped for clients flagged stripe_not_required.
    if (
      client.stripe_request_sent_at &&
      !stripeConnected &&
      !stripeNotRequired
    ) {
      columns.awaiting_stripe.push(card);
      continue;
    }

    // ── PRIORITY 5: failed COA ──
    if (coa && coa.status === "failed") {
      columns.coa_in_progress.push(card);
      continue;
    }

    // ── PRIORITY 6: active or failed reclass (COA done, no prior complete reclass) ──
    if (reclass && (ACTIVE_STATUSES.has(reclass.status) || reclass.status === "failed")) {
      if (!coa || !ACTIVE_STATUSES.has(coa.status)) {
        columns.reclass_in_progress.push(card);
        continue;
      }
    }

    // ── PRIORITY 7: needs cleanup (no active jobs) ──
    columns.needs_cleanup.push(card);
  }

  // Sort awaiting_stripe by oldest request first (highest priority)
  columns.awaiting_stripe.sort((a, b) =>
    (a.stripe_request_sent_at || "").localeCompare(b.stripe_request_sent_at || "")
  );

  // Paginate each column
  const paginated: Record<string, { cards: any[]; total: number }> = {};
  for (const [key, cards] of Object.entries(columns)) {
    paginated[key] = {
      cards: cards.slice(offset, offset + limit),
      total: cards.length,
    };
  }

  return NextResponse.json({
    columns: paginated,
    // Active bookkeepers — powers the assign dropdown on the Cleanup board.
    bookkeepers: (bookkeepers || []).map((b) => ({ id: b.id, full_name: b.full_name })),
  });
}

function emptyColumns() {
  const keys = [
    "needs_cleanup",
    "coa_in_progress",
    "reclass_in_progress",
    "awaiting_stripe",
    "manual_cleanup",
    "bs_cleanup",
    "review",
  ];
  return Object.fromEntries(keys.map((k) => [k, { cards: [], total: 0 }]));
}
