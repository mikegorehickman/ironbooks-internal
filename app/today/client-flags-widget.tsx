"use client";

import { useState } from "react";
import {
  Flag, Clock, CheckCircle2, X, Loader2, MessageSquare,
  ThumbsDown, ChevronDown, ChevronUp,
} from "lucide-react";

interface PendingFlag {
  id: string;
  client_link_id: string;
  client_name: string;
  submitted_at: string;
  submitter_name: string;
  submitter_email: string;
  qbo_txn_id: string | null;
  qbo_txn_type: string | null;
  qbo_account_id: string;
  account_label: string | null;
  txn_date: string | null;
  txn_amount: number | null;
  txn_doc_number: string | null;
  txn_vendor_or_customer: string | null;
  txn_memo: string | null;
  period_label: string | null;
  period_start: string | null;
  period_end: string | null;
  client_note: string;
  status: "pending" | "in_review";
}

/**
 * Today-page widget showing pending portal transaction flags from clients.
 * Each flag is one card with the snapshot + client note + action row
 * (acknowledge, mark applied, decline, dismiss). Resolutions write a
 * note back that the client sees.
 *
 * Once a flag is resolved client-side, we just remove it from the visible
 * list — no need to refetch. A page refresh shows the canonical state.
 */
export function ClientFlagsWidget({ flags: initial }: { flags: PendingFlag[] }) {
  const [flags, setFlags] = useState<PendingFlag[]>(initial);
  // Home shows the top 5; nothing on Home ever scrolls 20+ rows.
  const [showAll, setShowAll] = useState(false);
  const visibleFlags = showAll ? flags : flags.slice(0, 5);

  if (flags.length === 0) return null;

  return (
    <section className="bg-white rounded-2xl border-2 border-amber-300 overflow-hidden">
      <div className="px-5 py-3 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
        <Flag size={16} className="text-amber-700" />
        <h2 className="text-sm font-bold text-amber-900 uppercase tracking-wider">
          Client flags · {flags.length} pending
        </h2>
        <span className="text-xs text-amber-700 ml-auto">
          Clients have raised these for your attention
        </span>
      </div>
      <ul className="divide-y divide-amber-100">
        {visibleFlags.map((f) => (
          <li key={f.id}>
            <FlagRow
              flag={f}
              onResolved={() =>
                setFlags((prev) => prev.filter((x) => x.id !== f.id))
              }
            />
          </li>
        ))}
      </ul>
      {flags.length > 5 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="w-full px-5 py-2.5 text-left text-xs font-semibold text-teal-dark hover:text-navy border-t border-hairline transition-colors"
        >
          {showAll ? "Show top 5" : `Show all ${flags.length}`}
        </button>
      )}
    </section>
  );
}

