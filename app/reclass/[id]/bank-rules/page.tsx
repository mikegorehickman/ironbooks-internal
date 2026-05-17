import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { fetchAllAccounts, getValidToken } from "@/lib/qbo";
import { redirect } from "next/navigation";
import { BankRulesFromReclassClient } from "./bank-rules-client";

const PNL_TYPES_NORMALIZED = new Set([
  "income",
  "otherincome",
  "expense",
  "otherexpense",
  "costofgoodssold",
]);

function isPnLAccountType(t: string | null | undefined): boolean {
  if (!t) return false;
  return PNL_TYPES_NORMALIZED.has(t.toLowerCase().replace(/\s+/g, ""));
}

export default async function BankRulesFromReclassPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, client_link_id, workflow, status")
    .eq("id", id)
    .single();

  if (!job) {
    return (
      <AppShell>
        <TopBar title="Job Not Found" />
        <div className="px-8 py-6">
          <div className="p-4 bg-red-50 text-red-800 rounded-lg">Reclass job not found.</div>
        </div>
      </AppShell>
    );
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("client_name, qbo_realm_id")
    .eq("id", job.client_link_id)
    .single();

  const clientName = (clientLink as any)?.client_name || "Client";
  const qboRealmId = (clientLink as any)?.qbo_realm_id;

  // Fetch live P&L accounts so the bookkeeper can override any AI-picked target.
  // Fail-soft: if QBO is unreachable, dropdowns get an empty list and the row
  // shows the proposed account as a read-only label (current behavior).
  let availablePnLAccounts: Array<{ id: string; name: string; type: string }> = [];
  if (qboRealmId) {
    try {
      const accessToken = await getValidToken(job.client_link_id, service as any);
      const allAccounts = await fetchAllAccounts(qboRealmId, accessToken);
      availablePnLAccounts = allAccounts
        .filter((a) => a.Active !== false && isPnLAccountType(a.AccountType))
        .map((a) => ({ id: a.Id, name: a.Name, type: a.AccountType }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: any) {
      console.warn("[bank-rules] Could not fetch P&L accounts:", err.message);
    }
  }

  const { data: rows } = await service
    .from("reclassifications")
    .select(
      "vendor_name, vendor_pattern_normalized, to_account_id, to_account_name, bookkeeper_override_target_id, bookkeeper_override_target_name, transaction_amount, decision"
    )
    .eq("reclass_job_id", id)
    .in("decision", ["auto_approve", "approved"])
    .not("vendor_name", "is", null);

  type ReclassRow = {
    vendor_name: string | null;
    vendor_pattern_normalized: string | null;
    to_account_id: string;
    to_account_name: string | null;
    bookkeeper_override_target_id: string | null;
    bookkeeper_override_target_name: string | null;
    transaction_amount: number | null;
    decision: string;
  };

  const groupMap = new Map<
    string,
    {
      vendorDisplay: string;
      targetCounts: Map<string, { id: string; name: string; count: number }>;
      txCount: number;
      totalAmount: number;
    }
  >();

  for (const row of (rows || []) as ReclassRow[]) {
    const groupKey = row.vendor_pattern_normalized || row.vendor_name || "";
    if (!groupKey) continue;

    const targetId = row.bookkeeper_override_target_id || row.to_account_id;
    const targetName = row.bookkeeper_override_target_name || row.to_account_name;
    if (!targetName) continue;

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        vendorDisplay: row.vendor_name || groupKey,
        targetCounts: new Map(),
        txCount: 0,
        totalAmount: 0,
      });
    }

    const group = groupMap.get(groupKey)!;
    group.txCount += 1;
    group.totalAmount += row.transaction_amount || 0;

    const existing = group.targetCounts.get(targetId);
    if (existing) {
      existing.count += 1;
    } else {
      group.targetCounts.set(targetId, { id: targetId, name: targetName, count: 1 });
    }
  }

  const proposedRules = Array.from(groupMap.entries())
    .map(([vendorPattern, group]) => {
      let bestTarget = { id: "", name: "" };
      let bestCount = 0;
      for (const t of group.targetCounts.values()) {
        if (t.count > bestCount) {
          bestCount = t.count;
          bestTarget = { id: t.id, name: t.name };
        }
      }
      if (!bestTarget.name) return null;
      return {
        vendorPattern,
        vendorDisplay: group.vendorDisplay,
        targetAccountId: bestTarget.id,
        targetAccountName: bestTarget.name,
        txCount: group.txCount,
        totalAmount: group.totalAmount,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b!.txCount - a!.txCount) as Array<{
    vendorPattern: string;
    vendorDisplay: string;
    targetAccountId: string;
    targetAccountName: string;
    txCount: number;
    totalAmount: number;
  }>;

  return (
    <AppShell>
      <TopBar
        title={`Bank Rules: ${clientName}`}
        subtitle="From Reclassification"
      />
      <WorkflowStepper
        currentStep="rules"
        currentState="active"
        completedSteps={["coa", "reclass"]}
        clientLinkId={job.client_link_id}
      />
      <div className="px-8 py-6 max-w-4xl">
        <BankRulesFromReclassClient
          reclassJobId={id}
          clientLinkId={job.client_link_id}
          clientName={clientName}
          proposedRules={proposedRules}
          availableAccounts={availablePnLAccounts}
        />
      </div>
    </AppShell>
  );
}
