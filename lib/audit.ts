/**
 * The one way to write an audit event.
 *
 * WHY THIS EXISTS. There were 143 hand-rolled `from("audit_log").insert(...)`
 * call sites, each choosing for itself whether to record which client the action
 * affected. Measured 2026-07-28: only 31% of 23,211 rows were attributable to a
 * client, and the missing 69% was the substantive work — 2,149 account renames,
 * 1,312 merges, 785 inactivations, 1,017 silently-discarded actions. Filtering
 * /admin/audit by client therefore hid two thirds of the record while looking
 * like a complete answer.
 *
 * Migration 145 backfilled the history. This exists so it can't drift again:
 * `clientLinkId` is a required field on the scoped variant, so a new call site
 * omitting it is a type error rather than a silent gap discovered months later.
 *
 * DESIGN NOTE — built for internal QA now, external audit later. Nothing here
 * forecloses append-only storage, a hash chain, retention windows or signed
 * export; those need a policy decision first. What this does guarantee is the
 * thing all of them depend on: that every event carries who, what, when, and
 * whose books.
 */

import type { createServiceSupabase } from "./supabase";

type Service = ReturnType<typeof createServiceSupabase>;

export interface AuditEventBase {
  /** Stable snake_case verb, e.g. "qbo_rename", "month_stage_ticked". Treat an
   *  existing value as an interface — dashboards and this session's queries
   *  group by it, so renaming one silently breaks history. */
  eventType: string;
  /** Who did it. Null ONLY for genuine system actions (cron, webhook). */
  userId?: string | null;
  /** What was done — the detail a reviewer needs to understand the event.
   *  Keep it small and free of secrets; this is readable by anyone with audit
   *  access, and it is retained. */
  payload?: Record<string, unknown>;
  /** Job this belongs to, when there is one. Still worth setting even though
   *  clientLinkId is now explicit — it's what groups an event into a run. */
  jobId?: string | null;
  actionId?: string | null;
  /** Request context, for the API-shaped events that record it. */
  apiEndpoint?: string | null;
  httpMethod?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  responsePayload?: Record<string, unknown> | null;
}

export interface ClientAuditEvent extends AuditEventBase {
  /** REQUIRED. This is the field whose optionality caused the problem. */
  clientLinkId: string;
}

/**
 * Record something that happened to a specific client's books.
 *
 * Never throws. An audit write failing must not fail the operation it is
 * describing — but unlike the inserts this replaces, the error IS logged, because
 * silent audit loss is how you end up unable to answer "who changed this".
 */
export async function auditClient(service: Service, e: ClientAuditEvent): Promise<void> {
  await write(service, e.clientLinkId, e);
}

/**
 * Record a genuinely fleet-level action — a master-COA template edit, a cron
 * summary. `client_link_id` stays NULL, which means "no single client", NOT
 * "we didn't bother". Use auditClient whenever one client is affected.
 */
export async function auditFleet(service: Service, e: AuditEventBase): Promise<void> {
  await write(service, null, e);
}

async function write(
  service: Service,
  clientLinkId: string | null,
  e: AuditEventBase
): Promise<void> {
  try {
    const { error } = await (service as any).from("audit_log").insert({
      event_type: e.eventType,
      client_link_id: clientLinkId,
      user_id: e.userId ?? null,
      request_payload: (e.payload ?? {}) as any,
      response_payload: (e.responsePayload ?? null) as any,
      job_id: e.jobId ?? null,
      action_id: e.actionId ?? null,
      api_endpoint: e.apiEndpoint ?? null,
      http_method: e.httpMethod ?? null,
      status_code: e.statusCode ?? null,
      duration_ms: e.durationMs ?? null,
      error_message: e.errorMessage ?? null,
    });
    if (error) {
      // Loud on purpose. The inserts this replaces used a bare `catch {}`, so a
      // failing audit write was indistinguishable from an action that never
      // happened.
      console.error(
        `[audit] FAILED to record "${e.eventType}"` +
          `${clientLinkId ? ` for client ${clientLinkId}` : " (fleet)"}: ${error.message}`
      );
    }
  } catch (err: any) {
    console.error(`[audit] threw recording "${e.eventType}": ${err?.message || err}`);
  }
}

