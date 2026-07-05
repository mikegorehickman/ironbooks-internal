import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlaggedClient, FlaggedSource } from "@/app/approvals/flagged-queue";

/**
 * Flagged-for-senior-review data assembly — human-escalated flags from COA
 * cleanups, reclassifications, and Stripe recon, grouped one row per client.
 * Extracted from the old /flagged page so /approvals (its new home) renders
 * it as one more senior queue.
 */
export async function getFlaggedClients(service: SupabaseClient): Promise<{
  clients: FlaggedClient[];
  totalItems: number;
  queryErrors: string[];
}> {
  // ─────────── Pull flagged items from all 3 sources in parallel ───────────
  // Include client_links.id so we can group by client (one row per account)
  // instead of by (source, job) which produces duplicate account rows.
  const [coaQ, reclassQ, stripeQ] = await Promise.all([
    service
      .from("coa_actions")
      .select(`
        id, job_id, qbo_account_id, current_name, current_type, transaction_count,
        ai_confidence, ai_reasoning, ai_suggested_target, flagged_reason,
        coa_jobs!inner(id, status, created_at, bookkeeper_id, client_link_id, client_links(id, client_name, jurisdiction, state_province), users!bookkeeper_id(full_name))
      `)
      .eq("action", "flag")
      .eq("executed", false)
      // Human escalations only: bookkeeper_override means a PERSON set or
      // confirmed this flag. AI auto-flags live in each job's own review
      // screen — surfacing them here buried managers in 2,000 items.
      .eq("bookkeeper_override", true)
      // Active jobs only — flags from complete/failed/cancelled jobs are
      // unactionable corpses.
      .eq("coa_jobs.status", "in_review")
      .order("created_at", { ascending: false }),

    service
      .from("reclassifications")
      .select(`
        id, reclass_job_id, vendor_name, transaction_amount, transaction_date,
        from_account_name, to_account_name, ai_confidence, ai_reasoning, decision, description,
        reclass_jobs!reclass_job_id!inner(id, status, created_at, bookkeeper_id, client_link_id, client_links(id, client_name, jurisdiction, state_province), users!bookkeeper_id(full_name))
      `)
      .eq("decision", "flagged")
      .eq("bookkeeper_override", true)
      .eq("reclass_jobs.status", "in_review")
      .order("transaction_date", { ascending: false })
      .limit(500),

    service
      .from("stripe_recon_matches")
      .select(`
        id, job_id, qbo_deposit_id, deposit_amount, deposit_date, deposit_memo,
        matched_customer_names, ai_confidence, ai_reasoning, computed_fee,
        stripe_recon_jobs!inner(id, status, created_at, bookkeeper_id, client_link_id, client_links(id, client_name, jurisdiction, state_province), users(full_name))
      `)
      .eq("decision", "flagged")
      .eq("executed", false)
      .eq("bookkeeper_override", true)
      .eq("stripe_recon_jobs.status", "in_review")
      .order("deposit_date", { ascending: false }),
  ]);

  // Surface any query errors so they're visible during debugging
  const queryErrors = [
    coaQ.error && `COA: ${coaQ.error.message}`,
    reclassQ.error && `Reclass: ${reclassQ.error.message}`,
    stripeQ.error && `Stripe: ${stripeQ.error.message}`,
  ].filter(Boolean);

  // ─────────── Group everything by client_link_id ───────────
  // One row per client — all flagged items across COA / reclass / stripe
  // and across multiple jobs roll up under a single account header. Items
  // still carry their own type/job_id/job_status so the inline cards can
  // route resolutions to the right table and surface per-item context.
  //
  // Internal builder uses Sets for de-duplication while ingesting, then
  // converts to the array-shaped FlaggedClient at the bottom of the
  // function for the client component boundary.
  type FlaggedClientBuilder = Omit<FlaggedClient, "sources" | "bookkeeper_names" | "job_ids"> & {
    sources: Set<FlaggedSource>;
    bookkeeper_names: Set<string>;
    job_ids: Set<string>;
  };

  const groupedByClient = new Map<string, FlaggedClientBuilder>();

  function ensure(clientId: string, factory: () => FlaggedClientBuilder) {
    if (!groupedByClient.has(clientId)) groupedByClient.set(clientId, factory());
    return groupedByClient.get(clientId)!;
  }

  function addItem(
    clientId: string,
    clientName: string,
    jurisdiction: string,
    stateProvince: string,
    source: FlaggedSource,
    bookkeeperName: string,
    jobId: string,
    jobStatus: string,
    jobCreatedAt: string,
    item: Omit<FlaggedClient["items"][number], "source" | "job_id" | "job_status" | "bookkeeper_name" | "job_created_at">
  ) {
    const bucket = ensure(clientId, () => ({
      key: `client::${clientId}`,
      client_link_id: clientId,
      client_name: clientName,
      jurisdiction,
      state_province: stateProvince,
      sources: new Set<FlaggedSource>(),
      bookkeeper_names: new Set<string>(),
      job_ids: new Set<string>(),
      latest_activity_at: jobCreatedAt,
      items: [],
    }));
    bucket.sources.add(source);
    bucket.bookkeeper_names.add(bookkeeperName);
    bucket.job_ids.add(jobId);
    if ((jobCreatedAt || "") > (bucket.latest_activity_at || "")) {
      bucket.latest_activity_at = jobCreatedAt;
    }
    bucket.items.push({
      ...item,
      source,
      job_id: jobId,
      job_status: jobStatus,
      bookkeeper_name: bookkeeperName,
      job_created_at: jobCreatedAt,
    });
  }

  // COA
  for (const row of coaQ.data || []) {
    const job = (row as any).coa_jobs;
    if (!job) continue;
    const clientId = job.client_link_id || job.client_links?.id;
    if (!clientId) continue;
    addItem(
      clientId,
      job.client_links?.client_name || "Unknown",
      job.client_links?.jurisdiction || "",
      job.client_links?.state_province || "",
      "coa",
      job.users?.full_name || "Unknown",
      job.id,
      job.status,
      job.created_at,
      {
        id: row.id,
        type: "coa",
        headline: row.current_name || "Unknown account",
        subheadline: row.current_type || "",
        amount: null,
        date: null,
        ai_reasoning: row.ai_reasoning,
        flagged_reason: row.flagged_reason,
        ai_confidence: row.ai_confidence,
        ai_suggested_target: row.ai_suggested_target,
        transaction_count: row.transaction_count,
        raw: row,
      }
    );
  }

  // Reclass
  for (const row of reclassQ.data || []) {
    const job = (row as any).reclass_jobs;
    if (!job) continue;
    const clientId = job.client_link_id || job.client_links?.id;
    if (!clientId) continue;
    addItem(
      clientId,
      job.client_links?.client_name || "Unknown",
      job.client_links?.jurisdiction || "",
      job.client_links?.state_province || "",
      "reclass",
      job.users?.full_name || "Unknown",
      job.id,
      job.status,
      job.created_at,
      {
        id: row.id,
        type: "reclass",
        headline: (row as any).vendor_name || "Unknown vendor",
        subheadline: (row as any).from_account_name || "",
        amount: Number((row as any).transaction_amount || 0),
        date: (row as any).transaction_date,
        ai_reasoning: (row as any).ai_reasoning,
        flagged_reason: null,
        ai_confidence: (row as any).ai_confidence,
        ai_suggested_target: (row as any).to_account_name,
        transaction_count: null,
        raw: row,
      }
    );
  }

  // Stripe
  for (const row of stripeQ.data || []) {
    const job = (row as any).stripe_recon_jobs;
    if (!job) continue;
    const clientId = job.client_link_id || job.client_links?.id;
    if (!clientId) continue;
    addItem(
      clientId,
      job.client_links?.client_name || "Unknown",
      job.client_links?.jurisdiction || "",
      job.client_links?.state_province || "",
      "stripe",
      job.users?.full_name || "Unknown",
      job.id,
      job.status,
      job.created_at,
      {
        id: row.id,
        type: "stripe",
        headline: `Stripe deposit ${(row as any).qbo_deposit_id}`,
        subheadline: ((row as any).matched_customer_names || []).join(", ") || "No customers matched",
        amount: Number((row as any).deposit_amount || 0),
        date: (row as any).deposit_date,
        ai_reasoning: (row as any).ai_reasoning,
        flagged_reason: null,
        ai_confidence: (row as any).ai_confidence,
        ai_suggested_target: null,
        transaction_count: null,
        raw: row,
      }
    );
  }

  // Sort clients by most-recent flagged-job activity. Convert Sets to
  // arrays so they cross the server→client boundary cleanly.
  const clients = Array.from(groupedByClient.values())
    .map((c) => ({
      ...c,
      sources: Array.from(c.sources),
      bookkeeper_names: Array.from(c.bookkeeper_names),
      job_ids: Array.from(c.job_ids),
    }))
    .sort((a, b) =>
      (b.latest_activity_at || "").localeCompare(a.latest_activity_at || "")
    );

  const totalItems = clients.reduce((s, c) => s + c.items.length, 0);
  if (queryErrors.length) console.error("[flagged-data]", queryErrors);
  return { clients, totalItems, queryErrors: queryErrors as string[] };
}
