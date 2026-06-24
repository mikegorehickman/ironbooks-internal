import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { HeartPulse, Gauge, Flag, BarChart3 } from "lucide-react";
import { AdvisorContent } from "../advisor/page";
import { FleetContent } from "../fleet/page";
import { QboHealthContent } from "../fleet/qbo-health/page";
import { FlaggedContent } from "../flagged/page";

export const dynamic = "force-dynamic";

/**
 * /oversight (SNAP V2, senior only) — one place to answer "who needs
 * attention?" Merges the formerly separate senior dashboards into tabs:
 *   Needs attention  → the Strategic Advisor health triage
 *   Fleet & QBO      → Fleet Health + QBO connection health, stacked
 *   Flagged          → the senior review queue
 * Metrics links out to the standalone /dashboard. Each tab reuses the
 * extracted content component; only the active tab fetches.
 */
const TABS = [
  { id: "attention", label: "Needs attention", icon: HeartPulse },
  { id: "fleet", label: "Fleet & QBO", icon: Gauge },
  { id: "flagged", label: "Flagged", icon: Flag },
] as const;

export default async function OversightPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; bookkeeper?: string }>;
}) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead"].includes(role)) redirect("/home");

  const sp = await searchParams;
  const tab = (["attention", "fleet", "flagged"].includes(sp.tab || "")
    ? sp.tab
    : "attention") as "attention" | "fleet" | "flagged";

  return (
    <AppShell>
      <TopBar title="Oversight" subtitle="Who needs attention — health, fleet, and the flagged queue" />
      <div className="px-8 pt-5">
        <div className="inline-flex items-center gap-1 rounded-xl bg-gray-100 p-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <Link
                key={t.id}
                href={`/oversight?tab=${t.id}`}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                  active ? "bg-white text-navy shadow-sm" : "text-ink-slate hover:text-navy"
                }`}
              >
                <Icon size={15} />
                {t.label}
              </Link>
            );
          })}
          <Link
            href="/dashboard"
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-ink-slate hover:text-navy"
          >
            <BarChart3 size={15} />
            Metrics →
          </Link>
        </div>
      </div>

      {tab === "attention" && (
        <AdvisorContent searchParams={Promise.resolve({ bookkeeper: sp.bookkeeper })} />
      )}
      {tab === "fleet" && (
        <>
          <FleetContent searchParams={Promise.resolve({})} />
          <QboHealthContent />
        </>
      )}
      {tab === "flagged" && <FlaggedContent />}
    </AppShell>
  );
}
