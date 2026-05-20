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
 * Stages:
 *   needs_cleanup       no active COA or reclass job
 *   coa_in_progress     active COA job (executing / in_review / failed)
 *   reclass_in_progress active reclass job, no stripe request pending
 *   review              most recent reclass complete, no stripe request
 *   awaiting_stripe     stripe_request_sent_at set, not yet connected
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
    .select(`
      id,
      client_name,
      jurisdiction,
      state_province,
      assigned_bookkeeper_id,
      stripe_connection_status,
      stripe_detected,
      stripe_request_sent_at,
      kanban_on_hold,
      due_date,
      qbo_realm_id
    `)
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

  // Note counts per client
  const { data: noteCounts } = await service
    .from("client_notes")
    .select("client_link_id")
    .in("client_link_id", clientIds);

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
    review: [],
    awaiting_stripe: [],
  };

  for (const client of activeClients) {
    const coa = latestCoa.get(client.id);
    const reclass = latestReclass.get(client.id);
    const bk = client.assigned_bookkeeper_id ? bkById.get(client.assigned_bookkeeper_id) : null;
    const stripeConnected = client.stripe_connection_status === "connected";
    const stripePending = client.stripe_connection_status === "pending";
    const token = latestStripeToken.get(client.id);

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
      due_date: client.due_date,
      note_count: noteCountMap.get(client.id) || 0,
      bookkeeper: bk ? { id: bk.id, full_name: bk.full_name, avatar_url: bk.avatar_url } : null,
      latest_coa_job: coa ? { id: coa.id, status: coa.status } : null,
      latest_reclass_job: reclass ? { id: reclass.id, status: reclass.status } : null,
    };

    // Awaiting stripe takes priority — already sent request, not yet connected
    if (client.stripe_request_sent_at && !stripeConnected) {
      columns.awaiting_stripe.push(card);
      continue;
    }

    // Active or failed COA job — failed stays visible in column
    if (coa && (ACTIVE_STATUSES.has(coa.status) || coa.status === "failed")) {
      columns.coa_in_progress.push(card);
      continue;
    }

    // Active or failed reclass job (failed stays visible in column)
    if (reclass && (ACTIVE_STATUSES.has(reclass.status) || reclass.status === "failed")) {
      // Only in reclass column if COA is done or skipped
      if (!coa || !ACTIVE_STATUSES.has(coa.status)) {
        columns.reclass_in_progress.push(card);
        continue;
      }
    }

    // Reclass complete → in review
    if (reclass && reclass.status === "complete") {
      columns.review.push(card);
      continue;
    }

    // No active jobs → needs cleanup
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

  return NextResponse.json({ columns: paginated });
}

function emptyColumns() {
  const keys = ["needs_cleanup", "coa_in_progress", "reclass_in_progress", "review", "awaiting_stripe"];
  return Object.fromEntries(keys.map((k) => [k, { cards: [], total: 0 }]));
}
