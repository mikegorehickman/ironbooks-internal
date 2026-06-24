/**
 * Redo guard — answers "is starting a new job on this client a re-do of work
 * that's already finished?" Used to warn (never hard-block) before a bookkeeper
 * re-runs cleanup / reclass / bank-rules on a client that was already cleaned
 * up or already has a completed job of that type. Works at load/selection time
 * so deep-links (?client=<id>) are covered, not just the dropdown.
 */

export type RedoKind = "coa" | "reclass" | "rules";

const JOB_TABLE: Record<RedoKind, string> = {
  coa: "coa_jobs",
  reclass: "reclass_jobs",
  rules: "rule_discovery_jobs",
};

export interface RedoStatus {
  alreadyCleanedUp: boolean;
  cleanupCompletedAt: string | null;
  hasCompletedJobOfType: boolean;
  lastCompletedAt: string | null;
  /** The date range the last completed job of this type covered — so the next
   *  step can reuse the same period instead of asking again. (coa/reclass only;
   *  rule_discovery_jobs has no range.) */
  lastRangeStart: string | null;
  lastRangeEnd: string | null;
}

export async function getRedoStatus(
  service: any,
  clientLinkId: string,
  kind: RedoKind
): Promise<RedoStatus> {
  const { data: client } = await service
    .from("client_links")
    .select("cleanup_completed_at")
    .eq("id", clientLinkId)
    .single();

  let hasCompletedJobOfType = false;
  let lastCompletedAt: string | null = null;
  let lastRangeStart: string | null = null;
  let lastRangeEnd: string | null = null;
  try {
    // rule_discovery_jobs has no date range; coa/reclass do.
    const select =
      kind === "rules"
        ? "status, execution_completed_at"
        : "status, execution_completed_at, date_range_start, date_range_end";
    const { data: job } = await service
      .from(JOB_TABLE[kind])
      .select(select)
      .eq("client_link_id", clientLinkId)
      .eq("status", "complete")
      .order("execution_completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (job) {
      hasCompletedJobOfType = true;
      lastCompletedAt = (job as any).execution_completed_at || null;
      lastRangeStart = (job as any).date_range_start || null;
      lastRangeEnd = (job as any).date_range_end || null;
    }
  } catch {
    /* table/shape varies — fail open (no warning) */
  }

  return {
    alreadyCleanedUp: !!(client as any)?.cleanup_completed_at,
    cleanupCompletedAt: (client as any)?.cleanup_completed_at || null,
    hasCompletedJobOfType,
    lastCompletedAt,
    lastRangeStart,
    lastRangeEnd,
  };
}
