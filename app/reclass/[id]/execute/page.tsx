import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { ExecuteLive } from "./execute-live";

export default async function ReclassExecutePage({
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

  // Pull client_link_id from reclass_jobs (the view may not expose it directly,
  // but we need it for the bank rules handoff CTA).
  const { data: baseJob } = await service
    .from("reclass_jobs")
    .select("client_link_id, workflow")
    .eq("id", id)
    .single();
  if (job && baseJob) {
    (job as any).client_link_id = baseJob.client_link_id;
    if (!(job as any).workflow) (job as any).workflow = baseJob.workflow;
  }

  if (!job) {
    return (
      <AppShell>
        <TopBar title="Reclass Job Not Found" />
        <div className="px-8 py-6">
          <div className="p-4 bg-red-50 text-red-800 rounded-lg">Job not found.</div>
        </div>
      </AppShell>
    );
  }

  // Get user role for rollback gating
  const { data: userProfile } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const userRole = userProfile?.role || "bookkeeper";

  return (
    <AppShell>
      <TopBar
        title={`Reclassification: ${job.client_name}`}
        subtitle={
          job.status === "complete"
            ? "Complete"
            : job.status === "failed"
            ? "Failed"
            : "Executing..."
        }
      />
      <div className="px-8 py-6 max-w-4xl">
        <ExecuteLive job={job} userRole={userRole} />
      </div>
    </AppShell>
  );
}
