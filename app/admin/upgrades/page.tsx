import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { computeUpgradeSignals } from "@/lib/upgrade-signals";
import { UpgradesClient } from "./upgrades-client";

export const dynamic = "force-dynamic";

/**
 * /admin/upgrades — Upgrade Radar.
 *
 * Flags clients who've outgrown their service tier: 3 straight months over the
 * tier's monthly revenue cap ($25K/mo for Insight = a $300K/yr run rate) AND a
 * trailing net margin ≥ 15%. Revenue comes from closed monthly statements
 * (cash-basis), backfilled live from QuickBooks for clients short on closed
 * months. Admin / lead / billing_admin only.
 */
export default async function UpgradesPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "billing_admin"].includes((actor as any)?.role || "")) redirect("/dashboard");

  const report = await computeUpgradeSignals(service as any);

  return <UpgradesClient report={report} />;
}
