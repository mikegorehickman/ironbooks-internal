"use client";

import { useEffect, useState } from "react";
import { Inbox, Loader2, MessageSquare } from "lucide-react";
import { BookkeeperMessagesClient } from "../clients/[id]/messages/messages-client";
import type { ClientCommunication } from "@/lib/client-comms";

export interface InboxThread {
  clientLinkId: string;
  clientName: string;
  preview: string;
  lastAt: string | null;
  /** Inbound messages still owed a reply (undismissed), not merely unread. */
  unread: number;
  oldestUnreadAt: string | null;
  /** No bookkeeper assigned — visible to managers only. */
  unassigned?: boolean;
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function InboxClient({ threads, canSend }: { threads: InboxThread[]; canSend: boolean }) {
  const [selected, setSelected] = useState<string | null>(threads[0]?.clientLinkId || null);
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ClientCommunication[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  async function open(clientLinkId: string) {
    setSelected(clientLinkId);
    setLoading(true);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/messages`);
      const d = await res.json();
      setMessages(res.ok ? (d.messages || []) : []);
      setLoadedFor(clientLinkId);
    } catch {
      setMessages([]);
      setLoadedFor(clientLinkId);
    } finally {
      setLoading(false);
    }
  }

  // Auto-load the first thread on mount.
  useEffect(() => {
    if (selected) open(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sel = threads.find((t) => t.clientLinkId === selected) || null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5 items-start">
      {/* Thread list */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
          <Inbox size={15} className="text-teal" />
          <h2 className="text-sm font-bold text-navy">Conversations</h2>
          <span className="ml-auto text-[11px] font-semibold text-ink-slate bg-slate-100 rounded-full px-2 py-0.5">{threads.length}</span>
        </div>
        {threads.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-ink-slate">No client messages yet.</div>
        ) : (
          <ul className="max-h-[72vh] overflow-y-auto divide-y divide-gray-50">
            {threads.map((t) => (
              <li key={t.clientLinkId}>
                <button
                  onClick={() => open(t.clientLinkId)}
                  className={`w-full text-left px-4 py-3 hover:bg-teal-lighter/40 ${selected === t.clientLinkId ? "bg-teal-lighter/60" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-navy truncate flex-1">{t.clientName}</span>
                    {t.unread > 0 && <span className="text-[10px] font-bold text-white bg-red-500 rounded-full px-1.5 py-0.5 flex-shrink-0" title={`${t.unread} awaiting a reply`}>{t.unread}</span>}
                    <span className="text-[10px] text-ink-light flex-shrink-0">{ago(t.lastAt)}</span>
                  </div>
                  {t.unassigned && (
                    <span
                      className="inline-block mt-1 text-[9px] font-bold uppercase tracking-wider text-amber-800 bg-amber-100 border border-amber-300 rounded-full px-1.5 py-0.5"
                      title="No bookkeeper assigned — this client is on nobody's personal queue"
                    >
                      Unassigned
                    </span>
                  )}
                  <div className="text-[11px] text-ink-light truncate mt-0.5">{t.preview || "—"}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Selected thread */}
      <div>
        {!sel ? (
          <div className="bg-white rounded-2xl border border-gray-100 px-6 py-16 text-center text-sm text-ink-slate">
            <MessageSquare size={22} className="mx-auto text-ink-light mb-2" />
            Select a conversation to read and reply.
          </div>
        ) : loading || loadedFor !== sel.clientLinkId ? (
          <div className="bg-white rounded-2xl border border-gray-100 px-6 py-16 text-center text-sm text-ink-slate">
            <Loader2 size={18} className="mx-auto animate-spin text-teal mb-2" />
            Loading {sel.clientName}…
          </div>
        ) : (
          <div>
            <div className="text-sm font-bold text-navy mb-2">{sel.clientName}</div>
            <BookkeeperMessagesClient key={sel.clientLinkId} clientLinkId={sel.clientLinkId} initialMessages={messages} canSend={canSend} />
          </div>
        )}
      </div>
    </div>
  );
}
