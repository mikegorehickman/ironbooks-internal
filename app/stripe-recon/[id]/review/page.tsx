import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { StripeReconReview } from "./review-client";
import { UnmatchedPanel } from "./unmatched-panel";
import { MarkCleanupCompleteButton } from "./mark-complete-button";
import { UpgradeToStripeApiButton } from "./upgrade-button";

export default async function StripeReconReviewPage({
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
    .select("*, client_links(id, client_name, jurisdiction, state_province, stripe_connection_status)")
    .eq("id", id)
    .single();
  if (!job) notFound();

  const clientLink = (job as any).client_links;

  // "Upgrade to Stripe API" eligibility. Surfaces a prominent banner
  // when this recon used the QBO-AI matcher AND the client has since
  // connected Stripe — re-running with method=stripe_api replaces the
  // AI-matched [Ironbooks] lines on each deposit with deterministic
  // charges/fees/customers from Stripe. The execute step strips prior
  // tagged lines before writing fresh ones, so the upgrade is safe.
  //
  // We allow this on in_review jobs (most common — the bookkeeper hasn't
  // acknowledged yet) as well as complete jobs. Discovering / executing
  // are excluded because the existing run is still mid-flight.
  const canUpgradeToStripeApi =
    (job.status === "complete" || job.status === "in_review") &&
    (job as any).method === "qbo_invoice_match" &&
    clientLink?.stripe_connection_status === "connected";

  const upgradeClientId = (clientLink?.id as unknown as string) ||
    (job.client_link_id as unknown as string);
  const upgradeRangeStart = (job.date_range_start as unknown as string) || null;
  const upgradeRangeEnd = (job.date_range_end as unknown as string) || null;

  // Still discovering — show loader, auto-refresh
  if (job.status === "discovering" || !job.ai_completed_at) {
    return (
      <AppShell>
        <TopBar
          title={`Stripe Reconciliation — ${clientLink?.client_name}`}
          subtitle="Pulling Stripe deposits and matching them to invoices..."
        />
        <WorkflowStepper currentStep="stripe" currentState="active" completedSteps={["coa", "reclass", "revenue", "rules"]} clientLinkId={job.client_link_id as unknown as string} />
        <div className="px-8 py-12 flex flex-col items-center">
          <Loader2 size={48} className="animate-spin text-teal mb-4" />
          <p className="text-sm text-ink-slate">
            This usually takes 20-60 seconds. Page will auto-refresh.
          </p>
          <meta httpEquiv="refresh" content="5" />
        </div>
      </AppShell>
    );
  }

  const { data: matches } = await service
    .from("stripe_recon_matches")
    .select("*")
    .eq("job_id", id)
    .order("deposit_date");

  // Zero-deposits short-circuit: the recon job already self-completed
  // (lib/api/stripe-recon/discover sets status='complete' when no Stripe-
  // origin deposits exist in the range). Render a friendly summary with
  // CTAs to extend the date range or finish out the cleanup, instead of
  // dropping the bookkeeper into an empty match grid.
  const isNoDeposits =
    job.status === "complete" &&
    (job.stripe_deposits_found ?? 0) === 0 &&
    (!matches || matches.length === 0);

  if (isNoDeposits) {
    // Suggest extending back another calendar year from the original start.
    // e.g. range was 2026-01-01 → 2026-05-18, suggest 2025-01-01 → 2026-05-18.
    const origStart = job.date_range_start as unknown as string; // "YYYY-MM-DD"
    const origEnd = job.date_range_end as unknown as string;
    const [yStr, mStr, dStr] = (origStart || "").split("-");
    const extendedStart = yStr
      ? `${Number(yStr) - 1}-${mStr}-${dStr}`
      : origStart;

    const extendQs = new URLSearchParams({
      client: job.client_link_id as unknown as string,
      start: extendedStart,
      end: origEnd,
      extending_from: id,
      ...(job.reclass_job_id
        ? { reclass_job_id: job.reclass_job_id as unknown as string }
        : {}),
    }).toString();

    const customQs = new URLSearchParams({
      client: job.client_link_id as unknown as string,
      ...(job.reclass_job_id
        ? { reclass_job_id: job.reclass_job_id as unknown as string }
        : {}),
    }).toString();

    const jobWarnings: string[] = Array.isArray((job as any).warnings)
      ? ((job as any).warnings as any[]).filter((w) => typeof w === "string")
      : [];

    return (
      <AppShell>
        <TopBar
          title={`Stripe Reconciliation — ${clientLink?.client_name}`}
          subtitle="No Stripe deposits in range"
        />
        <WorkflowStepper
          currentStep="stripe"
          currentState="active"
          completedSteps={["coa", "reclass", "revenue", "rules"]}
          clientLinkId={job.client_link_id as unknown as string}
        />
        <div className="px-8 py-6 max-w-2xl">
          <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="text-teal flex-shrink-0 mt-0.5" size={24} />
              <div>
                <h2 className="text-lg font-bold text-navy">
                  No Stripe deposits found
                </h2>
                <p className="text-sm text-ink-slate mt-1">
                  We scanned QBO from{" "}
                  <span className="font-semibold">{origStart}</span> to{" "}
                  <span className="font-semibold">{origEnd}</span> and didn&apos;t
                  find any Stripe-origin deposits. There&apos;s nothing to
                  reconcile in this range.
                </p>
              </div>
            </div>

            {jobWarnings.length > 0 && (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1">
                {jobWarnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}

            <div className="pt-2 border-t border-gray-100 space-y-3">
              <p className="text-sm font-semibold text-navy">
                Want to check a wider window?
              </p>
              <p className="text-xs text-ink-slate">
                Sometimes Stripe deposits live further back than the cleanup
                date range, especially if the client only started using Stripe
                recently or if there&apos;s a gap in QBO categorization.
              </p>
              <div className="flex flex-col sm:flex-row gap-2 pt-1">
                <Link
                  href={`/stripe-recon/new?${extendQs}`}
                  className="flex-1 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2.5 rounded-lg text-center"
                >
                  Try one more year back ({extendedStart} → {origEnd})
                </Link>
                <Link
                  href={`/stripe-recon/new?${customQs}`}
                  className="flex-1 bg-white border border-gray-200 hover:border-gray-300 text-navy text-sm font-semibold px-4 py-2.5 rounded-lg text-center"
                >
                  Pick a custom range
                </Link>
              </div>
            </div>

            {/* Nothing to reconcile IS this step done — the primary action
                is moving on to the next wizard step. */}
            <div className="pt-3 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
              <Link
                href={
                  job.reclass_job_id
                    ? `/reclass/${job.reclass_job_id}/execute`
                    : `/clients/${job.client_link_id as unknown as string}`
                }
                className="text-sm text-ink-slate hover:text-navy underline"
              >
                ← Skip and finish cleanup (nothing to reconcile)
              </Link>
              <Link
                href={`/balance-sheet/${job.client_link_id as unknown as string}`}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-5 py-2.5 rounded-lg shadow-md"
              >
                Continue to Balance Sheet →
              </Link>
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  // All-unmatched short-circuit. If we have deposits but every single one
  // came back flagged with zero candidate invoices/payments, AR matching is
  // structurally impossible for this client (they don't invoice through
  // QBO — typically Stripe Payment Links / subscriptions / Stripe
  // Invoicing). Surface a dedicated panel with a "send connect link" CTA
  // and an "acknowledge & finish" path instead of dumping the bookkeeper
  // into a 50-row grid of flagged rows with nothing to do.
  const matchList = (matches as any[]) || [];
  const isAllUnmatchedNoCandidates =
    matchList.length > 0 &&
    matchList.every(
      (m) =>
        m.decision === "flagged" &&
        (!Array.isArray(m.candidate_invoices) || m.candidate_invoices.length === 0) &&
        (!Array.isArray(m.candidate_payments) || m.candidate_payments.length === 0)
    );

  if (isAllUnmatchedNoCandidates) {
    const totalAmount = matchList.reduce(
      (s, m) => s + Number(m.deposit_amount || 0),
      0
    );
    return (
      <AppShell>
        <TopBar
          title={`Stripe Reconciliation — ${clientLink?.client_name}`}
          subtitle="AR matching not possible — Stripe Connect needed"
        />
        <WorkflowStepper
          currentStep="stripe"
          currentState="active"
          completedSteps={["coa", "reclass", "revenue", "rules"]}
          clientLinkId={job.client_link_id as unknown as string}
        />
        <div className="px-8 py-6 space-y-6">
          {canUpgradeToStripeApi && (
            <UpgradeToStripeApiBanner
              clientName={clientLink?.client_name || "this client"}
              jobId={id}
              clientLinkId={upgradeClientId}
              dateRangeStart={upgradeRangeStart}
              dateRangeEnd={upgradeRangeEnd}
            />
          )}
          <UnmatchedPanel
            jobId={id}
            clientLinkId={job.client_link_id as unknown as string}
            clientName={clientLink?.client_name || "this client"}
            depositCount={matchList.length}
            totalAmount={totalAmount}
            reclassJobId={(job.reclass_job_id as unknown as string) || null}
            stripeConnected={clientLink?.stripe_connection_status === "connected"}
            dateRangeStart={(job.date_range_start as unknown as string) || null}
            dateRangeEnd={(job.date_range_end as unknown as string) || null}
            reconMethod={((job as any).method as "stripe_api" | "qbo_invoice_match" | null) ?? null}
          />
          <div className="max-w-2xl">
            <MarkCleanupCompleteButton
              clientLinkId={job.client_link_id as unknown as string}
              clientName={clientLink?.client_name || "this client"}
              defaultRangeStart={job.date_range_start as unknown as string}
              defaultRangeEnd={job.date_range_end as unknown as string}
            />
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <TopBar
        title={`Stripe Reconciliation — ${clientLink?.client_name}`}
        subtitle={`${matches?.length || 0} deposits matched`}
      />
      <WorkflowStepper currentStep="stripe" currentState="active" completedSteps={["coa", "reclass", "revenue", "rules"]} clientLinkId={job.client_link_id as unknown as string} />
      <div className="px-8 py-6 space-y-6">
        {canUpgradeToStripeApi && (
          <UpgradeToStripeApiBanner
            clientName={clientLink?.client_name || "this client"}
            jobId={id}
            clientLinkId={upgradeClientId}
            dateRangeStart={upgradeRangeStart}
            dateRangeEnd={upgradeRangeEnd}
          />
        )}
        <StripeReconReview
          job={job as any}
          matches={(matches as any) || []}
          clientLink={clientLink}
        />
        <MarkCleanupCompleteButton
          clientLinkId={job.client_link_id as unknown as string}
          clientName={clientLink?.client_name || "this client"}
          defaultRangeStart={job.date_range_start as unknown as string}
          defaultRangeEnd={job.date_range_end as unknown as string}
        />
      </div>
    </AppShell>
  );
}

/**
 * Banner rendered when the current recon used the QBO-AI matcher and
 * the client has since connected Stripe. The CTA uses the dedicated
 * UpgradeToStripeApiButton which acknowledges the current job FIRST
 * (so the concurrency guard on the next discover doesn't bounce the
 * user back here in a loop) and then navigates to /stripe-recon/new
 * with the upgrade params. The execute step is idempotent (strips
 * prior [Ironbooks] lines before writing fresh ones) so re-running
 * on the same deposits is safe.
 */
function UpgradeToStripeApiBanner({
  clientName,
  jobId,
  clientLinkId,
  dateRangeStart,
  dateRangeEnd,
}: {
  clientName: string;
  jobId: string;
  clientLinkId: string;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
}) {
  return (
    <div className="rounded-xl bg-teal-light border border-teal-border p-5">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-teal-light flex-shrink-0">
          <Sparkles size={18} className="text-teal-dark" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-navy">
            <strong className="text-teal-dark">{clientName}</strong> has
            connected Stripe — upgrade this recon to the deterministic path
          </h3>
          <p className="text-xs text-ink-slate mt-1 leading-relaxed mb-3">
            This run used the <strong className="text-navy">QBO invoice matcher</strong> (AI).
            Now that Stripe is connected, you can re-run with the{" "}
            <strong className="text-navy">Stripe API</strong> path — exact
            charges, fees, and customers pulled directly from Stripe with no
            guessing. The previous AI-matched lines on each deposit are
            replaced automatically (no duplicates).
          </p>
          <div className="inline-block">
            <UpgradeToStripeApiButton
              jobId={jobId}
              clientLinkId={clientLinkId}
              dateRangeStart={dateRangeStart}
              dateRangeEnd={dateRangeEnd}
              variant="secondary"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
