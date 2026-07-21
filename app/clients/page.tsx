import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { sweepStaleJobs } from "@/lib/stale-jobs";
import { ClientsList } from "./clients-list";
import { InReviewAccounts } from "./in-review-accounts";
import { type ManagerRow } from "./manager-dashboard";
import { StripeInviteSuggestions, type StripeInviteSuggestion } from "./stripe-invite-suggestions";
import { deriveLifecycleStatus, macroStageOfStatus } from "@/lib/client-lifecycle";
import { previousMonthPeriod } from "@/lib/monthly-rec";

export default async function ClientsPage({
  searchParams,
}: {
  searchParams?: Promise<{ stage?: string }>;
}) {
  const sp = (await searchParams) || {};
  const initialStage = ["onboarding", "cleanup", "production"].includes(sp.stage || "")
    ? (sp.stage as "onboarding" | "cleanup" | "production")
    : "all";
  // Watchdog: auto-fail any job that's been hung in `executing` past its
  // window before we render. Cheap (indexed UPDATEs, usually 0 rows) and
  // means a bookkeeper hitting the clients page after a silent worker
  // crash sees the row unblocked instead of a phantom "running" spinner.
  // Errors are swallowed — never let the watchdog break page load.
  await sweepStaleJobs().catch((e) =>
    console.warn("[clients] sweepStaleJobs failed:", e?.message)
  );

  const supabase = await createServerSupabase();
  // Service client used for any query that needs to see across all users —
  // the `users` table is RLS-locked to self-reads, which silently truncated
  // the bookkeeper dropdown to just the logged-in user.
  const service = createServiceSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase.from("users").select("role, full_name").eq("id", user.id).single()
    : { data: null };

  const canEdit = profile && ["admin", "lead"].includes(profile.role);

  // Stripe-invite suggestions (senior banner) — same query the old
  // /dashboard used; the nightly detector cron writes the columns.
  // Promise.resolve() subscribes the lazy builder NOW so the query runs
  // concurrently with the page's main parallel batch below.
  let stripeInviteSuggestions: StripeInviteSuggestion[] = [];
  const stripeInviteQ = !canEdit
    ? null
    : Promise.resolve(
        service
      .from("client_links")
      .select(
        "id, client_name, jurisdiction, state_province, stripe_invite_suggested_at, stripe_invite_deposit_count, stripe_invite_deposit_total"
      )
      .eq("is_active", true)
      .not("stripe_invite_suggested_at", "is", null)
      .is("stripe_invite_dismissed_at", null)
      .neq("stripe_connection_status", "connected")
      .eq("stripe_not_required" as any, false)
      .order("stripe_invite_suggested_at", { ascending: false })
      );

  const [
    clientsRes,
    linksRes,
    bookkeepersRes,
    resumableCoaRes,
    stripeTokensRes,
  ] = await Promise.all([
    supabase.from("client_list_view").select("*").order("client_name"),
    // client_list_view doesn't expose double_client_name, stripe fields, or
    // the cleanup-completion markers — pull from client_links and merge.
    supabase
      .from("client_links")
      .select(
        "id, double_client_name, stripe_connection_status, due_date, cleanup_completed_at, cleanup_completed_by, cleanup_range_start, cleanup_range_end, cleanup_completion_note, cleanup_review_state, cleanup_review_submitted_at, cleanup_review_submitted_by, ask_client_email_created_at, ask_client_email_sent_at, ask_client_email_body, stripe_request_sent_confirmed_at, cleanup_pdf_sent_at, stripe_not_required, qbo_realm_id, qbo_refresh_token, daily_recon_enabled"
      ),
    // Bookkeepers dropdown — must use service client (RLS on `users` limits
    // self-reads, which would otherwise return only the current user and
    // leave the assign dropdown almost empty for everyone).
    service
      .from("users")
      .select("id, full_name, avatar_url")
      .eq("is_active", true)
      .in("role", ["admin", "lead", "bookkeeper"])
      .order("full_name"),
    // Resumable cleanup jobs — anything mid-flight where re-execute would
    // actually do something useful. Status 'cancelled' is excluded
    // because cancel flags all pending actions, so re-execute is a no-op
    // (the bookkeeper should start a fresh cleanup instead).
    supabase
      .from("coa_jobs")
      .select("id, client_link_id, status, updated_at, execution_started_at")
      .in("status", ["in_review", "executing", "failed"])
      .order("updated_at", { ascending: false }),

    // Latest Stripe Connect token per client — drives the "stripe link
    // generated" indicator on the card view. We can't ask for "most
    // recent per client" in one query, so we pull all and dedupe in JS.
    supabase
      .from("stripe_connect_tokens")
      .select("client_link_id, created_at")
      .order("created_at", { ascending: false }),
  ]);

  if (stripeInviteQ) {
    const { data: sugg } = await stripeInviteQ;
    const detected = ((sugg as any[]) || []).filter((r) => (r.stripe_invite_deposit_count || 0) > 0);
    const ids = detected.map((r) => r.id);

    // Enrich with send state: the latest stripe_connect email per client (so we
    // can show "requested {date}" + delivery status) and the latest connect
    // token's expiry (so we can flag an expired link that needs a resend). Both
    // reads are best-effort — if client_email_log (migration 93) isn't there the
    // panel just shows everyone as not-yet-invited.
    const logByClient = new Map<string, any>();
    const tokenByClient = new Map<string, any>();
    if (ids.length) {
      try {
        const [logsRes, toksRes] = await Promise.all([
          (service as any)
            .from("client_email_log")
            .select("client_link_id, to_address, status, created_at")
            .eq("email_type", "stripe_connect")
            .in("client_link_id", ids)
            .order("created_at", { ascending: false }),
          (service as any)
            .from("stripe_connect_tokens")
            .select("client_link_id, expires_at, used_at, created_at")
            .in("client_link_id", ids)
            .order("created_at", { ascending: false }),
        ]);
        for (const l of (logsRes?.data as any[]) || []) if (!logByClient.has(l.client_link_id)) logByClient.set(l.client_link_id, l);
        for (const t of (toksRes?.data as any[]) || []) if (!tokenByClient.has(t.client_link_id)) tokenByClient.set(t.client_link_id, t);
      } catch { /* pre-migration env — no send state */ }
    }

    const now = Date.now();
    stripeInviteSuggestions = detected.map((r) => {
      const log = logByClient.get(r.id);
      const tok = tokenByClient.get(r.id);
      const expiresAt = tok?.expires_at || null;
      const expired = !!expiresAt && !tok?.used_at && new Date(expiresAt).getTime() < now;
      return {
        client_link_id: r.id,
        client_name: r.client_name,
        jurisdiction: r.jurisdiction,
        state_province: r.state_province,
        deposit_count: r.stripe_invite_deposit_count || 0,
        deposit_total: Number(r.stripe_invite_deposit_total || 0),
        suggested_at: r.stripe_invite_suggested_at,
        requested_at: log?.created_at || null,
        to_address: log?.to_address || null,
        delivery_status: log?.status || null,
        expires_at: expiresAt,
        expired,
      };
    });
  }

  // Ids of clients with a pending Stripe-invite suggestion — drives the
  // "Stripe" filter pill + its action panel on the unified Clients table.
  const stripePendingIds = new Set<string>(stripeInviteSuggestions.map((s) => s.client_link_id));

  const linksData = linksRes.data || [];

  // ── Portal-account state per client (created? logged in? last login?) and
  //    unread inbound (from_client) message counts. Both drive new columns
  //    in the clients table. Fetched with the service client so RLS on the
  //    portal tables doesn't truncate them. Fail-soft on either query.
  const portalAcctById = new Map<
    string,
    { has_account: boolean; logged_in: boolean; last_login_at: string | null }
  >();
  const unreadByClient = new Map<string, number>();
  try {
    const { data: cu } = await (service as any)
      .from("client_users")
      .select("client_link_id, active, first_login_at, last_login_at")
      .eq("active", true);
    for (const m of ((cu as any[]) || [])) {
      const prev = portalAcctById.get(m.client_link_id);
      const lastLogin = m.last_login_at || null;
      const loggedIn = !!(m.first_login_at || m.last_login_at);
      if (!prev) {
        portalAcctById.set(m.client_link_id, {
          has_account: true,
          logged_in: loggedIn,
          last_login_at: lastLogin,
        });
      } else {
        // Multiple portal users on one client → account exists, logged-in if
        // any has, keep the most recent login.
        prev.logged_in = prev.logged_in || loggedIn;
        if (lastLogin && (!prev.last_login_at || lastLogin > prev.last_login_at)) {
          prev.last_login_at = lastLogin;
        }
      }
    }
  } catch (e: any) {
    console.warn("[clients] portal-account fetch failed:", e?.message);
  }
  try {
    const { data: unread } = await (service as any)
      .from("client_communications")
      .select("client_link_id")
      .eq("direction", "from_client")
      .is("read_at", null);
    for (const r of ((unread as any[]) || [])) {
      unreadByClient.set(r.client_link_id, (unreadByClient.get(r.client_link_id) || 0) + 1);
    }
  } catch (e: any) {
    console.warn("[clients] unread-messages fetch failed:", e?.message);
  }

  const nameById = new Map<string, string | null>(
    linksData.map((l) => [l.id, l.double_client_name ?? null])
  );
  // QBO connection: "connected" needs both a realm and a live refresh token.
  const qboConnectedById = new Map<string, boolean>(
    linksData.map((l) => [l.id, !!((l as any).qbo_realm_id && (l as any).qbo_refresh_token)])
  );
  const dailyReconById = new Map<string, boolean>(
    linksData.map((l) => [l.id, !!(l as any).daily_recon_enabled])
  );
  const stripeStatusById = new Map<string, string | null>(
    linksData.map((l) => [l.id, (l as any).stripe_connection_status ?? null])
  );
  const dueDateById = new Map<string, string | null>(
    linksData.map((l) => [l.id, (l as any).due_date ?? null])
  );
  // BS cleanup deferral reuses the existing bs_enabled flag (migration 66):
  // bs_enabled === false ⇒ P&L-only / BS deferred ("owed"). Fetched separately
  // + tolerantly below. Default true.
  const bsDeferredById = new Map<string, boolean>();
  const reviewStateById = new Map<string, string | null>(
    linksData.map((l) => [l.id, (l as any).cleanup_review_state ?? null])
  );
  // Completion markers — drives the "active vs Completed Accounts"
  // partition below. A client is "completed" when cleanup_completed_at
  // is non-null; reopening clears the column back to null.
  const completionById = new Map<
    string,
    {
      cleanup_completed_at: string;
      cleanup_range_start: string | null;
      cleanup_range_end: string | null;
      cleanup_completion_note: string | null;
    }
  >();
  // In-review markers — clients whose cleanup is submitted, awaiting
  // senior approval. Distinct from Active and Completed.
  const inReviewById = new Map<
    string,
    {
      cleanup_review_submitted_at: string;
      cleanup_review_submitted_by: string | null;
      cleanup_range_start: string | null;
      cleanup_range_end: string | null;
    }
  >();
  for (const l of linksData) {
    const ca = (l as any).cleanup_completed_at;
    const rs = (l as any).cleanup_review_state;
    if (ca) {
      completionById.set(l.id, {
        cleanup_completed_at: ca,
        cleanup_range_start: (l as any).cleanup_range_start ?? null,
        cleanup_range_end: (l as any).cleanup_range_end ?? null,
        cleanup_completion_note: (l as any).cleanup_completion_note ?? null,
      });
    } else if (rs === "in_review") {
      inReviewById.set(l.id, {
        cleanup_review_submitted_at: (l as any).cleanup_review_submitted_at,
        cleanup_review_submitted_by:
          (l as any).cleanup_review_submitted_by || null,
        cleanup_range_start: (l as any).cleanup_range_start ?? null,
        cleanup_range_end: (l as any).cleanup_range_end ?? null,
      });
    }
  }

  // Most recent resumable COA job per client. The map's `.set` only
  // writes on first insert because the query is ordered desc; first
  // wins → newest. That's what the Continue button routes to.
  const resumableJobByClient = new Map<string, { id: string; status: string }>();
  for (const j of resumableCoaRes.data || []) {
    if (!j.client_link_id) continue;
    if (resumableJobByClient.has(j.client_link_id)) continue;
    resumableJobByClient.set(j.client_link_id, { id: j.id, status: j.status });
  }

  // Most recent Stripe Connect token per client (for the "request
  // created" indicator on the card view's comms tracker).
  const latestStripeTokenByClient = new Map<string, string>();
  for (const t of stripeTokensRes.data || []) {
    if (!t.client_link_id) continue;
    if (latestStripeTokenByClient.has(t.client_link_id)) continue;
    latestStripeTokenByClient.set(t.client_link_id, t.created_at as string);
  }

  // Lookup maps for the comms-tracker columns (added in migration 26).
  // Cast through any because the regenerated types haven't been pulled.
  const askEmailCreatedById = new Map<string, string | null>();
  const askEmailSentById = new Map<string, string | null>();
  const askEmailBodyById = new Map<string, string | null>();
  const stripeSentConfirmedById = new Map<string, string | null>();
  const pdfSentById = new Map<string, string | null>();
  const stripeNotRequiredById = new Map<string, boolean>();
  const pyTaxesFiledById = new Map<string, boolean>();
  const pyTaxesFiledThroughYearById = new Map<string, number | null>();
  for (const l of linksData) {
    askEmailCreatedById.set(l.id, (l as any).ask_client_email_created_at ?? null);
    askEmailSentById.set(l.id, (l as any).ask_client_email_sent_at ?? null);
    askEmailBodyById.set(l.id, (l as any).ask_client_email_body ?? null);
    stripeSentConfirmedById.set(
      l.id,
      (l as any).stripe_request_sent_confirmed_at ?? null
    );
    pdfSentById.set(l.id, (l as any).cleanup_pdf_sent_at ?? null);
    stripeNotRequiredById.set(l.id, !!(l as any).stripe_not_required);
  }

  // Fetch bs_enabled separately + tolerantly. bs_enabled === false ⇒ BS
  // deferred / P&L-only (still owed). Kept out of the main select for safety.
  const bsEnabledQuery = await supabase
    .from("client_links")
    .select("id, bs_enabled");
  if (bsEnabledQuery.error) {
    console.warn("[clients page] bs_enabled query failed:", bsEnabledQuery.error.message);
  } else {
    for (const r of (bsEnabledQuery.data as any[]) || []) {
      if (r.id && r.bs_enabled === false) bsDeferredById.set(r.id, true);
    }
  }

  // Fetch py_taxes_* separately and tolerate the "column does not exist"
  // error so the page survives when migration 32 hasn't been applied yet.
  // (Same pattern as the kanban route uses for kanban_on_hold.)
  // Supabase doesn't throw on bad columns — it returns data:null +
  // error:{...}, so we check the error explicitly here.
  const pyTaxesQuery = await supabase
    .from("client_links")
    .select("id, py_taxes_filed, py_taxes_filed_through_year");
  if (pyTaxesQuery.error) {
    // Most likely cause: migration 32 not applied yet. Log so it's
    // obvious in Vercel logs, but don't fail the page.
    console.warn(
      "[clients page] py_taxes columns not available — apply migration 32. Widgets will render in 'unset' state until then. Error:",
      pyTaxesQuery.error.message
    );
  } else {
    for (const r of (pyTaxesQuery.data as any[]) || []) {
      if (!r.id) continue;
      pyTaxesFiledById.set(r.id, !!r.py_taxes_filed);
      pyTaxesFiledThroughYearById.set(r.id, r.py_taxes_filed_through_year ?? null);
    }
  }

  // client_list_view does NOT filter is_active, so archived/deleted clients
  // would otherwise leak into every partition below. Drop them here at the
  // source. (is_active is null on legacy rows → treat as active.)
  const enrichedClients = (clientsRes.data || []).filter((c: any) => c.is_active !== false).map((c) => ({
    ...c,
    double_client_name: c.id ? nameById.get(c.id) ?? null : null,
    stripe_connection_status: c.id ? stripeStatusById.get(c.id) ?? null : null,
    due_date: c.id ? dueDateById.get(c.id) ?? null : null,
    resumable_job: c.id ? resumableJobByClient.get(c.id) ?? null : null,
    // Comms tracker
    ask_client_email_created_at: c.id ? askEmailCreatedById.get(c.id) ?? null : null,
    ask_client_email_sent_at: c.id ? askEmailSentById.get(c.id) ?? null : null,
    ask_client_email_body: c.id ? askEmailBodyById.get(c.id) ?? null : null,
    stripe_request_created_at: c.id
      ? latestStripeTokenByClient.get(c.id) ?? null
      : null,
    stripe_request_sent_confirmed_at: c.id
      ? stripeSentConfirmedById.get(c.id) ?? null
      : null,
    stripe_not_required: c.id ? stripeNotRequiredById.get(c.id) ?? false : false,
    cleanup_completed_at: c.id
      ? completionById.get(c.id)?.cleanup_completed_at ?? null
      : null,
    cleanup_range_start: c.id
      ? completionById.get(c.id)?.cleanup_range_start ?? null
      : null,
    cleanup_range_end: c.id
      ? completionById.get(c.id)?.cleanup_range_end ?? null
      : null,
    cleanup_pdf_sent_at: c.id ? pdfSentById.get(c.id) ?? null : null,
    py_taxes_filed: c.id ? pyTaxesFiledById.get(c.id) ?? false : false,
    py_taxes_filed_through_year: c.id
      ? pyTaxesFiledThroughYearById.get(c.id) ?? null
      : null,
    // Clients-table columns (revamp)
    qbo_connected: c.id ? qboConnectedById.get(c.id) ?? true : true,
    daily_recon_enabled: c.id ? dailyReconById.get(c.id) ?? false : false,
    portal_account: c.id
      ? portalAcctById.get(c.id) ?? { has_account: false, logged_in: false, last_login_at: null }
      : { has_account: false, logged_in: false, last_login_at: null },
    unread_from_client: c.id ? unreadByClient.get(c.id) ?? 0 : 0,
  }));

  // Bookkeeper names — needed for the "submitted by" column in the
  // In Review partition.
  const bkNameById = new Map<string, string>();
  for (const bk of bookkeepersRes.data || []) {
    if ((bk as any).id) bkNameById.set((bk as any).id, (bk as any).full_name);
  }

  // Partition: completed → Completed Accounts; in_review → In Review;
  // everything else → Active. A client can only be in one bucket.
  const activeClients = enrichedClients.filter(
    (c: any) =>
      c.id && !completionById.has(c.id) && !inReviewById.has(c.id)
  );
  const inReviewClients = enrichedClients
    .filter((c: any) => c.id && inReviewById.has(c.id))
    .map((c: any) => {
      const r = inReviewById.get(c.id)!;
      return {
        id: c.id as string,
        client_name: c.client_name as string,
        jurisdiction: c.jurisdiction as "US" | "CA",
        state_province: (c.state_province as string | null) || null,
        cleanup_review_submitted_at: r.cleanup_review_submitted_at,
        cleanup_review_submitted_by_name: r.cleanup_review_submitted_by
          ? bkNameById.get(r.cleanup_review_submitted_by) || null
          : null,
        cleanup_range_start: r.cleanup_range_start,
        cleanup_range_end: r.cleanup_range_end,
      };
    })
    .sort((a, b) =>
      (b.cleanup_review_submitted_at || "").localeCompare(
        a.cleanup_review_submitted_at || ""
      )
    );
  const completedClients = enrichedClients
    .filter((c: any) => c.id && completionById.has(c.id))
    .map((c: any) => ({
      id: c.id as string,
      client_name: c.client_name as string,
      jurisdiction: c.jurisdiction as "US" | "CA",
      state_province: (c.state_province as string | null) || null,
      // Whether they've graduated to Production (daily recon on). Almost
      // always true here — the cleanup full-close flips it — but the row
      // surfaces the rare completed-but-not-promoted case honestly.
      daily_recon_enabled: !!c.daily_recon_enabled,
      ...completionById.get(c.id)!,
    }))
    .sort((a, b) =>
      (b.cleanup_completed_at || "").localeCompare(a.cleanup_completed_at || "")
    );

  // ── Manager dashboard rows — every client, one unified status. Pipeline
  //    sub-stage (COA / reclass / BS) comes from coa_jobs + reclass_jobs so
  //    "In cleanup" isn't an opaque bucket. open_ask_client uses unread inbound
  //    messages as a proxy; month-done ("done") is a follow-up (monthly_rec_runs).
  const allIds = enrichedClients.map((c: any) => c.id).filter(Boolean) as string[];
  const ACTIVE = ["pending", "executing", "in_review", "failed"];
  const activeCoa = new Set<string>();
  const completeCoa = new Set<string>();
  const activeReclass = new Set<string>();
  const completeReclass = new Set<string>();
  const hasBankRules = new Set<string>();
  // Reclass jobs sitting on a human-gated pause (web-search / chunked-AI
  // Continue) → surface a "Needs Continue" flag so they don't sit unnoticed.
  const PAUSED = ["web_search_paused", "ai_paused"];
  const pausedReclassJobByClient = new Map<string, string>(); // client → newest paused job id
  if (allIds.length) {
    const [coaJobsAll, reclassJobsAll, bankRulesAll] = await Promise.all([
      service.from("coa_jobs").select("client_link_id, status").in("client_link_id", allIds),
      service.from("reclass_jobs").select("id, client_link_id, status, updated_at").in("client_link_id", allIds).order("updated_at", { ascending: false }),
      service.from("bank_rules").select("client_link_id").in("client_link_id", allIds),
    ]);
    for (const r of (bankRulesAll.data as any[]) || []) {
      if (r.client_link_id) hasBankRules.add(r.client_link_id);
    }
    for (const j of (coaJobsAll.data as any[]) || []) {
      if (!j.client_link_id) continue;
      if (j.status === "complete") completeCoa.add(j.client_link_id);
      else if (ACTIVE.includes(j.status)) activeCoa.add(j.client_link_id);
    }
    for (const j of (reclassJobsAll.data as any[]) || []) {
      if (!j.client_link_id) continue;
      if (j.status === "complete") completeReclass.add(j.client_link_id);
      else if (ACTIVE.includes(j.status)) activeReclass.add(j.client_link_id);
      // Rows are ordered newest-first, so the first paused job we see per
      // client is the most recent one to resume.
      if (PAUSED.includes(j.status) && !pausedReclassJobByClient.has(j.client_link_id)) {
        pausedReclassJobByClient.set(j.client_link_id, j.id);
      }
    }
  }

  // ── Month-end run state for production clients (current close period) — so
  //    the dashboard shows real "Done" / "Waiting on client" / "Ready for
  //    review" instead of a flat "In production". Tolerant: pre-migration-62
  //    envs (no monthly_rec_runs) just leave everyone "In production".
  const monthDone = new Set<string>();
  const monthReview = new Set<string>();
  const monthWaiting = new Set<string>();
  // Two month-end dashboard columns: status of the CURRENT close period, and
  // the most recent period that's been fully closed for each production client.
  const currentMEById = new Map<string, "done" | "in_review" | "waiting" | "in_progress" | "not_started">();
  const lastClosedById = new Map<string, string>(); // latest closed period, "YYYY-MM"
  const prodIds = enrichedClients.filter((c: any) => c.daily_recon_enabled).map((c: any) => c.id);
  const currentPeriod = previousMonthPeriod().period;
  if (prodIds.length) {
    try {
      // Pull ALL production_me runs (every period) so we can derive both the
      // current-close status and the last-closed period in one query.
      const { data: runs } = await (service as any)
        .from("monthly_rec_runs")
        .select("client_link_id, period, status, board_status")
        .eq("kind", "production_me")
        .in("client_link_id", prodIds);
      const byClient = new Map<string, any[]>();
      for (const r of (runs as any[]) || []) {
        if (!r.client_link_id) continue;
        const arr = byClient.get(r.client_link_id) || [];
        arr.push(r);
        byClient.set(r.client_link_id, arr);
      }
      for (const cid of prodIds) {
        const arr = byClient.get(cid) || [];
        const cur = arr.find((r) => r.period === currentPeriod);
        if (cur?.status === "complete") { monthDone.add(cid); currentMEById.set(cid, "done"); }
        else if (cur?.status === "pending_review") { monthReview.add(cid); currentMEById.set(cid, "in_review"); }
        else if (cur?.board_status === "waiting_client") { monthWaiting.add(cid); currentMEById.set(cid, "waiting"); }
        else if (cur) currentMEById.set(cid, "in_progress");
        else currentMEById.set(cid, "not_started");
        const closed = arr.filter((r) => r.status === "complete").map((r) => r.period as string).sort();
        if (closed.length) lastClosedById.set(cid, closed[closed.length - 1]);
      }
    } catch (e: any) {
      console.warn("[clients] monthly_rec_runs fetch failed:", e?.message);
    }
  }

  const managerRows: ManagerRow[] = enrichedClients
    .filter((c: any) => c.id)
    .map((c: any) => {
      const cleanupCompleted = !!completionById.get(c.id);
      const reviewState = reviewStateById.get(c.id) ?? null;
      const bsOwed = !!bsDeferredById.get(c.id);
      const status = deriveLifecycleStatus({
        status: c.status,
        qbo_connected: c.qbo_connected,
        cleanup_completed_at: cleanupCompleted ? "set" : null,
        cleanup_review_state: reviewState,
        daily_recon_enabled: c.daily_recon_enabled,
        bs_deferred: bsOwed,
        has_active_coa: activeCoa.has(c.id),
        has_active_reclass: activeReclass.has(c.id),
        has_complete_coa: completeCoa.has(c.id),
        has_complete_reclass: completeReclass.has(c.id),
        open_ask_client: (c.unread_from_client || 0) > 0,
        month_done: monthDone.has(c.id),
        month_review: monthReview.has(c.id),
        month_waiting_client: monthWaiting.has(c.id),
      });
      return {
        id: c.id,
        client_name: c.client_name,
        jurisdiction: c.jurisdiction ?? null,
        state_province: (c.state_province as string | null) ?? null,
        assigned_bookkeeper_id: c.assigned_bookkeeper_id ?? null,
        assigned_bookkeeper_name: c.assigned_bookkeeper_name ?? null,
        status,
        // BS cleanup deferral (orthogonal). bs_owed = bs_enabled false.
        bs_owed: bsOwed,
        // BS actions only meaningful while still in cleanup (not completed/production).
        in_cleanup_phase: !cleanupCompleted && !c.daily_recon_enabled,
        // Production clients get a Month-end deep link to finish the close.
        is_production: !!c.daily_recon_enabled && cleanupCompleted,
        // Month-end columns: current close status + last closed period (YYYY-MM).
        current_month_end: c.daily_recon_enabled ? (currentMEById.get(c.id) ?? "not_started") : null,
        current_month_end_period: c.daily_recon_enabled ? currentPeriod : null,
        last_month_end_closed: lastClosedById.get(c.id) ?? null,
        // A reclass job paused on a human-gated Continue (web-search / chunked AI).
        paused_job_id: pausedReclassJobByClient.get(c.id) ?? null,
        // Lifecycle checklist (row-expand drawer).
        steps: {
          qbo: !!c.qbo_connected,
          coa: completeCoa.has(c.id),
          reclass: completeReclass.has(c.id),
          rules: hasBankRules.has(c.id),
          bs: !bsOwed && cleanupCompleted,
          bs_deferred: bsOwed,
          signoff: cleanupCompleted,
          production: !!c.daily_recon_enabled,
          month_sent: monthDone.has(c.id),
        },
      };
    });

  // Reuse the precise lifecycle status the manager dashboard already derives,
  // so the clients list shows the same 11-stage label (not the old 3-label set).
  const lifecycleById = new Map(managerRows.map((r) => [r.id, r.status]));

  return (
    <AppShell>
      <TopBar
        title="Clients"
        subtitle={
          `${activeClients.length} active` +
          (inReviewClients.length > 0
            ? ` · ${inReviewClients.length} in review`
            : "") +
          ` · ${completedClients.length} completed`
        }
      />
      <div className="px-8 py-6 space-y-8">
        {/* Re-IA: ONE clients table across every lifecycle stage. The old
            ManagerDashboard/CompletedAccounts, the In-Review strip and the
            Stripe-invite strip are all folded in — they surface as filter
            pills, and their action panels appear only when that filter is
            active (no always-on tables stacked above). QBO connect lives on the
            client workspace now, not a generic top-of-page button. */}
        <ClientsList
          initialClients={enrichedClients
            .filter((c: any) => c.id)
            .map((c: any) => {
              const lc = lifecycleById.get(c.id) ?? null;
              return {
                ...c,
                lifecycle: lc,
                macroStage: lc ? macroStageOfStatus(lc) : null,
                needs_review: inReviewById.has(c.id),
                stripe_pending: stripePendingIds.has(c.id),
              };
            }) as any}
          initialStage={initialStage}
          bookkeepers={bookkeepersRes.data || []}
          currentUserId={user?.id || ""}
          canEdit={!!canEdit}
          inReviewClients={inReviewClients}
          stripeSuggestions={canEdit ? stripeInviteSuggestions : []}
        />
      </div>
    </AppShell>
  );
}
