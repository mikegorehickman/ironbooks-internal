import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { getApprovalQueues } from "@/lib/approvals-data";
import { ManagerReviewWidget } from "../today/manager-review-widget";
import { StatementApprovalsWidget } from "../today/statement-approvals-widget";
import { StatementEscalationsWidget } from "../today/statement-escalations-widget";
import { ScoreOverridesWidget } from "../today/score-overrides-widget";

export const dynamic = "force-dynamic";

/**
 * Production → Approvals. The manager's daily-production approval queue, lifted
 * off /today so Today stays a lean personal action queue. Senior-only:
 * files awaiting manager review, statements awaiting approval, and escalations.
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
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  if (!isSenior) redirect("/today");

  const params = await searchParams;
  const viewAs = params?.viewas ? String(params.viewas) : null;

  const { managerReviewRows, statementApprovals, statementEscalations, scoreOverrides } =
    await getApprovalQueues(service, { isSenior, viewAs });

  const total = managerReviewRows.length + statementApprovals.length + statementEscalations.length;

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
        {total === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 px-6 py-12 text-center text-sm text-ink-slate">
            You&apos;re all caught up — no files awaiting review, no statements to approve, and no
            escalations.
          </div>
        ) : (
          <>
            {managerReviewRows.length > 0 && <ManagerReviewWidget rows={managerReviewRows} />}
            {statementApprovals.length > 0 && <StatementApprovalsWidget rows={statementApprovals} />}
            {statementEscalations.length > 0 && (
              <StatementEscalationsWidget rows={statementEscalations} />
            )}
          </>
        )}
        {/* Transparency ledger, not a work queue — shown even when the queues are clear. */}
        <ScoreOverridesWidget rows={scoreOverrides} />
      </div>
    </AppShell>
  );
}
