"use client";

import Link from "next/link";
import { useState } from "react";
import { AlarmClock, ArrowRight } from "lucide-react";

export interface CleanupDeadlineRow {
  client_link_id: string;
  client_name: string;
  due_date: string | null; // YYYY-MM-DD
  overdue: boolean;
  bookkeeper_name: string | null;
}

/**
 * Assigned cleanup clients + their deadlines, on the bookkeeper's /today.
 * Past-deadline rows go red. Seniors see every bookkeeper's assignments
 * (or one bookkeeper's via the view-as selector).
 */
export function CleanupDeadlinesWidget({
  rows,
  showBookkeeper,
}: {
  rows: CleanupDeadlineRow[];
  showBookkeeper: boolean;
}) {
  // Home shows the top 5 (overdue first — rows arrive sorted); toggle for the rest.
  const [showAll, setShowAll] = useState(false);
  if (rows.length === 0) return null;
  const overdueCount = rows.filter((r) => r.overdue).length;
  const sorted = [...rows].sort((a, b) => Number(b.overdue) - Number(a.overdue));
  const visible = showAll ? sorted : sorted.slice(0, 5);
  return (
    <div className={`bg-white rounded-2xl border-2 overflow-hidden ${overdueCount > 0 ? "border-red-300" : "border-teal/30"}`}>
      <div className={`px-5 py-3 border-b flex items-center gap-2 ${overdueCount > 0 ? "bg-red-50 border-red-100" : "bg-teal/5 border-teal/20"}`}>
        <AlarmClock size={16} className={overdueCount > 0 ? "text-red-700" : "text-teal"} />
        <h2 className="font-bold text-navy text-sm">
          Cleanup assignments ({rows.length})
        </h2>
        {overdueCount > 0 && (
          <span className="text-[11px] font-bold text-red-700">
            {overdueCount} past deadline
          </span>
        )}
      </div>
      <ul className="divide-y divide-gray-50">
        {visible.map((r) => (
          <li key={r.client_link_id}>
            <Link
              href="/cleanup"
              className={`flex items-center gap-3 px-5 py-2.5 transition-colors ${
                r.overdue ? "bg-red-50/60 hover:bg-red-50" : "hover:bg-gray-50"
              }`}
            >
              <div className="flex-1 min-w-0">
                <span className={`text-sm font-semibold ${r.overdue ? "text-red-800" : "text-navy"}`}>
                  {r.client_name}
                </span>
                {showBookkeeper && r.bookkeeper_name && (
                  <span className="text-xs text-ink-slate ml-2">{r.bookkeeper_name}</span>
                )}
              </div>
              {r.due_date ? (
                <span
                  className={`text-[11px] font-bold px-2 py-0.5 rounded flex-shrink-0 ${
                    r.overdue ? "bg-red-100 text-red-700" : "bg-gray-100 text-ink-slate"
                  }`}
                >
                  due {r.due_date}{r.overdue ? " — OVERDUE" : ""}
                </span>
              ) : (
                <span className="text-[11px] text-ink-light flex-shrink-0">no deadline</span>
              )}
              <ArrowRight size={13} className="text-ink-light flex-shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
      {rows.length > 5 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="w-full px-5 py-2.5 text-left text-xs font-semibold text-teal-dark hover:text-navy border-t border-hairline transition-colors"
        >
          {showAll ? "Show top 5" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}
