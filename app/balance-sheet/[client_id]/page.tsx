import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import { BalanceSheetLanding } from "./landing-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/[client_id]
 *
 * Step 5 of the cleanup workflow — Balance Sheet. Lists the client's
 * bank / credit-card / loan accounts (with last-4 digits where
 * present) and a "Match Undeposited Funds to A/R" entry point.
 *
 * Accounts are fetched live from QBO via /api/clients/[id]/bs-accounts;
 * this page just renders the chrome and hands clientLink to the
 * client component for the data-fetching dance.
 */
export default async function BalanceSheetLandingPage({
  params,
}: {
  params: Promise<{ client_id: string }>;
}) {
  const { client_id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province")
    .eq("id", client_id)
    .single();
  if (!client) notFound();

  return (
    <AppShell>
      <TopBar
        title={`Balance Sheet — ${(client as any).client_name}`}
        subtitle="Step 5 · Reconcile bank, credit card, loan accounts · match Undeposited Funds to A/R"
      />
      <WorkflowStepper
        currentStep="bs"
        currentState="active"
        completedSteps={["coa", "reclass", "rules", "stripe"]}
        clientLinkId={(client as any).id}
      />
      <div className="px-8 py-6 max-w-5xl">
        <BalanceSheetLanding
          clientLinkId={(client as any).id}
          clientName={(client as any).client_name}
        />
      </div>
    </AppShell>
  );
}
