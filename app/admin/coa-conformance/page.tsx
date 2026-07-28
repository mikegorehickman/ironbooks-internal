import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { Target } from "lucide-react";
import { ConformanceClient } from "./conformance-client";

export const dynamic = "force-dynamic";

/**
 * /admin/coa-conformance — bring every client's chart onto the current master
 * COA, one client at a time.
 *
 * Step 1 of the two-step programme (step 2 is rebuilding their bank rules
 * against the conformed chart).
 */
export default async function CoaConformancePage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") redirect("/today");

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center gap-2.5 mb-1">
        <Target size={20} className="text-teal" />
        <h1 className="text-xl font-bold text-navy">COA conformance</h1>
      </div>
      <p className="text-sm text-ink-slate mb-6 max-w-3xl">
        Brings a client&apos;s chart onto the current master COA in three passes:{" "}
        <strong>create</strong> every missing master account, <strong>retype</strong> anything in the
        wrong statement section, then <strong>merge</strong> their non-master accounts into the
        master ones. Merges reclassify the <em>real</em> transactions and never post a journal
        entry — anything the API can&apos;t move (income, deposits, paycheques) is left in place and
        listed for a native merge in the QuickBooks UI. One client at a time, preview first.
      </p>
      <ConformanceClient />
    </div>
  );
}
