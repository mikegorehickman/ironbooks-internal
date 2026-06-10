import Link from "next/link";
import { ArrowRight, FileText, Inbox, Paperclip } from "lucide-react";
import type { CommAttachment } from "@/lib/client-comms";

export interface InboundCommRow {
  id: string;
  client_link_id: string;
  client_name: string;
  sender_name: string;
  body: string | null;
  attachments: CommAttachment[];
  created_at: string;
}

/**
 * /today widget: unread client→bookkeeper messages + statement uploads
 * across every (visible) client. Rows clear automatically when the
 * bookkeeper opens the client's thread — /clients/[id]/messages marks
 * them read on mount.
 *
 * Server component — pure links, no interactivity needed.
 */
export function ClientInboxWidget({ rows }: { rows: InboundCommRow[] }) {
  const totalFiles = rows.reduce((s, r) => s + (r.attachments?.length || 0), 0);

  return (
    <div className="bg-white rounded-2xl border border-teal/20 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 bg-teal-lighter/30 flex items-center justify-between">
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider flex items-center gap-2">
          <Inbox size={15} className="text-teal" />
          Inbound from clients ({rows.length})
        </h2>
        {totalFiles > 0 && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-teal-dark">
            <Paperclip size={12} />
            {totalFiles} file{totalFiles === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <ul className="divide-y divide-gray-50">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={`/clients/${r.client_link_id}/messages`}
              className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-navy text-sm">{r.client_name}</span>
                  {r.sender_name && (
                    <span className="text-xs text-ink-light">from {r.sender_name}</span>
                  )}
                  <span className="text-xs text-ink-light">· {formatAgo(r.created_at)}</span>
                </div>
                {r.body && (
                  <div className="text-xs text-ink-slate mt-0.5 truncate">{r.body}</div>
                )}
                {r.attachments?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {r.attachments.slice(0, 4).map((a) => (
                      <span
                        key={a.path}
                        className="inline-flex items-center gap-1 bg-teal-lighter/50 border border-teal/15 rounded-full px-2 py-0.5 text-[11px] text-teal-dark"
                      >
                        <FileText size={10} />
                        <span className="max-w-[160px] truncate">{a.name}</span>
                      </span>
                    ))}
                    {r.attachments.length > 4 && (
                      <span className="text-[11px] text-ink-light self-center">
                        +{r.attachments.length - 4} more
                      </span>
                    )}
                  </div>
                )}
              </div>
              <ArrowRight size={15} className="text-ink-light flex-shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
