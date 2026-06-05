import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import { UFARReview } from "./review-client";
import { Loader2 } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/uf-ar/[id]/review
 *
 * Review screen for a UF → A/R match job. Shows matches grouped by
 * confidence kind:
 *
 *   - exact_invoice_number → green, batch auto-approve
 *   - high_confidence      → green, individual approval per row
 *   - low_confidence       → amber, picker with candidate list
 *   - unmatched            → gray, manual handling
 *
 * While the job is still discovering, render a loading state that
 * polls until ai_completed_at is set.
 */
export default async function UFARReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: job } = (await (service as any)
    .from("uf_ar_jobs")
    .select("*, client_links(client_name, jurisdiction, state_province, id)")
    .eq("id", id)
    .single()) as any;
  if (!job) notFound();

  const clientLink = (job as any).client_links;

  // Still discovering — polling loader.
  if ((job as any).status === "discovering" && !(job as any).ai_completed_at) {
    return (
      <AppShell>
        <TopBar
          title={`UF → A/R match — ${clientLink?.client_name}`}
          subtitle="Discovery in progress · scanning Undeposited Funds + open A/R"
        />
        <div className="px-8 py-12 flex flex-col items-center text-center">
          <Loader2 size={48} className="animate-spin text-teal mb-4" />
          <h2 className="text-base font-bold text-navy mb-1">Matching…</h2>
          <p className="text-sm text-ink-slate max-w-md">
            Pulling Undeposited Funds payments and open A/R invoices from QBO,
            then running the matcher. Usually 10–30 seconds.
          </p>
          <meta httpEquiv="refresh" content="3" />
        </div>
      </AppShell>
    );
  }

  // Failed
  if ((job as any).status === "failed") {
    return (
      <AppShell>
        <TopBar title={`UF → A/R match failed`} />
        <div className="px-8 py-6 max-w-2xl">
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
            <div className="font-bold mb-1">Discovery failed</div>
            <div>{(job as any).error_message || "Unknown error"}</div>
          </div>
          <Link
            href={`/balance-sheet/${clientLink?.id}`}
            className="inline-block mt-4 text-sm font-semibold text-ink-slate hover:text-navy underline"
          >
            ← Back to Balance Sheet
          </Link>
        </div>
      </AppShell>
    );
  }

  const { data: matches } = (await (service as any)
    .from("uf_ar_matches")
    .select("*")
    .eq("job_id", id)
    .order("confidence", { ascending: false })) as any;

  return (
    <AppShell>
      <TopBar
        title={`UF → A/R match — ${clientLink?.client_name}`}
        subtitle={`Scanned ${(job as any).uf_transactions_scanned} UF payments against ${(job as any).open_invoices_scanned} open invoices`}
      />
      <div className="px-8 py-6 max-w-5xl space-y-4">
        {/* Deprecation notice — apply-to-QBO still works here for any
            in-flight job; new scans should run through hardcore-cleanup
            which now does UF↔A/R + Uncategorized Income + Stripe payouts
            under one Finalize. */}
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4">
          <div className="text-sm font-bold text-amber-900 mb-1">
            This UF → A/R surface is moving into Hardcore BS Cleanup
          </div>
          <p className="text-xs text-amber-900 leading-relaxed">
            Apply-to-QBO still works here — finish this scan if you&apos;re
            mid-flow. New scans should start from the consolidated tool,
            which now scans UF↔A/R, Uncategorized Income, and Stripe
            payouts together and finalizes them in one click.
          </p>
          {clientLink?.id && (
            <a
              href={`/balance-sheet/${clientLink.id}/hardcore-cleanup`}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-amber-900 hover:text-amber-700 underline"
            >
              Open Hardcore BS Cleanup →
            </a>
          )}
        </div>
        <UFARReview
          job={job as any}
          matches={(matches as any) || []}
          clientLinkId={clientLink?.id}
        />
      </div>
    </AppShell>
  );
}
