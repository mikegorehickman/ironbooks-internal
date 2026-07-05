import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { getApprovalQueues } from "@/lib/approvals-data";
import { ManagerReviewWidget } from "./manager-review-widget";
import { StatementApprovalsWidget } from "./statement-approvals-widget";
import { ScoreOverridesWidget } from "./score-overrides-widget";
import { FlaggedQueue } from "./flagged-queue";
import { getFlaggedClients } from "@/lib/flagged-data";
import { EscalationStrip } from "@/components/escalations-ui";

export const dynamic = "force-dynamic";

/**
 * Production → Approvals. THE senior queue — everything waiting on a senior
 * in one place: files awaiting manager review, statements awaiting approval,
 * client escalations, and items flagged for senior review (COA / reclass /
 * Stripe). Lifted off /today so Today stays a lean personal action queue.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ viewas?: string }>;
}) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  if (!isSenior) redirect("/today");

  const params = await searchParams;
  const viewAs = params?.viewas ? String(params.viewas) : null;

  const [{ managerReviewRows, statementApprovals, openEscalationCount, scoreOverrides }, flagged] =
    await Promise.all([
      getApprovalQueues(service, { isSenior, viewAs }),
      getFlaggedClients(service),
    ]);

  // The flagged queue has no per-bookkeeper scoping — hide it (and keep it
  // out of the total) when viewing-as, so the header count stays coherent.
  const showFlagged = !viewAs;
  const total =
    managerReviewRows.length +
    statementApprovals.length +
    openEscalationCount +
    (showFlagged ? flagged.totalItems : 0);

  return (
    <AppShell>
      <TopBar
        title="Approvals"
        subtitle={
          total === 0
            ? "Production approvals — nothing waiting"
            : `${total} item${total === 1 ? "" : "s"} awaiting your review`
        }
      />
      <div className="px-8 py-6 space-y-5 max-w-4xl">
        {managerReviewRows.length === 0 && statementApprovals.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 px-6 py-12 text-center text-sm text-ink-slate">
            No files awaiting review and no statements to approve.
          </div>
        ) : (
          <>
            {managerReviewRows.length > 0 && <ManagerReviewWidget rows={managerReviewRows} />}
            {statementApprovals.length > 0 && <StatementApprovalsWidget rows={statementApprovals} />}
          </>
        )}
        {/* Client escalations — THE one queue for "a senior needs to look at
            this client" (all kinds, incl. statements flagged as wrong). The
            strip owns the resolve lifecycle and shows last week's answers. */}
        <EscalationStrip clientIds={null} alwaysOpen />

        {/* A failing source query must be loud — silence here reads as
            "all clear" (the empty-Stripe-picker lesson). */}
        {showFlagged && flagged.queryErrors.length > 0 && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2.5 text-sm text-red-800">
            Flagged queue failed to load: {flagged.queryErrors.join(" · ")}
          </div>
        )}

        {/* Items flagged for senior review during COA / reclass / Stripe work
            (human-escalated only) — merged here from the old /flagged page. */}
        {showFlagged && flagged.clients.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-bold text-navy uppercase tracking-wider">
              Flagged for review · {flagged.totalItems}
            </h2>
            <FlaggedQueue
              clients={flagged.clients}
              reviewerName={(actor as any)?.full_name || ""}
            />
          </section>
        )}

        {/* Transparency ledger, not a work queue — shown even when the queues are clear. */}
        <ScoreOverridesWidget rows={scoreOverrides} />
      </div>
    </AppShell>
  );
}
