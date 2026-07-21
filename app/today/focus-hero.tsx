import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { TodayHero } from "@/lib/today-priority";

/**
 * "Focus now" banner — the single most important thing right now, computed by
 * computeTodayPriority. Design language: a standard white card with a 3px gold
 * bar inside on the left, gold "FOCUS NOW" eyebrow, navy title, rust risk line,
 * navy action button right. When there's nothing pressing it degrades to a calm
 * "you're clear" card so the page never feels alarmy when work is done.
 */
export function FocusHero({
  hero,
  autoExecuted,
  dueSoon,
}: {
  hero: TodayHero | null;
  autoExecuted: number;
  dueSoon: number;
}) {
  if (!hero) {
    return (
      <div className="bg-white border border-cardline rounded-lg shadow-card px-6 py-5 flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-teal flex-shrink-0" />
        <div className="min-w-0 text-sm text-ink-slate">
          <span className="font-bold text-navy">You&apos;re all caught up.</span>{" "}
          Nothing needs your decision right now
          {autoExecuted > 0 && (
            <> · <span className="font-semibold text-teal-dark">{autoExecuted}</span> auto-posted to QuickBooks in the last 24h</>
          )}
          {dueSoon > 0 && (
            <> · <span className="font-semibold text-navy">{dueSoon}</span> due soon</>
          )}
          .
        </div>
      </div>
    );
  }

  const risk = hero.tone === "red" ? "text-rust" : hero.tone === "amber" ? "text-gold-deep" : "text-teal-dark";

  return (
    <div className="bg-white border border-cardline rounded-lg shadow-card px-6 py-5">
      <div className="flex items-stretch gap-4">
        <div className="w-[3px] rounded-full bg-gold flex-shrink-0 self-stretch" />
        <div className="flex items-end justify-between gap-4 flex-wrap flex-1 min-w-0">
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-gold-deep mb-1">Focus now</div>
            <div className="text-lg font-extrabold text-navy truncate">{hero.client}</div>
            <div className={`text-[13px] font-semibold mt-0.5 ${risk}`}>{hero.whyNow}</div>
          </div>
          <Link
            href={hero.ctaHref}
            className="inline-flex items-center gap-2 bg-navy hover:bg-navy-deep text-white text-sm font-semibold px-5 py-2.5 rounded-md flex-shrink-0 transition-colors"
          >
            {hero.ctaLabel}
            <ArrowRight size={15} />
          </Link>
        </div>
      </div>
    </div>
  );
}
