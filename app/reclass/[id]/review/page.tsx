import { AppShell } from "@/components/AppShell";
import { DuplicatesPanel } from "@/components/DuplicatesPanel";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { fetchAllAccounts, getValidToken, QBOReauthRequiredError } from "@/lib/qbo";
import { redirect } from "next/navigation";
import { ReclassReview } from "./review-client";
import { ReclassDiscoveryPending } from "./discovery-pending";

export default async function ReclassReviewPage({
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
    .from("reclass_jobs_view")
    .select("*")
    .eq("id", id)
    .single();

  if (!job) {
    return (
      <AppShell>
        <TopBar title="Reclass Job Not Found" />
        <div className="px-8 py-6">
          <div className="p-4 bg-red-50 text-red-800 rounded-lg">
            Job not found. <a href="/history" className="underline">Back to history</a>
          </div>
        </div>
      </AppShell>
    );
  }

  // Show the pending/progress UI while discovering or waiting for web search chunks.
  // `web_search_paused` = AI done, waiting for bookkeeper to click Continue.
  // `ai_paused` = large job paused between chunked-categorization runs (Continue gate).
  // `failed` = watchdog caught a hang — pending component shows retry CTA.
  if (job.status === "executing" || job.status === "web_search_paused" || (job.status as string) === "ai_paused" || job.status === "failed" || !job.ai_completed_at) {
    return (
      <AppShell>
        <TopBar
          title={`Reclassification: ${job.client_name}`}
          subtitle={`Discovery in progress · ${job.workflow}`}
        />
        <WorkflowStepper currentStep="reclass" currentState="active" completedSteps={["coa"]} />
        <div className="px-8 py-6 max-w-4xl">
          <ReclassDiscoveryPending
            jobId={id}
            clientLinkId={(job as any).client_link_id}
            workflow={(job as any).workflow || "full_categorization"}
          />
        </div>
      </AppShell>
    );
  }

  // While actively executing, redirect to the live progress page.
  // After completion ("complete") the bookkeeper may return here to assign
  // targets to bounced rows and trigger a re-execute — don't redirect them away.
  if (job.status === "executing") {
    redirect(`/reclass/${id}/execute`);
  }

  // Load all reclassifications
  const { data: reclassifications } = await service
    .from("reclassifications")
    .select("*")
    .eq("reclass_job_id", id)
    .order("ai_confidence", { ascending: false })
    .order("vendor_name");

  // Check if user can use admin overrides
  const { data: userProfile } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const userRole = userProfile?.role || "bookkeeper";

  // Load master COA accounts for the Map-to-Master dropdown.
  // Filter to leaf accounts in the client's jurisdiction + industry.
  const jurisdiction = (job as any).jurisdiction || "US";

  // Fetch the client's industry (the view may not expose it)
  const { data: clientLink } = await service
    .from("client_links")
    .select("industry, qbo_realm_id")
    .eq("id", (job as any).client_link_id)
    .maybeSingle();
  // Industry is REQUIRED — silent default to "painters" caused chimney
  // sweepers (and others) to see the painter target list. If the client
  // has no industry set, surface a clear in-page error rather than
  // dropping the wrong dropdown options on the bookkeeper.
  const industry = (clientLink as any)?.industry as string | null;
  const industryWarnings: string[] = [];

  // Build the target-account dropdown from the client's CURRENT (live) QBO
  // chart of accounts — the accounts a transaction can ACTUALLY be posted to
  // in QBO. Previously this used the master_coa TEMPLATE, which could list
  // accounts the client doesn't have, or miss ones they renamed/added (the
  // "wrong / outdated category list" bug). The separate Bank-Rules dropdown
  // still uses the master COA by design; here the bookkeeper needs the
  // client's real accounts. P&L accounts (leaves) drive categorization;
  // Bank/Credit Card accounts cover transfers / CC payments.
  let masterAccounts: any[] = [];
  let usedLiveCoa = false;
  try {
    const clientLinkId = (job as any).client_link_id;
    const realmId = ((job as any).qbo_realm_id || (clientLink as any)?.qbo_realm_id) as string;
    if (clientLinkId && realmId) {
      const accessToken = await getValidToken(clientLinkId, service as any);
      const allQboAccounts = await fetchAllAccounts(realmId, accessToken);
      const active = allQboAccounts.filter((a) => a.Active !== false);
      // Leaf accounts only — you post to leaves, not roll-up parents.
      const parentIds = new Set(active.map((a) => a.ParentRef?.value).filter(Boolean));
      const isBankOrCC = (a: any) => a.AccountType === "Bank" || a.AccountType === "Credit Card";
      const sectionFor = (a: any) => {
        if (a.Classification === "Revenue") return "Income";
        if (/cost of goods sold/i.test(a.AccountType)) return "Cost of Goods Sold";
        if (a.Classification === "Expense") return "Expenses";
        if (isBankOrCC(a)) return "Balance Sheet — Transfers / CC Payments";
        if (a.Classification === "Asset") return "Balance Sheet — Assets";
        if (a.Classification === "Liability") return "Balance Sheet — Liabilities";
        if (a.Classification === "Equity") return "Balance Sheet — Equity";
        return "Other accounts";
      };
      const sortBase = (a: any) => {
        if (a.Classification === "Revenue") return 0;
        if (/cost of goods sold/i.test(a.AccountType)) return 10000;
        if (a.Classification === "Expense") return 20000;
        if (isBankOrCC(a)) return 30000;
        if (a.Classification === "Asset") return 40000;
        if (a.Classification === "Liability") return 50000;
        if (a.Classification === "Equity") return 60000;
        return 70000;
      };
      // Every live LEAF account — P&L drives categorization, and the full
      // balance sheet (assets / liabilities / equity, plus Bank/CC transfers)
      // so the bookkeeper can reclass into ANY real account during cleanup.
      // (Previously this was limited to P&L + Bank/CC, which hid every other
      // balance-sheet account from the picker.)
      const leaves = active.filter((a) => !parentIds.has(a.Id));
      masterAccounts = leaves
        .map((a) => ({
          account_name: a.FullyQualifiedName || a.Name,
          parent_account_name: a.AccountType, // "· Expense" / "· Bank" hint
          is_parent: false,
          section: sectionFor(a),
          sort_order: sortBase(a),
        }))
        .sort((a, b) => a.sort_order - b.sort_order || a.account_name.localeCompare(b.account_name));
      usedLiveCoa = masterAccounts.length > 0;
    }
  } catch (err: any) {
    if (err instanceof QBOReauthRequiredError) redirect(err.reconnectUrl);
    console.warn(
      `[reclass review] couldn't load live QBO COA, falling back to master template: ${err?.message}`
    );
  }

  // Fallback only when the live COA couldn't load — use the master_coa
  // template so the dropdown is never empty (the old behavior).
  if (!usedLiveCoa) {
    industryWarnings.push(
      "Couldn't load this client's live QuickBooks accounts — showing the master COA template instead. Re-open the page to retry."
    );
    if (industry) {
      const res = await service
        .from("master_coa")
        .select("account_name, parent_account_name, is_parent, section, sort_order")
        .eq("jurisdiction", jurisdiction)
        .eq("industry", industry)
        .eq("is_parent", false)
        .order("sort_order");
      masterAccounts = res.data || [];
      if (masterAccounts.length === 0) {
        const painters = await service
          .from("master_coa")
          .select("account_name, parent_account_name, is_parent, section, sort_order")
          .eq("jurisdiction", jurisdiction)
          .eq("industry", "painters")
          .eq("is_parent", false)
          .order("sort_order");
        masterAccounts = painters.data || [];
      }
    }
  }

  return (
    <AppShell>
      <TopBar
        title={`Reclassification: ${job.client_name}`}
        subtitle={`Review · ${
          job.workflow === "consolidation"
            ? "Account Consolidation"
            : job.workflow === "full_categorization"
            ? "Full AI Categorization"
            : "AI Scrub"
        }`}
      />
      <WorkflowStepper currentStep="reclass" currentState="active" completedSteps={["coa"]} />
      <div className="px-8 py-6 space-y-3">
        {industryWarnings.length > 0 && (
          <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="font-bold mb-1">⚠ Industry / master COA mismatch</div>
            <ul className="list-disc ml-5 space-y-1 text-xs">
              {industryWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
        {/* Duplicates stage — dedupe the books BEFORE categorizing them.
            Same engine as the production sweep; scoped to this client. */}
        <DuplicatesPanel
          clientLinkId={(job as any).client_link_id}
          showScan
          title="Duplicates — resolve before reclass"
        />
        <ReclassReview
          job={job}
          rows={reclassifications || []}
          userRole={userRole}
          masterAccounts={masterAccounts || []}
          clientLinkId={(job as any).client_link_id}
        />
      </div>
    </AppShell>
  );
}
