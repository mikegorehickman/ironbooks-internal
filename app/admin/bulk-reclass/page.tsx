import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BulkReclassClient } from "./bulk-client";

export const dynamic = "force-dynamic";

/**
 * /admin/bulk-reclass — fleet launcher for full-categorization reclass.
 *
 * Kicks off DISCOVERY (read-only + AI categorization) for many clients at
 * once; every job stops at the normal review screen. Execution stays a
 * per-client human decision — this tool deliberately has no bulk-execute.
 */
export default async function BulkReclassPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") redirect("/");

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province")
    .eq("is_active", true)
    .not("qbo_realm_id", "is", null)
    .order("client_name");

  // Latest full-categorization job per client so the launcher shows where
  // each client already stands (active jobs will 409 on start anyway).
  const { data: jobs } = await service
    .from("reclass_jobs")
    .select("id, client_link_id, status, created_at")
    .eq("workflow", "full_categorization")
    .order("created_at", { ascending: false })
    .limit(500);
  const latestByClient = new Map<string, { id: string; status: string; created_at: string }>();
  for (const j of jobs || []) {
    if (!j.client_link_id) continue;
    if (!latestByClient.has(j.client_link_id)) {
      latestByClient.set(j.client_link_id, { id: j.id, status: j.status, created_at: j.created_at as string });
    }
  }

  return (
    <AppShell>
      <TopBar
        title="Bulk Reclass"
        subtitle="Start AI categorization for many clients — every job stops at review; executing stays per-client"
      />
      <div className="px-8 py-6 max-w-5xl">
        <BulkReclassClient
          clients={(clients || []).map((c) => ({
            id: c.id,
            client_name: c.client_name,
            jurisdiction: (c as any).jurisdiction || "US",
            state_province: (c as any).state_province || "",
            latest_job: latestByClient.get(c.id) || null,
          }))}
        />
      </div>
    </AppShell>
  );
}
