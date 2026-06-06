import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { CleanupPilotBanner } from "@/components/CleanupPilotBanner";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import { CleanupStartClient } from "./cleanup-start-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/[client_id]/cleanup
 * Entry point for the guided BS cleanup wizard.
 * Redirects to active run if one exists.
 */
export default async function CleanupEntryPage({
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
    .select("id, client_name, jurisdiction, state_province, cleanup_completed_at")
    .eq("id", client_id)
    .single();
  if (!client) notFound();

  const { data: activeRun } = await service
    .from("cleanup_runs")
    .select("id, status")
    .eq("client_link_id", client_id)
    .in("status", ["discovering", "reviewing", "executing"])
    .limit(1)
    .maybeSingle();

  if (activeRun) {
    redirect(`/balance-sheet/${client_id}/cleanup/${(activeRun as any).id}`);
  }

  return (
    <AppShell>
      <TopBar
        title={`BS Cleanup — ${(client as any).client_name}`}
        subtitle="Pilot · guided balance sheet reconciliation"
      />
      <CleanupPilotBanner />
      <div className="px-8 py-6 max-w-3xl">
        <CleanupStartClient
          clientLinkId={(client as any).id}
          clientName={(client as any).client_name}
        />
      </div>
    </AppShell>
  );
}
