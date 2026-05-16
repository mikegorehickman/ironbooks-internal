import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { notFound, redirect } from "next/navigation";
import { StripeReconExecute } from "./execute-live";

export default async function StripeReconExecutePage({
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
    .from("stripe_recon_jobs")
    .select("*, client_links(client_name, jurisdiction, state_province, id)")
    .eq("id", id)
    .single();
  if (!job) notFound();

  const clientLink = (job as any).client_links;

  return (
    <AppShell>
      <TopBar
        title={`Stripe Recon Execution — ${clientLink?.client_name}`}
        subtitle={
          job.status === "complete"
            ? "Complete"
            : job.status === "failed"
            ? "Failed"
            : "Executing..."
        }
      />
      <div className="px-8 py-6 max-w-4xl">
        <StripeReconExecute
          jobId={id}
          initialStatus={job.status}
          clientName={clientLink?.client_name || ""}
          jurisdiction={clientLink?.jurisdiction || "US"}
          clientLinkId={clientLink?.id}
        />
      </div>
    </AppShell>
  );
}