/**
 * Events that make up a client's activity timeline, grouped so the UI can render
 * them without knowing every one of the 138 distinct event types.
 *
 * Anything unrecognised falls into "other" rather than being dropped — a new
 * event type must never become invisible just because this map wasn't updated.
 */
export const AUDIT_CATEGORIES = {
  chart: {
    label: "Chart of accounts",
    match: (t: string) =>
      /^(qbo_(rename|merge|inactivate|create|retype)|coa_|master_coa_|merge_|preflight_|auto_dismissed|manual_cleanup)/.test(t),
  },
  transactions: {
    label: "Transactions",
    match: (t: string) => /^(reclass_|stage_|bulk_reclass|parent_posting)/.test(t),
  },
  recon: {
    label: "Daily recon",
    match: (t: string) => /^(daily_recon|processed_qbo|queue_)/.test(t),
  },
  monthEnd: {
    label: "Month end",
    match: (t: string) => /^(month_end|monthly_|client_month|statement)/.test(t),
  },
  client: {
    label: "Client comms & portal",
    match: (t: string) =>
      /^(portal_|client_email|message_|ask_client|invite|onboarding_|support_)/.test(t),
  },
  access: {
    label: "Access & permissions",
    match: (t: string) => /^(user_|impersonat|auth_|login)/.test(t),
  },
  billing: { label: "Billing", match: (t: string) => /^(billing_|stripe_|subscription_)/.test(t) },
} as const;

export type AuditCategory = keyof typeof AUDIT_CATEGORIES | "other";

export function categorizeAuditEvent(eventType: string): AuditCategory {
  for (const [key, def] of Object.entries(AUDIT_CATEGORIES)) {
    if (def.match(eventType)) return key as AuditCategory;
  }
  return "other";
}

/** Turn "qbo_rename" into "Qbo rename" for display, without a lookup table
 *  that would go stale the moment someone adds an event type. */
export function humanizeEventType(eventType: string): string {
  const s = eventType.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Payload keys that are plumbing, not content — they identify the row rather
 *  than say what happened, so they never earn space in a one-line summary. */
const NOISE_KEYS = new Set([
  "client_link_id",
  "client_name",
  "job_id",
  "reclass_job_id",
  "coa_job_id",
  "discovery_job_id",
  "action_id",
  "user_id",
  "id",
]);

/**
 * One line describing what an audit event actually did, from a free-form JSONB
 * payload written by any of 143 call sites.
 *
 * Shared by /admin/audit and the per-client timeline on purpose: the same event
 * described two different ways on two screens is how people stop trusting both.
 * Recognised shapes are named explicitly; anything unrecognised degrades to its
 * own keys and values rather than to "—", because an event whose detail exists
 * but isn't rendered looks identical to one that carries no detail at all.
 */
export function summarizeAuditPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "—";
  const p = payload as Record<string, any>;

  // Named shapes, most specific first.
  if (p.old_name && p.new_name) return `"${p.old_name}" → "${p.new_name}"`;
  if (p.source && p.target) return `"${p.source}" → "${p.target}"`;
  if (p.from_account_name && p.to_account_name) {
    return `${p.from_account_name} → ${p.to_account_name}`;
  }
  if (p.account_name && p.new_name) return `"${p.account_name}" → "${p.new_name}"`;
  if (typeof p.message === "string") return p.message.slice(0, 200);
  if (typeof p.reason === "string") return p.reason.slice(0, 200);
  if (Array.isArray(p.changed)) return `changed: ${p.changed.join(", ")}`;
  if (typeof p.target_email === "string") return `as ${p.target_email}`;

  const parts: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (NOISE_KEYS.has(k) || v === null || v === undefined || v === "") continue;
    // Skip a nested object/array — a flattened blob is unreadable in a table
    // cell, and the expandable detail below the row shows it in full anyway.
    if (typeof v === "object") {
      parts.push(`${k}: ${Array.isArray(v) ? `${v.length} item(s)` : "{…}"}`);
    } else {
      parts.push(`${k}: ${v}`);
    }
    if (parts.length === 6) break;
  }
  return parts.length ? parts.join(" · ").slice(0, 220) : "—";
}
