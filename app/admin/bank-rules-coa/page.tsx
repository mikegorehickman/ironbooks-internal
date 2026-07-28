import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { ListChecks } from "lucide-react";
import { RulesCoaClient } from "./rules-coa-client";

export const dynamic = "force-dynamic";

/**
 * /admin/bank-rules-coa — fleet conformance of bank-rule categories against
 * the (new) master COA, for CA and US clients alike.
 *
 * Rules store their category by NAME because QBO's import wizard matches on
 * name. After the master-COA refresh, rules that named an old account export
 * as a BLANK category — silently. This page finds them and retargets them.
 */
export default async function BankRulesCoaPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/today");

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center gap-2.5 mb-1">
        <ListChecks size={20} className="text-teal" />
        <h1 className="text-xl font-bold text-navy">Bank rules vs master COA</h1>
      </div>
      <p className="text-sm text-ink-slate mb-6 max-w-3xl">
        Bank rules carry their category as a <strong>name</strong> (QBO&apos;s import wizard matches on
        name, not id), so a rule written against the old chart now names an account that no longer
        exists — and exports as a <strong>blank category</strong> with no warning. This checks every
        client&apos;s rules against their own jurisdiction&apos;s master COA (CA and US charts differ)
        plus their live QuickBooks chart, then lets you retarget the broken ones. Retargeting only
        writes to SNAP — the next rules export carries the corrected names into QBO.
      </p>
      <RulesCoaClient />
    </div>
  );
}