function FlagRow({ flag, onResolved }: { flag: PendingFlag; onResolved: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [acting, setActing] = useState(false);
  const [showReply, setShowReply] = useState<"applied" | "declined" | "dismissed" | null>(null);
  const [replyNote, setReplyNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function resolve(status: "in_review" | "applied" | "declined" | "dismissed", note?: string) {
    setActing(true);
    setError(null);
    try {
      const res = await fetch(`/api/today/transaction-flags/${flag.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, resolution_note: note || null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (status === "in_review") {
        // Soft state — keep the row visible but mark it visually
        flag.status = "in_review";
        setActing(false);
        return;
      }
      onResolved();
    } catch (e: any) {
      setError(e?.message || "Action failed");
      setActing(false);
    }
  }

  const hoursAgo = Math.floor((Date.now() - new Date(flag.submitted_at).getTime()) / 3_600_000);

  return (
    <div className="px-5 py-3 hover:bg-amber-50/30 transition-colors">
      <div className="flex items-start gap-3">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-amber-600 hover:text-amber-800 mt-0.5 flex-shrink-0"
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-navy">{flag.client_name}</span>
            {flag.status === "in_review" && (
              <span className="text-[10px] font-bold bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">
                IN REVIEW
              </span>
            )}
            <span className="text-xs text-ink-light">
              <Clock size={10} className="inline mr-0.5" />
              {hoursAgo === 0 ? "just now" : hoursAgo < 24 ? `${hoursAgo}h ago` : `${Math.floor(hoursAgo / 24)}d ago`}
            </span>
            <span className="text-xs text-ink-slate">· {flag.submitter_name || flag.submitter_email || "client"}</span>
          </div>

          <div className="mt-1.5 flex items-start gap-3 flex-wrap text-xs">
            <span className="font-semibold text-amber-900">
              <Flag size={10} className="inline mr-0.5" />
              {flag.account_label || "(account)"}
            </span>
            {flag.txn_date && <span className="text-ink-slate">{flag.txn_date}</span>}
            {flag.txn_vendor_or_customer && <span className="text-ink-slate">· {flag.txn_vendor_or_customer}</span>}
            {flag.txn_amount != null && (
              <span className="font-mono font-semibold text-navy">{fmtMoney(flag.txn_amount)}</span>
            )}
            {flag.txn_doc_number && (
              <span className="text-ink-light">#{flag.txn_doc_number}</span>
            )}
          </div>

          {/* Client's note — always visible, it's the whole point */}
          <div className="mt-2 text-sm text-navy bg-white border border-amber-200 rounded p-2 italic">
            "{flag.client_note}"
          </div>

          {/* Expanded detail */}
          {expanded && (
            <div className="mt-2 text-xs text-ink-slate space-y-0.5">
              {flag.txn_memo && (
                <div><strong>Memo:</strong> {flag.txn_memo}</div>
              )}
              {flag.period_label && (
                <div><strong>Period viewed:</strong> {flag.period_label} ({flag.period_start} → {flag.period_end})</div>
              )}
              {flag.qbo_txn_id && (
                <div><strong>QBO txn id:</strong> <code className="bg-slate-100 px-1 rounded">{flag.qbo_txn_id}</code></div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
              {error}
            </div>
          )}

          {/* Reply note input (shown when admin picks a terminal action) */}
          {showReply && (
            <div className="mt-2 space-y-2">
              <label className="text-[10px] uppercase tracking-wider font-semibold text-ink-slate">
                Reply to the client (optional)
              </label>
              <textarea
                value={replyNote}
                onChange={(e) => setReplyNote(e.target.value)}
                placeholder={
                  showReply === "applied"
                    ? "e.g. Good catch — moved to Job Supplies. Will reflect on next month's P&L."
                    : showReply === "declined"
                    ? "e.g. We checked and this categorization is actually correct because..."
                    : "e.g. Already handled in last month's adjustment — closing this out."
                }
                rows={2}
                className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded focus:border-teal/50 focus:outline-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => resolve(showReply, replyNote)}
                  disabled={acting}
                  className={`px-3 py-1 text-xs font-semibold rounded inline-flex items-center gap-1 ${
                    showReply === "applied"
                      ? "bg-emerald-600 text-white hover:bg-emerald-700"
                      : showReply === "declined"
                      ? "bg-red-600 text-white hover:bg-red-700"
                      : "bg-slate-500 text-white hover:bg-slate-600"
                  } disabled:opacity-50`}
                >
                  {acting ? <Loader2 size={11} className="animate-spin" /> : null}
                  Confirm {showReply}
                </button>
                <button
                  onClick={() => { setShowReply(null); setReplyNote(""); }}
                  className="px-3 py-1 text-xs font-semibold text-ink-slate hover:text-navy"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Action row */}
          {!showReply && (
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <button
                onClick={() => { setShowReply("applied"); setReplyNote(""); }}
                disabled={acting}
                className="px-2 py-1 text-xs font-semibold bg-emerald-600 text-white rounded hover:bg-emerald-700 inline-flex items-center gap-1"
                title="Mark resolved — you fixed the issue (do the actual reclass via your normal flow)"
              >
                <CheckCircle2 size={11} />
                Mark applied
              </button>
              <button
                onClick={() => { setShowReply("declined"); setReplyNote(""); }}
                disabled={acting}
                className="px-2 py-1 text-xs font-semibold border border-red-300 text-red-800 rounded hover:bg-red-50 inline-flex items-center gap-1"
                title="Decline with explanation back to the client"
              >
                <ThumbsDown size={11} />
                Decline
              </button>
              <button
                onClick={() => { setShowReply("dismissed"); setReplyNote(""); }}
                disabled={acting}
                className="px-2 py-1 text-xs font-semibold border border-slate-300 text-ink-slate hover:bg-slate-50 inline-flex items-center gap-1"
                title="Dismiss without action (already handled, duplicate, etc.)"
              >
                <X size={11} />
                Dismiss
              </button>
              {flag.status === "pending" && (
                <button
                  onClick={() => resolve("in_review")}
                  disabled={acting}
                  className="px-2 py-1 text-xs font-semibold border border-blue-300 text-blue-800 rounded hover:bg-blue-50 inline-flex items-center gap-1"
                  title="Mark you're looking into it; client sees IN REVIEW status"
                >
                  <MessageSquare size={11} />
                  Mark in review
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return sign + abs.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
