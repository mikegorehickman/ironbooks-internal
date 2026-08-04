import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BookHealthClient } from "./book-health-client";

/**
 * /admin/book-health — which clients' books can we actually stand behind?
 *
 * Every accuracy defect we know how to detect, rolled up per client. The data
 * already existed; it was scattered across dup_findings, coa_audit_scans,
 * ucpi_resolutions, uf_audit_scans, hardcore_cleanup_runs and audit_log jsonb,
 * with several scanners keeping nothing at all. This is the one place that
 * answers "is this client clean", and the number at the top — clean / total —
 * is the one to watch week over week.
 *
 * Read the "never swept" column as carefully as the defect columns: a client
 * with no defects for a type nobody has ever run is not clean, it's unknown.
 */
export const dynamic = "force-dynamic";

export default async function BookHealthPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/today");

  return (
    <AppShell>
      <TopBar
        title="Book health"
        subtitle="Known accuracy defects, per client — the ledger behind “can we stand behind these books?”"
      />
      <div className="px-8 py-6 max-w-7xl">
        <BookHealthClient />
      </div>
    </AppShell>
  );
}
