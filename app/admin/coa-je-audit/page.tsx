import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { CoaJeAuditClient } from "./audit-client";

export const dynamic = "force-dynamic";

/**
 * /admin/coa-je-audit — read-only inventory of the COA-merge lump JEs that
 * collapsed GL detail. Step 1 of the remediation (see memory
 * ironbooks-coa-merge-je-remediation). Reversal is a separate, later step.
 */
export default async function CoaJeAuditPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/home");

  return (
    <AppShell>
      <TopBar
        title="COA merge — JE audit"
        subtitle="Read-only: find the lump journal entries that collapsed GL detail during COA merges"
      />
      <div className="px-8 py-6 max-w-5xl mx-auto">
        <CoaJeAuditClient />
      </div>
    </AppShell>
  );
}
