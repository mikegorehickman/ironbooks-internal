import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { sweepStaleJobs } from "@/lib/stale-jobs";
import { Plus } from "lucide-react";
import { ClientsList } from "./clients-list";
import { CompletedAccounts } from "./completed-accounts";
import { InReviewAccounts } from "./in-review-accounts";

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
        "id, double_client_name, stripe_connection_status, due_date, cleanup_completed_at, cleanup_completed_by, cleanup_range_start, cleanup_range_end, cleanup_completion_note, cleanup_review_state, cleanup_review_submitted_at, cleanup_review_submitted_by, ask_client_email_created_at, ask_client_email_sent_at, ask_client_email_body, stripe_request_sent_confirmed_at, cleanup_pdf_sent_at, stripe_not_required, py_taxes_filed, py_taxes_filed_through_year"
      ),
    supabase
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
  const nameById = new Map<string, string | null>(
    linksData.map((l) => [l.id, l.double_client_name ?? null])
  );
  const stripeStatusById = new Map<string, string | null>(
    linksData.map((l) => [l.id, (l as any).stripe_connection_status ?? null])
  );
  const dueDateById = new Map<string, string | null>(
    linksData.map((l) => [l.id, (l as any).due_date ?? null])
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
    pyTaxesFiledById.set(l.id, !!(l as any).py_taxes_filed);
    pyTaxesFiledThroughYearById.set(
      l.id,
      (l as any).py_taxes_filed_through_year ?? null
    );
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
      ...completionById.get(c.id)!,
    }))
    .sort((a, b) =>
      (b.cleanup_completed_at || "").localeCompare(a.cleanup_completed_at || "")
    );

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
