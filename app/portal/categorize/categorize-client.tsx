"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronDown, Loader2, Send } from "lucide-react";

export interface AskRow {
  id: string;
  date: string | null;
  amount: number | null;
  label: string;
  detail: string | null;
  fromAccount: string | null;
  responseAccount: string | null;
  responseNote: string | null;
}

export interface AccountOption {
  name: string;
  fqn: string;
}

const OTHER = "__other__";

/**
 * Interactive answer list. Each open row gets a grouped dropdown
 * (transfers between own accounts / business categories / other) plus an
 * optional note. Submit sends ONLY the rows the client actually answered
 * — partial answers are fine, the rest stay on the list.
 */
export function CategorizeClient({
  open,
  answered,
  transferOptions,
  categoryOptions,
  accountsError,
}: {
  open: AskRow[];
  answered: AskRow[];
  transferOptions: AccountOption[];
  categoryOptions: AccountOption[];
  accountsError: boolean;
}) {
  const router = useRouter();
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState<number | null>(null);
  const [showAnswered, setShowAnswered] = useState(false);

  const answeredNow = open.filter((r) => {
    const p = picks[r.id];
    if (!p) return false;
    if (p === OTHER) return (notes[r.id] || "").trim().length > 0;
    return true;
  });

  async function submit() {
    if (answeredNow.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/categorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: answeredNow.map((r) => ({
            id: r.id,
            account: picks[r.id] === OTHER ? null : picks[r.id],
            note: (notes[r.id] || "").trim() || null,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      setDoneCount(answeredNow.length);
      setTimeout(() => router.refresh(), 1200);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (open.length === 0 && answered.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl p-10 text-center">
        <CheckCircle2 size={28} className="mx-auto text-emerald-500" />
        <div className="text-sm font-semibold text-navy mt-3">Nothing to categorize</div>
        <p className="text-xs text-ink-slate mt-1.5 max-w-sm mx-auto">
          You&apos;re all caught up. When your bookkeeping team needs help identifying a
          transaction, it will show up here (and we&apos;ll email you).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {doneCount !== null && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-2.5 text-sm text-emerald-800">
          <CheckCircle2 size={18} className="flex-shrink-0" />
          Thanks! {doneCount} answer{doneCount === 1 ? "" : "s"} sent to your bookkeeping team.
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          {error}
        </div>
      )}
      {accountsError && open.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-800">
          We couldn&apos;t load your account list just now, so the dropdowns are limited — you can
          still answer with a note on each transaction.
        </div>
      )}

      {open.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-bold text-navy">
                Needs your answer ({open.length})
              </div>
              <div className="text-xs text-ink-slate mt-0.5">
                If money just moved between your own accounts, pick it under &quot;Money moved
                between my accounts.&quot;
              </div>
            </div>
            <button
              onClick={submit}
              disabled={answeredNow.length === 0 || submitting}
              className="inline-flex items-center gap-1.5 text-sm font-semibold bg-teal text-white px-4 py-2 rounded-lg hover:bg-teal-dark disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send {answeredNow.length > 0 ? `${answeredNow.length} answer${answeredNow.length === 1 ? "" : "s"}` : "answers"}
            </button>
          </div>
          <ul className="divide-y divide-gray-100">
            {open.map((r) => {
              const pick = picks[r.id] || "";
              return (
                <li key={r.id} className="px-5 py-4">
                  <div className="flex flex-col md:flex-row md:items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2.5 flex-wrap">
                        <span className="text-xs text-ink-slate flex-shrink-0">{fmtDate(r.date)}</span>
                        <span className="font-mono text-sm font-semibold text-navy">{fmtMoney(r.amount)}</span>
                      </div>
                      <div className="text-sm font-medium text-navy mt-0.5 break-words">{r.label}</div>
                      {r.detail && (
                        <div className="text-xs text-ink-slate mt-0.5 break-words">{r.detail}</div>
                      )}
                      {r.fromAccount && (
                        <div className="text-[11px] text-ink-light mt-0.5">from {r.fromAccount}</div>
                      )}
                    </div>
                    <div className="w-full md:w-80 flex-shrink-0 space-y-2">
                      <div className="relative">
                        <select
                          value={pick}
                          onChange={(e) => setPicks((p) => ({ ...p, [r.id]: e.target.value }))}
                          className={`w-full appearance-none border rounded-lg px-3 py-2 pr-8 text-sm bg-white ${
                            pick ? "border-teal text-navy" : "border-gray-300 text-ink-slate"
                          }`}
                        >
                          <option value="">What was this for?</option>
                          {transferOptions.length > 0 && (
                            <optgroup label="Money moved between my accounts">
                              {transferOptions.map((a) => (
                                <option key={`t-${a.fqn}`} value={`Transfer to/from: ${a.fqn}`}>
                                  Transfer to/from {a.fqn}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          {categoryOptions.length > 0 && (
                            <optgroup label="Business categories">
                              {categoryOptions.map((a) => (
                                <option key={`c-${a.fqn}`} value={a.fqn}>
                                  {a.fqn}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          <optgroup label="Something else">
                            <option value={OTHER}>Other / not sure — I&apos;ll explain below</option>
                          </optgroup>
                        </select>
                        <ChevronDown
                          size={14}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-light pointer-events-none"
                        />
                      </div>
                      <input
                        type="text"
                        value={notes[r.id] || ""}
                        onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                        placeholder={
                          pick === OTHER
                            ? "Tell us what this was (required)"
                            : "Add a note (optional)"
                        }
                        maxLength={500}
                        className={`w-full border rounded-lg px-3 py-2 text-sm ${
                          pick === OTHER && !(notes[r.id] || "").trim()
                            ? "border-amber-300 bg-amber-50/50"
                            : "border-gray-200"
                        }`}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {answered.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <button
            onClick={() => setShowAnswered((s) => !s)}
            className="w-full px-5 py-3.5 flex items-center justify-between text-left"
          >
            <span className="text-sm font-bold text-navy">
              Already answered ({answered.length})
            </span>
            <ChevronDown
              size={16}
              className={`text-ink-light transition-transform ${showAnswered ? "rotate-180" : ""}`}
            />
          </button>
          {showAnswered && (
            <ul className="divide-y divide-gray-100 border-t border-gray-100">
              {answered.map((r) => (
                <li key={r.id} className="px-5 py-3 flex items-start justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <span className="text-xs text-ink-slate mr-2">{fmtDate(r.date)}</span>
                    <span className="font-mono text-sm font-medium text-navy mr-2">{fmtMoney(r.amount)}</span>
                    <span className="text-navy/85 break-words">{r.label}</span>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-full">
                      <CheckCircle2 size={11} />
                      {r.responseAccount || "Explained in note"}
                    </span>
                    {r.responseNote && (
                      <div className="text-[11px] text-ink-slate mt-1 max-w-[220px] truncate" title={r.responseNote}>
                        &quot;{r.responseNote}&quot;
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtMoney(n: number | null): string {
  const v = Math.abs(Number(n) || 0);
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
