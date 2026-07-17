"use client";

import Link from "next/link";
import { Copy, ArrowRight } from "lucide-react";

/**
 * Entry card for the fleet duplicates screen. This used to FIRE the sweep
 * directly and claim "sweeping in the background" — but server self-chaining
 * is cron-only (the fire-and-forget after() chain dies unreliably on Vercel),
 * so a browser fire only ever scanned the first 8-client chunk. The real
 * runner lives on /admin/duplicates: it drives every chunk itself, shows
 * per-chunk progress/errors, and lists every client's findings for review.
 */
export function DupSweepButton() {
  return (
    <Link
      href="/admin/duplicates"
      className="group w-full flex items-center justify-between rounded-xl bg-white border border-gray-200 px-5 py-3 hover:border-teal hover:bg-teal-lighter/40 transition-colors text-left"
    >
      <div className="flex items-center gap-3">
        <div className="rounded-lg flex items-center justify-center w-9 h-9 bg-teal-light">
          <Copy size={16} className="text-teal" />
        </div>
        <div>
          <h3 className="font-bold text-sm text-navy">Duplicates — fleet</h3>
          <p className="text-xs text-ink-slate">
            Fleet-wide expense-duplicate scan · ranked by $ exposure · one-click guarded remove per finding
          </p>
        </div>
      </div>
      <ArrowRight size={16} className="text-ink-light group-hover:text-teal" />
    </Link>
  );
}
