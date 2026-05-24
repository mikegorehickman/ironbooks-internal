"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Send, AlertCircle, Loader2 } from "lucide-react";
import { MarkdownText } from "./markdown-text";

/**
 * Portal Q&A chat. Per-session conversation only (no DB persistence in
 * MVP) — refreshing the page or signing out clears history. Each user
 * message hits /api/portal/ask-ai with the prior turns; the response
 * streams back as Server-Sent Events.
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
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the chat to the bottom on every new chunk
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

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
          if (eventType === "delta" && payload.text) {
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
    }
  }

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-100px)]">
      <div className="flex-shrink-0">
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Your AI bookkeeper</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Ask anything about your finances</h1>
        <div className="text-sm text-ink-slate mt-1">
          Knows your live QuickBooks data · Trained to explain things in plain English
        </div>
      </div>

      {/* Starter pills — only when chat is empty */}
      {messages.length === 0 && (
        <div className="flex-shrink-0 flex flex-wrap gap-2">
          {starters.map((s) => (
            <button
              key={s}
              onClick={() => send(s)}
              disabled={streaming}
              className="text-xs px-3 py-1.5 bg-white border border-slate-200 rounded-full text-ink-slate hover:bg-teal/5 hover:border-teal/40 hover:text-teal-dark disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Chat history */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-4 bg-white border border-slate-200 rounded-2xl p-5"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-ink-slate text-sm py-12">
            <Sparkles size={28} className="text-teal-dark mb-3" />
            <div className="font-semibold text-navy">Ask a question about your books</div>
            <div className="text-xs mt-1 max-w-xs">
              Pick a starter above or type your own. The AI sees your live financials and explains
              things in plain English.
            </div>
          </div>
        ) : (
          messages.map((m, i) =>
            m.role === "user" ? (
              <UserBubble key={i}>{m.content}</UserBubble>
            ) : (
              <AiBubble key={i} streaming={streaming && i === messages.length - 1}>
                <MarkdownText>{m.content}</MarkdownText>
              </AiBubble>
            )
          )
        )}
      </div>

      {error && (
        <div className="flex-shrink-0 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {/* Input box */}
      <div className="flex-shrink-0 bg-white border-2 border-slate-200 rounded-2xl p-3 focus-within:border-teal/50">
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
        <div className="flex items-center justify-between mt-2">
          <div className="text-[11px] text-ink-light">
            AI has access to your live QBO data. It won't give legal or tax advice — talk to your
            CPA for that.
          </div>
          <button
            onClick={() => send()}
            disabled={streaming || !input.trim()}
            className="px-3 py-1.5 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {streaming ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            {streaming ? "Thinking…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="bg-teal text-white rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[80%] text-sm whitespace-pre-wrap">
        {children}
      </div>
    </div>
  );
}

function AiBubble({ children, streaming }: { children: React.ReactNode; streaming?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-full bg-teal/10 flex items-center justify-center flex-shrink-0">
        <Sparkles size={14} className="text-teal-dark" />
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
