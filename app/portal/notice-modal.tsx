"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileText, Loader2, Send, X } from "lucide-react";
import { noticePeriodLabel } from "@/lib/statement-notices";

/** The safe subset of a statement_notices row the portal page passes down —
 *  server-selected, so internal linkage columns never reach the client bundle. */
export interface StatementNoticeView {
  id: string;
  period_year: number;
  period_month: number;
  boilerplate_body: string;
  ai_body: string | null;
  custom_body: string | null;
  sent_by_name: string | null;
  sent_at: string;
}

/**
 * The Notice to Reader, as the client experiences it.
 *
 * Opens AUTOMATICALLY on every P&L visit until this user acknowledges the
 * current version (server-side receipts — surviving devices and sessions;
 * re-sends bump sent_at and the modal honestly returns). A persistent header
 * button re-opens it anytime after that.
 *
 * Actions: "I've reviewed this" (ack) · Reply (inline; sending also acks —
 * you necessarily read what you answered) · Close (X — reappears next visit
 * until acknowledged; that behavior is the point, not a bug).
 *
 * Impersonating staff see a preview banner and disabled actions — their
 * clicks must never stamp receipts or create client messages.
 */

export function NoticeModal({
  notice,
  initiallyAcked,
  impersonating,
  open,
  onClose,
  onAcked,
}: {
  notice: StatementNoticeView;
  initiallyAcked: boolean;
  impersonating: boolean;
  open: boolean;
  onClose: () => void;
  onAcked: () => void;
}) {
  const [acking, setAcking] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyDone, setReplyDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewedStamped = useRef(false);

  const periodLabel = noticePeriodLabel(notice.period_year, notice.period_month);

  // Stamp "viewed" once per mount-open — client-side POST so the server render
  // never writes; skipped for impersonators server-side too (belt and braces).
  useEffect(() => {
    if (!open || viewedStamped.current || impersonating) return;
    viewedStamped.current = true;
    fetch(`/api/portal/notices/${notice.id}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "viewed" }),
    }).catch(() => {});
  }, [open, impersonating, notice.id]);

  if (!open) return null;

  async function ack() {
    setAcking(true);
    setError(null);
    try {
      const r = await fetch(`/api/portal/notices/${notice.id}/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "ack" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onAcked();
      onClose();
    } catch (e: any) {
      setError(e?.message || "Couldn't record that — try again.");
    } finally {
      setAcking(false);
    }
  }

  async function sendReply() {
    const text = replyText.trim();
    if (!text) return;
    setReplyBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/portal/notices/${notice.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setReplyDone(d.message || "Sent — your bookkeeping team will follow up.");
      setReplyText("");
      onAcked(); // replying acknowledges
    } catch (e: any) {
      setError(e?.message || "Couldn't send the reply — try again.");
    } finally {
      setReplyBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[86vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Notice to Reader — ${periodLabel}`}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-3 shrink-0">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-teal-light flex items-center justify-center shrink-0">
              <FileText size={17} className="text-teal-dark" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-navy">Notice to Reader</h2>
              <p className="text-xs text-ink-slate">
                {periodLabel} statements
                {notice.sent_by_name ? <> · from {notice.sent_by_name}</> : null}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy shrink-0" aria-label="Close">
            <X size={17} />
          </button>
        </div>

        {impersonating && (
          <div className="px-6 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 shrink-0">
            Impersonation preview — acknowledging and replying are disabled so nothing is recorded as the client.
          </div>
        )}

        <div className="px-6 py-4 overflow-y-auto space-y-4 text-sm text-ink leading-relaxed whitespace-pre-wrap">
          <div>{notice.boilerplate_body}</div>
          {notice.ai_body && (
            <div className="border-t border-gray-100 pt-4">{notice.ai_body}</div>
          )}
          {notice.custom_body && (
            <div className="border-t border-gray-100 pt-4">{notice.custom_body}</div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 shrink-0 space-y-2.5">
          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}
          {replyDone ? (
            <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center gap-1.5">
              <CheckCircle2 size={13} /> {replyDone}
            </div>
          ) : replyOpen ? (
            <div className="space-y-2">
              <textarea
                autoFocus
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                rows={3}
                maxLength={8000}
                placeholder="Answer the requests above, or ask your own question…"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:border-teal focus:outline-none"
                disabled={impersonating}
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={sendReply}
                  disabled={replyBusy || impersonating || !replyText.trim()}
                  className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-3.5 py-2 rounded-lg disabled:opacity-50"
                >
                  {replyBusy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                  Send reply
                </button>
                <button onClick={() => setReplyOpen(false)} className="text-xs font-semibold text-ink-slate hover:text-navy">
                  Cancel
                </button>
                <span className="text-[11px] text-ink-slate">Sending also marks the notice as reviewed.</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              {!initiallyAcked && (
                <button
                  onClick={ack}
                  disabled={acking || impersonating}
                  className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-3.5 py-2 rounded-lg disabled:opacity-50"
                >
                  {acking ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  I&apos;ve reviewed this
                </button>
              )}
              <button
                onClick={() => setReplyOpen(true)}
                disabled={impersonating}
                className="inline-flex items-center gap-1.5 text-xs font-bold px-3.5 py-2 rounded-lg border border-teal/40 text-teal-dark hover:bg-teal-lighter disabled:opacity-50"
              >
                <Send size={13} /> Reply
              </button>
              {!initiallyAcked && (
                <span className="text-[11px] text-ink-slate">
                  This notice will reappear until you mark it reviewed.
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Header button — the way back in after acknowledging. Accented until acked. */
export function NoticeButton({
  acked,
  onOpen,
}: {
  acked: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border transition-colors ${
        acked
          ? "border-gray-200 text-ink-slate hover:border-gray-300 hover:text-navy"
          : "border-teal bg-teal-lighter text-teal-dark hover:bg-teal-light"
      }`}
      title={acked ? "Re-read the Notice to Reader" : "You have an unread Notice to Reader"}
    >
      <FileText size={13} />
      Notice to Reader
      {!acked && <span className="w-1.5 h-1.5 rounded-full bg-teal-dark" aria-hidden />}
    </button>
  );
}
