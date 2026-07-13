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

// ── Onboarding form → client profile (migration 73) ─────────────────────────
// The Ironbooks onboarding form posts these flat camelCase keys. This is the
// authoritative mapping from form field → client_links column. GHL sometimes
// nests custom fields under `customData`, so we read both top-level and there.

import type { SupabaseClient as _SupabaseClient } from "@supabase/supabase-js";

/**
 * Read a form field by trying several key aliases, top-level then customData.
 * GHL's real onboarding webhook sends Title-Case-with-spaces keys ("Business
 * Type", "Year End", "Province", "Bank Connected", …) plus snake_case identity
 * (first_name, company_name) — NOT the camelCase a hand-built sample suggested.
 * We accept all variants so the mapping survives either form configuration.
 */
function readFormField(payload: any, keys: string[]): string | null {
  for (const key of keys) {
    const v = payload?.[key] ?? payload?.customData?.[key];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s !== "") return s;
  }
  return null;
}

function normalizeCountry(v: string): string {
  const s = v.trim().toLowerCase();
  if (["usa", "us", "u.s.", "u.s.a.", "united states"].includes(s)) return "United States";
  if (["canada", "ca", "can"].includes(s)) return "Canada";
  return v;
}

const CA_PROVINCES = new Set([
  "alberta", "ab", "british columbia", "bc", "manitoba", "mb", "new brunswick", "nb",
  "newfoundland and labrador", "newfoundland", "labrador", "nl", "northwest territories", "nt",
  "nova scotia", "ns", "nunavut", "nu", "ontario", "on", "prince edward island", "pei", "pe",
  "quebec", "québec", "qc", "saskatchewan", "sk", "yukon", "yt",
]);

/**
 * Derive the SNAP jurisdiction (US/CA tax system) from a province/state value.
 * A recognized Canadian province/territory → "CA"; anything else present (a US
 * state) → "US"; blank → null (leave unset).
 */
export function deriveJurisdiction(province: string | null | undefined): "US" | "CA" | null {
  if (!province) return null;
  const s = String(province).trim().toLowerCase();
  if (!s) return null;
  return CA_PROVINCES.has(s) ? "CA" : "US";
}

/** Jurisdiction from the onboarding form: country field first, then province. */
export function deriveJurisdictionFromForm(payload: any): "US" | "CA" | null {
  const country = readFormField(payload, ["country", "Country"]);
  if (country) {
    const c = country.trim().toLowerCase();
    if (["ca", "can", "canada"].includes(c)) return "CA";
    if (["us", "usa", "u.s.", "u.s.a.", "united states"].includes(c)) return "US";
  }
  return deriveJurisdiction(readFormField(payload, ["Province", "province", "State", "state"]));
}

/** form column → candidate keys (real GHL key first, then camelCase fallback). */
const FORM_TO_PROFILE: { keys: string[]; col: string; transform?: (v: string) => string }[] = [
  { keys: ["first_name", "firstName"], col: "contact_first_name" },
  { keys: ["last_name", "lastName"], col: "contact_last_name" },
  { keys: ["email"], col: "client_email" },
  { keys: ["phone"], col: "client_phone" },
  { keys: ["company_name", "companyName"], col: "legal_business_name" },
  { keys: ["Business Type", "businessType"], col: "trade_type" },
  { keys: ["Corporation Type", "corporationType"], col: "corporate_type" },
  { keys: ["Year End", "yearEnd"], col: "fiscal_year_end" },
  { keys: ["country", "Country"], col: "country", transform: normalizeCountry },
  { keys: ["Province", "province", "State", "state"], col: "state_province" },
  { keys: ["Annual Revenue", "annualRevenue"], col: "annual_revenue_range" },
  { keys: ["Taxs Filed", "Taxes Filed", "taxsFiled"], col: "taxes_up_to_date" },
  { keys: ["Last Bookkeeper", "lastBookkeeper"], col: "prior_bookkeeper" },
  { keys: ["Accounting Software", "accountingSoftware"], col: "accounting_software" },
  { keys: ["Payroll Provider", "payrollProvider"], col: "payroll_provider" },
  { keys: ["Number Of Employees", "numberOfEmployees"], col: "employee_count_range" },
  { keys: ["Keep Receipts", "keepReceipts"], col: "keeps_receipts" },
  { keys: ["Bank Connected", "bankConnected"], col: "bank_connected_to_software" },
  { keys: ["CreditCards", "creditCards", "Credit Cards"], col: "uses_business_cards" },
  // Address block — columns exist since migration 73 and render on the profile,
  // but no form variant sent them until the ironbooks.com (Manus) form did.
  {
    keys: ["Address Line 1", "addressLine1", "Street Address", "streetAddress", "Address", "address", "address1"],
    col: "address_line1",
  },
  { keys: ["Address Line 2", "addressLine2", "Unit", "Suite", "address2"], col: "address_line2" },
  { keys: ["City", "city"], col: "city" },
  {
    keys: ["Postal Code", "postalCode", "postal_code", "Zip Code", "zipCode", "Zip", "zip"],
    col: "postal_code",
  },
  // "Additional Notes" is intentionally NOT mapped to client_links.notes (that's
  // the internal bookkeeper notes field). It stays visible via the onboarding
  // answers card + the raw stored payload.
];

