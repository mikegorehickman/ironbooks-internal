import Link from "next/link";
import { ShieldAlert, ArrowRight } from "lucide-react";
import type { ScoreOverrideRow } from "@/lib/approvals-data";

function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Books Reliability overrides — statements that went to a client BELOW the
 * score threshold on a senior's written override (last 30 days). Not a work
 * queue; a transparency ledger so under-the-bar sends are never invisible.
 */
export function ScoreOverridesWidget({ rows }: { rows: ScoreOverrideRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="bg-white rounded-2xl border-2 border-red-200 overflow-hidden">
      <div className="px-5 py-3 bg-red-50 border-b border-red-100 flex items-center gap-2">
        <ShieldAlert size={16} className="text-red-700" />
        <h2 className="font-bold text-navy text-sm">
          Sent below the reliability bar ({rows.length})
        </h2>
        <span className="text-[11px] text-red-800 ml-1">last 30 days — who overrode, and why</span>
      </div>
      <ul className="divide-y divide-gray-50">
        {rows.map((r) => (
          <li key={`${r.client_link_id}-${r.period}`}>
            <Link
              href={`/clients/${r.client_link_id}`}
              className="flex items-center gap-3 px-5 py-3 hover:bg-red-50/40 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-navy">{r.client_name}</span>
                  <span className="text-xs text-ink-slate">{periodLabel(r.period)}</span>
                  <span className="text-[10px] font-bold bg-red-100 text-red-800 px-1.5 py-0.5 rounded">
                    SCORE {r.score}
                  </span>
                </div>
                <div className="text-xs text-ink-slate mt-0.5">
                  {r.overridden_by_name || "A senior"}
                  {r.at ? ` · ${new Date(r.at).toLocaleString()}` : ""}
                  {r.reason ? ` — “${r.reason.slice(0, 140)}${r.reason.length > 140 ? "…" : ""}”` : ""}
                </div>
              </div>
              <ArrowRight size={14} className="text-red-600 flex-shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
