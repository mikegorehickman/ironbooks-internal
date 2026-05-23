import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase } from "@/lib/supabase";
import { NewReclassForm } from "./form";

export default async function NewReclassPage() {
  const supabase = await createServerSupabase();

  // Completed clients are hidden — they live in /clients Completed Accounts
  // with a Reopen button. In-review clients are still included: a bookkeeper
  // may need to run or re-run a reclassification as part of the cleanup work
  // even while it's awaiting senior approval (e.g. retrying a failed job).
  // Contrast with the COA job page which also excludes in-review clients,
  // since re-running the whole COA cleanup on something mid-review makes no
  // sense. For reclass, restricting to cleanup_completed_at IS NULL is enough.
  const { data: clientLinks } = await supabase
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, qbo_realm_id, double_client_id, double_client_name")
    .eq("is_active", true)
    .is("cleanup_completed_at", null)
    .order("client_name");

  // Fetch py_taxes_* separately so the page survives if migration 32 isn't
  // applied yet. Same fail-soft pattern as the /clients page.
  const pyTaxesByClient = new Map<string, { filed: boolean; year: number | null }>();
  const pyTaxesQuery = await supabase
    .from("client_links")
    .select("id, py_taxes_filed, py_taxes_filed_through_year");
  if (!pyTaxesQuery.error) {
    for (const r of (pyTaxesQuery.data as any[]) || []) {
      if (!r.id) continue;
      pyTaxesByClient.set(r.id, {
        filed: !!r.py_taxes_filed,
        year: r.py_taxes_filed_through_year ?? null,
      });
    }
  } else {
    console.warn(
      "[reclass/new] py_taxes columns unavailable; PY-aware date defaults will be off until migration 32 is applied. Error:",
      pyTaxesQuery.error.message
    );
  }

  // Merge py_taxes onto each client link so the form can default the date
  // range to the unfiled window and warn if the bookkeeper picks a range
  // that crosses a filed-year boundary.
  const enrichedClientLinks = ((clientLinks as any[]) || []).map((c: any) => {
    const pt = pyTaxesByClient.get(c.id);
    return {
      ...c,
      py_taxes_filed: pt?.filed ?? false,
      py_taxes_filed_through_year: pt?.year ?? null,
    };
  });

  return (
    <AppShell>
      <TopBar
        title="New Reclassification Job"
        subtitle="Categorize transactions against the new COA"
      />
      <WorkflowStepper currentStep="reclass" currentState="active" completedSteps={["coa"]} />
      <div className="px-8 py-6 max-w-4xl">
        <NewReclassForm clientLinks={enrichedClientLinks} />
      </div>
    </AppShell>
  );
}
