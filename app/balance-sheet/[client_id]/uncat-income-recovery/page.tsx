import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { UncatIncomeRecoveryClient } from "./uncat-income-recovery-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/[client_id]/uncat-income-recovery
 *
 * Recovery tool for deposits stuck in Uncategorized Income because the
 * previous bookkeeper didn't know who paid them. Deterministic match
 * against open A/R invoices + optional Claude inference (with safety
 * rails) for descriptions containing customer hints.
 */
export default async function UncatIncomeRecoveryPage({
  params,
}: {
  params: Promise<{ client_id: string }>;
}) {
  const { client_id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, assigned_bookkeeper_id")
    .eq("id", client_id)
    .single();
  if (!client) notFound();

  let latestScan: any = null;
  try {
    const { data, error } = await service
      .from("uncat_income_scans" as any)
      .select("*")
      .eq("client_link_id", client_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error) latestScan = data;
  } catch {}

  return (
    <AppShell>
      <TopBar
        title={`Uncategorized Income Recovery — ${(client as any).client_name}`}
        subtitle="Find deposits stuck in Uncategorized Income · match to open A/R · post one-click clearing JEs"
      />
      <div className="px-8 py-6 max-w-6xl space-y-4">
        <Link
          href={`/balance-sheet/${client_id}/ar-recovery`}
          className="inline-flex items-center gap-1 text-sm text-ink-slate hover:text-navy"
        >
          <ArrowLeft size={14} />
          Back to A/R Recovery
        </Link>
        <UncatIncomeRecoveryClient
          clientLinkId={client_id}
          clientName={(client as any).client_name}
          latestScan={latestScan}
        />
      </div>
    </AppShell>
  );
}
