/**
 * Cleanup launcher roster — buckets every active client into the five sections
 * the New Cleanup page renders. One pass, mutually-exclusive by precedence
 * (first match wins):
 *   1. bs        — in production but Balance Sheet still owed (bs_enabled=false)
 *   2. completed — done + in production (or cleanup_completed_at set)
 *   3. stripe    — a connect request was sent and we're still waiting to connect
 *   4. continue  — ANY cleanup job exists (finished, mid-flight, or failed),
 *                  still before P&L send / close
 *   5. new       — truly untouched: no job of any kind yet
 *
 * Continue rows resume at the exact outstanding step (COA → reclass → bank
 * rules → stripe), and say which step that is. Completed rows open the closed
 * COA job file.
 */

export type CleanupBucket = "new" | "continue" | "completed" | "stripe" | "bs";

export interface RosterClient {
  id: string;
  client_name: string;
  jurisdiction: string | null;
  state_province: string | null;
  qbo_connected: boolean;
  bucket: CleanupBucket;
  subLabel: string;
  highlight: boolean;
  routeTarget: string | null;
  requestedAt: string | null;
}

export interface CleanupRoster {
  newCleanup: any[];
  continueCleanup: RosterClient[];
  completed: RosterClient[];
  stripeRecon: RosterClient[];
  bsCleanup: RosterClient[];
}

const COA_RESUMABLE = new Set(["in_review", "executing", "failed", "draft", "pending_lisa", "approved"]);
const byCreatedDesc = (a: any, b: any) =>
  (b.updated_at || b.created_at || "").localeCompare(a.updated_at || a.created_at || "");

/**
 * The next outstanding cleanup step for an in-progress client, with where to
 * resume it. Walks COA → reclass → bank rules → stripe; the first step that's
 * unfinished (or mid-flight) is where the client picks up.
 */
function outstandingStep(
  c: any,
  coaJobs: any[],
  reclassJobs: any[],
  rulesJobs: any[]
): { label: string; route: string } {
  if (c.cleanup_review_state === "in_review") {
    return { label: "Submitted — in senior review", route: `/balance-sheet/${c.id}` };
  }

  // COA
  const coaResume = coaJobs.filter((j) => COA_RESUMABLE.has(j.status)).sort(byCreatedDesc)[0];
  if (coaResume) return { label: `COA cleanup — ${String(coaResume.status).replace(/_/g, " ")}`, route: `/jobs/${coaResume.id}/review` };
  const coaComplete = coaJobs.some((j) => j.status === "complete");
  if (!coaComplete) return { label: "COA cleanup — not started", route: "/jobs/new" };

  // Reclass
  const reclassResume = reclassJobs.filter((j) => !["complete", "cancelled"].includes(j.status)).sort(byCreatedDesc)[0];
  if (reclassResume) return { label: "Reclass — in progress", route: `/reclass/${reclassResume.id}/review` };
  const reclassComplete = reclassJobs.some((j) => j.status === "complete");
  if (!reclassComplete) return { label: "Reclass — not started", route: `/reclass/new?client=${c.id}&workflow=full_categorization` };

  // Bank rules
  const rulesResume = rulesJobs.filter((j) => !["complete", "cancelled"].includes(j.status)).sort(byCreatedDesc)[0];
  if (rulesResume) return { label: "Bank rules — in progress", route: `/rules/${rulesResume.id}/review` };
  const rulesComplete = rulesJobs.some((j) => j.status === "complete");
  if (!rulesComplete) return { label: "Bank rules — not started", route: `/rules/new?client=${c.id}` };

  // Stripe recon (then BS)
  if (c.stripe_connection_status === "connected") {
    return { label: "Stripe recon — ready to reconcile", route: `/stripe-recon/new?client=${c.id}` };
  }
  return { label: "Stripe recon", route: `/stripe-recon/new?client=${c.id}` };
}

