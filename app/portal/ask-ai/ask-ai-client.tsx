"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Send, AlertCircle, Loader2, ArrowUpRight, Wand2, Plus, History } from "lucide-react";
import { MarkdownText } from "./markdown-text";

/**
 * Portal Q&A chat — facelifted. The streaming logic is unchanged: each user
 * message hits /api/portal/ask-ai with prior turns and the response streams
 * back as Server-Sent Events. Per-session only (no DB persistence in MVP).
 *
 * Visual system matches the rest of the portal: gradient hero, an inspiring
 * empty state with dynamic starter cards, gradient AI avatar, and a polished
 * composer.
 */

interface Message {
  role: "user" | "assistant";
  content: string;
}

export function AskAiClient({ starters }: { starters: string[] }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<
    { id: string; title: string | null; updated_at: string }[]
  >([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loadingConv, setLoadingConv] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the chat to the bottom on every new chunk
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Load saved conversations on mount so returning clients see their history.
  useEffect(() => {
    void loadConversations();
  }, []);

  async function loadConversations() {
    try {
      const res = await fetch("/api/portal/ask-ai/conversations");
      if (res.ok) {
        const body = await res.json();
        setConversations(body.conversations || []);
      }
    } catch {
      /* non-fatal — history just won't show */
    }
  }

  function newChat() {
    setMessages([]);
    setConversationId(null);
    setError(null);
    setShowHistory(false);
  }

  async function loadConversation(id: string) {
    if (streaming) return;
    setShowHistory(false);
    setLoadingConv(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/ask-ai/conversations?id=${id}`);
      if (res.ok) {
        const body = await res.json();
        setMessages(
          (body.messages || []).map((m: any) => ({ role: m.role, content: m.content }))
        );
        setConversationId(id);
      }
    } catch {
      setError("Couldn't load that conversation.");
    } finally {
      setLoadingConv(false);
    }
  }

  async function send(text?: string) {
    const question = (text ?? input).trim();
    if (!question || streaming) return;

    setInput("");
    setError(null);

    // Add user message + placeholder assistant message (empty content,
    // we'll mutate it as chunks stream in)
    const newMessages: Message[] = [
      ...messages,
      { role: "user", content: question },
      { role: "assistant", content: "" },
    ];
    setMessages(newMessages);
    setStreaming(true);

    try {
      const res = await fetch("/api/portal/ask-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          history: messages, // everything before this turn
          conversation_id: conversationId, // null on a fresh chat; server mints one
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      if (!res.body) {
        throw new Error("No response body");
      }

      // Parse the SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by blank lines (\n\n)
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const evt of events) {
          const lines = evt.split("\n");
          let eventType = "";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!eventType || !data) continue;
          let payload: any;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (eventType === "meta" && payload.conversation_id) {
            setConversationId(payload.conversation_id);
          } else if (eventType === "delta" && payload.text) {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "assistant") {
                next[next.length - 1] = { ...last, content: last.content + payload.text };
              }
              return next;
            });
          } else if (eventType === "error") {
            throw new Error(payload.message || "Stream error");
          }
        }
      }
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
      // Remove the empty assistant placeholder on error
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.content === "") {
          return prev.slice(0, -1);
        }
        return prev;
      });
    } finally {
      setStreaming(false);
      // Refresh the saved-conversation list so this turn (new convo or an
      // updated title/timestamp) shows up in History.
      void loadConversations();
    }
  }

  const empty = messages.length === 0;

  return (
    <div className="flex flex-col h-[calc(100vh-100px)] gap-4">
      {/* ── Gradient hero ───────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy to-teal-dark px-6 py-5 text-white flex-shrink-0">
        <div className="absolute -right-10 -top-12 w-48 h-48 rounded-full bg-teal/25 blur-3xl" />
        <div className="absolute -left-6 -bottom-14 w-40 h-40 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center flex-shrink-0">
            <Sparkles size={22} className="text-white" />
          </div>
          <div>
            <div className="text-xs text-white/60 uppercase tracking-wider font-semibold">Your AI bookkeeper</div>
            <h1 className="text-2xl font-bold leading-tight">Ask anything about your finances</h1>
            <div className="text-xs text-white/65 mt-0.5">
              Knows your live QuickBooks data · Explains things in plain English
            </div>
          </div>
        </div>
      </div>

      {/* History toolbar — New chat + saved conversations */}
      {(conversations.length > 0 || messages.length > 0) && (
        <div className="flex-shrink-0 flex items-center justify-between gap-2">
          <button
            onClick={newChat}
            disabled={streaming}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-teal-dark hover:text-teal px-3 py-1.5 rounded-lg border border-slate-200 hover:border-teal/40 bg-white disabled:opacity-50"
          >
            <Plus size={14} /> New chat
          </button>
          <div className="relative">
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-slate hover:text-navy px-3 py-1.5 rounded-lg border border-slate-200 hover:border-teal/40 bg-white"
            >
              {loadingConv ? <Loader2 size={14} className="animate-spin" /> : <History size={14} />}
              History
              {conversations.length > 0 && (
                <span className="text-xs text-ink-light">({conversations.length})</span>
              )}
            </button>
            {showHistory && (
              <div className="absolute right-0 mt-1 w-80 max-h-96 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-lg z-20 p-1">
                {conversations.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-ink-slate text-center">
                    No past conversations yet.
                  </div>
                ) : (
                  conversations.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => loadConversation(c.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 ${
                        c.id === conversationId ? "bg-teal/5" : ""
                      }`}
                    >
                      <div className="text-sm text-navy truncate font-medium">
                        {c.title || "Conversation"}
                      </div>
                      <div className="text-[11px] text-ink-light">
                        {new Date(c.updated_at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Chat / empty state */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-white border border-slate-200 rounded-2xl p-5"
      >
        {empty ? (
          <div className="h-full flex flex-col">
            <div className="text-center pt-6 pb-5">
              <div className="w-14 h-14 mx-auto rounded-2xl bg-teal-lighter-dark flex items-center justify-center shadow-sm">
                <Wand2 size={26} className="text-white" />
              </div>
              <div className="font-bold text-navy text-lg mt-3">What can I help you understand?</div>
              <div className="text-sm text-ink-slate mt-1 max-w-md mx-auto">
                Tap a question below or type your own. I read your live financials and answer
                in plain English — no accounting jargon.
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-w-2xl mx-auto w-full">
              {starters.map((s) => (
                <StarterCard key={s} text={s} onClick={() => send(s)} disabled={streaming} />
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <UserBubble key={i}>{m.content}</UserBubble>
              ) : (
                <AiBubble key={i} streaming={streaming && i === messages.length - 1}>
                  <MarkdownText>{m.content}</MarkdownText>
                </AiBubble>
              )
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="flex-shrink-0 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {/* Composer */}
      <div className="flex-shrink-0 bg-white border-2 border-slate-200 rounded-2xl p-3 focus-within:border-teal/50 transition-colors">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask anything — 'Can I afford this?', 'Explain my taxes', 'Why is this number weird?'"
          className="w-full resize-none outline-none text-sm text-navy placeholder:text-ink-light min-h-[60px]"
          disabled={streaming}
        />
        <div className="flex items-center justify-between mt-2 gap-3">
          <div className="text-[11px] text-ink-light">
            AI has access to your live QBO data. It won't give legal or tax advice — talk to your
            CPA for that.
          </div>
          <button
            onClick={() => send()}
            disabled={streaming || !input.trim()}
            className="px-4 py-2 bg-teal-lighter-dark text-white rounded-lg text-sm font-semibold hover:from-teal-dark hover:to-teal-dark disabled:opacity-50 inline-flex items-center gap-1.5 flex-shrink-0 transition-all"
          >
            {streaming ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            {streaming ? "Thinking…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StarterCard({ text, onClick, disabled }: { text: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group flex items-start gap-2.5 text-left p-3 rounded-xl border border-slate-200 bg-white hover:border-teal/40 hover:bg-teal/5 disabled:opacity-50 transition-all"
    >
      <span className="w-7 h-7 rounded-lg bg-teal/10 text-teal-dark flex items-center justify-center flex-shrink-0 group-hover:bg-teal/15">
        <Sparkles size={13} />
      </span>
      <span className="text-sm text-navy/85 flex-1 leading-snug">{text}</span>
      <ArrowUpRight size={14} className="text-ink-light group-hover:text-teal-dark flex-shrink-0 mt-0.5 transition-colors" />
    </button>
  );
}

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="bg-teal-lighter-dark text-white rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[80%] text-sm whitespace-pre-wrap shadow-sm">
        {children}
      </div>
    </div>
  );
}

function AiBubble({ children, streaming }: { children: React.ReactNode; streaming?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-full bg-teal-lighter-dark flex items-center justify-center flex-shrink-0 shadow-sm">
        <Sparkles size={14} className="text-white" />
      </div>
      <div className="flex-1 bg-slate-50 border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-navy max-w-[85%] leading-relaxed">
        {children}
        {streaming && (
          <span className="inline-block w-2 h-4 bg-teal-dark animate-pulse ml-0.5 align-middle" />
        )}
      </div>
    </div>
  );
}
