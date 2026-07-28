"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, FileText, Inbox, Loader2, Paperclip } from "lucide-react";
import type { CommAttachment } from "@/lib/client-comms";

export interface InboundCommRow {
  id: string;
  client_link_id: string;
  client_name: string;
  sender_name: string;
  body: string | null;
  attachments: CommAttachment[];
  created_at: string;
  /** No assigned_bookkeeper_id — this sits in no bookkeeper's personal queue. */
  unassigned?: boolean;
}

interface ClientGroup {
  client_link_id: string;
  client_name: string;
  sender_name: string;
  latest_at: string;
  preview: string | null;
  count: number;
  files: number;
  unassigned: boolean;
}

/**
 * /today widget: OPEN (undismissed) client→bookkeeper messages, NESTED by
 * client. Each client shows once — most-recent message preview + a red badge
 * with how many messages are still owed a response. Clicking opens the full
 * thread; the row clears when somebody replies or hits Dismiss, NOT merely by
 * reading it. Rows arrive most-recent-first.
 */
export function ClientInboxWidget({
  rows,
  canDismiss = true,
}: {
  rows: InboundCommRow[];
  /** Viewers are read-only — the API 403s them, so don't offer the button. */
  canDismiss?: boolean;
}) {
  const router = useRouter();
  const [dismissing, setDismissing] = useState<string | null>(null);
  const totalFiles = rows.reduce((s, r) => s + (r.attachments?.length || 0), 0);

  async function dismiss(clientLinkId: string) {
    if (dismissing) return;
    setDismissing(clientLinkId);
    try {
      await fetch("/api/comms/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientLinkId }),
      });
      router.refresh();
    } catch {
      /* leave the row in place — a failed dismiss must not look like success */
    } finally {
      setDismissing(null);
    }
  }

  // Group by client, preserving the incoming most-recent-first order.
  const order: string[] = [];
  const byClient = new Map<string, ClientGroup>();
  for (const r of rows) {
    let g = byClient.get(r.client_link_id);
    if (!g) {
      g = {
        client_link_id: r.client_link_id,
        client_name: r.client_name,
        sender_name: r.sender_name,
        latest_at: r.created_at,
        preview: r.body, // first seen = most recent
        count: 0,
        files: 0,
        unassigned: !!r.unassigned,
      };
      byClient.set(r.client_link_id, g);
      order.push(r.client_link_id);
    }
    g.count += 1;
    g.files += r.attachments?.length || 0;
  }
  const groups = order.map((id) => byClient.get(id)!);
  // Home shows the top 5 clients; nothing on Home ever scrolls 20+ rows.
  // (Client component now — the toggle is the only interactivity.)
  const [showAll, setShowAll] = useState(false);
  const visibleGroups = showAll ? groups : groups.slice(0, 5);

  return (
    <div className="bg-white rounded-2xl border border-teal/20 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 bg-teal-lighter/30 flex items-center justify-between">
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider flex items-center gap-2">
          <Inbox size={15} className="text-teal" />
          Inbound from clients ({groups.length})
        </h2>
        {totalFiles > 0 && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-teal-dark">
            <Paperclip size={12} />
            {totalFiles} file{totalFiles === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <ul className="divide-y divide-gray-50">
        {visibleGroups.map((g) => (
          <li key={g.client_link_id} className="flex items-stretch hover:bg-gray-50 transition-colors">
            <Link
              href={`/clients/${g.client_link_id}/messages`}
              className="flex items-center gap-4 px-5 py-3.5 flex-1 min-w-0"
            >
              {/* Red count badge — how many messages still owe this client a reply */}
              <span className="relative flex-shrink-0">
                <span
                  className={`inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full text-xs font-bold ${
                    g.count > 1 ? "bg-red-500 text-white" : "bg-teal-lighter text-teal-dark"
                  }`}
                  title={`${g.count} unread message${g.count === 1 ? "" : "s"}`}
                >
                  {g.count}
                </span>
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-navy text-sm">{g.client_name}</span>
                  {g.sender_name && (
                    <span className="text-xs text-ink-light">from {g.sender_name}</span>
                  )}
                  <span className="text-xs text-ink-light">· {formatAgo(g.latest_at)}</span>
                  {g.count > 1 && (
                    <span className="text-[11px] text-red-600 font-semibold">{g.count} messages</span>
                  )}
                  {g.unassigned && (
                    <span
                      className="text-[10px] font-bold uppercase tracking-wider text-amber-800 bg-amber-100 border border-amber-300 rounded-full px-1.5 py-0.5"
                      title="No bookkeeper is assigned to this client — it appears on no one's personal queue"
                    >
                      Unassigned
                    </span>
                  )}
                </div>
                {g.preview && (
                  <div className="text-xs text-ink-slate mt-0.5 truncate">{g.preview}</div>
                )}
                {g.files > 0 && (
                  <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-teal-dark">
                    <FileText size={10} /> {g.files} file{g.files === 1 ? "" : "s"}
                  </div>
                )}
              </div>
              <ArrowRight size={15} className="text-ink-light flex-shrink-0" />
            </Link>
            {/* "No reply needed" — the answer went out by phone, the client
                sorted it themselves, or it was an FYI. Reversible from the
                thread, which tags dismissed messages with who cleared them. */}
            {canDismiss && (
            <button
              onClick={() => dismiss(g.client_link_id)}
              disabled={dismissing === g.client_link_id}
              title="Dismiss — no reply needed"
              className="flex-shrink-0 px-3 my-2 mr-2 rounded-lg text-[11px] font-semibold text-ink-light hover:text-teal-dark hover:bg-teal-lighter/50 border border-transparent hover:border-teal/20 transition-colors disabled:opacity-50"
            >
              {dismissing === g.client_link_id ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <span className="inline-flex items-center gap-1"><Check size={13} /> Dismiss</span>
              )}
            </button>
            )}
          </li>
        ))}
      </ul>
      {groups.length > 5 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="w-full px-5 py-2.5 text-left text-xs font-semibold text-teal-dark hover:text-navy border-t border-hairline transition-colors"
        >
          {showAll ? "Show top 5" : `Show all ${groups.length}`}
        </button>
      )}
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
