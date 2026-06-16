"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell, Download, FileText, Loader2, MessageSquare, Send,
} from "lucide-react";
import type { ClientCommunication, CommAttachment } from "@/lib/client-comms";
import { playSound } from "@/lib/sounds";

/**
 * Bookkeeper-side thread + composer for /clients/[id]/messages.
 *
 * Two send modes:
 *   - Message:      conversational, shows as a chat bubble in the portal
 *   - Notification: one-way announcement with optional subject, rendered
 *                   as the amber Bell card in the portal and counted in
 *                   the client's red unread badge
 *
 * Mounting marks inbound (from_client) rows read → clears this client
 * from the /today "Inbound from clients" widget.
 */
export function BookkeeperMessagesClient({
  clientLinkId,
  initialMessages,
  canSend,
}: {
  clientLinkId: string;
  initialMessages: ClientCommunication[];
  canSend: boolean;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ClientCommunication[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [subject, setSubject] = useState("");
  const [kind, setKind] = useState<"message" | "notification">("message");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-blocking warning: the message saved, but the client won't get an
  // email notification (no portal login / send failure).
  const [deliveryWarning, setDeliveryWarning] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Mark inbound read on open, then refresh so the /today + /clients inbox
    // surfaces (and their client-side Router Cache entries) reflect the cleared
    // state when the bookkeeper navigates back.
    fetch(`/api/clients/${clientLinkId}/messages/read`, { method: "POST" })
      .then(() => router.refresh())
      .catch(() => {});
  }, [clientLinkId, router]);

  // Live thread: poll every 20s so a client reply appears without a manual
  // refresh. New from_client messages chime + get marked read (thread is
  // on screen, so the /today widget clears too).
  const lastIdRef = useRef<string | null>(
    initialMessages.length > 0 ? initialMessages[initialMessages.length - 1].id : null
  );
  useEffect(() => {
    if (messages.length > 0) lastIdRef.current = messages[messages.length - 1].id;
  }, [messages]);
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/clients/${clientLinkId}/messages`);
        if (!res.ok) return;
        const json = await res.json();
        const fresh: ClientCommunication[] = json.messages || [];
        if (fresh.length === 0) return;
        if (fresh[fresh.length - 1].id === lastIdRef.current) return;
        const lastIdx = fresh.findIndex((m) => m.id === lastIdRef.current);
        const newOnes = lastIdx >= 0 ? fresh.slice(lastIdx + 1) : fresh;
        setMessages(fresh);
        if (newOnes.some((m) => m.direction === "from_client")) {
          playSound("message_received");
          fetch(`/api/clients/${clientLinkId}/messages/read`, { method: "POST" }).catch(() => {});
        }
      } catch {
        /* transient — next poll retries */
      }
    }, 20_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientLinkId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  async function handleSend() {
    if (sending) return;
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          subject: kind === "notification" ? subject.trim() || undefined : undefined,
          body,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Send failed");
      setMessages((prev) => [...prev, json.message]);
      setDraft("");
      setSubject("");
      // Sending cleared the inbound unread server-side — refresh so the inbox
      // surfaces show it cleared when the bookkeeper returns to /today / /clients.
      router.refresh();
      const d = json.email_delivery;
      if (d && !d.sent) {
        setDeliveryWarning(
          d.reason === "no_portal_user" || d.reason === "no_active_email"
            ? "Message saved — but this client has NO portal login, so they won't get an email and can't see it. Invite them to the portal or reach them another way."
            : "Message saved, but the email notification failed to send — they won't know it's waiting until they log in."
        );
      } else {
        setDeliveryWarning(null);
      }
    } catch (err: any) {
      setError(err?.message || "Send failed — try again");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      {/* Thread */}
      <div className="px-5 py-5 space-y-4 max-h-[55vh] overflow-y-auto">
        {messages.length === 0 && (
          <div className="text-center py-10 text-sm text-ink-slate">
            No messages with this client yet.
          </div>
        )}
        {messages.map((m) => (
          <Row key={m.id} m={m} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      {canSend && (
        <div className="border-t border-gray-100 px-5 py-4 space-y-3 bg-gray-50/60">
          <div className="flex items-center gap-1.5">
            <ModeButton
              active={kind === "message"}
              onClick={() => setKind("message")}
              icon={<MessageSquare size={13} />}
              label="Message"
            />
            <ModeButton
              active={kind === "notification"}
              onClick={() => setKind("notification")}
              icon={<Bell size={13} />}
              label="Notification"
            />
            <span className="text-[11px] text-ink-light ml-2">
              {kind === "notification"
                ? "One-way announcement — amber card + red badge in their portal"
                : "Two-way chat message"}
            </span>
          </div>

          {kind === "notification" && (
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject (e.g. Your March P&L is ready)"
              maxLength={200}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-navy placeholder:text-ink-light focus:outline-none focus:ring-2 focus:ring-teal/40"
            />
          )}

          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
              }}
              rows={2}
              placeholder={
                kind === "notification"
                  ? "Notification text… (⌘+Enter to send)"
                  : "Reply to the client… (⌘+Enter to send)"
              }
              className="flex-1 resize-none rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-navy placeholder:text-ink-light focus:outline-none focus:ring-2 focus:ring-teal/40"
            />
            <button
              onClick={handleSend}
              disabled={sending || !draft.trim()}
              className="flex-shrink-0 inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2.5 rounded-lg disabled:opacity-50"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {kind === "notification" ? "Send notification" : "Send message"}
            </button>
          </div>

          {error && <div className="text-xs text-red-600">{error}</div>}
          {deliveryWarning && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <Bell size={13} className="flex-shrink-0 mt-0.5 text-amber-600" />
              <div className="flex-1">{deliveryWarning}</div>
              <button
                onClick={() => setDeliveryWarning(null)}
                className="text-amber-700 hover:text-amber-900 font-bold flex-shrink-0"
                aria-label="Dismiss warning"
              >
                ✕
              </button>
            </div>
          )}
          <div className="text-[11px] text-ink-light">
            The client also gets an email pointing them to their portal inbox.
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ m }: { m: ClientCommunication }) {
  const fromClient = m.direction === "from_client";

  if (m.kind === "notification") {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="flex items-center gap-2 text-amber-800">
          <Bell size={13} />
          <span className="text-xs font-bold uppercase tracking-wider">
            {m.subject || "Notification"}
          </span>
        </div>
        {m.body && (
          <div className="text-sm text-amber-900 mt-1 whitespace-pre-wrap">{m.body}</div>
        )}
        <div className="text-[10px] text-amber-700/70 mt-1.5">
          {m.sender_name ? `${m.sender_name} · ` : ""}
          {formatWhen(m.created_at)}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${fromClient ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-4 py-3 ${
          fromClient
            ? "bg-teal-lighter/60 text-navy rounded-bl-sm border border-teal/15"
            : "bg-navy text-white rounded-br-sm"
        }`}
      >
        <div
          className={`text-[11px] font-semibold mb-1 ${
            fromClient ? "text-teal-dark" : "text-white/60"
          }`}
        >
          {fromClient ? `${m.sender_name || "Client"} (client)` : m.sender_name || "You"}
        </div>
        {m.body && <div className="text-sm whitespace-pre-wrap leading-relaxed">{m.body}</div>}
        {m.attachments?.length > 0 && (
          <div className="mt-2 space-y-1">
            {m.attachments.map((a: CommAttachment) => (
              <a
                key={a.path}
                href={`/api/client-files/download?path=${encodeURIComponent(a.path)}`}
                target="_blank"
                rel="noopener noreferrer"
                className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs ${
                  fromClient
                    ? "bg-white border border-teal/20 text-navy hover:border-teal"
                    : "bg-white/10 text-white hover:bg-white/20"
                }`}
              >
                <FileText size={13} className={fromClient ? "text-teal" : "text-white/70"} />
                <span className="flex-1 truncate">{a.name}</span>
                <Download size={12} className={fromClient ? "text-ink-light" : "text-white/70"} />
              </a>
            ))}
          </div>
        )}
        <div className={`text-[10px] mt-1.5 ${fromClient ? "text-ink-light" : "text-white/50"}`}>
          {formatWhen(m.created_at)}
          {fromClient && !m.read_at && (
            <span className="ml-2 font-bold text-amber-600">● new</span>
          )}
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active, onClick, icon, label,
}: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
        active
          ? "bg-navy text-white border-navy"
          : "bg-white text-ink-slate border-gray-200 hover:border-gray-300"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}
