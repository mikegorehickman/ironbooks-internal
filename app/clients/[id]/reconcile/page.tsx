import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ReconcileClient } from "./reconcile-client";

export const dynamic = "force-dynamic";

/**
 * /clients/[id]/reconcile — QBO-style bank/CC reconciliation, prepped in SNAP.
 * Pick an account + statement → SNAP pre-fills the ending balance/date, pulls
 * the QBO ledger, auto-checks what matches the statement, and shows live
 * difference math. Finish snapshots the exact minimal steps to replay in
 * QBO's reconcile screen (QBO stays the official record — its API has no
 * reconcile endpoint).
 */
export default async function ReconcilePage(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) redirect("/dashboard");

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", id)
    .single();
  if (!client) redirect("/clients");

  return (
    <AppShell>
      <TopBar
        title={`Reconcile — ${(client as any).client_name}`}
        subtitle="SNAP preps the reconciliation · QBO gets the official stamp in a few clicks"
      />
      <div className="px-8 py-6">
        <Suspense fallback={<div className="text-sm text-ink-slate">Loading…</div>}>
          <ReconcileClient clientLinkId={id} />
        </Suspense>
      </div>
    </AppShell>
  );
}
