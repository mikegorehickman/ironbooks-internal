import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { currentMonth } from "@/lib/time-tracking";
import { TimeReportClient } from "./time-report-client";

export const dynamic = "force-dynamic";

/**
 * /time-report — where bookkeeper time went.
 *
 * Per client, per month: how long the work actually took versus the client's
 * monthly budget, who spent the time, and the notes explaining any overage
 * (required at completion, so an over-budget client always arrives explained).
 *
 * Admin / lead only — NOT under /admin, because that layout admits only
 * admin + billing_admin and would bounce leads (Lisa needs this page).
 */
export default async function TimeReportPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/today");

  return (
    <AppShell>
      <TopBar
        title="Time tracking"
        subtitle="Tracked time per client vs the monthly budget, overhead, and why anything ran over"
      />
      <div className="px-8 py-6">
        <TimeReportClient initialMonth={currentMonth(Date.now())} />
      </div>
    </AppShell>
  );
}
