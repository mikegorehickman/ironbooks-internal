"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Building2, Pencil, Check, X, Loader2, Sparkles, Save, Lock,
} from "lucide-react";
import {
  type EntityType, entityOptionsFor, entityLabel, resolveEntityType, taxFormFor,
} from "@/lib/entity-type";

// ─── Field config ─────────────────────────────────────────────────────────────
// Dropdown option lists mirror the GHL onboarding form exactly so values
// round-trip cleanly between the form answers and the SNAP profile.

const REVENUE_OPTIONS = [
  "Under $100K", "$100K – $250K", "$250K – $500K",
  "$500K – $1M", "$1M – $3M", "Over $3M",
];
const SOFTWARE_OPTIONS = [
  "QuickBooks Online", "Xero", "Wave", "FreshBooks", "Sage",
  "None / Spreadsheets", "Other",
];
const EMPLOYEE_OPTIONS = [
  "Just me (owner-operator)", "2–5", "6–15", "16–30", "30+",
];
const RECEIPTS_OPTIONS = [
  "Yes, digitally (app or email)", "Yes, paper only", "Sometimes", "No",
];
const BANK_CONNECTED_OPTIONS = ["Yes", "No", "Not sure"];
const CORPORATE_TYPE_OPTIONS = [
  "Sole Proprietor", "Partnership", "Corporation", "LLC", "S-Corp",
  "Nonprofit", "Other",
];
const YES_NO_UNSURE = ["Yes", "No", "Not sure"];
const COUNTRY_OPTIONS = ["United States", "Canada", "Other"];

export interface ClientProfileFields {
  contact_first_name: string | null;
  contact_last_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  legal_business_name: string | null;
  trade_type: string | null;
  corporate_type: string | null;
  fiscal_year_end: string | null;
  country: string | null;
  state_province: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  annual_revenue_range: string | null;
  taxes_up_to_date: string | null;
  prior_bookkeeper: string | null;
  accounting_software: string | null;
  payroll_provider: string | null;
  employee_count_range: string | null;
  uses_business_cards: string | null;
  keeps_receipts: string | null;
  bank_connected_to_software: string | null;
  entity_type: string | null;
  profile_updated_at: string | null;
}

type EditableKey = keyof Omit<ClientProfileFields, "profile_updated_at">;

const ALL_KEYS: EditableKey[] = [
  "contact_first_name", "contact_last_name", "client_email", "client_phone",
  "legal_business_name", "trade_type", "corporate_type", "fiscal_year_end",
  "country", "state_province", "address_line1", "address_line2", "city",
  "postal_code", "annual_revenue_range", "taxes_up_to_date", "prior_bookkeeper",
  "accounting_software", "payroll_provider", "employee_count_range",
  "uses_business_cards", "keeps_receipts", "bank_connected_to_software",
];

/**
 * Editable client-profile card on the internal /clients/[id] Overview.
 *
 * Read mode renders a labelled grid; Edit mode swaps to text inputs /
 * selects and PATCHes the whole diff to /api/clients/[id]. A "Fill from
 * onboarding" button best-effort maps the GHL onboarding-form answers into
 * the matching fields for the bookkeeper to review before saving.
 */