export async function buildCleanupRoster(service: any): Promise<CleanupRoster> {
  const { data: clients } = await service
    .from("client_links")
    .select("*")
    .eq("is_active", true)
    .order("client_name");
  const list = ((clients as any[]) || []);
  const ids = list.map((c) => c.id);

  const empty: CleanupRoster = { newCleanup: [], continueCleanup: [], completed: [], stripeRecon: [], bsCleanup: [] };
  if (ids.length === 0) return empty;

  const safe = async (p: Promise<any>) => { try { return await p; } catch { return { data: [] }; } };
  const [coaRes, reclassRes, rulesRes, stmtRes] = await Promise.all([
    safe(service.from("coa_jobs").select("id, client_link_id, status, updated_at, created_at").in("client_link_id", ids)),
    safe(service.from("reclass_jobs").select("id, client_link_id, status, created_at").in("client_link_id", ids)),
    safe(service.from("rule_discovery_jobs").select("id, client_link_id, status, created_at").in("client_link_id", ids)),
    safe(service.from("statement_requests").select("client_link_id, status").in("client_link_id", ids)),
  ]);

  const group = (rows: any[]) => {
    const m = new Map<string, any[]>();
    for (const j of rows || []) {
      const arr = m.get(j.client_link_id) || [];
      arr.push(j);
      m.set(j.client_link_id, arr);
    }
    return m;
  };
  const coaByClient = group((coaRes.data as any[]) || []);
  const reclassByClient = group((reclassRes.data as any[]) || []);
  const rulesByClient = group((rulesRes.data as any[]) || []);

  const completedStepClients = new Set<string>();
  for (const j of ((coaRes.data as any[]) || [])) if (j.status === "complete") completedStepClients.add(j.client_link_id);
  for (const j of ((reclassRes.data as any[]) || [])) if (j.status === "complete") completedStepClients.add(j.client_link_id);
  for (const j of ((rulesRes.data as any[]) || [])) if (j.status === "complete") completedStepClients.add(j.client_link_id);

  const stmtReceived = new Set<string>();
  const stmtRequested = new Set<string>();
  for (const r of ((stmtRes.data as any[]) || [])) {
    if (r.status === "fulfilled") stmtReceived.add(r.client_link_id);
    if (r.status === "open") stmtRequested.add(r.client_link_id);
  }

  const out: CleanupRoster = { newCleanup: [], continueCleanup: [], completed: [], stripeRecon: [], bsCleanup: [] };

  for (const c of list) {
    const qboConnected = !!c.qbo_realm_id && !!c.qbo_refresh_token;
    const completedAt = c.cleanup_completed_at;
    const inProduction = c.daily_recon_enabled === true;
    const bsOwed = inProduction && c.bs_enabled === false;
    const stripeConnected = c.stripe_connection_status === "connected";
    const stripeRequested = !!c.stripe_connect_requested_at || !!c.stripe_request_sent_at;
    const stripeWaiting = stripeRequested && !stripeConnected && c.stripe_not_required !== true;
    const finishedStep =
      completedStepClients.has(c.id) ||
      c.cleanup_review_state === "in_review" ||
      c.cleanup_review_state === "complete" ||
      !!completedAt ||
      stripeConnected;

    const coaJobs = coaByClient.get(c.id) || [];
    const reclassJobs = reclassByClient.get(c.id) || [];
    const rulesJobs = rulesByClient.get(c.id) || [];

    // "Started" must count in-flight and FAILED jobs too, not just complete
    // ones — a client with a failed COA run has absolutely started cleanup,
    // and showing them under "no cleanup started" hides the failure. Only a
    // cancelled-and-never-retried job counts as untouched.
    const startedStep =
      finishedStep ||
      [...coaJobs, ...reclassJobs, ...rulesJobs].some((j) => j.status !== "cancelled");

    const base = {
      id: c.id,
      client_name: c.client_name,
      jurisdiction: c.jurisdiction ?? null,
      state_province: c.state_province ?? null,
      qbo_connected: qboConnected,
      requestedAt: null as string | null,
    };

    // 1. BS Cleanup
    if (bsOwed) {
      const received = stmtReceived.has(c.id);
      out.bsCleanup.push({
        ...base,
        bucket: "bs",
        highlight: received,
        subLabel: received
          ? "Statements received — ready to finish BS"
          : stmtRequested.has(c.id) || c.bs_statements_requested_at
          ? "Waiting on client for statements"
          : "Statements not yet requested",
        routeTarget: `/balance-sheet/${c.id}`,
      });
      continue;
    }

    // 2. Completed — open the closed COA job file.
    if (inProduction || completedAt) {
      const lastCoa = [...coaJobs].sort(byCreatedDesc)[0];
      out.completed.push({
        ...base,
        bucket: "completed",
        highlight: false,
        subLabel: completedAt ? `Completed ${new Date(completedAt).toLocaleDateString()}` : "In production",
        routeTarget: lastCoa ? `/jobs/${lastCoa.id}/review` : `/clients/${c.id}`,
      });
      continue;
    }

    // 3. Stripe recon — waiting to connect.
    if (stripeWaiting) {
      out.stripeRecon.push({
        ...base,
        bucket: "stripe",
        highlight: false,
        subLabel: "Waiting to connect",
        routeTarget: `/stripe-recon/new?client=${c.id}`,
        requestedAt: c.stripe_connect_requested_at || c.stripe_request_sent_at || null,
      });
      continue;
    }

    // 4. Continue cleanup — resume the outstanding step.
    if (startedStep) {
      const step = outstandingStep(c, coaJobs, reclassJobs, rulesJobs);
      out.continueCleanup.push({
        ...base,
        bucket: "continue",
        highlight: false,
        subLabel: step.label,
        routeTarget: step.route,
      });
      continue;
    }

    // 5. New cleanup — nothing finished yet.
    out.newCleanup.push(c);
  }

  return out;
}
