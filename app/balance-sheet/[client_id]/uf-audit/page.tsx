import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { UfAuditClient } from "./uf-audit-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/[client_id]/uf-audit
 *
 * Targeted detector for orphan Undeposited Funds payments — Receive-Payment
 * entries that posted to UF but never had a corresponding deposit.
 *
 * Distinct from the AI BS Cleanup: this is deterministic (uses QBO's
 * LinkedTxn data) and resolution-focused. The bookkeeper groups orphans
 * by customer, picks a resolution (Owner Draw / Write-off / etc), and
 * finalizes — one balanced JE per group lands in QBO.
 */
export default async function UfAuditPage({
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
    .select("id, client_name, jurisdiction, state_province, assigned_bookkeeper_id")
    .eq("id", client_id)
    .single();
  if (!client) notFound();

  // Fail-soft on migration 34 not applied — page still loads, just no run.
  let latestScan: any = null;
  try {
    const { data, error } = await service
      .from("uf_audit_scans" as any)
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
        title={`UF Audit — ${(client as any).client_name}`}
        subtitle="Find orphan Undeposited Funds payments · group by customer · post balanced clearing JEs to QBO"
      />
      <div className="px-8 py-6 max-w-6xl space-y-4">
        <Link
          href={`/balance-sheet/${client_id}/coa`}
          className="inline-flex items-center gap-1 text-sm text-ink-slate hover:text-navy"
        >
          <ArrowLeft size={14} />
          Back to BS COA viewer
        </Link>
        <UfAuditClient
          clientLinkId={client_id}
          clientName={(client as any).client_name}
          latestScan={latestScan}
        />
      </div>
    </AppShell>
  );
}
