import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { PayrollDoubleScanClient } from "./scan-client";

export const dynamic = "force-dynamic";

/**
 * /admin/payroll-double-scan — fleet-wide READ-ONLY scan for the cross-account
 * payroll double-count (BMD/Taro pattern: gross paycheques on one account,
 * net-pay bank deposits expensed to a second labor account). Triage only —
 * no writes. The remediation (reclass net-pay lines to payroll clearing)
 * lands in a separate reviewed flow.
 */
export default async function PayrollDoubleScanPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/");

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction")
    .eq("is_active", true)
    .not("qbo_realm_id", "is", null)
    .order("client_name");

  return (
    <AppShell>
      <TopBar
        title="Payroll Double-Count Scan"
        subtitle="Find clients booking the same crew's pay to two labor lines — read-only triage"
      />
      <div className="px-8 py-6 max-w-5xl">
        <PayrollDoubleScanClient
          clients={(clients || []).map((c) => ({ id: c.id, client_name: c.client_name, jurisdiction: (c as any).jurisdiction || "US" }))}
        />
      </div>
    </AppShell>
  );
}
