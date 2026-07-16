import Link from "next/link";
import { FileWarning, ArrowRight } from "lucide-react";
import { createServiceSupabase } from "@/lib/supabase";

/**
 * Compact DRAFT banner for portal pages (overview, financial statements
 * hub, P&L, BS, cash flow). Shown while the client's books are in the DRAFT
 * stage (Mike, 2026-07-15: the draft state must be obvious everywhere
 * numbers appear). The WHOLE card is a link to the latest draft month so
 * the client can complete the gut-check review — Mike flagged that a
 * text-only link wasn't obviously clickable.
 *
 * Messaging splits by client age (Mike, 2026-07-16): a brand-new client
 * hears "normal for your first month or two"; an established client (>90
 * days) hears "we'd like your sign-off" instead — the "new" framing would
 * confuse someone we've served for months.
 *
 * Server component — renders nothing once the client graduates to verified,
 * and fails soft (renders nothing) in a pre-migration environment.
 */
export async function DraftStageBanner({ clientLinkId }: { clientLinkId: string }) {
  const service = createServiceSupabase();

  let isDraft = false;
  let established = false;
  let reviewHref: string | null = null;
  try {
    const { data: cl } = await service
      .from("client_links")
      .select("statements_stage, created_at")
      .eq("id", clientLinkId)
      .single();
    isDraft = (cl as any)?.statements_stage === "draft";
    const createdAt = (cl as any)?.created_at ? new Date((cl as any).created_at).getTime() : null;
    established = createdAt !== null && Date.now() - createdAt > 90 * 24 * 60 * 60 * 1000;
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

  const body = established
    ? "Your books are in the draft stage — we'd like your sign-off on the accounts and revenue before we call them verified. You know your business best; once you're happy the numbers are right, verify and we'll carry on."
    : "Your books are in the draft stage — normal for your first month or two with us. The numbers here are our best picture so far; they become verified once you've confirmed everything looks right.";

  const inner = (
    <>
      <span className="inline-flex items-center gap-1.5 text-[11px] font-black tracking-widest bg-amber-600 text-white px-2 py-1 rounded-md flex-shrink-0">
        <FileWarning size={12} />
        DRAFT
      </span>
      <p className="text-sm text-navy/80 flex-1 min-w-[240px]">{body}</p>
      {reviewHref && (
        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-amber-800 flex-shrink-0">
          Review &amp; confirm <ArrowRight size={14} />
        </span>
      )}
    </>
  );

  const cls =
    "rounded-xl border-2 border-amber-300 bg-white px-4 py-3 flex flex-wrap items-center gap-3";

  // Whole card clickable when we can point at a draft month.
  return reviewHref ? (
    <Link href={reviewHref} className={`${cls} hover:border-amber-400 hover:bg-amber-50/40 transition-colors`}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
