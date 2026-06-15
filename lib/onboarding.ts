/**
 * Onboarding pipeline helpers — stage derivation, SLA, and the webhook
 * upsert path. Shared by the GHL webhook endpoints, the /onboarding board,
 * and the (future) reconciliation poll.
 *
 * Stage is DERIVED from milestone timestamps, never stored — that way the
 * three out-of-order webhooks (won / form / call) can land in any sequence
 * and the board always reflects the true furthest-along state.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type OnboardingStage =
  | "new_sale" // won, neither form nor call done
  | "in_progress" // form OR call started, not finished
  | "ready" // form done + call attended → create client
  | "converted"
  | "lost";

export interface OnboardingLead {
  id: string;
  ghl_contact_id: string;
  ghl_opportunity_id: string | null;
  full_name: string | null;
  business_name: string | null;
  email: string | null;
  phone: string | null;
  won_at: string | null;
  ob_form_submitted_at: string | null;
  ob_form_payload: any;
  ob_call_scheduled_at: string | null;
  ob_call_time: string | null;
  ob_call_status: string | null;
  ob_call_attended_at: string | null;
  ob_call_grain_id: string | null;
  status: "active" | "converted" | "lost";
  lost_reason: string | null;
  assigned_to: string | null;
  notes: string | null;
  last_resend_at: string | null;
  client_link_id: string | null;
  created_at: string;
  updated_at: string;
}

const ACTIVE_CALL = (s: string | null | undefined) =>
  !!s && s !== "cancelled" && s !== "no_show";

/** Derive the board column from a lead's milestones. */
export function deriveStage(lead: Partial<OnboardingLead>): OnboardingStage {
  if (lead.status === "converted") return "converted";
  if (lead.status === "lost") return "lost";

  const formDone = !!lead.ob_form_submitted_at;
  const callBooked = !!lead.ob_call_time && ACTIVE_CALL(lead.ob_call_status);
  const callAttended =
    !!lead.ob_call_attended_at || lead.ob_call_status === "attended";

  if (formDone && callAttended) return "ready";
  if (formDone || callBooked || callAttended) return "in_progress";
  return "new_sale";
}

export type SlaLevel = "ok" | "warn" | "overdue";

/**
 * Time-pressure on a not-yet-finished lead, anchored on the sale date:
 *   won + 3 days, no movement → warn (red)
 *   won + 5 days, no movement → overdue (dark red)
 * "Movement" = any onboarding milestone reached.
 */
export function slaLevel(lead: Partial<OnboardingLead>, now = Date.now()): SlaLevel {
  if (!lead.won_at) return "ok";
  const stage = deriveStage(lead);
  if (stage === "ready" || stage === "converted" || stage === "lost") return "ok";
  const moved = !!lead.ob_form_submitted_at || !!lead.ob_call_time;
  if (moved) return "ok";
  const days = (now - new Date(lead.won_at).getTime()) / 86400000;
  if (days >= 5) return "overdue";
  if (days >= 3) return "warn";
  return "ok";
}

// ── GHL payload field extraction ──────────────────────────────────────────
// PLACEHOLDER mapping. GHL custom-webhook payloads vary by workflow config;
// we try the common shapes and ALWAYS keep the raw payload so finalizing the
// mapping (once we see real payloads) is a one-spot change — no data is lost.

