import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { TaxExportClient } from "./tax-export-client";

export const dynamic = "force-dynamic";

/** Year-end tax export for one client: GIFI (T2 — imports into ProFile /
 *  TaxPrep / CanTax / TaxCycle), T2125 sheet (T1), T5018 vendor totals. */
export default async function TaxExportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province")
    .eq("id", id)
    .single();
  if (!client) redirect("/clients");
  return (
    <AppShell>
      <TopBar
        title={`Year-end tax export — ${client.client_name}`}
        subtitle="GIFI for T2 · T2125 sheet for T1 · T5018 subcontractor totals · review material, not a filing"
      />
      <div className="px-8 py-6 max-w-5xl space-y-5">
        <TaxExportClient
          clientLinkId={client.id}
          clientName={client.client_name}
          jurisdiction={client.jurisdiction || "CA"}
        />
      </div>
    </AppShell>
  );
}
