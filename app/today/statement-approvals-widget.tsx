import Link from "next/link";
import { ArrowRight, FileCheck2 } from "lucide-react";

export interface StatementApprovalRow {
  client_link_id: string;
  client_name: string;
  period: string; // YYYY-MM
  kind: "production_me" | "cleanup";
  submitted_by_name: string;
  submitted_at: string | null;
  has_concerns: boolean;
  concerns: string | null;
  /** Books Reliability score for the period; null = not verified yet. */
  verification_score?: number | null;
}

/** Books Reliability chip: emerald ≥95, amber 85-94, red below or missing. */
function ScoreChip({ score }: { score: number | null | undefined }) {
  const cls =
    score == null
      ? "bg-red-100 text-red-800"
      : score >= 95
      ? "bg-emerald-100 text-emerald-800"
      : score >= 85
      ? "bg-amber-100 text-amber-800"
      : "bg-red-100 text-red-800";
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${cls}`}>
      {score == null ? "NOT VERIFIED" : `RELIABILITY ${score}`}
    </span>
  );
}

function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Senior approval queue: monthly closes + cleanup sign-offs a JR has
 * attested and submitted. Clicking through lands on /monthly-rec where the
 * senior reviews the same statements (P&L/BS/CFS + AI spot check) and
 * approves the send to the client.
 */
export function StatementApprovalsWidget({ rows }: { rows: StatementApprovalRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="bg-white rounded-2xl border-2 border-purple-200 overflow-hidden">
      <div className="px-5 py-3 bg-purple-50 border-b border-purple-100 flex items-center gap-2">
        <FileCheck2 size={16} className="text-purple-700" />
        <h2 className="font-bold text-navy text-sm">
          Statements awaiting your approval ({rows.length})
        </h2>
        <span className="text-[11px] text-purple-800 ml-1">
          review → approve → sends to the client &amp; closes the period
        </span>
      </div>
      <ul className="divide-y divide-gray-50">
        {rows.map((r) => (
          <li key={`${r.client_link_id}-${r.period}`}>
            <Link
              href={r.kind === "cleanup" ? "/cleanup" : "/production"}
              className="flex items-center gap-3 px-5 py-3 hover:bg-purple-50/40 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-navy">{r.client_name}</span>
                  <span className="text-xs text-ink-slate">
                    {r.kind === "cleanup"
                      ? "Onboarding complete — ready for review"
                      : `${periodLabel(r.period)} month-end — ready for review`}
                  </span>
                  {r.kind === "cleanup" && (
                    <span className="text-[10px] font-bold bg-violet-100 text-violet-800 px-1.5 py-0.5 rounded">
                      NEW CLIENT
                    </span>
                  )}
                  {r.has_concerns && (
                    <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                      CONCERNS NOTED
                    </span>
                  )}
                  <ScoreChip score={r.verification_score} />
                </div>
                <div className="text-xs text-ink-slate mt-0.5">
                  Submitted by {r.submitted_by_name || "a bookkeeper"}
                  {r.submitted_at ? ` · ${new Date(r.submitted_at).toLocaleString()}` : ""}
                  {r.concerns ? ` — “${r.concerns.slice(0, 120)}${r.concerns.length > 120 ? "…" : ""}”` : ""}
                </div>
              </div>
              <ArrowRight size={14} className="text-purple-600 flex-shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