export function pick(obj: any, paths: string[]): any {
  for (const p of paths) {
    const v = p.split(".").reduce((o: any, k) => (o == null ? o : o[k]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/** The stable cross-event key. Required — we can't track a lead without it. */
export function extractContactId(payload: any): string | null {
  const v = pick(payload, [
    "contact_id",
    "contactId",
    "contact.id",
    "contactID",
    "customData.contact_id",
  ]);
  return v ? String(v) : null;
}

// Keys that are plumbing/contact identity, not onboarding-form answers — so
// the profile shows the questions the client actually answered, not GHL noise.
const FORM_SYSTEM_KEYS = new Set([
  "contact_id", "contactid", "location_id", "locationid", "id", "workflow",
  "opportunity_id", "opportunityid", "first_name", "firstname", "last_name",
  "lastname", "full_name", "name", "email", "phone", "company_name", "companyname",
  "business_name", "businessname", "date_created", "datecreated", "timestamp",
  "tags", "source", "customdata", "type", "event",
]);

function humanizeKey(k: string): string {
  return k
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function flattenValue(v: any): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const parts = v.map((x) => flattenValue(x)).filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof v === "object") {
    const parts = Object.entries(v)
      .map(([k, val]) => {
        const fv = flattenValue(val);
        return fv ? `${humanizeKey(k)}: ${fv}` : null;
      })
      .filter(Boolean);
    return parts.length ? parts.join("; ") : null;
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Flatten a GHL onboarding-form payload into readable label/value answers for
 * the client profile, so a senior can reference them without opening GHL.
 * Prefers a nested `customData` block (GHL's usual home for custom form
 * fields), else the top-level payload, dropping the system keys above.
 * Generic by design — curate labels/order once we see a real payload, but no
 * answer is ever lost (the raw payload is stored too).
 */
export function extractFormAnswers(payload: any): { label: string; value: string }[] {
  if (!payload || typeof payload !== "object") return [];
  const src =
    payload.customData && typeof payload.customData === "object" ? payload.customData : payload;
  const out: { label: string; value: string }[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (FORM_SYSTEM_KEYS.has(k.toLowerCase())) continue;
    const val = flattenValue(v);
    if (val == null) continue;
    out.push({ label: humanizeKey(k), value: val });
  }
  return out;
}

export function extractContactFields(payload: any) {
  const first = pick(payload, ["first_name", "firstName", "contact.firstName"]);
  const last = pick(payload, ["last_name", "lastName", "contact.lastName"]);
  const full =
    pick(payload, ["full_name", "name", "contact.name"]) ||
    [first, last].filter(Boolean).join(" ") ||
    null;
  return {
    full_name: full,
    email: pick(payload, ["email", "contact.email"]),
    phone: pick(payload, ["phone", "contact.phone"]),
    business_name: pick(payload, [
      "company_name",
      "companyName",
      "business_name",
      "contact.companyName",
    ]),
    ghl_opportunity_id: pick(payload, ["opportunity_id", "opportunityId", "opportunity.id"]),
  };
}

/**
 * Upsert a lead from an inbound webhook keyed on the GHL contact id. Logs
 * the raw event first (idempotency/audit), then merges the milestone fields
 * for this event kind. Creating-on-any-event makes the three webhooks
 * order-independent.
 */
export async function upsertLeadFromWebhook(
  service: SupabaseClient,
  kind: "won" | "ob_form" | "ob_call",
  contactId: string,
  payload: any,
  fields: Record<string, any>
): Promise<{ ok: boolean; id?: string; error?: string }> {
  await (service as any)
    .from("onboarding_webhook_events")
    .insert({ kind, ghl_contact_id: contactId, payload });

  const { data: existing } = await (service as any)
    .from("onboarding_leads")
    .select("id, status")
    .eq("ghl_contact_id", contactId)
    .maybeSingle();

  const merged = {
    ghl_contact_id: contactId,
    raw: payload,
    updated_at: new Date().toISOString(),
    ...fields,
  };

  if (existing) {
    const { error } = await (service as any)
      .from("onboarding_leads")
      .update(merged)
      .eq("id", existing.id);
    return error ? { ok: false, error: error.message } : { ok: true, id: existing.id };
  }

  const { data, error } = await (service as any)
    .from("onboarding_leads")
    .insert({ source: "webhook", ...merged })
    .select("id")
    .single();
  return error ? { ok: false, error: error.message } : { ok: true, id: data?.id };
}
