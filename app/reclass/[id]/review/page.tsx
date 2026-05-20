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
  const industry = ((clientLink as any)?.industry as string) || "painters";

  let { data: masterAccounts } = await service
    .from("master_coa")
    .select("account_name, parent_account_name, is_parent, section, sort_order")
    .eq("jurisdiction", jurisdiction)
    .eq("industry", industry)
    .eq("is_parent", false)
    .order("sort_order");
  // Fallbacks for missing industry rows or pre-Migration-7 state:
  //   1. Try painters (the always-populated baseline) for this jurisdiction
  //   2. If that's empty too, fetch with no industry filter at all
  if ((masterAccounts || []).length === 0 && industry !== "painters") {
    const painters = await service
      .from("master_coa")
      .select("account_name, parent_account_name, is_parent, section, sort_order")
      .eq("jurisdiction", jurisdiction)
      .eq("industry", "painters")
      .eq("is_parent", false)
      .order("sort_order");
    masterAccounts = painters.data;
  }
  if ((masterAccounts || []).length === 0) {
    const noFilter = await service
      .from("master_coa")
      .select("account_name, parent_account_name, is_parent, section, sort_order")
      .eq("jurisdiction", jurisdiction)
      .eq("is_parent", false)
      .order("sort_order");
    masterAccounts = noFilter.data;
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
      <div className="px-8 py-6">
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
