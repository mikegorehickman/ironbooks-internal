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

  // If discovery still running, show pending page
  if (job.status === "executing" || !job.ai_completed_at) {
    return (
      <AppShell>
        <TopBar
          title={`Reclassification: ${job.client_name}`}
          subtitle={`Discovery in progress · ${job.workflow}`}
        />
        <WorkflowStepper currentStep="reclass" currentState="active" completedSteps={["coa"]} />
        <div className="px-8 py-6 max-w-4xl">
          <ReclassDiscoveryPending jobId={id} />
        </div>
      </AppShell>
    );
  }

  // If executing/complete, redirect to execute page
  if (job.execution_started_at) {
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
  // Filter to leaf accounts in the client's jurisdiction.
  const jurisdiction = (job as any).jurisdiction || "US";
  const { data: masterAccounts } = await service
    .from("master_coa")
    .select("account_name, parent_account_name, is_parent, section, sort_order")
    .eq("jurisdiction", jurisdiction)
    .eq("is_parent", false)
    .order("sort_order");

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
