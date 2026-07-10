import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import Link from "next/link";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { CleanupBoard } from "../cleanup/cleanup-board";
import { ProductionBoard } from "../production/production-board";
import { OnboardingBoard } from "../onboarding/onboarding-board";
import { fetchOnboardingBoardData } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * /board — ALL the pipeline kanbans on one screen with a toggle:
 * Onboarding (senior only) → Cleanup → Production. The standalone routes
 * (/onboarding, /cleanup, /production) still work for deep links; the sidebar
 * points here. ?pipeline=… keeps the toggle deep-linkable.
 */
const PIPELINES: { key: string; label: string; senior?: boolean }[] = [
  { key: "onboarding", label: "Onboarding", senior: true },
  { key: "cleanup", label: "Cleanup" },
  { key: "production", label: "Production" },
];

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string }>;
}) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper", "viewer"].includes(role)) redirect("/dashboard");
  const isSenior = ["admin", "lead"].includes(role);

  const sp = await searchParams;
  let pipeline = ["onboarding", "cleanup", "production"].includes(sp.pipeline || "")
    ? (sp.pipeline as string)
    : "cleanup";
  if (pipeline === "onboarding" && !isSenior) pipeline = "cleanup";

  const onboardingData =
    pipeline === "onboarding" ? await fetchOnboardingBoardData(service) : null;

  const subtitle =
    pipeline === "onboarding"
      ? "New sales → onboarding form → onboarding call → client"
      : pipeline === "cleanup"
      ? "New clients · step-by-step to clean books, then on to Production"
      : "Monthly closes · rec → statements → sent";

  return (
    <AppShell>
      <TopBar title="Pipelines" subtitle={subtitle} />
      <div className="px-8 py-6">
        {/* Pipeline toggle */}
        <div className="inline-flex items-center gap-1 mb-5 p-1 rounded-xl bg-gray-100 border border-gray-200">
          {PIPELINES.filter((p) => !p.senior || isSenior).map((p) => (
            <Link
              key={p.key}
              href={`/board?pipeline=${p.key}`}
              className={`px-4 py-1.5 rounded-lg text-sm font-bold transition-colors ${
                pipeline === p.key
                  ? "bg-white text-navy shadow-sm border border-gray-200"
                  : "text-ink-slate hover:text-navy"
              }`}
            >
              {p.label}
            </Link>
          ))}
        </div>

        {pipeline === "onboarding" && onboardingData && (
          <OnboardingBoard leads={onboardingData.leads} bookkeepers={onboardingData.bookkeepers} />
        )}
        {pipeline === "cleanup" && (
          <div className="max-w-7xl">
            <CleanupBoard />
          </div>
        )}
        {pipeline === "production" && <ProductionBoard />}
      </div>
    </AppShell>
  );
}