/** Map a form payload to the client_links profile columns it should set. */
export function mapOnboardingFormToProfile(payload: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { keys, col, transform } of FORM_TO_PROFILE) {
    const raw = readFormField(payload, keys);
    if (raw == null) continue;
    out[col] = transform ? transform(raw) : raw;
  }
  return out;
}

/**
 * Write the mapped onboarding-form fields onto a client_links row. Fills
 * blanks only by default (never stomps a bookkeeper's manual edit); pass
 * { overwrite: true } to let the form win. Stamps profile_updated_at. Returns
 * how many columns were written. Fail-soft — caller decides what to do on error.
 */
export async function applyOnboardingFormToProfile(
  service: _SupabaseClient,
  clientLinkId: string,
  payload: any,
  opts: { overwrite?: boolean } = {}
): Promise<{ filled: number; error?: string }> {
  const mapped = mapOnboardingFormToProfile(payload);
  if (Object.keys(mapped).length === 0) return { filled: 0 };

  let updates: Record<string, any> = mapped;
  if (!opts.overwrite) {
    const cols = Object.keys(mapped);
    const { data: cur } = await (service as any)
      .from("client_links")
      .select(cols.join(", "))
      .eq("id", clientLinkId)
      .single();
    updates = {};
    for (const [k, v] of Object.entries(mapped)) {
      const existing = cur?.[k];
      if (existing == null || String(existing).trim() === "") updates[k] = v;
    }
  }
  if (Object.keys(updates).length === 0) return { filled: 0 };

  updates.profile_updated_at = new Date().toISOString();
  const { error } = await (service as any)
    .from("client_links")
    .update(updates)
    .eq("id", clientLinkId);
  if (error) return { filled: 0, error: error.message };
  return { filled: Object.keys(updates).length - 1 };
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

// Canadian NANP area codes — used to infer US/CA jurisdiction from a phone
// number when the form/address doesn't say (GHL's `country` field defaults
// everyone to "CA", so it's not trustworthy; the area code is).
const CA_AREA_CODES = new Set([
  "204","226","236","249","263","289","306","343","354","365","367","368","382",
  "403","416","418","431","437","438","450","468","474","506","514","519","548",
  "579","581","584","587","604","613","639","647","672","683","705","709","742",
  "753","778","780","782","807","819","825","867","873","879","902","905",
]);

function jurisdictionFromPhone(phone?: string | null): "US" | "CA" | null {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  const ac = digits.length >= 11 && digits.startsWith("1") ? digits.slice(1, 4) : digits.slice(0, 3);
  if (ac.length !== 3) return null;
  return CA_AREA_CODES.has(ac) ? "CA" : "US";
}

/**
 * Resolve (or create) the SNAP client profile (`client_links`) for a won sale.
 *
 * A closed-won opportunity is a committed bookkeeping client, so it must have a
 * `client_links` row from the moment it's won — not wait for the onboarding
 * form. Mirrors the create path in the ob-form webhook (status "onboarding",
 * is_active), but is the entry point for the WON event.
 *
 * Match-first by email (the canonical key — `client_links` has no
 * ghl_contact_id column), so re-firing the webhook or running the backfill is
 * idempotent and never duplicates an existing client. The GHL contact id is
 * stamped into `metadata` for traceability.
 */
export async function resolveOrCreateClientForWon(
  service: SupabaseClient,
  opts: {
    email?: string | null;
    fullName?: string | null;
    businessName?: string | null;
    phone?: string | null;
    jurisdiction?: "US" | "CA" | null;
    ghlContactId?: string | null;
    ghlOpportunityId?: string | null;
  }
): Promise<{ clientLinkId: string | null; created: boolean; error?: string }> {
  const emailLc = (opts.email || "").trim().toLowerCase();

  if (emailLc) {
    const { data: existing } = await (service as any)
      .from("client_links")
      .select("id")
      .ilike("client_email", emailLc)
      .limit(1)
      .maybeSingle();
    if (existing?.id) return { clientLinkId: existing.id, created: false };
  }

  const clientName = opts.businessName || opts.fullName || "New won client";
  const insert: Record<string, any> = {
    client_name: clientName,
    client_email: opts.email || null,
    client_phone: opts.phone || null,
    status: "onboarding",
    is_active: true,
    // double_client_id is a legacy NOT-NULL column (pre-Double-retirement).
    // A GHL-won client has no Double id, so synthesize a unique, clearly
    // non-Double value keyed off the GHL contact (stable + collision-free).
    double_client_id: opts.ghlContactId
      ? `ghl_${opts.ghlContactId}`
      : `won_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
  };
  // jurisdiction is NOT NULL. Prefer the form-derived value; else infer from
  // the phone area code (Canadian NANP codes → CA); else default US (the modal
  // case for new sales). Best-effort — the onboarding form sets it correctly.
  insert.jurisdiction = opts.jurisdiction || jurisdictionFromPhone(opts.phone) || "US";
  if (opts.businessName) insert.legal_business_name = opts.businessName;
  if (opts.fullName) {
    const parts = opts.fullName.trim().split(/\s+/);
    insert.contact_first_name = parts[0] || null;
    if (parts.length > 1) insert.contact_last_name = parts.slice(1).join(" ");
  }
  if (opts.ghlContactId || opts.ghlOpportunityId) {
    insert.metadata = {
      ...(opts.ghlContactId ? { ghl_contact_id: opts.ghlContactId } : {}),
      ...(opts.ghlOpportunityId ? { ghl_opportunity_id: opts.ghlOpportunityId } : {}),
      created_from: "ghl_won",
    };
  }

  const { data, error } = await (service as any)
    .from("client_links")
    .insert(insert)
    .select("id")
    .single();
  if (error) return { clientLinkId: null, created: false, error: error.message };
  return { clientLinkId: data.id, created: true };
}

/**
 * Board data for the Onboarding pipeline — active unconverted leads (minus
 * anyone who's already an active client by email) + the bookkeeper roster.
 * Shared by /onboarding and the unified /board screen so the two never drift.
 */
export async function fetchOnboardingBoardData(service: any): Promise<{
  leads: OnboardingLead[];
  bookkeepers: Array<{ id: string; full_name: string }>;
}> {
  let leads: OnboardingLead[] = [];
  try {
    const { data } = await service
      .from("onboarding_leads")
      .select("*")
      .eq("status", "active")
      .is("client_link_id", null)
      .order("won_at", { ascending: true, nullsFirst: false });
    leads = (data as OnboardingLead[]) || [];

    if (leads.length) {
      const { data: activeClients } = await service
        .from("client_links")
        .select("client_email")
        .eq("is_active", true);
      const clientEmails = new Set(
        ((activeClients as any[]) || [])
          .map((c: any) => (c.client_email || "").toLowerCase().trim())
          .filter(Boolean)
      );
      if (clientEmails.size) {
        leads = leads.filter(
          (l) => !clientEmails.has((l.email || "").toLowerCase().trim())
        );
      }
    }
  } catch {
    leads = [];
  }

  const { data: bks } = await service
    .from("users")
    .select("id, full_name, role")
    .eq("is_active", true)
    .in("role", ["admin", "lead", "bookkeeper"])
    .order("full_name");
  const bookkeepers = ((bks as any[]) || [])
    .filter((b: any) => b.full_name)
    .map((b: any) => ({ id: b.id, full_name: b.full_name }));

  return { leads, bookkeepers };
}
