import Link from "next/link";
import { Sparkles } from "lucide-react";
import { ConnectQuickBooksCard } from "./connect-quickbooks-card";

/**
 * Shown on any portal surface that defaults to "the most recent closed
 * month" when the client has NO reconciled period yet (no monthly close,
 * no completed cleanup). Policy: we never show partial / unreconciled /
 * guessed numbers — only finished books the client can trust. Until the
 * first month is closed, every numbers page shows this instead of data.
 *
 * Deliberately calm and reassuring (not an error) — a client landing here
 * should feel "my team is on it", not "something's broken".
 */
export function NoClosedPeriodState({
  heading = "Your numbers are being prepared",
  blurb,
  showAccountantSetup = false,
}: {
  heading?: string;
  blurb?: string;
  /** Portal home only: show the "connect us to QuickBooks" card while QBO isn't linked. */
  showAccountantSetup?: boolean;
}) {
  return (
    <div className="space-y-6">
      {showAccountantSetup && <ConnectQuickBooksCard />}
      <header className="min-w-0">
        <div className="font-brand text-[11px] uppercase tracking-[0.14em] text-teal-dark">Getting set up</div>
        <h1 className="font-brand text-3xl font-semibold text-navy leading-none mt-1.5">{heading}</h1>
        <div className="text-sm text-ink-slate mt-2">
          We&apos;ll show your numbers the moment your first month is closed.
        </div>
      </header>

      <div className="bg-white border border-cardline rounded-2xl p-8 text-center space-y-3">
        <div className="inline-flex w-14 h-14 rounded-full bg-teal/10 items-center justify-center">
          <Sparkles size={24} className="text-teal" />
        </div>
        <h2 className="text-lg font-bold text-navy">
          Your first month isn&apos;t closed yet
        </h2>
        <p className="text-sm text-ink-slate max-w-md mx-auto leading-relaxed">
          {blurb ||
            "As soon as your Ironbooks team reconciles and closes your first month, your figures will appear here. We only ever show fully reconciled books — never partial or in-progress numbers — so what you see is always something you can trust."}
        </p>
        <p className="text-xs text-ink-light pt-1">
          Questions about timing?{" "}
          <Link href="/portal/messages" className="font-semibold text-teal-dark hover:underline">
            Ask your bookkeeper on the Messages page
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
