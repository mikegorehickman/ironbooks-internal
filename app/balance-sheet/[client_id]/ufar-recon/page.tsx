import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { UfArReconClient } from "./ufar-client";

export const dynamic = "force-dynamic";

/** UF/AR Reconciler — the one-button replacement for the manual
 *  export-4-CSVs-into-Claude-chat workflow. */
export default async function UfArReconPage({
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
    .select("id, client_name")
    .eq("id", client_id)
    .single();
  if (!client) redirect("/clients");

  return (
    <AppShell>
      <TopBar
        title={`UF / A/R Reconciler — ${client.client_name}`}
        subtitle="Match deposits to revenue · true A/R · step-by-step clearing plan"
      />
      <div className="px-8 py-6 max-w-5xl space-y-5">
        <UfArReconClient clientLinkId={client.id} clientName={client.client_name} />
      </div>
    </AppShell>
  );
}
