import Link from "next/link";
import { FileWarning, ArrowRight } from "lucide-react";
import { createServiceSupabase } from "@/lib/supabase";

/**
 * Compact DRAFT banner for portal report pages (financial statements hub,
 * P&L, etc). Shown while the client's books are in the DRAFT stage (Mike,
 * 2026-07-15: the draft state must be obvious everywhere numbers appear,
 * not just on the monthly statement page). Links to the latest draft month
 * so the client can complete the gut-check review.
 *
 * Server component — renders nothing once the client graduates to verified,
 * and fails soft (renders nothing) in a pre-migration environment.
 */
export async function DraftStageBanner({ clientLinkId }: { clientLinkId: string }) {
  const service = createServiceSupabase();

  let isDraft = false;
  let reviewHref: string | null = null;
  try {
    const { data: cl } = await service
      .from("client_links")
      .select("statements_stage")
      .eq("id", clientLinkId)
      .single();
    isDraft = (cl as any)?.statements_stage === "draft";
    if (isDraft) {
      const { data: pkg } = await (service as any)
        .from("month_end_packages")
        .select("period_year, period_month")
        .eq("client_link_id", clientLinkId)
        .eq("status", "sent")
        .eq("sent_as_draft", true)
        .order("period_year", { ascending: false })
        .order("period_month", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (pkg) reviewHref = `/portal/statements/${(pkg as any).period_year}/${(pkg as any).period_month}`;
    }
  } catch {
    /* pre-migration env — no banner */
  }

  if (!isDraft) return null;

  return (
    <div className="rounded-xl border-2 border-amber-300 bg-white px-4 py-3 flex flex-wrap items-center gap-3">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-black tracking-widest bg-amber-600 text-white px-2 py-1 rounded-md flex-shrink-0">
        <FileWarning size={12} />
        DRAFT
      </span>
      <p className="text-sm text-navy/80 flex-1 min-w-[240px]">
        Your books are in the <strong>draft stage</strong> — normal for your first month or two with
        us. The numbers here are our best picture so far; they become <strong>verified</strong> once
        you&apos;ve confirmed everything looks right.
      </p>
      {reviewHref && (
        <Link
          href={reviewHref}
          className="inline-flex items-center gap-1.5 text-sm font-bold text-amber-800 hover:text-amber-900 flex-shrink-0"
        >
          Review &amp; confirm <ArrowRight size={14} />
        </Link>
      )}
    </div>
  );
}
