import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { ApplyMasterCoaClient } from "./apply-client";

export const dynamic = "force-dynamic";

/**
 * /admin/apply-master-coa — fleet-wide "apply standard COA".
 * Additive only: creates missing master accounts (correct types, parents
 * included) in each client's QBO. Renames/merges/deletes stay in the
 * reviewed per-client COA cleanup.
 */
export default async function ApplyMasterCoaPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") redirect("/");

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, industry")
    .eq("is_active", true)
    .not("qbo_realm_id", "is", null)
    .order("client_name");

  return (
    <AppShell>
      <TopBar
        title="Apply Standard COA"
        subtitle="Create missing master accounts in every client's QuickBooks — additive only"
      />
      <div className="px-8 py-6 max-w-4xl">
        <ApplyMasterCoaClient
          clients={(clients || []).map((c) => ({
            id: c.id,
            client_name: c.client_name,
            jurisdiction: (c as any).jurisdiction || "US",
          }))}
        />
      </div>
    </AppShell>
  );
}
