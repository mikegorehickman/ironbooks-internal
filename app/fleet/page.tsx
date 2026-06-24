import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { buildFleetSnapshot, type Severity } from "@/lib/fleet-health";
import { FleetDashboardClient } from "./fleet-client";

export const dynamic = "force-dynamic";

/**
 * Fleet Health Dashboard — Week 1: read-only.
 *
 * One screen, every broken / stuck / drifting client across the fleet.
 * Lisa opens this at 9 AM, triages in <10 min, routes work. Without it
 * the silent-failure rate at 1,000 clients would be unmanageable.
 *
 * Access: admin + lead see everything. Bookkeepers see only their
 * portfolio (server enforces this in /api/fleet/health).
 */
export async function FleetContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("id, role, full_name")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  const isSenior = ["admin", "lead"].includes(role);

  // Bookkeepers list — used by the filter dropdown on the page.
  // Bookkeepers (non-senior) only see their own option so we suppress
  // the dropdown for them entirely.
  const { data: bookkeepers } = await service
    .from("users")
    .select("id, full_name")
    .eq("is_active", true)
    .in("role", ["bookkeeper", "lead", "admin"])
    .order("full_name");

  // Parse filters from URL — kept in sync with the API.
  const params = await searchParams;
  const bookkeeperIdParam = params.bookkeeper_id || null;
  const severityRaw = (params.severity || "").toLowerCase();
  const severity: Severity | null =
    severityRaw === "failing" || severityRaw === "warning" || severityRaw === "healthy"
      ? (severityRaw as Severity)
      : null;
  const search = params.search || null;

  // Non-senior callers locked to own portfolio regardless of URL.
  const bookkeeperId = isSenior ? bookkeeperIdParam : user.id;

  const snapshot = await buildFleetSnapshot(service as any, {
    bookkeeperId,
    severity,
    search,
  });

  return (
    <div className="px-6 py-5 max-w-[1400px] mx-auto">
      <FleetDashboardClient
        snapshot={snapshot}
        bookkeepers={(bookkeepers as any) || []}
        currentUserId={user.id}
        isSenior={isSenior}
        activeFilters={{
          bookkeeperId,
          severity,
          search,
        }}
      />
    </div>
  );
}

/** Standalone /fleet — wraps FleetContent in the app shell (V1). */
export default async function FleetHealthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  return (
    <AppShell>
      <TopBar
        title="Fleet Health"
        subtitle="Every client with issues — sorted by severity (critical, warning, healthy)"
      />
      <FleetContent searchParams={searchParams} />
    </AppShell>
  );
}
