"use client";

import { useState, useRef, useEffect } from "react";
import { MessageCircle, X, Send, CheckCircle2, AlertCircle } from "lucide-react";

/**
 * Floating support ticket widget for the client portal.
 *
 * Bottom-right pill button that expands into a chat-style form. Submits
 * the ticket via POST /api/portal/support which emails admin@ironbooks.com
 * and persists to audit_log.
 *
 * Mounted exclusively from app/portal/layout.tsx so it appears only on
 * client-facing surfaces — bookkeepers don't see it on their dashboards.
 *
 * Props come from the portal layout's already-resolved context so we don't
 * round-trip to fetch the client name / user email — instant render, no
 * loading flicker on first paint.
 */
export function SupportWidget({
  clientName,
  userEmail,
  userFullName,
}: {
  clientName: string;
  userEmail: string;
  userFullName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-focus the textarea when the widget opens — saves a click for
  // someone in the middle of typing a complaint about their books.
  useEffect(() => {
    if (open && status === "idle" && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [open, status]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;

    setSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await fetch("/api/portal/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim() || "(no subject)",
          message: message.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Failed to send. Please try again.");
      }

      setStatus("success");
      setSubject("");
      setMessage("");
      // Auto-close after a beat so the user sees confirmation, then we
      // get out of their way. Reset to idle so next open is a fresh form.
      setTimeout(() => {
        setOpen(false);
        setStatus("idle");
      }, 2200);
    } catch (err: any) {
      setStatus("error");
      setErrorMsg(err?.message || "Couldn't send. Please email admin@ironbooks.com directly.");
    } finally {
      setSubmitting(false);
    }
  }

  const firstName = userFullName?.split(" ")[0] || "";

  return (
    <>
      {/* FAB — only rendered when the panel is closed so we don't double-up
          a focus target. Z-index above main content but below modals. */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open support chat"
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 px-4 py-3 rounded-full bg-navy hover:bg-[#0a1722] text-white shadow-xl hover:shadow-2xl transition-all hover:scale-105"
          style={{
            background: "linear-gradient(135deg, #0F1F2E 0%, #1a3651 100%)",
          }}
        >
          <MessageCircle size={18} />
          <span className="text-sm font-semibold">Help</span>
        </button>
      )}

      {open && (
        <div className="fixed bottom-5 right-5 z-50 w-[360px] max-w-[calc(100vw-2.5rem)] bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-200">
          {/* Header */}
          <div
            className="px-5 py-4 text-white flex items-center justify-between"
            style={{ background: "linear-gradient(135deg, #0F1F2E 0%, #1a3651 100%)" }}
          >
            <div>
              <div className="font-bold text-sm">Need a hand?</div>
              <div className="text-xs text-white/70 mt-0.5">
                {firstName ? `Hi ${firstName}, ` : ""}our team usually replies within a few hours
              </div>
            </div>
            <button
              onClick={() => {
                setOpen(false);
                // Defer state reset so the slide-out animation doesn't
                // flash the wrong UI mid-transition.
                setTimeout(() => {
                  setStatus("idle");
                  setErrorMsg(null);
                }, 200);
              }}
              aria-label="Close support chat"
              className="text-white/70 hover:text-white p-1 rounded transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          {status === "success" ? (
            <div className="px-6 py-8 text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center mb-3">
                <CheckCircle2 className="text-emerald-600" size={24} />
              </div>
              <div className="font-bold text-slate-900 text-sm">Message sent</div>
              <p className="text-xs text-slate-600 mt-2 leading-relaxed">
                We've got it. Someone will reach out to{" "}
                <span className="font-medium text-slate-800">{userEmail}</span> soon.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                  Subject (optional)
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="e.g. Question about my P&L"
                  maxLength={120}
                  disabled={submitting}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:border-teal focus:ring-1 focus:ring-teal/30 outline-none transition-colors disabled:bg-slate-50"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                  How can we help?
                </label>
                <textarea
                  ref={textareaRef}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Tell us what's going on..."
                  rows={5}
                  maxLength={4000}
                  required
                  disabled={submitting}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:border-teal focus:ring-1 focus:ring-teal/30 outline-none transition-colors resize-none disabled:bg-slate-50"
                />
                <div className="text-[10px] text-slate-400 mt-1 text-right">
                  {message.length}/4000
                </div>
              </div>

              {status === "error" && errorMsg && (
                <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
                  <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !message.trim()}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-teal hover:bg-teal-dark text-white text-sm font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? (
                  "Sending..."
                ) : (
                  <>
                    <Send size={14} /> Send to Ironbooks
                  </>
                )}
              </button>

              <p className="text-[10px] text-slate-400 text-center leading-relaxed pt-1">
                Sending as <span className="font-medium text-slate-600">{userEmail}</span>
                <br />
                Client: <span className="font-medium text-slate-600">{clientName}</span>
              </p>
            </form>
          )}
        </div>
      )}
    </>
  );
}
