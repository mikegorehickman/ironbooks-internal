import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import { AccountReconForm } from "./form-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/[client_id]/[account_id]
 *
 * Per-account reconciliation entry form. The bookkeeper enters the
 * statement ending balance + date, we save a bank_recon_jobs row,
 * and (next iteration) run the gap-analysis stage.
 *
 * For now this is the data-capture step — the actual diff/recon
 * surface comes in a follow-up commit. Capturing the inputs first
 * means we have a record and can backfill the analysis later.
 */
export default async function AccountReconPage({
  params,
}: {
  params: Promise<{ client_id: string; account_id: string }>;
}) {
  const { client_id, account_id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", client_id)
    .single();
  if (!client) notFound();

  return (
    <AppShell>
      <TopBar
        title={`Reconcile account — ${(client as any).client_name}`}
        subtitle="Enter the statement ending balance + as-of date · we'll find the gap"
      />
      <div className="px-8 py-6 max-w-2xl">
        <AccountReconForm
          clientLinkId={(client as any).id}
          clientName={(client as any).client_name}
          accountId={account_id}
        />
      </div>
    </AppShell>
  );
}
