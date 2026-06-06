import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/**
 * Shown on BS cleanup wizard pages while the flow is a standalone pilot tab,
 * not yet integrated into the 5-step Account Cleanup stepper.
 */
export function CleanupPilotBanner() {
  return (
    <div className="px-8 pt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 max-w-6xl">
        <span className="text-[10px] font-bold uppercase tracking-wide text-amber-700">
          Pilot
        </span>
        <span className="flex-1 min-w-[12rem]">
          Standalone BS Cleanup — not part of the main Account Cleanup steps yet.
        </span>
        <Link
          href="/balance-sheet/cleanup"
          className="inline-flex items-center gap-1 font-semibold text-teal hover:text-teal-dark"
        >
          <ArrowLeft size={14} />
          All clients
        </Link>
      </div>
    </div>
  );
}
