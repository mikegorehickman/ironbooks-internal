import type { SupabaseClient } from "@supabase/supabase-js";
import { computeBillingCoverage } from "./billing-coverage";

/**
 * Client attention state — the ONE place badge inputs are computed, so every
 * surface (cleanup board, production board, manager dashboard, client
 * profile) reads identical signals from one batched fetch instead of growing
 * its own joins.
 *
 * Lifecycle stages are columns; these are the orthogonal, mostly-DERIVED
 * attention states that can strike at any stage:
 *   escalated    — open client_escalations rows (the one manual state)
 *   billing      — past_due | hold | unbilled (dunning columns + billing coverage)
 *   bs_owed      — bs_enabled = false (balance-sheet cleanup deferred)
 *   disconnected — qbo_connection_health.status = 'invalid_grant' (token dead)
 *   stuck_job    — a paused reclass job (web_search_paused / ai_paused)
 *
 * Every query degrades to "no signal" if its migration isn't applied.
 */

export interface OpenEscalation {
  id: string;
  kind: string;
  reason: string;
  note: string | null;
  raised_by_name: string | null;
  created_at: string;
  /** Open for more than 3 days — render darker (mirrors onboarding SLA). */
  aging: boolean;
}

export interface AttentionState {
  escalations: OpenEscalation[];
  billing: "past_due" | "hold" | "unbilled" | null;
  bs_owed: boolean;
  disconnected: boolean;
  stuck_job: boolean;
}

function hasAttention(a: AttentionState | undefined | null): boolean {
  if (!a) return false;
  return a.escalations.length > 0 || !!a.billing || a.bs_owed || a.disconnected || a.stuck_job;
}

/** Escalation SLA aging window (3 days): shared by board badges and the strips. */
export const AGING_MS = 3 * 24 * 60 * 60 * 1000;

/** Batched attention map for the whole active fleet (or a subset). ~6 queries total. */
export async function getAttentionMap(
  service: SupabaseClient,
  opts?: { clientIds?: string[] }
): Promise<Map<string, AttentionState>> {
  const svc = service as any;
  const scope = opts?.clientIds || null;
  const safe = async <T,>(p: Promise<{ data: T }>, fallback: T): Promise<T> => {
    try {
      const { data } = await p;
      return (data as T) ?? fallback;
    } catch {
      return fallback;
    }
  };

  let escQuery = svc
    .from("client_escalations")
    .select("id, client_link_id, kind, reason, note, raised_by, created_at")
    .eq("status", "open")
    .order("created_at", { ascending: true });
  if (scope) escQuery = escQuery.in("client_link_id", scope);

  let clientQuery = svc
    .from("client_links")
    .select("id, bs_enabled, portal_billing_hold, billing_past_due_since, daily_recon_enabled, is_active")
    .eq("is_active", true);
  if (scope) clientQuery = clientQuery.in("id", scope);

  let healthQuery = svc.from("qbo_connection_health").select("client_link_id, status").eq("status", "invalid_grant");
  if (scope) healthQuery = healthQuery.in("client_link_id", scope);

  let pausedQuery = svc
    .from("reclass_jobs")
    .select("client_link_id, status")
    .in("status", ["web_search_paused", "ai_paused"]);
  if (scope) pausedQuery = pausedQuery.in("client_link_id", scope);

  const [escRows, clientRows, healthRows, pausedRows, coverage] = await Promise.all([
    safe(escQuery, [] as any[]),
    safe(clientQuery, [] as any[]),
    safe(healthQuery, [] as any[]),
    safe(pausedQuery, [] as any[]),
    computeBillingCoverage(service).catch(() => null),
  ]);

  // Resolve raiser names (one query).
  const userIds = [...new Set((escRows as any[]).map((e) => e.raised_by).filter(Boolean))];
  const nameById = new Map<string, string>();
  if (userIds.length) {
    const users = await safe(
      svc.from("users").select("id, full_name, email").in("id", userIds),
      [] as any[]
    );
    for (const u of users as any[]) nameById.set(u.id, u.full_name || u.email);
  }

  const unbilledIds = new Set(
    (coverage?.unbilled || []).filter((g) => g.service === "production").map((g) => g.client_link_id)
  );
  const deadIds = new Set((healthRows as any[]).map((h) => h.client_link_id));
  const stuckIds = new Set((pausedRows as any[]).map((p) => p.client_link_id));
  const now = Date.now();

  const map = new Map<string, AttentionState>();
  const ensure = (id: string) => {
    let a = map.get(id);
    if (!a) {
      a = { escalations: [], billing: null, bs_owed: false, disconnected: false, stuck_job: false };
      map.set(id, a);
    }
    return a;
  };

  for (const e of escRows as any[]) {
    ensure(e.client_link_id).escalations.push({
      id: e.id,
      kind: e.kind,
      reason: e.reason,
      note: e.note,
      raised_by_name: e.raised_by ? nameById.get(e.raised_by) || null : null,
      created_at: e.created_at,
      aging: now - new Date(e.created_at).getTime() > AGING_MS,
    });
  }

  for (const c of clientRows as any[]) {
    const a = ensure(c.id);
    a.bs_owed = c.bs_enabled === false;
    a.disconnected = deadIds.has(c.id);
    a.stuck_job = stuckIds.has(c.id);
    // Billing severity: hold > past_due > unbilled.
    a.billing = c.portal_billing_hold
      ? "hold"
      : c.billing_past_due_since
      ? "past_due"
      : unbilledIds.has(c.id)
      ? "unbilled"
      : null;
  }

  return map;
}

/** JSON-safe shape for the /api/attention endpoint. */
export function attentionMapToJson(map: Map<string, AttentionState>): Record<string, AttentionState> {
  const out: Record<string, AttentionState> = {};
  for (const [id, a] of map) if (hasAttention(a)) out[id] = a;
  return out;
}
