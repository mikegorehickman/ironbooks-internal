import { redirect } from "next/navigation";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import {
  readOnboardingState,
  onboardingComplete,
  onboardingVideoUrl,
  onboardingCallCalendarUrl,
} from "@/lib/portal-onboarding";
import { PortalErrorState } from "../error-state";
import { OnboardingWizard } from "./onboarding-wizard";
// Must come from the plain module, NOT from onboarding-form.tsx — that file is
// "use client", and a server component importing a value out of a client module
// gets a reference proxy with zero keys, so the spread below would silently do
// nothing and the form would receive undefined arrays.
import { EMPTY_ANSWERS, normalizeAnswers } from "@/lib/onboarding-answers";

export const dynamic = "force-dynamic";

/**
 * Portal onboarding wizard — the client's guided first-run: intro video →
 * foundation intake (lives in SNAP now) → send documents. Shown by default to
 * new clients; the persistent banner in the portal layout nags until done.
 */
export default async function PortalOnboardingPage() {
  const ctxRes = await tryResolvePortalContext();
  if (!ctxRes.ok) return <PortalErrorState code={ctxRes.code} message={ctxRes.message} />;
  const { ctx } = ctxRes;

  const service = createServiceSupabase();
  const { data: client } = await (service as any)
    .from("client_links")
    .select(
      "id, client_name, client_email, jurisdiction, country, legal_business_name, trade_type, entity_type, corporate_type, fiscal_year_end, payroll_provider, prior_bookkeeper, accounting_software, employee_count_range, annual_revenue_range, taxes_up_to_date, keeps_receipts, bank_connected_to_software, uses_business_cards, contact_first_name, contact_last_name, client_phone, state_province, portal_onboarding"
    )
    .eq("id", ctx.clientLinkId)
    .single();

  const state = readOnboardingState(client);
  // Already finished → send them to their real dashboard.
  if (onboardingComplete(state)) redirect("/portal");

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <OnboardingWizard
        clientName={client?.client_name || ctx.clientName || "your business"}
        jurisdiction={client?.jurisdiction || "US"}
        videoUrl={onboardingVideoUrl()}
        calendarUrl={onboardingCallCalendarUrl()}
        initialAnswers={normalizeAnswers({
          ...EMPTY_ANSWERS,
          // Pre-fill from the client profile so they aren't retyping what we
          // already know, then let any saved draft win over it.
          firstName: client?.contact_first_name || "",
          lastName: client?.contact_last_name || "",
          email: client?.client_email || ctx.userEmail || "",
          phone: client?.client_phone || "",
          companyName: client?.legal_business_name || client?.client_name || "",
          tradeType: client?.trade_type || "",
          corporationType: client?.corporate_type || "",
          fiscalYearEnd: client?.fiscal_year_end || "",
          country: client?.country || (client?.jurisdiction === "CA" ? "Canada" : "Canada"),
          provinceState: client?.state_province || "",
          annualRevenue: client?.annual_revenue_range || "",
          taxesUpToDate: client?.taxes_up_to_date || "",
          lastBookkeeper: client?.prior_bookkeeper || "",
          accountingSoftware: client?.accounting_software || "",
          employeeCount: client?.employee_count_range || "",
          keepsReceipts: client?.keeps_receipts || "",
          bankConnected: client?.bank_connected_to_software || "",
          cardsUsed: client?.uses_business_cards || "",
          payrollProvider: client?.payroll_provider || "",
          ...(state.form_draft || {}),
        })}
        state={state}
      />
    </div>
  );
}
