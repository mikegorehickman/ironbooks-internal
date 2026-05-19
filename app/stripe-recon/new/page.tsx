import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { NewStripeReconForm } from "./form";

export default async function NewStripeReconPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  // Cleanup-completed clients are normally hidden from the picker — they
  // live in the Completed Accounts table on /clients with a Reopen
  // button. BUT for the Stripe-recon flow specifically they remain
  // selectable, because a "secondary" Stripe-API recon is a valid
  // post-completion delta op once a client connects Stripe: the execute
  // step is idempotent (strips prior [Ironbooks] lines and rewrites
  // deterministic ones), so re-running on a completed client doesn't
  // break their close-out. The form annotates completed clients in the
  // dropdown so it's obvious.
  const { data: clientLinks } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, qbo_realm_id, double_client_id, double_client_name, stripe_connection_status, cleanup_completed_at, stripe_has_payouts, stripe_last_payout_at, stripe_payouts_checked_at")
    .eq("is_active", true)
    .order("client_name");

  return (
    <AppShell>
      <TopBar
        title="Stripe AR Reconciliation"
        subtitle="Match Stripe deposits to customer invoices · calculate fees + sales tax"
      />
      <WorkflowStepper currentStep="stripe" currentState="active" completedSteps={["coa", "reclass", "rules"]} />
      <div className="px-8 py-6 max-w-3xl">
        {/* Cast through unknown because cleanup_completed_at lives in
            migration 19 and the regenerated supabase types haven't been
            pulled. Runtime shape is correct. */}
        <NewStripeReconForm clientLinks={(clientLinks as unknown as any[]) || []} />
      </div>
    </AppShell>
  );
}
