"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bell, Loader2, Paperclip, Send, X, FileText, Download,
} from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { playSound } from "@/lib/sounds";
import { DOCUMENTS_CHANGED_EVENT } from "./documents-panel";
import {
  CLIENT_UPLOADS_BUCKET,
  MAX_UPLOAD_BYTES,
  type ClientCommunication,
  type CommAttachment,
} from "@/lib/client-comms";

/**
 * Client component for /portal/messages.
 *
 * Send flow for attachments (bypasses Vercel's request body cap):
 *   1. POST /api/portal/messages/upload-url per file → {path, token}
 *   2. supabase.storage.uploadToSignedUrl() straight from the browser
 *   3. POST /api/portal/messages with the collected attachment metas
 *
 * Marks bookkeeper→client messages read on mount (clears the nav badge).
 */
export function MessagesClient({ initialMessages }: { initialMessages: ClientCommunication[] }) {
  const [messages, setMessages] = useState<ClientCommunication[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Clear the unread badge as soon as the thread is on screen
  useEffect(() => {
    fetch("/api/portal/messages/read", { method: "POST" }).catch(() => {});
  }, []);

  // Live thread: poll every 20s so a bookkeeper reply appears without a
  // manual refresh. New incoming messages chime + get marked read (the
  // thread is on screen).
  const lastIdRef = useRef<string | null>(
    initialMessages.length > 0 ? initialMessages[initialMessages.length - 1].id : null
  );
  useEffect(() => {
    if (messages.length > 0) lastIdRef.current = messages[messages.length - 1].id;
  }, [messages]);
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/portal/messages");
        if (!res.ok) return;
        const json = await res.json();
        const fresh: ClientCommunication[] = json.messages || [];
        if (fresh.length === 0) return;
        if (fresh[fresh.length - 1].id === lastIdRef.current) return;
        const lastIdx = fresh.findIndex((m) => m.id === lastIdRef.current);
        const newOnes = lastIdx >= 0 ? fresh.slice(lastIdx + 1) : fresh;
        setMessages(fresh);
        if (newOnes.some((m) => m.direction === "to_client")) {
          playSound("message_received");
          fetch("/api/portal/messages/read", { method: "POST" }).catch(() => {});
        }
      } catch {
        /* transient — next poll retries */
      }
    }, 20_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (f.size > MAX_UPLOAD_BYTES) {
        setError(`"${f.name}" is over the ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`);
        continue;
      }
      if (next.length >= 10) break;
      next.push(f);
    }
    setFiles(next);
  }

  async function handleSend() {
    if (sending) return;
    const body = draft.trim();
    if (!body && files.length === 0) return;
    setSending(true);
    setError(null);

    try {
      // 1+2: upload each file directly to storage via signed URL
      const attachments: CommAttachment[] = [];
      const supabase = createBrowserSupabase();
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setStatus(files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : "Uploading…");
        const urlRes = await fetch("/api/portal/messages/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: f.name, size: f.size, content_type: f.type }),
        });
        const urlJson = await urlRes.json();
        if (!urlRes.ok) throw new Error(urlJson.error || `Couldn't prepare upload for ${f.name}`);

        const { error: upErr } = await supabase.storage
          .from(CLIENT_UPLOADS_BUCKET)
          .uploadToSignedUrl(urlJson.path, urlJson.token, f);
        if (upErr) throw new Error(`Upload failed for ${f.name}: ${upErr.message}`);

        attachments.push({
          path: urlJson.path,
          name: urlJson.name,
          size: urlJson.size,
          content_type: urlJson.content_type,
        });
      }

      // 3: create the message row
      setStatus(files.length > 0 ? "Sending…" : null);
      const res = await fetch("/api/portal/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, attachments }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't send — try again");

      setMessages((prev) => [...prev, json.message]);
      setDraft("");
      if (attachments.length > 0) window.dispatchEvent(new Event(DOCUMENTS_CHANGED_EVENT));
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err: any) {
      setError(err?.message || "Something went wrong — try again");
    } finally {
      setSending(false);
      setStatus(null);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      {/* Thread */}
      <div className="px-5 py-5 space-y-4 max-h-[55vh] overflow-y-auto">
        {messages.length === 0 && (
          <div className="text-center py-10">
            <div className="text-sm font-semibold text-navy">No messages yet</div>
            <p className="text-xs text-ink-slate mt-1 max-w-sm mx-auto leading-relaxed">
              Send your bookkeeper a question, or upload bank and credit-card
              statements using the paperclip below.
            </p>
          </div>
        )}

        {messages.map((m) =>
          m.kind === "notification" ? (
            <NotificationCard key={m.id} m={m} />
          ) : (
            <MessageBubble key={m.id} m={m} />
          )
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="border-t border-slate-200 px-5 py-4 space-y-3 bg-slate-50/60">
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((f, i) => (
              <span
                key={`${f.name}-${i}`}
                className="inline-flex items-center gap-1.5 bg-white border border-slate-200 rounded-full pl-3 pr-1.5 py-1 text-xs text-navy"
              >
                <FileText size={12} className="text-teal" />
                <span className="max-w-[180px] truncate">{f.name}</span>
                <button
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  className="p-0.5 rounded-full hover:bg-slate-100"
                  aria-label={`Remove ${f.name}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept=".pdf,.csv,.xls,.xlsx,.txt,.png,.jpg,.jpeg,.heic,.webp,.ofx,.qfx,.qbo,.doc,.docx,.zip"
            onChange={(e) => addFiles(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            className="flex-shrink-0 p-2.5 rounded-lg border border-slate-200 bg-white text-ink-slate hover:text-navy hover:border-slate-300 disabled:opacity-50"
            title="Attach statements or files"
          >
            <Paperclip size={16} />
          </button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
            }}
            rows={2}
            placeholder="Write a message to your bookkeeper… (⌘+Enter to send)"
            className="flex-1 resize-none rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-navy placeholder:text-ink-light focus:outline-none focus:ring-2 focus:ring-teal/40"
          />
          <button
            onClick={handleSend}
            disabled={sending || (!draft.trim() && files.length === 0)}
            className="flex-shrink-0 inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2.5 rounded-lg disabled:opacity-50"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Send
          </button>
        </div>

        {status && <div className="text-xs text-ink-slate">{status}</div>}
        {error && <div className="text-xs text-red-600">{error}</div>}
        <div className="text-[11px] text-ink-light">
          Attach bank or credit-card statements as PDF, CSV, Excel, or bank-export
          files (max 25MB each).
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ m }: { m: ClientCommunication }) {
  const mine = m.direction === "from_client";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-4 py-3 ${
          mine
            ? "bg-navy text-white rounded-br-sm"
            : "bg-slate-100 text-navy rounded-bl-sm"
        }`}
      >
        {!mine && (
          <div className="text-[11px] font-semibold text-teal-dark mb-1">
            {m.sender_name || "Your bookkeeper"}
          </div>
        )}
        {m.body && <div className="text-sm whitespace-pre-wrap leading-relaxed">{m.body}</div>}
        {m.attachments?.length > 0 && (
          <AttachmentList attachments={m.attachments} dark={mine} />
        )}
        <div className={`text-[10px] mt-1.5 ${mine ? "text-white/50" : "text-ink-light"}`}>
          {formatWhen(m.created_at)}
        </div>
      </div>
    </div>
  );
}

function NotificationCard({ m }: { m: ClientCommunication }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex items-center gap-2 text-amber-800">
        <Bell size={14} />
        <span className="text-xs font-bold uppercase tracking-wider">
          {m.subject || "Update from your bookkeeper"}
        </span>
      </div>
      {m.body && (
        <div className="text-sm text-amber-900 mt-1.5 whitespace-pre-wrap leading-relaxed">
          {m.body}
        </div>
      )}
      <div className="text-[10px] text-amber-700/70 mt-1.5">
        {m.sender_name ? `${m.sender_name} · ` : ""}
        {formatWhen(m.created_at)}
      </div>
    </div>
  );
}

function AttachmentList({ attachments, dark }: { attachments: CommAttachment[]; dark: boolean }) {
  return (
    <div className="mt-2 space-y-1">
      {attachments.map((a) => (
        <a
          key={a.path}
          href={`/api/client-files/download?path=${encodeURIComponent(a.path)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs ${
            dark
              ? "bg-white/10 text-white hover:bg-white/20"
              : "bg-white border border-slate-200 text-navy hover:border-teal"
          }`}
        >
          <FileText size={13} className={dark ? "text-white/70" : "text-teal"} />
          <span className="flex-1 truncate">{a.name}</span>
          <span className={dark ? "text-white/50" : "text-ink-light"}>{formatSize(a.size)}</span>
          <Download size={12} className={dark ? "text-white/70" : "text-ink-light"} />
        </a>
      ))}
    </div>
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

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
