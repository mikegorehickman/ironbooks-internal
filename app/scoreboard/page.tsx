import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { currentMonth } from "@/lib/time-tracking";
import { ScoreboardClient } from "./scoreboard-client";

/**
 * /scoreboard — the team's month, shared with everyone doing production.
 *
 * Scored on OUTCOMES, not hours: clients brought in at or under budget, months
 * closed, share of time that went to client work. Hours appear only as the
 * denominator — a board that ranked logged hours would just teach everyone to
 * leave the timer running.
 *
 * Team totals are shared; individual rows come back only for admins/leads (plus
 * your own). admin / lead / bookkeeper.
 */
export const dynamic = "force-dynamic";

export default async function ScoreboardPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role, full_name").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper"].includes(role)) redirect("/dashboard");

  return (
    <AppShell>
      <TopBar
        title="Scoreboard"
        subtitle="How the team's month is going — clients on budget, work closed, and your own progress"
      />
      <div className="px-8 py-6">
        <ScoreboardClient
          initialMonth={currentMonth(Date.now())}
          firstName={((actor as any)?.full_name || "").split(" ")[0] || null}
        />
      </div>
    </AppShell>
  );
}
