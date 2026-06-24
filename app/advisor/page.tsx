import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { fetchAdvisorDashboard } from "@/lib/client-health";
import { AdvisorDashboard } from "./advisor-dashboard";

export const dynamic = "force-dynamic";
// Computing health for ~60 clients with bounded parallelism (10 at a time)
// takes 10-30s on warm tokens, longer on cold refresh. Push the timeout.
export const maxDuration = 120;

/**
 * /advisor — Strategic Advisor Dashboard
 *
 * Triage-style view across the entire client base, scored red/yellow/green
 * by financial health. Designed for limited advisor time: "show me who
 * needs help RIGHT NOW, why, and let me jump straight to their profile."
 *
 * Health scoring lives in lib/client-health.ts. Page is server-rendered
 * so the heavy parallel QBO fetching happens on the edge, not in the
 * browser. Client component just renders the resulting data + handles
 * tier toggles + filter UI.
 */
export async function AdvisorContent({
  searchParams,
}: {
  searchParams?: Promise<{ bookkeeper?: string }>;
}) {
  const sp = (await searchParams) || {};
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (!role || role === "client") redirect("/portal");

  // Pull bookkeeper list for the filter dropdown
  const { data: bookkeepers } = await service
    .from("users")
    .select("id, full_name, role")
    .in("role", ["bookkeeper", "lead", "admin"])
    .order("full_name", { ascending: true });

  // Compute dashboard. Bookkeeper filter via ?bookkeeper=<id>
  const data = await fetchAdvisorDashboard(service as any, {
    assignedBookkeeperId: sp.bookkeeper || null,
  });

  return (
    <AdvisorDashboard
      data={data}
      bookkeepers={
        ((bookkeepers || []) as any[]).map((b) => ({
          id: b.id,
          name: b.full_name || "(unnamed)",
          role: b.role,
        }))
      }
      activeBookkeeperId={sp.bookkeeper || null}
    />
  );
}

/** Standalone /advisor — wraps AdvisorContent in the app shell (V1). */
export default async function AdvisorPage({
  searchParams,
}: {
  searchParams?: Promise<{ bookkeeper?: string }>;
}) {
  return (
    <AppShell>
      <TopBar
        title="Strategic Advisor"
        subtitle="Spot the clients who need support — focus your advisory time where it matters."
      />
      <AdvisorContent searchParams={searchParams} />
    </AppShell>
  );
}
