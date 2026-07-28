import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { Undo2 } from "lucide-react";
import { RevertClient } from "./revert-client";

export const dynamic = "force-dynamic";

/**
 * /admin/coa-fleet-revert — undo the fleet-wide apply-master-coa runs
 * (2026-07-11 + 07-14) client by client.
 *
 * The tool was additive-only and audited, so each client's revert is exact:
 * inactivate the accounts it created — but only the ones still EMPTY.
 * Anything that has since taken postings is surfaced, not touched.
 */
export default async function CoaFleetRevertPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") redirect("/today");

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center gap-2.5 mb-1">
        <Undo2 size={20} className="text-teal" />
        <h1 className="text-xl font-bold text-navy">COA fleet-apply revert</h1>
      </div>
      <p className="text-sm text-ink-slate mb-6 max-w-3xl">
        The fleet-wide master-COA push (Jul 11 + Jul 14) created accounts on every client below.
        The push was additive-only and fully audited, so the revert is precise: per client,
        inactivate the created accounts that are still <strong>empty</strong>. Accounts that have
        taken postings since are listed but never touched — reclass them first. Preview is
        read-only; the revert button asks before writing. One client at a time, on purpose.
      </p>
      <RevertClient />
    </div>
  );
}
