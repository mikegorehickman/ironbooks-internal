/**
 * Reading the audit log honestly.
 *
 * WHY THIS EXISTS. /admin/audit read a view called `recent_activity_feed`, which
 * is capped at 500 rows. Measured 2026-07-31: the view held 500 of the log's
 * 23,211 rows, spanning 29 hours (2026-07-30 09:54 onward). The page offers to
 * "search all actions by user, client, date, or event type — for compliance
 * review" and could not reach past yesterday morning. Pick a client whose work
 * happened last month and the screen answers, truthfully-looking, "no events".
 *
 * The client filter failed twice over. The view resolves the client only through
 * job_id, and just 99 of those 500 rows carry one — so filtering by a client
 * returned 0 rows, and the CSV export wrote a blank client column on every row.
 *
 * This reads `audit_log` directly, with no ceiling but the caller's limit, and
 * resolves the client from three places in order of directness:
 *
 *   1. the client_link_id COLUMN (migration 145)
 *   2. job_id → reclass_jobs / coa_jobs
 *   3. request_payload->>'client_link_id'
 *
 * Source 1 does not exist until migration 145 is applied, so its presence is
 * probed once per query rather than assumed. Selecting a missing column is a
 * PostgREST 400 that would blank the whole screen — worse than the gap it fixes.
 * Sources 2 and 3 keep the filter working today; source 1 makes it fast and
 * complete afterwards.
 */

import type { createServiceSupabase } from "./supabase";

type Service = ReturnType<typeof createServiceSupabase>;

export interface AuditFeedRow {
  id: string;
  event_type: string;
  occurred_at: string | null;
  user_id: string | null;
  user_name: string | null;
  user_role: string | null;
  job_id: string | null;
  action_id: string | null;
  client_link_id: string | null;
  client_name: string | null;
  request_payload: any;
  response_payload: any;
  error_message: string | null;
}

export interface AuditQueryFilters {
  userId?: string | null;
  clientLinkId?: string | null;
  jobId?: string | null;
  eventType?: string | null;
  since?: string | null;
  until?: string | null;
  limit?: number;
}

