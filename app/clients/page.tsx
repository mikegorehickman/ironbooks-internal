import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { sweepStaleJobs } from "@/lib/stale-jobs";
import { Plus } from "lucide-react";
import { ClientsList } from "./clients-list";
import { CompletedAccounts } from "./completed-accounts";
import { InReviewAccounts } from "./in-review-accounts";
import { ManagerDashboard, type ManagerRow } from "./manager-dashboard";
import { deriveLifecycleStatus } from "@/lib/client-lifecycle";

export default async function ClientsPage() {
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
        "id, double_client_name, stripe_connection_status, due_date, cleanup_completed_at, cleanup_completed_by, cleanup_range_start, cleanup_range_end, cleanup_completion_note, cleanup_review_state, cleanup_review_submitted_at, cleanup_review_submitted_by, ask_client_email_created_at, ask_client_email_sent_at, ask_client_email_body, stripe_request_sent_confirmed_at, cleanup_pdf_sent_at, stripe_not_required, qbo_realm_id, qbo_refresh_token, daily_recon_enabled, bs_cleanup_skipped_at"
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
  const bsSkippedById = new Map<string, string | null>(
    linksData.map((l) => [l.id, (l as any).bs_cleanup_skipped_at ?? null])
  );
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

  const enrichedClients = (clientsRes.data || []).map((c) => ({
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

  // ── Manager dashboard rows — every client, one unified status. Derived
  //    from the flags already loaded above (no extra queries). open_ask_client
  //    uses unread inbound messages as a proxy; month-done (production "done")
  //    is left to a follow-up that reads monthly_rec_runs.
  const managerRows: ManagerRow[] = enrichedClients
    .filter((c: any) => c.id)
    .map((c: any) => {
      const cleanupCompleted = !!completionById.get(c.id);
      const reviewState = reviewStateById.get(c.id) ?? null;
      const status = deriveLifecycleStatus({
        status: c.status,
        qbo_connected: c.qbo_connected,
        cleanup_completed_at: cleanupCompleted ? "set" : null,
        cleanup_review_state: reviewState,
        daily_recon_enabled: c.daily_recon_enabled,
        bs_cleanup_skipped_at: bsSkippedById.get(c.id) ?? null,
        has_active_job: !!c.resumable_job,
        open_ask_client: (c.unread_from_client || 0) > 0,
      });
      return {
        id: c.id,
        client_name: c.client_name,
        jurisdiction: c.jurisdiction ?? null,
        state_province: (c.state_province as string | null) ?? null,
        assigned_bookkeeper_id: c.assigned_bookkeeper_id ?? null,
        assigned_bookkeeper_name: c.assigned_bookkeeper_name ?? null,
        status,
        bs_cleanup_skipped: !!bsSkippedById.get(c.id),
        // BS-skip is only meaningful while still in cleanup (not completed/production).
        in_cleanup_phase: !cleanupCompleted && !c.daily_recon_enabled,
      };
    });

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
        actions={
          <a
            href="/api/qbo/connect"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg"
          >
            <Plus size={16} />
            Connect QuickBooks Client
          </a>
        }
      />
      <div className="px-8 py-6 space-y-8">
        <ManagerDashboard
          rows={managerRows}
          bookkeepers={(bookkeepersRes.data || []).map((b: any) => ({ id: b.id, full_name: b.full_name }))}
          canEdit={!!canEdit}
        />
        <ClientsList
          initialClients={activeClients as any}
          bookkeepers={bookkeepersRes.data || []}
          currentUserId={user?.id || ""}
          canEdit={!!canEdit}
        />
        {inReviewClients.length > 0 && (
          <InReviewAccounts
            clients={inReviewClients}
            canApprove={!!canEdit}
          />
        )}
        {completedClients.length > 0 && (
          <CompletedAccounts clients={completedClients} canEdit={!!canEdit} />
        )}
      </div>
    </AppShell>
  );
}
