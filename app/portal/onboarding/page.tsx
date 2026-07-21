import { redirect } from "next/navigation";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { readOnboardingState, onboardingComplete, onboardingVideoUrl } from "@/lib/portal-onboarding";
import { PortalErrorState } from "../error-state";
import { OnboardingWizard } from "./onboarding-wizard";

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
      "id, client_name, jurisdiction, legal_business_name, trade_type, entity_type, corporate_type, fiscal_year_end, payroll_provider, prior_bookkeeper, accounting_software, employee_count_range, contact_first_name, contact_last_name, client_phone, state_province, portal_onboarding"
    )
    .eq("id", ctx.clientLinkId)
    .single();

  const state = readOnboardingState(client);
  // Already finished → send them to their real dashboard.
  if (onboardingComplete(state)) redirect("/portal");

  // Documents we've asked for (open statement requests) — shown in the docs step.
  let docRequests: Array<{ label: string }> = [];
  try {
    const { data } = await (service as any)
      .from("statement_requests")
      .select("label, status")
      .eq("client_link_id", ctx.clientLinkId)
      .eq("status", "open");
    docRequests = ((data as any[]) || []).map((r) => ({ label: r.label }));
  } catch { /* pre-migration env */ }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <OnboardingWizard
        clientName={client?.client_name || ctx.clientName || "your business"}
        jurisdiction={client?.jurisdiction || "US"}
        videoUrl={onboardingVideoUrl()}
        initial={{
          legal_business_name: client?.legal_business_name || "",
          trade_type: client?.trade_type || "",
          entity_type: client?.entity_type || "",
          fiscal_year_end: client?.fiscal_year_end || "",
          payroll_provider: client?.payroll_provider || "",
          prior_bookkeeper: client?.prior_bookkeeper || "",
          accounting_software: client?.accounting_software || "",
          employee_count_range: client?.employee_count_range || "",
          contact_first_name: client?.contact_first_name || "",
          contact_last_name: client?.contact_last_name || "",
          client_phone: client?.client_phone || "",
          state_province: client?.state_province || "",
        }}
        state={state}
        docRequests={docRequests}
      />
    </div>
  );
}
