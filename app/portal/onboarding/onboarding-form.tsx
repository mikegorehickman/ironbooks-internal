"use client";

import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import {
  Loader2, ArrowRight, ArrowLeft, Plus, Trash2, Upload, FileCheck2, X, Save, CheckCircle2,
} from "lucide-react";

/**
 * The onboarding intake form — the long one, broken into pages.
 *
 * 29 fields plus two dynamic lists is far too much for one screen, so it's
 * paged, and EVERY "Next" saves a draft server-side. A client can close the tab
 * mid-way and pick up exactly where they left off, which matters because a lot
 * of this (bank list, loan paperwork, last tax return) means going and finding
 * something.
 *
 * Nothing here is validated beyond the handful of genuinely required fields —
 * chasing a contractor for a fiscal year-end at 9pm is how you lose the form.
 * The bookkeeper fills gaps on the onboarding call.
 */

// ── Option lists ────────────────────────────────────────────────────────────
const TRADES = [
  "Painting", "Plumbing", "Electrical", "HVAC", "Roofing", "General Contracting",
  "Landscaping", "Remodeling / Renovation", "Chimney Sweeping", "Other",
];
const CORP_TYPES = [
  "Sole Proprietorship", "Partnership", "Corporation (Inc.)", "LLC", "S-Corp", "Other",
];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const REVENUE = [
  "Under $100K", "$100K – $250K", "$250K – $500K", "$500K – $1M", "$1M – $3M", "Over $3M",
];
const TAXES_UP_TO_DATE = [
  "Yes, fully up to date", "1 year behind", "2+ years behind", "Not sure",
];
const SOFTWARE = [
  "QuickBooks Online", "Xero", "Wave", "FreshBooks", "Sage", "None / Spreadsheets", "Other",
];
const EMPLOYEES = ["Just me (owner-operator)", "2–5", "6–15", "16–30", "30+"];
const RECEIPTS = ["Yes, digitally (app or email)", "Yes, paper only", "Sometimes", "No"];
const YES_NO_UNSURE = ["Yes", "No", "Not sure"];
const YES_NO = ["Yes", "No"];
const GST_FREQUENCY = ["Monthly", "Quarterly", "Annual"];
const PAYROLL_PROVIDERS = ["ADP", "Gusto", "QuickBooks Payroll", "Wagepoint", "Other", "None"];
const STAFF_ROLES = ["Office", "Field", "Painter"];
const ACCOUNT_TYPES = ["Checking", "Savings", "Credit Card", "Loan", "Line of Credit", "Investment"];

const TAX_YEARS = Array.from({ length: 10 }, (_, i) => String(new Date().getFullYear() - i));

export interface StaffRow { name: string; role: string }
export interface AccountRow { institution: string; accountType: string; last4: string }
export interface UploadedFile { path: string; name: string }

export interface OnboardingAnswers {
  firstName: string; lastName: string; email: string; phone: string;
  companyName: string; tradeType: string; corporationType: string;
  fiscalYearEnd: string; country: string; provinceState: string;
  annualRevenue: string; taxesUpToDate: string; lastBookkeeper: string; accountingSoftware: string;
  employeeCount: string; keepsReceipts: string; bankConnected: string; cardsUsed: string;
  incorporationDate: string; lastTaxReturnYear: string; taxReturnFile: UploadedFile | null;
  gstRegistered: string; gstFrequency: string; gstQuarterEndMonths: string;
  payrollProvider: string; payrollProviderOther: string;
  staff: StaffRow[];
  hasFinancedVehicles: string; leaseFiles: UploadedFile[];
  accounts: AccountRow[];
  accountAttestation: boolean; accountAttestationTimestamp: string | null;
  additionalNotes: string;
}

export const EMPTY_ANSWERS: OnboardingAnswers = {
  firstName: "", lastName: "", email: "", phone: "",
  companyName: "", tradeType: "", corporationType: "",
  fiscalYearEnd: "", country: "Canada", provinceState: "",
  annualRevenue: "", taxesUpToDate: "", lastBookkeeper: "", accountingSoftware: "",
  employeeCount: "", keepsReceipts: "", bankConnected: "", cardsUsed: "",
  incorporationDate: "", lastTaxReturnYear: "", taxReturnFile: null,
  gstRegistered: "", gstFrequency: "", gstQuarterEndMonths: "",
  payrollProvider: "", payrollProviderOther: "",
  staff: [],
  hasFinancedVehicles: "", leaseFiles: [],
  accounts: [],
  accountAttestation: false, accountAttestationTimestamp: null,
  additionalNotes: "",
};

