import { AppShell } from "@/components/AppShell";
import { HubTabs } from "@/components/HubTabs";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import ApprovalsPage from "@/app/approvals/page";
import AdvisorPage from "@/app/advisor/page";
import FleetHealthPage from "@/app/fleet/page";

export const dynamic = "force-dynamic";
// Advisor computes health for ~60 clients (10-30s+); Oversight can render it as
// a tab, so inherit the longer budget.
export const maxDuration = 120;

/**
 * /oversight — the single senior landing. Merges the reviewer surfaces —
 * Approvals (the senior queue), Advisor (health triage) and Fleet Health —
 * into one hub with a tab strip. Senior-only; each tab server-renders the
 * existing surface inside the shared shell (nesting-aware AppShell renders the
 * inner page bare). Only the active tab renders.
 */
const TABS = [
  { key: "approvals", label: "Approvals" },
  { key: "advisor", label: "Advisor" },
  { key: "fleet", label: "Fleet Health" },
];

export default async function OversightPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; viewas?: string; bookkeeper?: string }>;
}) {
  const sp = await searchParams;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  if (!isSenior) redirect("/home");

  const active = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "approvals";

  return (
    <AppShell>
      <HubTabs basePath="/oversight" tabs={TABS} active={active} />
      {active === "approvals" && (
        <ApprovalsPage searchParams={Promise.resolve({ viewas: sp.viewas })} />
      )}
      {active === "advisor" && (
        <AdvisorPage searchParams={Promise.resolve({ bookkeeper: sp.bookkeeper })} />
      )}
      {active === "fleet" && <FleetHealthPage searchParams={Promise.resolve(sp as any)} />}
    </AppShell>
  );
}
