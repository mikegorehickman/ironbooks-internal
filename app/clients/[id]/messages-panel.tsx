"use client";

import { useState } from "react";
import { MessageSquare, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { BookkeeperMessagesClient } from "./messages/messages-client";
import type { ClientCommunication } from "@/lib/client-comms";

/**
 * Collapsible message thread on the client-profile Overview — lets a
 * bookkeeper "text" the client inline instead of opening the separate
 * /messages page. Lazy-loads the thread on first expand, then hands off to
 * the shared BookkeeperMessagesClient (live polling + reply + read-receipts).
 */
export function MessagesPanel({
  clientLinkId,
  canSend,
  unreadCount = 0,
}: {
  clientLinkId: string;
  canSend: boolean;
  unreadCount?: number;
}) {
  const [open, setOpen] = useState(unreadCount > 0); // auto-open when there's unread
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ClientCommunication[]>([]);

  async function load() {
    if (loaded || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/messages`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMessages(data.messages || []);
      setLoaded(true);
    } catch (e: any) {
      setError(e.message || "Couldn't load messages");
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next) void load();
      return next;
    });
  }

  // Auto-load if it starts open (unread).
  if (open && !loaded && !loading && !error) void load();

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 px-5 py-3 hover:bg-gray-50"
      >
        {open ? <ChevronDown size={15} className="text-ink-slate" /> : <ChevronRight size={15} className="text-ink-slate" />}
        <MessageSquare size={15} className="text-teal" />
        <h3 className="text-sm font-bold text-navy">Messages</h3>
        <span className="text-[11px] text-ink-light">text the client directly</span>
        {unreadCount > 0 && (
          <span className="ml-auto inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[11px] font-bold">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 pt-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-ink-slate py-6 justify-center">
              <Loader2 size={16} className="animate-spin text-teal" /> Loading thread…
            </div>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
          {loaded && (
            <BookkeeperMessagesClient
              clientLinkId={clientLinkId}
              initialMessages={messages}
              canSend={canSend}
            />
          )}
        </div>
      )}
    </div>
  );
}
