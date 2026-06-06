import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BsCleanupPicker } from "./picker-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/cleanup
 *
 * Standalone entry for the guided BS cleanup wizard (pilot). Sidebar tab
 * routes here; bookkeeper picks a client and lands on
 * /balance-sheet/[id]/cleanup. Not yet wired into the 5-step Account Cleanup
 * stepper — intentional so we can test on real clients in production first.
 */
export default async function BsCleanupPickerPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "lead"].includes((profile as any).role)) {
    redirect("/dashboard");
  }

  const { data: clientLinks } = await supabase
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, cleanup_completed_at")
    .eq("is_active", true)
    .order("client_name");

  const service = createServiceSupabase();
  const { data: activeRuns } = await service
    .from("cleanup_runs")
    .select("id, client_link_id, status")
    .in("status", ["discovering", "reviewing", "executing"]);

  return (
    <AppShell>
      <TopBar
        title="BS Cleanup"
        subtitle="Pilot · guided balance sheet reconciliation — pick a client to start or continue"
      />
      <div className="px-8 py-6 max-w-3xl">
        <BsCleanupPicker
          clientLinks={(clientLinks as any[]) || []}
          activeRuns={(activeRuns as any[]) || []}
        />
      </div>
    </AppShell>
  );
}
