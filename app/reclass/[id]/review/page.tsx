import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
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
  // `failed` = watchdog caught a hang — pending component shows retry CTA.
  if (job.status === "executing" || job.status === "web_search_paused" || job.status === "failed" || !job.ai_completed_at) {
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
    .select("industry")
    .eq("id", (job as any).client_link_id)
    .maybeSingle();
  // Industry is REQUIRED — silent default to "painters" caused chimney
  // sweepers (and others) to see the painter target list. If the client
  // has no industry set, surface a clear in-page error rather than
  // dropping the wrong dropdown options on the bookkeeper.
  const industry = (clientLink as any)?.industry as string | null;
  const industryWarnings: string[] = [];

  let masterAccounts: any[] = [];
  if (industry) {
    const res = await service
      .from("master_coa")
      .select("account_name, parent_account_name, is_parent, section, sort_order")
      .eq("jurisdiction", jurisdiction)
      .eq("industry", industry)
      .eq("is_parent", false)
      .order("sort_order");
    masterAccounts = res.data || [];

    // Soft fallback ONLY when the requested industry has zero seeded rows.
    // Always surface the fallback so the bookkeeper sees why painter
    // account names are appearing for a chimney sweep client.
    if (masterAccounts.length === 0) {
      industryWarnings.push(
        `No master COA seeded for industry="${industry}" / jurisdiction="${jurisdiction}". ` +
        `Showing painters baseline — customize the ${industry} template in /templates to make targets industry-specific.`
      );
      const painters = await service
        .from("master_coa")
        .select("account_name, parent_account_name, is_parent, section, sort_order")
        .eq("jurisdiction", jurisdiction)
        .eq("industry", "painters")
        .eq("is_parent", false)
        .order("sort_order");
      masterAccounts = painters.data || [];
    }
    if (masterAccounts.length === 0) {
      industryWarnings.push(
        `Painters baseline ALSO empty for ${jurisdiction}. Showing all master COA accounts for this jurisdiction.`
      );
      const noFilter = await service
        .from("master_coa")
        .select("account_name, parent_account_name, is_parent, section, sort_order")
        .eq("jurisdiction", jurisdiction)
        .eq("is_parent", false)
        .order("sort_order");
      masterAccounts = noFilter.data || [];
    }
  } else {
    industryWarnings.push(
      "This client has no industry set. Set the industry on the client record so target categories load correctly."
    );
  }

  // Also load live QBO accounts so we can resolve target_account_id when the
  // bookkeeper picks a master account by name. The qbo-accounts endpoint already
  // exists but is async-only; we'll let the client-side fetch it on demand.

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
