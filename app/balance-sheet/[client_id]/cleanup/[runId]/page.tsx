import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { CleanupPilotBanner } from "@/components/CleanupPilotBanner";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import { CleanupWizardClient } from "./cleanup-wizard-client";

export const dynamic = "force-dynamic";

export default async function CleanupWizardPage({
  params,
}: {
  params: Promise<{ client_id: string; runId: string }>;
}) {
  const { client_id, runId } = await params;
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

  const { data: run } = await service
    .from("cleanup_runs")
    .select("id, status, workflow_mode")
    .eq("id", runId)
    .eq("client_link_id", client_id)
    .single();
  if (!run) notFound();

  return (
    <AppShell>
      <TopBar
        title={`BS Cleanup — ${(client as any).client_name}`}
        subtitle={`Pilot · ${(run as any).workflow_mode === "monthly_close" ? "Monthly close" : "Onboarding"} · run ${runId.slice(0, 8)}…`}
      />
      <CleanupPilotBanner />
      <div className="px-8 py-6 max-w-6xl">
        <CleanupWizardClient clientLinkId={client_id} runId={runId} />
      </div>
    </AppShell>
  );
}
