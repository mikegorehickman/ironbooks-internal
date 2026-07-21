"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Clock, FileText, RotateCcw, Loader2, ChevronDown, ChevronRight, User,
} from "lucide-react";
import { CleanupReviewModal } from "./review-modal";

export interface InReviewClient {
  id: string;
  client_name: string;
  jurisdiction: "US" | "CA";
  state_province: string | null;
  cleanup_review_submitted_at: string;
  cleanup_review_submitted_by_name: string | null;
  cleanup_range_start: string | null;
  cleanup_range_end: string | null;
}

/**
 * "In Review" partition on the clients page. Shows every client whose
 * cleanup has been submitted by a bookkeeper and is awaiting senior
 * approval. Two row actions:
 *
 *   - "Review & Approve" → opens the review modal (PDF link + copy
 *     branded email + final approve button).
 *   - "Withdraw" → bookkeeper realized more work is needed; sends the
 *     client back to the Active list. Available to anyone (the original
 *     submitter or a senior).
 *
 * Visible to seniors (admin/lead) AND to junior bookkeepers — juniors
 * see their own submissions here so they can withdraw if needed, but
 * the Approve action is gated server-side to admin/lead.
 */
export function InReviewAccounts({
  clients,
  canApprove,
}: {
  clients: InReviewClient[];
  canApprove: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [reviewing, setReviewing] = useState<InReviewClient | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [error, setError] = useState<string>("");

  async function handleWithdraw(c: InReviewClient) {
    if (
      !confirm(
        `Withdraw ${c.client_name} from the review queue?\n\n` +
          `The client moves back to your active list so you can finish more work. ` +
          `You can resubmit when ready.`
      )
    )
      return;
    setWithdrawing(c.id);
    setError("");
    try {
      const res = await fetch(`/api/clients/${c.id}/submit-for-review`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      router.refresh();
    } catch (e: any) {
      setError(`${c.client_name}: ${e.message || "Failed to withdraw"}`);
      setWithdrawing(null);
    }
  }

  const fmtDate = (iso: string | null) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const fmtAgo = (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime();
    const hrs = Math.round(ms / (3600 * 1000));
    if (hrs < 1) return "just now";
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  };

  if (clients.length === 0) return null;

  return (
    <>
      <div className="bg-white rounded-2xl border border-gray-100">
        <button
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between px-6 py-4 hover:bg-amber-50/40 rounded-t-2xl"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-amber-100 p-2">
              <Clock size={16} className="text-amber-700" />
            </div>
            <div className="text-left">
              <div className="text-sm font-bold text-navy">
                In Review ({clients.length})
              </div>
              <div className="text-xs text-ink-slate">
                {canApprove
                  ? "Cleanups awaiting your approval. Open each one to send the PDF + approve."
                  : "Your submitted cleanups, waiting for a senior to approve and send the client the PDF."}
              </div>
            </div>
          </div>
          {open ? (
            <ChevronDown size={18} className="text-ink-slate" />
          ) : (
            <ChevronRight size={18} className="text-ink-slate" />
          )}
        </button>

        {open && (
          <div className="border-t border-gray-100">
            {error && (
              <div className="m-4 p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
                {error}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-bold uppercase tracking-wider text-ink-slate border-b border-gray-100">
                    <th className="px-6 py-3">Client</th>
                    <th className="px-6 py-3">Submitted</th>
                    <th className="px-6 py-3">By</th>
                    <th className="px-6 py-3">Cleanup range</th>
                    <th className="px-6 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-gray-50 last:border-0 hover:bg-amber-50/30"
                    >
                      <td className="px-6 py-3">
                        <div className="font-semibold text-navy">
                          {c.client_name}
                        </div>
                        <div className="text-xs text-ink-light">
                          {c.jurisdiction}
                          {c.state_province ? ` · ${c.state_province}` : ""}
                        </div>
                      </td>
                      <td className="px-6 py-3 text-ink-slate">
                        <div className="font-semibold">
                          {fmtAgo(c.cleanup_review_submitted_at)}
                        </div>
                        <div className="text-[10px] text-ink-light">
                          {fmtDate(c.cleanup_review_submitted_at)}
                        </div>
                      </td>
                      <td className="px-6 py-3 text-ink-slate">
                        <span className="inline-flex items-center gap-1.5">
                          <User size={11} />
                          {c.cleanup_review_submitted_by_name || "Unknown"}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-ink-slate">
                        {c.cleanup_range_start && c.cleanup_range_end ? (
                          <span className="font-mono text-xs">
                            {c.cleanup_range_start} → {c.cleanup_range_end}
                          </span>
                        ) : (
                          <span className="text-ink-light">—</span>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {canApprove ? (
                            <button
                              onClick={() => setReviewing(c)}
                              className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-semibold px-3 py-1.5 rounded-md"
                              title="Open the review modal — view PDF, copy email, approve"
                            >
                              <FileText size={12} />
                              Review &amp; Approve
                            </button>
                          ) : (
                            <span className="text-xs text-ink-light italic">
                              Awaiting senior
                            </span>
                          )}
                          <button
                            onClick={() => handleWithdraw(c)}
                            disabled={withdrawing === c.id}
                            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-60"
                            title="Withdraw from review and send back to Active"
                          >
                            {withdrawing === c.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <RotateCcw size={12} />
                            )}
                            Withdraw
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {reviewing && (
        <CleanupReviewModal
          client={reviewing}
          onClose={() => setReviewing(null)}
        />
      )}
    </>
  );
}
