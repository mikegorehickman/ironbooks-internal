import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { ReapplySkippedClient } from "./reapply-client";

export const dynamic = "force-dynamic";

/**
 * /admin/reapply-skipped — fleet-wide "re-confirm the already-correct skips".
 * Re-pushes every reclassification the discovery step marked
 * "skipped — already in target account" back to QBO, so any that silently
 * never landed finally get categorized. Idempotent + closed-period-safe.
 */
export default async function ReapplySkippedPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") redirect("/");

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("is_active", true)
    .not("qbo_realm_id", "is", null)
    .order("client_name");

  return (
    <AppShell>
      <TopBar
        title="Re-apply Skipped"
        subtitle="Re-push 'already in target account' skips to QuickBooks so any that never landed get categorized"
      />
      <div className="px-8 py-6 max-w-4xl">
        <ReapplySkippedClient
          clients={(clients || []).map((c) => ({ id: c.id, client_name: c.client_name }))}
        />
      </div>
    </AppShell>
  );
}