export function ClientDetailsCard({
  clientLinkId,
  initial,
  onboardingAnswers,
  jurisdiction,
  canEditEntity = false,
}: {
  clientLinkId: string;
  initial: ClientProfileFields;
  onboardingAnswers?: { label: string; value: string }[];
  /** client_links.jurisdiction — drives which entity options are offered. */
  jurisdiction?: string | null;
  /** admin/lead only may change the entity type (manual override). */
  canEditEntity?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ClientProfileFields>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  function set(key: EditableKey, value: string) {
    setForm((f) => ({ ...f, [key]: value || null }));
  }

  function cancel() {
    setForm(initial);
    setEditing(false);
    setError(null);
    setPrefilled(false);
  }

  // Best-effort prefill from the GHL onboarding answers. Matches by fuzzy
  // label keyword so it survives small wording changes; only fills blanks
  // (never clobbers something a bookkeeper already entered).
  function fillFromOnboarding() {
    if (!onboardingAnswers || onboardingAnswers.length === 0) return;
    const find = (...keywords: string[]): string | null => {
      for (const a of onboardingAnswers) {
        const label = a.label.toLowerCase();
        if (keywords.every((k) => label.includes(k))) return a.value;
      }
      return null;
    };
    const next: ClientProfileFields = { ...form };
    const apply = (key: EditableKey, val: string | null) => {
      if (val && !next[key]) (next as any)[key] = val;
    };
    apply("contact_first_name", find("first"));
    apply("contact_last_name", find("last"));
    apply("client_email", find("email"));
    apply("client_phone", find("phone"));
    apply("legal_business_name", find("company") || find("business", "name"));
    apply("trade_type", find("trade") || find("type", "business"));
    apply("corporate_type", find("corporate") || find("corp", "type"));
    apply("fiscal_year_end", find("fiscal") || find("year", "end"));
    apply("country", find("country"));
    apply("state_province", find("province") || find("state"));
    apply("annual_revenue_range", find("revenue"));
    apply("taxes_up_to_date", find("tax"));
    apply("prior_bookkeeper", find("bookkeeper") || find("accountant"));
    apply("accounting_software", find("software") || find("accounting"));
    apply("payroll_provider", find("payroll"));
    apply("employee_count_range", find("employee"));
    apply("uses_business_cards", find("card"));
    setForm(next);
    setPrefilled(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    // Only send changed keys.
    const diff: Record<string, any> = {};
    for (const k of ALL_KEYS) {
      if (form[k] !== initial[k]) diff[k] = form[k];
    }
    if (Object.keys(diff).length === 0) {
      setEditing(false);
      setSaving(false);
      return;
    }
    try {
      const res = await fetch(`/api/clients/${clientLinkId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(diff),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // The profile saved. If an email change couldn't repoint the portal
      // login (e.g. the new address already belongs to another login), surface
      // it and keep the card open so it isn't missed — the contact email still
      // saved either way.
      if (data.login_error) {
        setError(data.login_error);
        return;
      }
      setEditing(false);
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const fmtUpdated = initial.profile_updated_at
    ? new Date(initial.profile_updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-navy flex items-center gap-2">
          <Building2 size={15} className="text-teal" />
          Client details
        </h3>
        <div className="flex items-center gap-2">
          {!editing && fmtUpdated && (
            <span className="text-[11px] text-ink-light">Updated {fmtUpdated}</span>
          )}
          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-gray-200 text-navy hover:bg-gray-50"
            >
              <Pencil size={11} /> Edit
            </button>
          ) : (
            <div className="flex items-center gap-2">
              {onboardingAnswers && onboardingAnswers.length > 0 && (
                <button
                  onClick={fillFromOnboarding}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-teal/30 text-teal hover:bg-teal-lighter"
                  title="Best-effort copy from the GHL onboarding form answers (fills blanks only)"
                >
                  <Sparkles size={11} /> Fill from onboarding
                </button>
              )}
              <button
                onClick={cancel}
                disabled={saving}
                className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-gray-200 text-ink-slate hover:bg-gray-50 disabled:opacity-50"
              >
                <X size={11} /> Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg bg-teal text-white hover:bg-teal-dark disabled:opacity-50"
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} Save
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</div>
      )}
      {prefilled && editing && (
        <div className="mb-3 text-xs text-teal bg-teal-lighter rounded px-2 py-1 flex items-center gap-1">
          <Check size={12} /> Prefilled blank fields from onboarding answers — review, then Save.
        </div>
      )}

      {editing ? (
        <EditGrid form={form} set={set} />
      ) : (
        <>
          <EntitySelector
            clientLinkId={clientLinkId}
            jurisdiction={jurisdiction}
            entityType={initial.entity_type}
            corporateType={initial.corporate_type}
            canEdit={canEditEntity}
          />
          <ReadGrid form={initial} />
        </>
      )}
    </div>
  );
}

// ─── Entity type selector ────────────────────────────────────────────────────
// The client's tax classification (Mike 2026-07-18). Drives which return form
// the year-end export targets (US: 1120 / 1120-S / 1065 / Sch C — CA: T2 vs
// T2125) and the owner-equity account mapping. Comes in from the onboarding
// form; admin/lead can manually select or override here. Writes entity_type
// (migration 135); bookkeepers see it read-only.

function EntitySelector({
  clientLinkId, jurisdiction, entityType, corporateType, canEdit,
}: {
  clientLinkId: string;
  jurisdiction?: string | null;
  entityType: string | null;
  corporateType: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState<string | null>(null);
  const options = entityOptionsFor(jurisdiction);
  const explicit = entityType && ["c_corp", "s_corp", "partnership", "sole_prop"].includes(entityType);
  const current = resolveEntityType(entityType, corporateType);
  const form = taxFormFor(current, jurisdiction);

  async function setType(value: EntityType) {
    setSaving(value);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_type: value }),
      });
      if (res.ok) router.refresh();
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="mb-3 bg-teal-lighter/60 border border-teal/15 rounded-xl px-3 py-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-bold uppercase tracking-wider text-ink-slate">Entity type</span>
        {options.map((opt) => {
          const active = explicit ? entityType === opt : current === opt;
          return (
            <button
              key={opt}
              onClick={() => canEdit && !active && setType(opt)}
              disabled={!canEdit || saving !== null}
              className={`px-3 py-1 rounded-full text-[11px] font-bold border transition-colors ${
                active
                  ? "bg-teal text-white border-teal"
                  : "bg-white text-ink-slate border-gray-200 " +
                    (canEdit ? "hover:border-teal/50 hover:text-teal cursor-pointer" : "opacity-70 cursor-not-allowed")
              }`}
            >
              {saving === opt ? <Loader2 size={11} className="inline animate-spin" /> : entityLabel(opt, jurisdiction)}
            </button>
          );
        })}
        {!canEdit && <Lock size={11} className="text-ink-light" />}
      </div>
      <p className="text-[10px] text-ink-light mt-1.5">
        {!explicit && <span className="text-amber-700 font-semibold">Assumed from onboarding — confirm. </span>}
        Files <strong className="text-navy">{form}</strong>.
        {canEdit ? " Admin/lead can override." : " Only admin/lead can change this."}
      </p>
    </div>
  );
}

// ─── Read mode ──────────────────────────────────────────────────────────────

function ReadGrid({ form }: { form: ClientProfileFields }) {
  const rows: { label: string; value: string | null }[] = [
    { label: "Contact name", value: [form.contact_first_name, form.contact_last_name].filter(Boolean).join(" ") || null },
    { label: "Email", value: form.client_email },
    { label: "Phone", value: form.client_phone },
    { label: "Legal business name", value: form.legal_business_name },
    { label: "Trade / business type", value: form.trade_type },
    { label: "Corporate type", value: form.corporate_type },
    { label: "Fiscal year end", value: form.fiscal_year_end },
    { label: "Country", value: form.country },
    { label: "Province / State", value: form.state_province },
    { label: "Address", value: [form.address_line1, form.address_line2, form.city, form.postal_code].filter(Boolean).join(", ") || null },
    { label: "Annual revenue", value: form.annual_revenue_range },
    { label: "Taxes up to date", value: form.taxes_up_to_date },
    { label: "Prior bookkeeper / accountant", value: form.prior_bookkeeper },
    { label: "Accounting software", value: form.accounting_software },
    { label: "Payroll provider", value: form.payroll_provider },
    { label: "Employees", value: form.employee_count_range },
    { label: "Uses business / credit cards", value: form.uses_business_cards },
    { label: "Keeps receipts", value: form.keeps_receipts },
    { label: "Bank connected to software", value: form.bank_connected_to_software },
  ];
  const anySet = rows.some((r) => r.value);

  if (!anySet) {
    return (
      <p className="text-xs text-ink-slate italic">
        No client details captured yet. Click <strong>Edit</strong> to add them — or
        <strong> Fill from onboarding</strong> to pull from the GHL form.
      </p>
    );
  }

  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="min-w-0">
          <dt className="text-[10px] font-bold uppercase tracking-wider text-ink-light">{r.label}</dt>
          <dd className={`text-sm break-words ${r.value ? "text-navy" : "text-ink-light italic"}`}>
            {r.value || "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ─── Edit mode ──────────────────────────────────────────────────────────────

function EditGrid({
  form,
  set,
}: {
  form: ClientProfileFields;
  set: (k: EditableKey, v: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
      <TextField label="First name" k="contact_first_name" form={form} set={set} />
      <TextField label="Last name" k="contact_last_name" form={form} set={set} />
      <TextField label="Email" k="client_email" form={form} set={set} type="email" />
      <TextField label="Phone" k="client_phone" form={form} set={set} type="tel" />
      <TextField label="Legal business name" k="legal_business_name" form={form} set={set} />
      <TextField label="Trade / business type" k="trade_type" form={form} set={set} placeholder="e.g. Painting contractor" />
      <SelectField label="Corporate type" k="corporate_type" form={form} set={set} options={CORPORATE_TYPE_OPTIONS} />
      <TextField label="Fiscal year end" k="fiscal_year_end" form={form} set={set} placeholder="e.g. December 31" />
      <SelectField label="Country" k="country" form={form} set={set} options={COUNTRY_OPTIONS} />
      <TextField label="Province / State" k="state_province" form={form} set={set} />
      <TextField label="Address line 1" k="address_line1" form={form} set={set} />
      <TextField label="Address line 2" k="address_line2" form={form} set={set} />
      <TextField label="City" k="city" form={form} set={set} />
      <TextField label="Postal / ZIP code" k="postal_code" form={form} set={set} />
      <SelectField label="Annual revenue" k="annual_revenue_range" form={form} set={set} options={REVENUE_OPTIONS} />
      <SelectField label="Taxes up to date" k="taxes_up_to_date" form={form} set={set} options={YES_NO_UNSURE} />
      <TextField label="Prior bookkeeper / accountant" k="prior_bookkeeper" form={form} set={set} />
      <SelectField label="Accounting software" k="accounting_software" form={form} set={set} options={SOFTWARE_OPTIONS} />
      <TextField label="Payroll provider" k="payroll_provider" form={form} set={set} placeholder="e.g. Wagepoint, Gusto" />
      <SelectField label="Employees" k="employee_count_range" form={form} set={set} options={EMPLOYEE_OPTIONS} />
      <SelectField label="Uses business / credit cards" k="uses_business_cards" form={form} set={set} options={YES_NO_UNSURE} />
      <SelectField label="Keeps receipts" k="keeps_receipts" form={form} set={set} options={RECEIPTS_OPTIONS} />
      <SelectField label="Bank connected to software" k="bank_connected_to_software" form={form} set={set} options={BANK_CONNECTED_OPTIONS} />
    </div>
  );
}

function TextField({
  label, k, form, set, type = "text", placeholder,
}: {
  label: string; k: EditableKey; form: ClientProfileFields;
  set: (k: EditableKey, v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="text-[10px] font-bold uppercase tracking-wider text-ink-light">{label}</span>
      <input
        type={type}
        value={(form[k] as string) || ""}
        onChange={(e) => set(k, e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full text-sm rounded-lg border border-gray-200 px-2.5 py-1.5 text-navy placeholder:text-ink-light focus:outline-none focus:border-teal"
      />
    </label>
  );
}

function SelectField({
  label, k, form, set, options,
}: {
  label: string; k: EditableKey; form: ClientProfileFields;
  set: (k: EditableKey, v: string) => void; options: string[];
}) {
  const current = (form[k] as string) || "";
  // If the stored value isn't one of the options (e.g. legacy free text),
  // keep it selectable so editing doesn't silently drop it.
  const showCustom = current && !options.includes(current);
  return (
    <label className="block min-w-0">
      <span className="text-[10px] font-bold uppercase tracking-wider text-ink-light">{label}</span>
      <select
        value={current}
        onChange={(e) => set(k, e.target.value)}
        className="mt-1 w-full text-sm rounded-lg border border-gray-200 px-2.5 py-1.5 text-navy bg-white focus:outline-none focus:border-teal"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
        {showCustom && <option value={current}>{current}</option>}
      </select>
    </label>
  );
}
