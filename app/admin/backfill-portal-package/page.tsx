import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BackfillPortalClient } from "./backfill-portal-client";

export const dynamic = "force-dynamic";

/**
 * /admin/backfill-portal-package
 *
 * Publish the full month-end package (P&L + BS if available) to the portal and
 * send the "your statements are ready" email for months that were closed but
 * only delivered as a plain summary email (P&L-only clients + package
 * fallbacks). Preview-first: the list loads read-only; nothing is published or
 * emailed until you click.
 */
export default async function BackfillPortalPackagePage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/dashboard");

  return (
    <AppShell>
      <TopBar title="Backfill portal packages" subtitle="Publish P&L (+BS) to the portal + email clients whose close only went out as a plain email" />
      <div className="px-8 py-6 max-w-3xl">
        <BackfillPortalClient />
      </div>
    </AppShell>
  );
}
