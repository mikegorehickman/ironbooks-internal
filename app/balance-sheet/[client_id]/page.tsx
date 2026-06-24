import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import { BalanceSheetStage } from "./stage-client";

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
  // select("*") so we never 400 on a column that lags a migration (the new
  // pl_attested_at / bs_statements_requested_at land in migration 94).
  const { data: client } = await service
    .from("client_links")
    .select("*")
    .eq("id", client_id)
    .single();
  if (!client) notFound();
  const c = client as any;

  return (
    <AppShell>
      <TopBar
        title={`Balance Sheet — ${c.client_name}`}
        subtitle="Step 5 · See statements → request → review & attest P&L → submit for review"
      />
      <WorkflowStepper
        currentStep="bs"
        currentState="active"
        completedSteps={["coa", "reclass", "rules", "stripe"]}
        clientLinkId={c.id}
      />
      <div className="px-8 py-6 max-w-5xl">
        <BalanceSheetStage
          clientLinkId={c.id}
          clientName={c.client_name}
          plAttestedAt={c.pl_attested_at ?? null}
          statementsRequestedAt={c.bs_statements_requested_at ?? null}
          defaultRangeStart={c.cleanup_range_start ?? null}
          defaultRangeEnd={c.cleanup_range_end ?? null}
        />
      </div>
    </AppShell>
  );
}
