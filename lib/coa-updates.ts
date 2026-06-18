/**
 * COA-update detection: which master-COA categories are NEW for a client
 * relative to when that client was last cleaned.
 *
 * The master COA ([[master_coa]] table) is the single source of truth and is
 * read live everywhere (dropdowns, AI categorization, the executor), so a
 * newly-added category ALREADY flows platform-wide. The gap this fills: a
 * client cleaned BEFORE a category was added never gets the chance to apply
 * it. We surface that opportunity at month-end by comparing each category's
 * created_at to the client's last cleanup.
 *
 * "Last cleaned at" = the most recent of:
 *   - client_links.cleanup_completed_at (the cleanup sign-off), and
 *   - the newest completed coa_jobs.execution_completed_at (a COA cleanup run)
 * Whichever is later. A client that has never been cleaned returns null and is
 * treated as "no new categories to re-offer" (their first cleanup uses the
 * current COA anyway).
 */

export interface NewCoaCategory {
  account_name: string;
  section: string;
  parent_account_name: string | null;
  qbo_account_type: string | null;
  qbo_account_subtype: string | null;
  created_at: string;
}

/**
 * The timestamp a client was last cleaned, or null if never. Reads are
 * scoped to the one client. `service` is a Supabase client (service-role or
 * RLS — caller's choice).
 */
export async function getLastCleanedAt(
  service: any,
  clientLinkId: string
): Promise<string | null> {
  const stamps: string[] = [];

  const { data: cl } = await service
    .from("client_links")
    .select("cleanup_completed_at")
    .eq("id", clientLinkId)
    .maybeSingle();
  if (cl?.cleanup_completed_at) stamps.push(cl.cleanup_completed_at);

  const { data: jobs } = await service
    .from("coa_jobs")
    .select("execution_completed_at")
    .eq("client_link_id", clientLinkId)
    .not("execution_completed_at", "is", null)
    .order("execution_completed_at", { ascending: false })
    .limit(1);
  const jobStamp = (jobs as any[])?.[0]?.execution_completed_at;
  if (jobStamp) stamps.push(jobStamp);

  if (stamps.length === 0) return null;
  return stamps.sort().slice(-1)[0]; // latest ISO timestamp
}

/**
 * Master-COA categories for (jurisdiction, industry) that were added AFTER the
 * client was last cleaned — i.e. the ones that client never had the chance to
 * adopt. Sorted newest-first. Empty when the client was never cleaned or
 * nothing is newer.
 */
export async function getNewCoaCategoriesForClient(
  service: any,
  params: {
    clientLinkId: string;
    jurisdiction: string | null;
    industry?: string | null;
  }
): Promise<{ lastCleanedAt: string | null; categories: NewCoaCategory[] }> {
  const lastCleanedAt = await getLastCleanedAt(service, params.clientLinkId);
  if (!lastCleanedAt || !params.jurisdiction) {
    return { lastCleanedAt, categories: [] };
  }

  let q = service
    .from("master_coa")
    .select("account_name, section, parent_account_name, qbo_account_type, qbo_account_subtype, created_at")
    .eq("jurisdiction", params.jurisdiction)
    .gt("created_at", lastCleanedAt)
    .order("created_at", { ascending: false });
  // Default industry to painters — the only seeded industry in use today.
  q = q.eq("industry", params.industry || "painters");

  const { data, error } = await q;
  if (error) return { lastCleanedAt, categories: [] };
  return { lastCleanedAt, categories: ((data as NewCoaCategory[]) || []) };
}
