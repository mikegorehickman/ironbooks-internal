"use client";

import { useState } from "react";
import {
  MessageCircleQuestion,
  X,
  Loader2,
  CheckCircle2,
  Sparkles,
  Send,
} from "lucide-react";

/**
 * AskAboutButton — the reusable "Ask Ironbooks about this" affordance.
 *
 * Drop it on any portal surface (a P&L line, a Balance Sheet line, a single
 * transaction, an A/R customer, an A/P vendor, or a whole-page summary) and
 * it opens a small modal where the client types a plain-English question.
 * Submitting POSTs to /api/portal/ask-about, which persists to audit_log and
 * emails the Ironbooks team (admin@ironbooks.com).
 *
 * Variants:
 *   "icon"  → bare question-mark icon button (for dense rows / tables)
 *   "chip"  → pill with "Ask" label (for cards)
 *   "text"  → inline text link (for prose / summaries)
 */

export type AskKind =
  | "pl_line"
  | "bs_line"
  | "transaction"
  | "ar_customer"
  | "ap_vendor"
  | "pl_summary"
  | "bs_summary";

export interface AskAboutProps {
  kind: AskKind;
  /** The thing being asked about, e.g. an account / customer / vendor name. */
  label: string;
  /** Optional dollar figure shown in the modal snapshot. */
  amount?: number;
  /** Optional period label, e.g. "Last month (April 2026)". */
  period?: string;
  /** Extra structured detail forwarded to the Ironbooks team. */
  context?: Record<string, any>;
  /** Short human description shown under the title in the modal. */
  subtitle?: string;
  variant?: "icon" | "chip" | "text";
  className?: string;
}

const KIND_PROMPTS: Record<AskKind, string[]> = {
  pl_line: [
    "Why is this categorized here?",
    "Does this amount look right?",
    "What's included in this line?",
  ],
  bs_line: [
    "What does this account represent?",
    "Why did this balance change?",
    "Should this number be this high?",
  ],
  transaction: [
    "Is this categorized correctly?",
    "I don't recognize this — can you check?",
    "Should this be on a job instead?",
  ],
  ar_customer: [
    "Has this customer actually not paid?",
    "Can you double-check these invoices?",
    "Is anything here a duplicate?",
  ],
  ap_vendor: [
    "Do I actually still owe this?",
    "Is this bill a duplicate?",
    "When is this really due?",
  ],
  pl_summary: [
    "Can you walk me through this month?",
    "Why did my profit move like this?",
    "Is my margin where it should be?",
  ],
  bs_summary: [
    "Explain my balance sheet simply.",
    "Is my business financially healthy?",
    "What should I keep an eye on?",
  ],
};

export function AskAboutButton({
  kind,
  label,
  amount,
  period,
  context,
  subtitle,
  variant = "icon",
  className = "",
}: AskAboutProps) {
  const [open, setOpen] = useState(false);

  const trigger = (() => {
    if (variant === "chip") {
      return (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full border border-teal/30 text-teal-dark bg-white hover:bg-teal/5 transition-colors ${className}`}
          title="Ask your Ironbooks team about this"
        >
          <MessageCircleQuestion size={12} />
          Ask
        </button>
      );
    }
    if (variant === "text") {
      return (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className={`inline-flex items-center gap-1.5 text-xs font-semibold text-teal-dark hover:underline ${className}`}
        >
          <MessageCircleQuestion size={13} />
          Ask Ironbooks about this
        </button>
      );
    }
    // icon
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={`text-ink-light hover:text-teal-dark transition-colors p-1 rounded hover:bg-teal/5 ${className}`}
        title="Ask your Ironbooks team about this"
      >
        <MessageCircleQuestion size={14} />
      </button>
    );
  })();

  return (
    <>
      {trigger}
      {open && (
        <AskAboutModal
          kind={kind}
          label={label}
          amount={amount}
          period={period}
          context={context}
          subtitle={subtitle}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AskAboutModal({
  kind,
  label,
  amount,
  period,
  context,
  subtitle,
  onClose,
}: AskAboutProps & { onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<null | "email_and_audit_log" | "audit_log_only" | "skipped_impersonating">(null);
  const [error, setError] = useState<string | null>(null);

  const prompts = KIND_PROMPTS[kind] || [];

  async function submit() {
    const trimmed = question.trim();
    if (!trimmed) {
      setError("Type your question first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/ask-about", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, label, amount, period, question: trimmed, context }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setDone(body.delivered || "audit_log_only");
    } catch (e: any) {
      setError(e?.message || "Couldn't send your question — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] bg-navy/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-lg w-full shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Gradient header */}
        <div className="bg-gradient-to-r from-teal-dark to-teal px-5 py-4 text-white flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-white/15 flex items-center justify-center">
              <MessageCircleQuestion size={18} />
            </div>
            <div>
              <h3 className="font-bold leading-tight">Ask your Ironbooks team</h3>
              <div className="text-xs text-white/80">
                {subtitle || "We'll review and reply by email."}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {done ? (
            <>
              <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                <CheckCircle2 size={20} className="text-emerald-700 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-emerald-900">
                  <strong className="block">
                    {done === "skipped_impersonating"
                      ? "Preview mode — not sent"
                      : "Sent to your Ironbooks team."}
                  </strong>
                  <span className="text-xs">
                    {done === "skipped_impersonating"
                      ? "You're viewing as an admin, so this test question wasn't delivered."
                      : "A real person will look at this and reply to your email. Nothing in your books changes in the meantime."}
                  </span>
                </div>
              </div>
              <button
                onClick={onClose}
                className="w-full px-4 py-2.5 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark"
              >
                Done
              </button>
            </>
          ) : (
            <>
              {/* Snapshot of what's being asked about */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-slate mb-1">
                  You're asking about
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="font-semibold text-navy truncate" title={label}>
                    {label || "This item"}
                  </div>
                  {amount != null && (
                    <div className="font-mono font-bold text-navy flex-shrink-0">
                      {fmtMoney(amount)}
                    </div>
                  )}
                </div>
                {period && <div className="text-xs text-ink-slate mt-0.5">{period}</div>}
              </div>

              {/* Quick-prompt chips */}
              {prompts.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {prompts.map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        setQuestion(p);
                        if (error) setError(null);
                      }}
                      className="text-[11px] px-2.5 py-1 rounded-full bg-teal/5 border border-teal/20 text-teal-dark hover:bg-teal/10"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}

              <div>
                <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider">
                  Your question
                </label>
                <textarea
                  value={question}
                  onChange={(e) => {
                    setQuestion(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="e.g. Why is this under overhead instead of job costs? Or: this looks higher than I expected — can you double-check?"
                  maxLength={4000}
                  rows={4}
                  autoFocus
                  className="mt-1 w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:border-teal/50 focus:outline-none"
                />
                <div className="text-[11px] text-ink-light mt-1">
                  Your team sees this question plus the item details above.
                </div>
              </div>

              {error && (
                <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                  {error}
                </div>
              )}

              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={onClose}
                  disabled={submitting}
                  className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-semibold text-ink-slate hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={submit}
                  disabled={submitting || !question.trim()}
                  className="px-4 py-1.5 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {submitting ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                  {submitting ? "Sending…" : "Send to Ironbooks"}
                </button>
              </div>
              <div className="text-[11px] text-ink-light flex items-center gap-1">
                <Sparkles size={11} className="text-teal-dark" />
                Want an instant answer instead?{" "}
                <a href="/portal/ask-ai" className="text-teal-dark font-semibold hover:underline">
                  Ask the AI
                </a>
                .
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return (
    sign +
    abs.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    })
  );
}