const PAGES = [
  "You & your business",
  "Money & operations",
  "Incorporation & tax",
  "Payroll & your team",
  "Accounts & assets",
  "Anything else",
];

export function OnboardingForm({
  initial,
  initialPage = 0,
  onSaveProgress,
  onSubmit,
  busy,
}: {
  initial: OnboardingAnswers;
  /** Page the client was last on. Saving a draft is only half of "come back
   *  later" — dropping them back on page 1 to click through six pages of
   *  answers they already gave is its own kind of losing your place. */
  initialPage?: number;
  /** Persist a draft — called on every Next so progress survives a closed tab. */
  onSaveProgress: (answers: OnboardingAnswers, page: number) => Promise<boolean>;
  onSubmit: (answers: OnboardingAnswers) => Promise<void>;
  busy: boolean;
}) {
  const [a, setA] = useState<OnboardingAnswers>(initial);
  const [page, setPage] = useState(() =>
    Math.min(Math.max(Math.trunc(initialPage) || 0, 0), PAGES.length - 1)
  );
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const set = <K extends keyof OnboardingAnswers>(k: K, v: OnboardingAnswers[K]) =>
    setA((prev) => ({ ...prev, [k]: v }));

  const isCanada = a.country !== "USA";
  const lastPage = PAGES.length - 1;

  /** Only the genuinely required fields block progress. */
  function validatePage(p: number): string {
    if (p === 0) {
      if (!a.firstName.trim() || !a.lastName.trim()) return "First and last name are required.";
      if (!a.email.trim()) return "Email address is required.";
      if (!a.companyName.trim()) return "Company / business name is required.";
      if (!a.tradeType) return "Please pick your type of trade or business.";
      if (!a.corporationType) return "Please pick your corporation type.";
      if (!a.country) return "Please pick your country.";
    }
    if (p === 4 && a.accounts.length > 0 && !a.accountAttestation) {
      return "Please check the account attestation box before submitting.";
    }
    return "";
  }

  async function next() {
    const v = validatePage(page);
    if (v) { setError(v); return; }
    setError("");
    const ok = await onSaveProgress(a, page + 1);
    if (ok) {
      setSavedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
      setPage((p) => Math.min(p + 1, lastPage));
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function back() {
    setError("");
    setPage((p) => Math.max(p - 1, 0));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveAndClose() {
    setError("");
    const ok = await onSaveProgress(a, page);
    if (ok) setSavedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  }

  async function submit() {
    // Attestation is the one hard gate — the bank list is the thing that makes
    // or breaks the books, so we make them say it's complete.
    if (a.accounts.length > 0 && !a.accountAttestation) {
      setPage(4);
      setError("Please check the account attestation box before submitting.");
      return;
    }
    const v = validatePage(0);
    if (v) { setPage(0); setError(v); return; }
    setError("");
    await onSubmit(a);
  }

  return (
    <div className="space-y-5">
      {/* Page progress */}
      <div>
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="font-brand text-[11px] uppercase tracking-[0.12em] text-teal-dark">
            Step {page + 1} of {PAGES.length} · {PAGES[page]}
          </div>
          <div className="text-[11px] text-ink-light">
            {savedAt ? (
              <span className="inline-flex items-center gap-1 text-teal-dark">
                <CheckCircle2 size={11} /> Saved {savedAt}
              </span>
            ) : (
              "We save as you go"
            )}
          </div>
        </div>
        <div className="flex gap-1">
          {PAGES.map((_, i) => (
            <div key={i} className={`h-1 flex-1 rounded-full ${i <= page ? "bg-teal" : "bg-hairline"}`} />
          ))}
        </div>
      </div>

      {error && (
        <div className="p-3 bg-rust-tint border border-rust-border rounded-lg text-sm text-rust">{error}</div>
      )}

      {/* ── PAGE 1 — You & your business ─────────────────────────────── */}
      {page === 0 && (
        <div className="space-y-5">
          <Section title="About you">
            <Grid>
              <Field label="First name" required v={a.firstName} on={(v) => set("firstName", v)} placeholder="Mike" />
              <Field label="Last name" required v={a.lastName} on={(v) => set("lastName", v)} placeholder="Gore-Hickman" />
              <Field label="Email address" required type="email" v={a.email} on={(v) => set("email", v)} placeholder="mike@company.com" />
              <Field label="Phone number" type="tel" v={a.phone} on={(v) => set("phone", v)} placeholder="(555) 000-0000" />
            </Grid>
          </Section>
          <Section title="Your business">
            <Grid>
              <Field label="Company / business name" required v={a.companyName} on={(v) => set("companyName", v)} placeholder="ABC Painting Inc." />
              <Select label="Type of trade / business" required v={a.tradeType} on={(v) => set("tradeType", v)} options={TRADES} />
              <Select label="Corporation type" required v={a.corporationType} on={(v) => set("corporationType", v)} options={CORP_TYPES} />
              <Select label="Fiscal year end" v={a.fiscalYearEnd} on={(v) => set("fiscalYearEnd", v)} options={MONTHS} />
              <Select label="Country" required v={a.country} on={(v) => set("country", v)} options={["Canada", "USA"]} />
              <Field label="Province / state" v={a.provinceState} on={(v) => set("provinceState", v)} placeholder="e.g. Ontario, British Columbia, California" />
            </Grid>
          </Section>
        </div>
      )}

      {/* ── PAGE 2 — Money & operations ──────────────────────────────── */}
      {page === 1 && (
        <div className="space-y-5">
          <Section title="Financial details">
            <Grid>
              <Select label="Annual revenue (approx.)" v={a.annualRevenue} on={(v) => set("annualRevenue", v)} options={REVENUE} />
              <Select label="Taxes filed up to date?" v={a.taxesUpToDate} on={(v) => set("taxesUpToDate", v)} options={TAXES_UP_TO_DATE} />
              <Field label="Last bookkeeper / accountant" v={a.lastBookkeeper} on={(v) => set("lastBookkeeper", v)} placeholder="Name or firm, or 'None'" />
              <Select label="Accounting software" v={a.accountingSoftware} on={(v) => set("accountingSoftware", v)} options={SOFTWARE} />
            </Grid>
          </Section>
          <Section title="How you operate">
            <Grid>
              <Select label="Number of employees" v={a.employeeCount} on={(v) => set("employeeCount", v)} options={EMPLOYEES} />
              <Select label="Do you keep receipts?" v={a.keepsReceipts} on={(v) => set("keepsReceipts", v)} options={RECEIPTS} />
              <Select label="Bank account connected to your software?" v={a.bankConnected} on={(v) => set("bankConnected", v)} options={YES_NO_UNSURE} />
              <Field label="Credit / business cards used" v={a.cardsUsed} on={(v) => set("cardsUsed", v)} placeholder="e.g. Visa, Mastercard, or 'None'" />
            </Grid>
          </Section>
        </div>
      )}

      {/* ── PAGE 3 — Incorporation & tax ─────────────────────────────── */}
      {page === 2 && (
        <div className="space-y-5">
          <Section title="Incorporation & tax">
            <Grid>
              <Field label="Date of incorporation" type="date" v={a.incorporationDate} on={(v) => set("incorporationDate", v)} />
              <Select label="Last tax return filed (year)" v={a.lastTaxReturnYear} on={(v) => set("lastTaxReturnYear", v)} options={TAX_YEARS} />
            </Grid>
            <FileField
              label="Upload last tax return"
              hint="PDF, up to 20 MB. Skip it if you don't have it handy — you can send it later in Messages."
              accept="application/pdf"
              file={a.taxReturnFile}
              onFile={(f) => set("taxReturnFile", f)}
              onError={setError}
            />
          </Section>

          {isCanada && (
            <Section title="GST / HST">
              <Grid>
                <Select label="GST/HST registered?" v={a.gstRegistered} on={(v) => set("gstRegistered", v)} options={YES_NO} />
                {a.gstRegistered === "Yes" && (
                  <Select label="Remittance frequency" v={a.gstFrequency} on={(v) => set("gstFrequency", v)} options={GST_FREQUENCY} />
                )}
              </Grid>
              {a.gstRegistered === "Yes" && a.gstFrequency === "Quarterly" && (
                <Field
                  label="Quarter-end months"
                  v={a.gstQuarterEndMonths}
                  on={(v) => set("gstQuarterEndMonths", v)}
                  placeholder="e.g. Mar, Jun, Sep, Dec or Jan, Apr, Jul, Oct"
                />
              )}
            </Section>
          )}
        </div>
      )}

      {/* ── PAGE 4 — Payroll & team ──────────────────────────────────── */}
      {page === 3 && (
        <div className="space-y-5">
          <Section title="Payroll">
            <Grid>
              <Select label="Payroll provider" v={a.payrollProvider} on={(v) => set("payrollProvider", v)} options={PAYROLL_PROVIDERS} />
              {a.payrollProvider === "Other" && (
                <Field label="Which provider?" v={a.payrollProviderOther} on={(v) => set("payrollProviderOther", v)} placeholder="Provider name" />
              )}
            </Grid>
          </Section>

          <Section
            title="Your team"
            hint="Tag each person as Office (a fixed cost) or Field / Painter (a variable cost). It's what makes your gross margin mean something."
          >
            {a.staff.map((row, i) => (
              <RowShell key={i} onRemove={() => set("staff", a.staff.filter((_, j) => j !== i))}>
                <Field
                  label={i === 0 ? "Name" : ""}
                  v={row.name}
                  on={(v) => set("staff", a.staff.map((r, j) => (j === i ? { ...r, name: v } : r)))}
                  placeholder="Jane Smith"
                />
                <Select
                  label={i === 0 ? "Role" : ""}
                  v={row.role}
                  on={(v) => set("staff", a.staff.map((r, j) => (j === i ? { ...r, role: v } : r)))}
                  options={STAFF_ROLES}
                />
              </RowShell>
            ))}
            <AddButton label="Add person" onClick={() => set("staff", [...a.staff, { name: "", role: "" }])} />
          </Section>
        </div>
      )}

      {/* ── PAGE 5 — Accounts & assets ───────────────────────────────── */}
      {page === 4 && (
        <div className="space-y-5">
          <Section title="Financed or leased vehicles & equipment">
            <Select
              label="Do you have any financed or leased vehicles or equipment?"
              v={a.hasFinancedVehicles}
              on={(v) => set("hasFinancedVehicles", v)}
              options={YES_NO}
            />
            {a.hasFinancedVehicles === "Yes" && (
              <MultiFileField
                label="Upload loan / lease paperwork"
                hint="One file per vehicle or item, up to 20 MB each. These tell us what's a loan payment versus an expense — without them the balance sheet is a guess."
                files={a.leaseFiles}
                onFiles={(f) => set("leaseFiles", f)}
                onError={setError}
              />
            )}
          </Section>

          <Section
            title="Bank & account list"
            hint="Every checking, savings, investment, credit card, loan, and line of credit account. A missing account means the books can't be right."
          >
            {a.accounts.map((row, i) => (
              <RowShell key={i} onRemove={() => set("accounts", a.accounts.filter((_, j) => j !== i))}>
                <Field
                  label={i === 0 ? "Institution" : ""}
                  v={row.institution}
                  on={(v) => set("accounts", a.accounts.map((r, j) => (j === i ? { ...r, institution: v } : r)))}
                  placeholder="TD Bank, Chase…"
                />
                <Select
                  label={i === 0 ? "Account type" : ""}
                  v={row.accountType}
                  on={(v) => set("accounts", a.accounts.map((r, j) => (j === i ? { ...r, accountType: v } : r)))}
                  options={ACCOUNT_TYPES}
                />
                <Field
                  label={i === 0 ? "Last 4 digits" : ""}
                  v={row.last4}
                  on={(v) =>
                    set("accounts", a.accounts.map((r, j) => (j === i ? { ...r, last4: v.replace(/\D/g, "").slice(0, 4) } : r)))
                  }
                  placeholder="1234"
                />
              </RowShell>
            ))}
            <AddButton label="Add account" onClick={() => set("accounts", [...a.accounts, { institution: "", accountType: "", last4: "" }])} />

            {a.accounts.length > 0 && (
              <label className="mt-4 flex items-start gap-2.5 rounded-lg border border-cardline bg-white px-3 py-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={a.accountAttestation}
                  onChange={(e) => {
                    set("accountAttestation", e.target.checked);
                    // Stamp the moment they confirm — this is the record we rely on.
                    set("accountAttestationTimestamp", e.target.checked ? new Date().toISOString() : null);
                  }}
                  className="mt-0.5 w-4 h-4 rounded border-cardline text-teal focus:ring-teal flex-shrink-0"
                />
                <span className="text-sm text-ink">
                  <strong className="text-navy">These are ALL of my business bank accounts, credit cards, loans, and credit lines.</strong>{" "}
                  I understand my books will be wrong if any account is missing.
                </span>
              </label>
            )}
          </Section>
        </div>
      )}

      {/* ── PAGE 6 — Anything else ───────────────────────────────────── */}
      {page === 5 && (
        <Section title="Anything else we should know?">
          <label className="block">
            <span className="block text-xs font-semibold text-ink-slate mb-1">Additional notes</span>
            <textarea
              value={a.additionalNotes}
              onChange={(e) => set("additionalNotes", e.target.value)}
              rows={6}
              placeholder="e.g. We have a complicated job costing setup, or we're behind on reconciliations…"
              className="w-full px-3 py-2 rounded-lg border border-cardline text-sm text-navy focus:border-teal outline-none"
            />
          </label>
          <p className="text-xs text-ink-slate mt-3">
            That&apos;s everything. Your bookkeeper reads all of this before your call.
          </p>
        </Section>
      )}

      {/* Nav */}
      <div className="flex items-center justify-between gap-3 pt-1 flex-wrap">
        <div className="flex items-center gap-3">
          {page > 0 && (
            <button type="button" onClick={back} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-slate hover:text-navy">
              <ArrowLeft size={15} /> Back
            </button>
          )}
          <button
            type="button"
            onClick={saveAndClose}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-slate hover:text-navy disabled:opacity-50"
            title="Save your progress — you can close this and come back any time"
          >
            <Save size={14} /> Save &amp; finish later
          </button>
        </div>

        {page < lastPage ? (
          <button
            type="button"
            onClick={next}
            disabled={busy}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-60"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />} Next
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-60"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />} Submit onboarding form
          </button>
        )}
      </div>

      <p className="text-[11px] text-ink-light">
        Your answers are saved each time you hit Next, so you can close this and come back whenever suits —
        nothing is lost.
      </p>
    </div>
  );
}

// ── Field primitives ────────────────────────────────────────────────────────

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-bold text-navy">{title}</h3>
      {hint && <p className="text-xs text-ink-slate mt-0.5 mb-3 max-w-2xl leading-relaxed">{hint}</p>}
      <div className={hint ? "" : "mt-3"}>{children}</div>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid sm:grid-cols-2 gap-3">{children}</div>;
}

function Lbl({ children, required }: { children: React.ReactNode; required?: boolean }) {
  if (!children) return null;
  return (
    <span className="block text-xs font-semibold text-ink-slate mb-1">
      {children} {required && <span className="text-rust">*</span>}
    </span>
  );
}

function Field({
  label, v, on, placeholder, required, type = "text",
}: {
  label: string; v: string; on: (v: string) => void;
  placeholder?: string; required?: boolean; type?: string;
}) {
  return (
    <label className="block">
      <Lbl required={required}>{label}</Lbl>
      <input
        type={type}
        value={v}
        onChange={(e) => on(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg border border-cardline text-sm text-navy focus:border-teal outline-none"
      />
    </label>
  );
}

function Select({
  label, v, on, options, required,
}: {
  label: string; v: string; on: (v: string) => void; options: string[]; required?: boolean;
}) {
  return (
    <label className="block">
      <Lbl required={required}>{label}</Lbl>
      <select
        value={v}
        onChange={(e) => on(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-cardline text-sm text-navy focus:border-teal outline-none bg-white"
      >
        <option value="">Select…</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

function RowShell({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <div className="flex items-end gap-2 mb-2">
      <div className="flex-1 grid sm:grid-cols-3 gap-2">{children}</div>
      <button
        type="button"
        onClick={onRemove}
        className="mb-1 p-2 text-ink-light hover:text-rust flex-shrink-0"
        title="Remove"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-sm font-semibold text-teal-dark border border-teal-border rounded-lg px-3 py-2 hover:bg-teal-lighter"
    >
      <Plus size={14} /> {label}
    </button>
  );
}

// ── Uploads ─────────────────────────────────────────────────────────────────
// Browser → signed URL → Supabase Storage directly, so big PDFs bypass the
// serverless request-body limit (same path the Messages statement upload uses).

function browserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

/** Mirrors CLIENT_UPLOADS_BUCKET in lib/client-comms (kept literal so no
 *  server-side module gets pulled into the client bundle). */
const UPLOADS_BUCKET = "client-uploads";

async function uploadOne(file: File): Promise<UploadedFile> {
  const urlRes = await fetch("/api/portal/messages/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, size: file.size, content_type: file.type }),
  });
  const urlJson = await urlRes.json();
  // The route enforces an extension allowlist + size cap and returns a plain
  // message when it refuses — surface that rather than a generic failure.
  if (!urlRes.ok) throw new Error(urlJson.error || `Couldn't prepare upload for ${file.name}`);
  const { error } = await browserClient()
    .storage.from(UPLOADS_BUCKET)
    .uploadToSignedUrl(urlJson.path, urlJson.token, file);
  if (error) throw new Error(`Upload failed for ${file.name}`);
  return { path: urlJson.path, name: file.name };
}

function FileField({
  label, hint, accept, file, onFile, onError,
}: {
  label: string; hint?: string; accept?: string;
  file: UploadedFile | null; onFile: (f: UploadedFile | null) => void; onError: (m: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  return (
    <div className="mt-3">
      <Lbl>{label}</Lbl>
      {hint && <p className="text-[11px] text-ink-light mb-2 max-w-xl">{hint}</p>}
      {file ? (
        <div className="inline-flex items-center gap-2 rounded-lg border border-teal-border bg-teal-lighter px-3 py-2 text-sm text-teal-dark">
          <FileCheck2 size={15} /> {file.name}
          <button type="button" onClick={() => onFile(null)} className="text-ink-light hover:text-rust ml-1">
            <X size={14} />
          </button>
        </div>
      ) : (
        <label className="inline-flex items-center gap-2 rounded-lg border border-cardline bg-white px-3 py-2 text-sm font-semibold text-ink-slate hover:border-teal hover:text-navy cursor-pointer">
          {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          {uploading ? "Uploading…" : "Choose file"}
          <input
            type="file"
            accept={accept}
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setUploading(true);
              try { onFile(await uploadOne(f)); } catch (err: any) { onError(err?.message || "Upload failed"); }
              finally { setUploading(false); }
            }}
          />
        </label>
      )}
    </div>
  );
}

function MultiFileField({
  label, hint, files, onFiles, onError,
}: {
  label: string; hint?: string; files: UploadedFile[];
  onFiles: (f: UploadedFile[]) => void; onError: (m: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  return (
    <div className="mt-3">
      <Lbl>{label}</Lbl>
      {hint && <p className="text-[11px] text-ink-light mb-2 max-w-xl">{hint}</p>}
      {files.length > 0 && (
        <ul className="mb-2 space-y-1">
          {files.map((f, i) => (
            <li key={i} className="inline-flex items-center gap-2 rounded-lg border border-teal-border bg-teal-lighter px-3 py-1.5 text-sm text-teal-dark mr-2">
              <FileCheck2 size={14} /> {f.name}
              <button type="button" onClick={() => onFiles(files.filter((_, j) => j !== i))} className="text-ink-light hover:text-rust">
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="inline-flex items-center gap-2 rounded-lg border border-cardline bg-white px-3 py-2 text-sm font-semibold text-ink-slate hover:border-teal hover:text-navy cursor-pointer">
        {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
        {uploading ? "Uploading…" : files.length ? "Add another file" : "Choose files"}
        <input
          type="file"
          multiple
          className="hidden"
          onChange={async (e) => {
            const list = Array.from(e.target.files || []);
            if (!list.length) return;
            setUploading(true);
            const done: UploadedFile[] = [];
            try {
              for (const f of list) done.push(await uploadOne(f));
              onFiles([...files, ...done]);
            } catch (err: any) {
              if (done.length) onFiles([...files, ...done]); // keep what did land
              onError(err?.message || "Upload failed");
            } finally {
              setUploading(false);
            }
          }}
        />
      </label>
    </div>
  );
}
