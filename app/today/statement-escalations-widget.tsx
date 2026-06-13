import Link from "next/link";
import { AlertTriangle } from "lucide-react";

export interface StatementEscalationRow {
  client_link_id: string;
  client_name: string;
  note: string;
  escalated_by_name: string;
  at: string;
}

/**
 * Senior-only Today widget: financial statements a bookkeeper flagged as
 * wrong during review, with their written explanation. Links to the
 * client's BS cleanup so the manager can dig in.
 */
export function StatementEscalationsWidget({ rows }: { rows: StatementEscalationRow[] }) {
  return (
    <div className="bg-white border border-amber-200 rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-amber-100 bg-amber-50 flex items-center gap-2">
        <AlertTriangle size={15} className="text-amber-600" />
        <span className="text-sm font-bold text-navy">Statements flagged wrong</span>
        <span className="text-xs text-ink-light ml-auto">{rows.length}</span>
      </div>
      <ul className="divide-y divide-gray-100">
        {rows.map((r, i) => (
          <li key={i} className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <Link
                href={`/balance-sheet/${r.client_link_id}/cleanup`}
                className="text-sm font-semibold text-navy hover:text-teal"
              >
                {r.client_name}
              </Link>
              <span className="text-[11px] text-ink-light flex-shrink-0">
                {r.escalated_by_name} · {fmtWhen(r.at)}
              </span>
            </div>
            <p className="text-xs text-ink-slate mt-1 leading-relaxed whitespace-pre-wrap">
              {r.note}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function fmtWhen(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