export interface AuditQueryResult {
  rows: AuditFeedRow[];
  /** How the client was resolved, and anything the query could not cover. Shown
   *  in the UI so a short result is never mistaken for a quiet period. */
  notes: string[];
  /** True once migration 145 is applied. Until then client attribution relies
   *  entirely on job lookups and payload sniffing. */
  hasClientColumn: boolean;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

/** Does audit_log.client_link_id exist yet? Cached for the process — a column
 *  does not come and go within a deploy. */
let clientColumnPresent: boolean | null = null;

async function hasClientColumn(service: Service): Promise<boolean> {
  if (clientColumnPresent !== null) return clientColumnPresent;
  const { error } = await (service as any).from("audit_log").select("client_link_id").limit(1);
  clientColumnPresent = !error;
  return clientColumnPresent;
}

export async function queryAuditLog(
  service: Service,
  f: AuditQueryFilters
): Promise<AuditQueryResult> {
  const notes: string[] = [];
  const limit = Math.min(Math.max(Number(f.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const hasCol = await hasClientColumn(service);
  if (!hasCol) {
    notes.push(
      "audit_log.client_link_id is not present yet (migration 145) — the client for " +
        "each event is being resolved from its job and payload, which covers less of the log."
    );
  }

  // A client's events reach the log three ways, so filtering by client needs all
  // three. Job ids are collected first because they are the widest of the three
  // (11,156 of 23,211 rows carry a job_id).
  let jobIdsForClient: string[] = [];
  if (f.clientLinkId) {
    const [{ data: rj }, { data: cj }] = await Promise.all([
      (service as any).from("reclass_jobs").select("id").eq("client_link_id", f.clientLinkId),
      (service as any).from("coa_jobs").select("id").eq("client_link_id", f.clientLinkId),
    ]);
    jobIdsForClient = [
      ...((rj as any[]) || []).map((j) => j.id),
      ...((cj as any[]) || []).map((j) => j.id),
    ];
  }

  let q = (service as any)
    .from("audit_log")
    .select(
      "id, event_type, occurred_at, user_id, job_id, action_id, request_payload, " +
        "response_payload, error_message" +
        (hasCol ? ", client_link_id" : "")
    )
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (f.userId) q = q.eq("user_id", f.userId);
  if (f.jobId) q = q.eq("job_id", f.jobId);
  if (f.eventType) q = q.eq("event_type", f.eventType);
  if (f.since) q = q.gte("occurred_at", f.since);
  if (f.until) q = q.lte("occurred_at", f.until);

  if (f.clientLinkId) {
    const clauses: string[] = [`request_payload->>client_link_id.eq.${f.clientLinkId}`];
    if (hasCol) clauses.push(`client_link_id.eq.${f.clientLinkId}`);
    if (jobIdsForClient.length) clauses.push(`job_id.in.(${jobIdsForClient.join(",")})`);
    q = q.or(clauses.join(","));
  }

  const { data, error } = await q;
  if (error) {
    return { rows: [], notes: [...notes, `audit_log query failed: ${error.message}`], hasClientColumn: hasCol };
  }
  const raw = (data as any[]) || [];
  if (raw.length >= limit) {
    notes.push(
      `Showing the ${limit} most recent matching events. Older matches exist — narrow the date range.`
    );
  }

  // ── Enrich: users, jobs, clients ────────────────────────────────────────────
  const userIds = new Set<string>();
  const jobIds = new Set<string>();
  const clientIds = new Set<string>();
  for (const r of raw) {
    if (r.user_id) userIds.add(r.user_id);
    if (r.job_id) jobIds.add(r.job_id);
    if (r.client_link_id) clientIds.add(r.client_link_id);
    const p = r.request_payload;
    const fromPayload = p && typeof p === "object" ? p.client_link_id : null;
    if (typeof fromPayload === "string") clientIds.add(fromPayload);
  }

  const [users, jobClients] = await Promise.all([
    fetchUsers(service, [...userIds]),
    fetchJobClients(service, [...jobIds]),
  ]);
  for (const cid of jobClients.values()) if (cid) clientIds.add(cid);
  const clientNames = await fetchClientNames(service, [...clientIds]);

  const rows: AuditFeedRow[] = raw.map((r) => {
    const p = r.request_payload && typeof r.request_payload === "object" ? r.request_payload : {};
    const clientId: string | null =
      r.client_link_id ??
      (r.job_id ? jobClients.get(r.job_id) ?? null : null) ??
      (typeof p.client_link_id === "string" ? p.client_link_id : null);
    const u = r.user_id ? users.get(r.user_id) : null;
    return {
      id: r.id,
      event_type: r.event_type,
      occurred_at: r.occurred_at,
      user_id: r.user_id ?? null,
      user_name: u?.full_name ?? null,
      user_role: u?.role ?? null,
      job_id: r.job_id ?? null,
      action_id: r.action_id ?? null,
      client_link_id: clientId,
      client_name: clientId ? clientNames.get(clientId) ?? null : null,
      request_payload: r.request_payload,
      response_payload: r.response_payload,
      error_message: r.error_message ?? null,
    };
  });

  const unattributed = rows.filter((r) => !r.client_link_id).length;
  if (unattributed > 0) {
    notes.push(
      `${unattributed} of ${rows.length} events could not be tied to a single client. Some are ` +
        `genuinely fleet-level (master COA edits, cron summaries); the rest predate client attribution.`
    );
  }

  return { rows, notes, hasClientColumn: hasCol };
}

async function fetchUsers(service: Service, ids: string[]) {
  const map = new Map<string, { full_name: string | null; role: string | null }>();
  if (!ids.length) return map;
  const { data } = await (service as any).from("users").select("id, full_name, role").in("id", ids);
  for (const u of (data as any[]) || []) map.set(u.id, { full_name: u.full_name, role: u.role });
  return map;
}

/** job_id → client. Checked against both job tables because audit_log's job_id
 *  points at either, with no discriminator column to say which. */
async function fetchJobClients(service: Service, ids: string[]) {
  const map = new Map<string, string | null>();
  if (!ids.length) return map;
  const [{ data: rj }, { data: cj }] = await Promise.all([
    (service as any).from("reclass_jobs").select("id, client_link_id").in("id", ids),
    (service as any).from("coa_jobs").select("id, client_link_id").in("id", ids),
  ]);
  for (const j of [...((rj as any[]) || []), ...((cj as any[]) || [])]) {
    if (j.client_link_id) map.set(j.id, j.client_link_id);
  }
  return map;
}

async function fetchClientNames(service: Service, ids: string[]) {
  const map = new Map<string, string>();
  if (!ids.length) return map;
  const { data } = await (service as any)
    .from("client_links")
    .select("id, client_name")
    .in("id", ids);
  for (const c of (data as any[]) || []) map.set(c.id, c.client_name);
  return map;
}
