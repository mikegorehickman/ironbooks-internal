import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { findDesyncedClientLogins } from "@/lib/client-email";
import { redirect } from "next/navigation";
import { ResyncLoginsClient } from "./resync-client";

export const dynamic = "force-dynamic";

/**
 * /admin/resync-logins — one-click repair for clients whose portal LOGIN email
 * drifted from their contact email (email edits made before the profile path
 * repointed logins). Preview, then repoint all via the Supabase Admin API.
 */
export default async function ResyncLoginsPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/dashboard");

  const desynced = await findDesyncedClientLogins(service);

  return (
    <AppShell>
      <TopBar title="Re-sync portal logins" subtitle="Repoint client login emails to match their contact email" />
      <div className="px-8 py-6 max-w-3xl">
        <ResyncLoginsClient initial={desynced} />
      </div>
    </AppShell>
  );
}
