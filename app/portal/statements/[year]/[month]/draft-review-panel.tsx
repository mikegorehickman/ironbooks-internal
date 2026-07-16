"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, MessageCircleQuestion, Building2 } from "lucide-react";

/**
 * The DRAFT gut-check panel (Mike, 2026-07-15 / 07-16). Shown under the
 * statements for months delivered in the draft stage. The client confirms a
 * short checklist, then approves ("looks right") or sends what's missing.
 * Framing splits by client age; the accounts question lists the accounts we
 * actually have so the client can spot a missing one. GST/HST is intentionally
 * omitted until the tax engine ships.
 */

export interface PortalAccount {
  name: string;
  kind: string; // "Bank" | "Credit card" | "Loan / liability"
}

const QUESTIONS: { id: string; label: string }[] = [
  { id: "revenue_complete", label: "Is all of your revenue showing here?" },
  { id: "accounts_complete", label: "Are ALL your bank accounts, credit cards, and loans included?" },
  { id: "cash_payments", label: "Have you paid anyone in cash that isn't reflected here?" },
];

// Which answer is the "all good" one — cash_payments is inverted (a "No,
// no cash payments" is the clean answer).
const GOOD_ANSWER: Record<string, boolean> = {
  revenue_complete: true,
  accounts_complete: true,
  cash_payments: false,
};

export function DraftReviewPanel({
  periodYear,
  periodMonth,
  existingStatus,
  established,
  accounts,
}: {
  periodYear: number;
  periodMonth: number;
  existingStatus: "approved" | "questions" | "info_added" | null;
  established: boolean;
  accounts: PortalAccount[];
}) {
  const [answers, setAnswers] = useState<Record<string, boolean | null>>(
    Object.fromEntries(QUESTIONS.map((q) => [q.id, null]))
  );
  const [note, setNote] = useState("");
  const [missingAccount, setMissingAccount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<null | "approved" | "info_added">(
    existingStatus === "approved" ? "approved" : existingStatus === "info_added" ? "info_added" : null
  );
  const [error, setError] = useState("");

  const allAnswered = QUESTIONS.every((q) => answers[q.id] !== null);
  const anyConcern = QUESTIONS.some((q) => answers[q.id] !== null && answers[q.id] !== GOOD_ANSWER[q.id]);
  const accountsMissing = answers.accounts_complete === false;

  async function submit(status: "approved" | "info_added") {
    setSubmitting(true);
    setError("");
    try {
      // Fold the "missing account" detail into the note so it reaches the
      // bookkeeper alongside everything else.
      const parts: string[] = [];
      if (missingAccount.trim()) parts.push(`Missing account(s): ${missingAccount.trim()}`);
      if (note.trim()) parts.push(note.trim());
      const combinedNote = parts.join("\n") || undefined;

      const res = await fetch("/api/portal/statement-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period_year: periodYear, period_month: periodMonth, status, answers, note: combinedNote }),
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
        {established ? (
          <>
            <p className="text-sm text-ink-slate mt-2.5 leading-relaxed">
              We&apos;ve marked this a <strong>draft</strong> because we&apos;d like your sign-off
              before we call it verified. We build these numbers from your bank feeds, statements,
              and records — but <strong>you know your business best</strong>, and a quick look from
              you is the surest way to catch anything we can&apos;t see from the outside: an account
              or credit card we don&apos;t have yet, cash that changed hands, or revenue landing in
              an unexpected place.
            </p>
            <p className="text-sm text-ink-slate mt-2 leading-relaxed">
              Take 2 minutes to check the numbers above and answer the questions below. When
              you&apos;re happy everything is right, approve it — once our senior team signs off,
              your books are <strong>verified</strong> and we carry on as normal. Anything looks
              off? Tell us and we&apos;ll fix it first.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-ink-slate mt-2.5 leading-relaxed">
              For the first month or two of doing your books, your statements go out as a{" "}
              <strong>draft</strong> — completely normal, and it happens with every new client.
              We&apos;ve built these numbers from the bank feeds, statements, and records we have so
              far, but early on there can be things we can&apos;t see from the outside: an account
              or credit card we don&apos;t know about yet, cash jobs, or revenue that lands somewhere
              unexpected.
            </p>
            <p className="text-sm text-ink-slate mt-2 leading-relaxed">
              <strong>You know your business best.</strong> Take 2 minutes to gut-check the numbers
              above and answer the questions below. Once you confirm everything looks right — and our
              senior team signs off — your books are marked <strong>verified</strong>, and future
              statements arrive without the draft label. If anything looks off, tell us below and
              we&apos;ll chase it down before anything is finalized.
            </p>
          </>
        )}
      </div>

      <div className="space-y-2.5">
        {QUESTIONS.map((q) => (
          <div key={q.id}>
            <div className="flex items-center justify-between gap-3 bg-amber-50/50 rounded-lg border border-amber-200 px-3 py-2.5">
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

            {/* Accounts question: show what we have on file so the client can
                confirm at a glance and name anything missing. */}
            {q.id === "accounts_complete" && (
              <div className="mt-1.5 ml-1 pl-3 border-l-2 border-amber-200 space-y-2">
                {accounts.length > 0 ? (
                  <div>
                    <div className="text-[11px] font-semibold text-ink-slate mb-1">
                      Accounts we have on file for you:
                    </div>
                    <ul className="space-y-0.5">
                      {accounts.map((a, i) => (
                        <li key={i} className="flex items-center gap-1.5 text-[12px] text-navy">
                          <Building2 size={11} className="text-ink-light flex-shrink-0" />
                          <span className="font-medium">{a.name}</span>
                          <span className="text-ink-light">· {a.kind}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="text-[11px] text-ink-slate">
                    We couldn&apos;t list your accounts here right now — if any bank, card, or loan is
                    missing, tell us below.
                  </div>
                )}
                {accountsMissing && (
                  <div>
                    <label className="text-[11px] font-semibold text-amber-800 block mb-1">
                      Which account(s) are missing? Add the bank/lender name and rough balance so we can add it.
                    </label>
                    <textarea
                      value={missingAccount}
                      onChange={(e) => setMissingAccount(e.target.value)}
                      rows={2}
                      maxLength={1000}
                      placeholder="e.g. RBC line of credit ending 4021, ~$8,000 owing; and a Home Depot card we opened in May"
                      className="w-full text-sm rounded-lg border border-amber-300 bg-amber-50/40 px-3 py-2 text-navy placeholder:text-gray-400 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div>
        <label className="text-xs font-semibold text-navy block mb-1">
          Anything else that looks off, or info we&apos;re missing? {anyConcern && <span className="text-amber-700">(tell us more)</span>}
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="e.g. The revenue looks low — we did a big job for the Hendricks in June that I don't see here…"
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
          disabled={submitting || (!note.trim() && !missingAccount.trim() && !anyConcern)}
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
