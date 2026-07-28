/**
 * Shape of the portal onboarding intake — types, the empty value, and a
 * normalizer.
 *
 * This lives in its own plain module ON PURPOSE. It used to sit in
 * app/portal/onboarding/onboarding-form.tsx, which is `"use client"`, and the
 * server component that builds the initial answers imported EMPTY_ANSWERS from
 * there. A server component importing a value out of a client module doesn't
 * get the value — it gets a client-reference proxy (`typeof` is "function",
 * zero enumerable keys). So `{...EMPTY_ANSWERS, ...}` silently contributed
 * nothing, `staff`/`accounts`/`leaseFiles` reached the form as `undefined`, and
 * page 4 died on `a.staff.map(...)` with a blank "Application error" screen.
 *
 * Keep this file free of "use client" and of any React import so both sides can
 * use the real object.
 */

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Coerce anything draft-shaped into a complete, render-safe answer set.
 *
 * Drafts are stored as free-form jsonb and are read back by a form that maps
 * over the array fields, so a missing or wrong-typed key is a white screen, not
 * a missing input. Every field gets forced to its declared type — belt and
 * braces alongside the client-module fix above, and it also heals the drafts
 * already saved in the broken shape.
 */
export function normalizeAnswers(raw: any): OnboardingAnswers {
  const d = raw && typeof raw === "object" ? raw : {};
  const str = (v: any) => (typeof v === "string" ? v : "");
  const file = (v: any): UploadedFile | null =>
    v && typeof v === "object" && typeof v.path === "string" && typeof v.name === "string"
      ? { path: v.path, name: v.name }
      : null;

  return {
    ...EMPTY_ANSWERS,
    firstName: str(d.firstName), lastName: str(d.lastName), email: str(d.email), phone: str(d.phone),
    companyName: str(d.companyName), tradeType: str(d.tradeType), corporationType: str(d.corporationType),
    // Fiscal year end became a real date picker; older rows hold a month name
    // ("January", "Dec 31"), which an <input type="date"> can't display. Drop
    // those rather than render a permanently-invalid field — the client re-picks
    // it, and the onboarding call catches it if they don't.
    fiscalYearEnd: ISO_DATE.test(str(d.fiscalYearEnd)) ? str(d.fiscalYearEnd) : "",
    country: str(d.country) || EMPTY_ANSWERS.country,
    provinceState: str(d.provinceState),
    annualRevenue: str(d.annualRevenue), taxesUpToDate: str(d.taxesUpToDate),
    lastBookkeeper: str(d.lastBookkeeper), accountingSoftware: str(d.accountingSoftware),
    employeeCount: str(d.employeeCount), keepsReceipts: str(d.keepsReceipts),
    bankConnected: str(d.bankConnected), cardsUsed: str(d.cardsUsed),
    incorporationDate: ISO_DATE.test(str(d.incorporationDate)) ? str(d.incorporationDate) : "",
    lastTaxReturnYear: str(d.lastTaxReturnYear),
    taxReturnFile: file(d.taxReturnFile),
    gstRegistered: str(d.gstRegistered), gstFrequency: str(d.gstFrequency),
    gstQuarterEndMonths: str(d.gstQuarterEndMonths),
    payrollProvider: str(d.payrollProvider), payrollProviderOther: str(d.payrollProviderOther),
    staff: Array.isArray(d.staff)
      ? d.staff.map((r: any) => ({ name: str(r?.name), role: str(r?.role) }))
      : [],
    hasFinancedVehicles: str(d.hasFinancedVehicles),
    leaseFiles: Array.isArray(d.leaseFiles) ? d.leaseFiles.map(file).filter(Boolean) as UploadedFile[] : [],
    accounts: Array.isArray(d.accounts)
      ? d.accounts.map((r: any) => ({
          institution: str(r?.institution), accountType: str(r?.accountType), last4: str(r?.last4),
        }))
      : [],
    accountAttestation: d.accountAttestation === true,
    accountAttestationTimestamp: typeof d.accountAttestationTimestamp === "string" ? d.accountAttestationTimestamp : null,
    additionalNotes: str(d.additionalNotes),
  };
}
