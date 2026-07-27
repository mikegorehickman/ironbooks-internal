"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2, Loader2, PartyPopper, FileQuestion, CircleDollarSign, ChevronLeft,
} from "lucide-react";

/**
 * The card flow: one open invoice at a time, three honest answers. "It was
 * paid" reveals the machine-proposed payment candidates as radio rows —
 * confirmation, not matching. All copy is client-facing: plain, no
 * bookkeeping jargon, never "our books are wrong."
 *
 * Light theme — matches the Categorize page's card language (white cards on
 * canvas, navy text; the portal sidebar is the only dark surface).
 */

interface Candidate {
  txn_id: string;
  date: string;
  account: string;
  customer: string | null;
  amount: number;
  tax_label: string;
  same_customer: boolean;
  exact_eligible: boolean;
}

interface Item {
  id: string;
  qbo_invoice_id: string;
  doc_number: string | null;
  customer_name: string | null;
  txn_date: string;
  amount: number;
  balance: number;
  candidates: Candidate[];
  answer: string | null;
  answered_at: string | null;
  outcome: string | null;
}

const money = (n: number) =>
  "$" + Math.abs(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateLabel = (iso: string) =>
  new Date(iso + (iso?.length === 10 ? "T12:00:00" : "")).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });

export function InvoiceCheckClient({
  clientName,
  hasSession,
  initialItems,
}: {
  clientName: string;
  hasSession: boolean;
  initialItems: Item[];
}) {
  const [items, setItems] = useState<Item[]>(initialItems);
  const open = useMemo(() => items.filter((i) => !i.answered_at), [items]);
  const done = items.length - open.length;

  if (!hasSession || items.length === 0) {
    return (
      <div className="bg-white border border-cardline rounded-2xl p-10 text-center">
        <CheckCircle2 size={32} className="mx-auto text-teal mb-3" />
        <h1 className="text-lg font-bold text-navy">Nothing to review</h1>
        <p className="text-sm text-ink-slate mt-1.5 max-w-md mx-auto">
          You&apos;re all caught up — there are no invoices waiting on your confirmation right now.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-2 text-teal-dark text-xs font-bold uppercase tracking-wider mb-1">
          <FileQuestion size={14} /> Invoice check
        </div>
        <h1 className="font-brand text-3xl font-semibold text-navy leading-none mt-1.5">
          Which of these are still outstanding?
        </h1>
        <p className="text-sm text-ink-slate mt-3 max-w-xl">
          These invoices show as unpaid in QuickBooks. Some were probably paid already — the payment
          just never got connected. Confirm what happened with each one; it keeps {clientName}&apos;s
          numbers (and your who-owes-you list) accurate.
        </p>
        {/* Progress */}
        <div className="mt-4 flex items-center gap-3">
          <div className="h-1.5 flex-1 rounded-full bg-gray-200 overflow-hidden">
            <div
              className="h-full bg-teal transition-all"
              style={{ width: `${(done / items.length) * 100}%` }}
            />
          </div>
          <span className="text-xs text-ink-light tabular-nums">
            {done} of {items.length}
          </span>
        </div>
      </div>

      {open.length === 0 ? (
        <div className="bg-white border border-cardline rounded-2xl p-10 text-center">
          <PartyPopper size={30} className="mx-auto text-teal mb-3" />
          <h2 className="text-lg font-bold text-navy">All done — thank you!</h2>
          <p className="text-sm text-ink-slate mt-1.5 max-w-md mx-auto">
            Your bookkeeper takes it from here. Anything you marked as still owed will show on your
            &ldquo;Who owes you&rdquo; page so you can follow up.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {open.map((item) => (
            <InvoiceCard
              key={item.id}
              item={item}
              onAnswered={(updated) =>
                setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InvoiceCard({ item, onAnswered }: { item: Item; onAnswered: (i: Item) => void }) {
  const [mode, setMode] = useState<"choice" | "pick_payment" | "note">("choice");
  const [pendingAnswer, setPendingAnswer] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const candidates = item.candidates || [];

  async function submit(answer: string, depositTxnId?: string | null, noteText?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/ar-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: item.id,
          answer,
          deposit_txn_id: depositTxnId || undefined,
          note: noteText || undefined,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setFlash(
        j.applied
          ? "Matched — we've connected that payment to this invoice."
          : answer === "still_owed"
          ? "Noted as still owed."
          : "Thanks — sent to your bookkeeper."
      );
      // Brief confirmation, then the card leaves the open list.
      setTimeout(() => {
        onAnswered({ ...item, answer, answered_at: new Date().toISOString(), outcome: j.outcome });
      }, 900);
    } catch (e: any) {
      setError(e?.message || "Couldn't save that — try again");
      setBusy(false);
    }
  }

  return (
    <div className="bg-white border border-cardline rounded-2xl p-5">
      {/* Invoice header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-ink-light">
            Invoice {item.doc_number ? `#${item.doc_number}` : ""} · {dateLabel(item.txn_date)}
          </div>
          <div className="text-base font-bold text-navy mt-0.5 truncate">
            {item.customer_name || "(no customer)"}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold text-navy tabular-nums">{money(item.balance)}</div>
          <div className="text-[11px] text-ink-light">unpaid balance</div>
        </div>
      </div>

      {flash ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-teal-dark font-semibold">
          <CheckCircle2 size={16} /> {flash}
        </div>
      ) : mode === "choice" ? (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <button
            disabled={busy}
            onClick={() => {
              setPendingAnswer("paid_matched");
              setMode(candidates.length > 0 ? "pick_payment" : "note");
            }}
            className="rounded-xl border border-teal bg-teal-light px-3 py-2.5 text-sm font-semibold text-teal-dark hover:bg-teal hover:text-white transition-colors"
          >
            It was paid
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setPendingAnswer("not_owed");
              setMode("note");
            }}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm font-semibold text-ink-slate hover:border-navy hover:text-navy transition-colors"
          >
            Not a real invoice
          </button>
          <button
            disabled={busy}
            onClick={() => submit("still_owed")}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm font-semibold text-ink-slate hover:border-navy hover:text-navy transition-colors"
          >
            {busy ? <Loader2 size={14} className="inline animate-spin" /> : "Still owed"}
          </button>
        </div>
      ) : mode === "pick_payment" ? (
        <div className="mt-4">
          <div className="text-sm text-ink-slate mb-2">Great — was it one of these payments?</div>
          <div className="space-y-1.5">
            {candidates.map((c) => (
              <label
                key={c.txn_id}
                className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                  picked === c.txn_id
                    ? "border-teal bg-teal-light"
                    : "border-gray-200 bg-white hover:border-teal/50"
                }`}
              >
                <input
                  type="radio"
                  name={`cand-${item.id}`}
                  checked={picked === c.txn_id}
                  onChange={() => setPicked(c.txn_id)}
                  className="accent-[#3E908D]"
                />
                <CircleDollarSign size={16} className="text-teal shrink-0" />
                <span className="flex-1 min-w-0 text-sm text-navy">
                  <strong className="tabular-nums">{money(c.amount)}</strong>
                  <span className="text-ink-slate"> received {dateLabel(c.date)}</span>
                  {c.customer && <span className="text-ink-slate"> · from {c.customer}</span>}
                </span>
                {c.exact_eligible && (
                  <span className="text-[10px] font-bold text-teal-dark bg-teal-light border border-teal-border rounded-full px-1.5 py-0.5 shrink-0">
                    exact match
                  </span>
                )}
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button
              disabled={!picked || busy}
              onClick={() => submit("paid_matched", picked)}
              className="rounded-xl bg-teal px-4 py-2 text-sm font-bold text-white hover:bg-teal-dark disabled:opacity-40 transition-colors"
            >
              {busy ? <Loader2 size={14} className="inline animate-spin" /> : "Confirm match"}
            </button>
            <button
              disabled={busy}
              onClick={() => { setPendingAnswer("paid_no_match"); setMode("note"); }}
              className="text-sm font-semibold text-ink-slate hover:text-navy px-2 py-2"
            >
              None of these
            </button>
            <button
              disabled={busy}
              onClick={() => { setMode("choice"); setPicked(null); }}
              className="ml-auto inline-flex items-center gap-1 text-sm text-ink-light hover:text-navy px-2 py-2"
            >
              <ChevronLeft size={14} /> Back
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <div className="text-sm text-ink-slate mb-2">
            {pendingAnswer === "not_owed"
              ? "No problem — what happened with it? (cancelled job, duplicate, something else)"
              : "OK — anything that helps us find the payment? (roughly when, how it was paid, the amount)"}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Optional, but it helps"
            className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-navy placeholder:text-ink-light focus:outline-none focus:border-teal"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              disabled={busy}
              onClick={() =>
                submit(pendingAnswer === "not_owed" ? "not_owed" : "paid_no_match", null, note)
              }
              className="rounded-xl bg-teal px-4 py-2 text-sm font-bold text-white hover:bg-teal-dark disabled:opacity-40 transition-colors"
            >
              {busy ? <Loader2 size={14} className="inline animate-spin" /> : "Send"}
            </button>
            <button
              disabled={busy}
              onClick={() => { setMode("choice"); setNote(""); }}
              className="inline-flex items-center gap-1 text-sm text-ink-light hover:text-navy px-2 py-2"
            >
              <ChevronLeft size={14} /> Back
            </button>
          </div>
        </div>
      )}

      {error && <div className="mt-3 text-sm text-red-600">{error}</div>}
    </div>
  );
}
