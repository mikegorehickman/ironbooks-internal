"use client";

import Link from "next/link";
import { ClipboardCheck, ArrowRight } from "lucide-react";

export interface ManagerReviewRow {
  id: string;
  client_name: string;
  submitted_at: string | null;
  submitted_by: string | null;
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/**
 * Manager review queue (seniors). Files a bookkeeper submitted for review land
 * here so the manager can open each, review the statements, and send to the
 * client (from the client profile's review + Close-&-send controls). Oldest
 * first so nothing waits too long.
 */
export function ManagerReviewWidget({ rows }: { rows: ManagerReviewRow[] }) {
  return (
    <section className="bg-white rounded-2xl border-2 border-teal-border overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 bg-teal-light border-b border-teal-border">
        <ClipboardCheck size={16} className="text-teal-dark" />
        <h2 className="text-sm font-bold text-navy">Ready for manager review</h2>
        <span className="ml-auto text-xs font-bold text-teal-dark bg-teal-light rounded-full px-2 py-0.5">{rows.length}</span>
      </div>
      <ul className="divide-y divide-gray-50">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={`/clients/${r.id}`}
              className="flex items-center gap-3 px-5 py-3 hover:bg-teal-light/40 group"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-navy truncate">{r.client_name}</div>
                <div className="text-[11px] text-ink-light">
                  Submitted{r.submitted_by ? ` by ${r.submitted_by}` : ""}{r.submitted_at ? ` · ${ago(r.submitted_at)}` : ""}
                </div>
              </div>
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-teal-dark group-hover:text-teal-dark flex-shrink-0">
                Review &amp; send <ArrowRight size={13} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
