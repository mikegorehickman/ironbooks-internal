"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, MessageCircleQuestion } from "lucide-react";

/**
 * The DRAFT gut-check panel (Mike, 2026-07-15). Shown under the DRAFT
 * banner for months delivered while the client is in the draft stage.
 * The client confirms a short checklist, then either approves ("looks
 * right") or sends us what's missing. Questions route to the existing
 * portal Messages thread.
 */

const QUESTIONS: { id: string; label: string }[] = [
  { id: "revenue_complete", label: "Is all of your revenue showing here?" },
  { id: "accounts_complete", label: "Are ALL your bank accounts, credit cards, and loans included?" },
  { id: "cash_payments", label: "Have you paid anyone in cash that isn't reflected here?" },
  { id: "tax_ok", label: "Does the sales tax (GST/HST) look right to you?" },
];

// Which answer is the "all good" one — cash_payments is inverted (a "No,
// no cash payments" is the clean answer).
const GOOD_ANSWER: Record<string, boolean> = {
  revenue_complete: true,
  accounts_complete: true,
  cash_payments: false,
  tax_ok: true,
};

export function DraftReviewPanel({
  periodYear,
  periodMonth,
  existingStatus,
}: {
  periodYear: number;
  periodMonth: number;
  existingStatus: "approved" | "questions" | "info_added" | null;
}) {
  const [answers, setAnswers] = useState<Record<string, boolean | null>>(
    Object.fromEntries(QUESTIONS.map((q) => [q.id, null]))
  );
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<null | "approved" | "info_added">(
    existingStatus === "approved" ? "approved" : existingStatus === "info_added" ? "info_added" : null
  );
  const [error, setError] = useState("");

  const allAnswered = QUESTIONS.every((q) => answers[q.id] !== null);
  const anyConcern = QUESTIONS.some((q) => answers[q.id] !== null && answers[q.id] !== GOOD_ANSWER[q.id]);

  async function submit(status: "approved" | "info_added") {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/portal/statement-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period_year: periodYear,
          period_month: periodMonth,
          status,
          answers,
          note: note.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Couldn't save your review — please try again.");
        return;
      }
      setDone(status);
    } catch (e: any) {
      setError(e?.message || "Couldn't save your review — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done === "approved") {
    return (
      <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-5">
        <div className="flex items-center gap-2 text-emerald-800 font-bold">
          <CheckCircle2 size={18} />
          Thanks — you&apos;ve confirmed this draft looks right.
        </div>
        <p className="text-sm text-emerald-900/80 mt-1.5">
          Your bookkeeping team will review your confirmation and move your books to
          <strong> verified</strong>. If anything changes, just message us from the portal.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border-2 border-amber-300 bg-white p-6 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black tracking-widest bg-amber-600 text-white px-2 py-0.5 rounded">
            DRAFT
          </span>
          <span className="text-sm font-bold text-navy">
            Why is this a draft — and what we need from you
          </span>
        </div>
        <p className="text-sm text-ink-slate mt-2.5 leading-relaxed">
          For the first month or two of doing your books, your statements go out as a{" "}
          <strong>draft</strong> — this is completely normal and happens with every new client.
          We&apos;ve built these numbers from the bank feeds, statements, and records we have so
          far, but early on there can be things we can&apos;t see from the outside: an account or
          credit card we don&apos;t know about yet, cash jobs, or revenue that lands somewhere
          unexpected.
        </p>
        <p className="text-sm text-ink-slate mt-2 leading-relaxed">
          <strong>You know your business best.</strong> Take 2 minutes to gut-check the numbers
          above and answer the questions below. Once you confirm everything looks right — and our
          senior team signs off — your books are marked <strong>verified</strong>, and future
          statements arrive without the draft label. If anything looks off, tell us below and
          we&apos;ll chase it down before anything is finalized.
        </p>
      </div>

      <div className="space-y-2.5">
        {QUESTIONS.map((q) => (
          <div key={q.id} className="flex items-center justify-between gap-3 bg-amber-50/50 rounded-lg border border-amber-200 px-3 py-2.5">
            <span className="text-sm text-navy">{q.label}</span>
            <div className="flex gap-1.5 flex-shrink-0">
              {([true, false] as const).map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors ${
                    answers[q.id] === v
                      ? v === GOOD_ANSWER[q.id]
                        ? "bg-emerald-600 border-emerald-600 text-white"
                        : "bg-amber-600 border-amber-600 text-white"
                      : "bg-white border-gray-300 text-ink-slate hover:border-navy"
                  }`}
                >
                  {v ? "Yes" : "No"}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div>
        <label className="text-xs font-semibold text-navy block mb-1">
          Anything else that looks off, or info we&apos;re missing? {anyConcern && <span className="text-amber-700">(tell us more below)</span>}
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="e.g. We opened a new credit card in May that I don't see here…"
          className="w-full text-sm rounded-lg border border-amber-200 bg-amber-50/30 px-3 py-2 text-navy placeholder:text-gray-400 focus:outline-none focus:border-amber-500"
        />
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {done === "info_added" && (
        <p className="text-sm text-emerald-800 font-semibold">
          Got it — your bookkeeping team has been notified. You can still approve once everything looks right.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          disabled={submitting || !allAnswered || anyConcern}
          onClick={() => submit("approved")}
          title={
            !allAnswered
              ? "Answer every question first"
              : anyConcern
              ? "You flagged a concern — send us the details instead, and approve once it's fixed"
              : undefined
          }
          className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold px-4 py-2.5 rounded-lg disabled:opacity-50"
        >
          {submitting ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
          Looks right — approve this draft
        </button>
        <button
          type="button"
          disabled={submitting || (!note.trim() && !anyConcern)}
          onClick={() => submit("info_added")}
          className="inline-flex items-center gap-2 bg-white border border-amber-400 text-amber-800 hover:bg-amber-100 text-sm font-semibold px-4 py-2.5 rounded-lg disabled:opacity-50"
        >
          Send this to my bookkeeper
        </button>
        <Link
          href="/portal/messages"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-teal-dark hover:underline"
        >
          <MessageCircleQuestion size={15} />
          Ask a question instead
        </Link>
      </div>
    </div>
  );
}
