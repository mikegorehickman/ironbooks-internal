import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { MonthlyRecClient } from "./monthly-rec-client";

export const dynamic = "force-dynamic";

/**
 * /monthly-rec — the monthly maintenance surface for PRODUCTION clients.
 *
 * Once a client's balance sheet is clean and they've been promoted to
 * production (daily recon enabled from the client profile), their monthly
 * work moves here: run the checks for last month, fix what's flagged via
 * deep links, note concerns, mark the month done. Target: under 5 minutes
 * per client.
 */
export default async function MonthlyRecPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  return (
    <AppShell>
      <TopBar
        title="Monthly Rec"
        subtitle="Production clients · catch up last month in under 5 minutes each"
      />
      <div className="px-8 py-6 max-w-4xl">
        <MonthlyRecClient />
      </div>
    </AppShell>
  );
}
