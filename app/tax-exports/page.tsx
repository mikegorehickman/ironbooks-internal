import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Landmark } from "lucide-react";
import { GifiMappingEditor } from "./gifi-mapping-editor";

export const dynamic = "force-dynamic";

/** Tax Exports hub (Tools) — the seasonal batch surface: every client with a
 *  link into their year-end export, plus the master-COA → GIFI mapping editor. */
export default async function TaxExportsPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/today");

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, cleanup_completed_at, daily_recon_enabled")
    .eq("is_active", true)
    .order("client_name");
  const ready = ((clients as any[]) || []).filter(
    (c) => (c.cleanup_completed_at || c.daily_recon_enabled) && !/\btest\b/i.test(c.client_name || "")
  );

  return (
    <AppShell>
      <TopBar
        title="Tax Exports"
        subtitle="GIFI (T2) · T2125 (T1) · T5018 — one export per client, imports into ProFile / TaxPrep / CanTax / TaxCycle"
      />
      <div className="px-8 py-6 max-w-5xl space-y-6">
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
            <Landmark size={15} className="text-teal" />
            <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Clients ({ready.length})</h2>
            <span className="text-[11px] text-ink-light">cleaned-up books only — the export reads the closed year</span>
          </div>
          <ul className="divide-y divide-gray-50">
            {ready.map((c) => (
              <li key={c.id}>
                <Link href={`/clients/${c.id}/tax-export`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-gray-50">
                  <span className="flex-1 text-sm font-semibold text-navy">{c.client_name}</span>
                  <span className="text-xs text-ink-light">{c.jurisdiction}{c.state_province ? ` · ${c.state_province}` : ""}</span>
                  <ArrowRight size={14} className="text-ink-light" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <GifiMappingEditor />
      </div>
    </AppShell>
  );
}
