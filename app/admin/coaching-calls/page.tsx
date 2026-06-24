import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { CoachingCallsSettings } from "./settings-client";

export const dynamic = "force-dynamic";

export default async function CoachingCallsAdminPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: profile } = await service.from("users").select("role").eq("id", user.id).single();
  if (!profile || !["admin", "lead"].includes((profile as any).role)) {
    return (
      <AppShell>
        <TopBar title="Coaching calls" />
        <div className="px-8 py-6 text-sm text-ink-slate">Admin/lead only.</div>
      </AppShell>
    );
  }

  let coaches: any[] = [];
  try {
    const { data } = await service
      .from("coaching_call_settings")
      .select("*")
      .order("sort_order");
    coaches = (data as any[]) || [];
  } catch {
    coaches = [];
  }

  const priceUsd = !!process.env.STRIPE_COACHING_PRICE_USD;
  const priceCad = !!process.env.STRIPE_COACHING_PRICE_CAD;

  return (
    <AppShell>
      <TopBar title="Coaching calls" subtitle="$150 / 30-min paid call — calendar & billing settings" />
      <div className="px-8 py-6 max-w-3xl">
        {coaches.length === 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Run migration 95 (<code>coaching_call_settings</code>) to set up coaches.
          </div>
        ) : (
          <CoachingCallsSettings
            coaches={coaches.map((c) => ({
              coach_key: c.coach_key,
              coach_name: c.coach_name,
              ghl_embed_url: c.ghl_embed_url || "",
              ghl_calendar_id: c.ghl_calendar_id || "",
              active: c.active !== false,
            }))}
            priceUsdConfigured={priceUsd}
            priceCadConfigured={priceCad}
          />
        )}
      </div>
    </AppShell>
  );
}
