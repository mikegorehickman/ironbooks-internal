import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { CopyX } from "lucide-react";
import { DuplicatesFleetClient } from "./duplicates-client";

export const dynamic = "force-dynamic";

/**
 * /admin/duplicates — fleet-wide expense-duplicate report (Mike 2026-07-17).
 *
 * The sweep engine existed but findings only surfaced per-client; this is the
 * walk-through view: every client with OPEN duplicate findings, ranked by
 * dollar exposure, expanding to the same DuplicatesPanel used on the reclass
 * flow (one-click guarded remove / keep). Includes the new rules: big or
 * same-bank-originator near-dups are HIGH, and refund/credit reversal pairs
 * are surfaced separately (informational, never removable).
 */
export default async function DuplicatesFleetPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/today");

  const { data: findings } = await (service as any)
    .from("dup_findings")
    .select("client_link_id, tier, amount, fingerprint, dates")
    .eq("status", "open")
    .limit(5000);

  // Aggregate per client. kind rides in the fingerprint prefix ("kind:ids").
  const byClient = new Map<
    string,
    { certain: number; likely: number; possible: number; reversals: number; exposure: number; newest: string }
  >();
  for (const f of (findings as any[]) || []) {
    const g =
      byClient.get(f.client_link_id) ||
      { certain: 0, likely: 0, possible: 0, reversals: 0, exposure: 0, newest: "" };
    const kind = String(f.fingerprint || "").split(":")[0];
    if (kind === "reversal_pair") g.reversals++;
    else if (f.tier === "certain") g.certain++;
    else if (f.tier === "likely") g.likely++;
    else g.possible++;
    if (kind !== "reversal_pair" && (f.tier === "certain" || f.tier === "likely")) {
      g.exposure += Math.abs(Number(f.amount) || 0);
    }
    const d = Array.isArray(f.dates) && f.dates.length ? String(f.dates[f.dates.length - 1]) : "";
    if (d > g.newest) g.newest = d;
    byClient.set(f.client_link_id, g);
  }

  const ids = [...byClient.keys()];
  let names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: clients } = await (service as any)
      .from("client_links")
      .select("id, client_name")
      .in("id", ids);
    names = new Map(((clients as any[]) || []).map((c) => [c.id, c.client_name]));
  }

  const rows = ids
    .map((id) => ({
      client_link_id: id,
      client_name: names.get(id) || "(unknown client)",
      ...byClient.get(id)!,
      exposure: Math.round(byClient.get(id)!.exposure * 100) / 100,
    }))
    .sort((a, b) => b.exposure - a.exposure || b.certain + b.likely - (a.certain + a.likely));

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center gap-2.5 mb-1">
        <CopyX size={20} className="text-teal" />
        <h1 className="text-xl font-bold text-navy">Duplicates — fleet</h1>
      </div>
      <p className="text-sm text-ink-slate mb-6 max-w-3xl">
        Every client with open duplicate findings, ranked by dollar exposure (certain + likely,
        excluding refund pairs). Run the sweep to rescan the whole fleet — YTD window, all active
        clients including mid-cleanup. Expand a client to review and one-click remove (guarded:
        snapshot first, closed periods skipped) or keep. Refund/credit <em>reversal pairs</em> are
        informational — verify, never remove.
      </p>
      <DuplicatesFleetClient rows={rows} />
    </div>
  );
}
