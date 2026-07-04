"use client";

import { useState } from "react";
import {
  Tag, ChevronDown, ChevronUp, Loader2, CheckCircle2, X, ThumbsDown, AlertTriangle, ArrowRight,
} from "lucide-react";

export interface PendingReclassRequest {
  id: string;
  client_link_id: string;
  client_name: string;
  requested_at: string;
  requester_name: string;
  requester_email: string;
  source_account_qbo_id: string;
  source_account_name: string | null;
  target_account_qbo_id: string;
  target_account_name: string | null;
  example_txn_id: string | null;
  vendor_name: string | null;
  client_reason: string;
  /** failed = an approve attempt errored / matched nothing; still actionable. */
  status: "pending" | "failed";
}

type PreviewState = {
  loading: boolean;
  error: string | null;
  data: PreviewResponse | null;
};
type PreviewResponse = {
  ok: true;
  period: { start: string; end: string; label: string };
  source_account: { id: string; name: string };
  target_account: { id: string; name: string };
  vendor: string | null;
  counts: {
    matched_lines: number;
    matched_transactions: number;
    reconciled_lines: number;
    account_total_lines: number;
  };
  total_amount: number;
  sample: Array<{
    transaction_id: string;
    transaction_type: string;
    transaction_date: string;
    vendor_name: string;
    amount: number;
    description: string;
    is_reconciled: boolean;
  }>;
};

const fmtMoney = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/**
 * Bookkeeper-side widget for client reclass requests. Each request is an
 * expandable card with a "Preview" call that scans QBO for matching txns,
 * then approve/decline buttons. On approve, the decide endpoint runs the
 * bulk reclass + (optionally) activates a bank_rule.
 */
export function ReclassRequestsWidget({
  requests: initial,
}: {
  requests: PendingReclassRequest[];
}) {
  const [requests, setRequests] = useState<PendingReclassRequest[]>(initial);

  if (requests.length === 0) return null;

  return (
    <section className="bg-white rounded-2xl border-2 border-violet-300 overflow-hidden">
      <div className="px-5 py-3 bg-violet-50 border-b border-violet-200 flex items-center gap-2">
        <Tag size={16} className="text-violet-700" />
        <h2 className="text-sm font-bold text-violet-900 uppercase tracking-wider">
          Client reclass requests · {requests.length} to review
        </h2>
        <span className="text-xs text-violet-700 ml-auto">
          Approve to reclassify matching txns + create a bank rule
        </span>
      </div>
      <ul className="divide-y divide-violet-100">
        {requests.map((r) => (
          <li key={r.id}>
            <ReclassRow
              req={r}
              onResolved={() =>
                setRequests((prev) => prev.filter((x) => x.id !== r.id))
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReclassRow({
  req,
  onResolved,
}: {
  req: PendingReclassRequest;
  onResolved: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ loading: false, error: null, data: null });
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Approve checkboxes
  const [alsoBulk, setAlsoBulk] = useState(true);
  const [createRule, setCreateRule] = useState(true);

  // Decline
  const [showDecline, setShowDecline] = useState(false);
  const [declineNote, setDeclineNote] = useState("");

  async function loadPreview() {
    if (preview.data || preview.loading) return;
    setPreview({ loading: true, error: null, data: null });
    try {
      const res = await fetch(`/api/today/reclass-requests/${req.id}/preview`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setPreview({ loading: false, error: null, data: body as PreviewResponse });
    } catch (e: any) {
      setPreview({ loading: false, error: e?.message || "Preview failed", data: null });
    }
  }

  function toggleExpand() {
    setExpanded((v) => {
      const next = !v;
      if (next) void loadPreview();
      return next;
    });
  }

  async function approve() {
    setActing(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/today/reclass-requests/${req.id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approve", also_bulk: alsoBulk, create_rule: createRule }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onResolved();
    } catch (e: any) {
      setActionError(e?.message || "Approve failed");
      setActing(false);
    }
  }

  async function decline() {
    setActing(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/today/reclass-requests/${req.id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "decline",
          decision_note: declineNote.trim() || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onResolved();
    } catch (e: any) {
      setActionError(e?.message || "Decline failed");
      setActing(false);
    }
  }

  const hoursAgo = Math.floor((Date.now() - new Date(req.requested_at).getTime()) / 3_600_000);

  return (
    <div className="px-5 py-3 hover:bg-violet-50/30 transition-colors">
      <div className="flex items-start gap-3">
        <button
          onClick={toggleExpand}
          className="text-violet-600 hover:text-violet-800 mt-0.5 flex-shrink-0"
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-navy">{req.client_name}</span>
            <span className="text-[10px] text-ink-light">
              {hoursAgo < 1 ? "just now" : hoursAgo < 24 ? `${hoursAgo}h ago` : `${Math.floor(hoursAgo / 24)}d ago`}
            </span>
            {req.requester_name && (
              <span className="text-[10px] text-ink-light">· {req.requester_name}</span>
            )}
            {req.status === "failed" && (
              <span
                className="text-[10px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded"
                title="An approve attempt found no matching transactions (or errored). Decline with a note to answer the client, or retry approve."
              >
                COULDN&apos;T APPLY — DECLINE OR RETRY
              </span>
            )}
          </div>
          <div className="text-sm text-ink-slate mt-1 flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-red-700">{req.source_account_name}</span>
            <ArrowRight size={12} className="text-ink-light" />
            <span className="font-semibold text-emerald-700">{req.target_account_name}</span>
            {req.vendor_name && (
              <span className="text-xs px-2 py-0.5 bg-slate-100 rounded text-ink-slate">
                Vendor: <strong>{req.vendor_name}</strong>
              </span>
            )}
          </div>
          <div className="text-xs italic text-ink-slate mt-1">"{req.client_reason}"</div>

          {expanded && (
            <div className="mt-3 space-y-3">
              {/* Preview */}
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-[10px] uppercase tracking-wider font-bold text-ink-slate mb-2">
                  Preview · what approve will touch
                </div>
                {preview.loading ? (
                  <div className="text-xs text-ink-slate flex items-center gap-2">
                    <Loader2 size={12} className="animate-spin" /> Scanning QBO…
                  </div>
                ) : preview.error ? (
                  <div className="text-xs text-red-700 flex items-start gap-1.5">
                    <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" /> {preview.error}
                  </div>
                ) : preview.data ? (
                  <>
                    <div className="text-sm text-navy">
                      <strong>{preview.data.counts.matched_transactions}</strong> transaction
                      {preview.data.counts.matched_transactions === 1 ? "" : "s"} matched
                      {" "}({preview.data.counts.matched_lines} lines, {fmtMoney(preview.data.total_amount)})
                      {preview.data.counts.reconciled_lines > 0 && (
                        <span className="text-amber-700">
                          {" "}· {preview.data.counts.reconciled_lines} reconciled
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-ink-light mt-0.5">
                      Period: {preview.data.period.label}{" "}
                      ({preview.data.period.start} → {preview.data.period.end})
                    </div>
                    {preview.data.sample.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[11px] text-violet-700 font-semibold">
                          Show sample ({preview.data.sample.length})
                        </summary>
                        <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                          {preview.data.sample.map((s) => (
                            <li key={s.transaction_id} className="text-[11px] text-ink-slate flex justify-between gap-2">
                              <span className="truncate">
                                {s.transaction_date} · {s.vendor_name}
                                {s.is_reconciled && <span className="text-amber-700"> · R</span>}
                              </span>
                              <span className="font-mono text-navy flex-shrink-0">{fmtMoney(s.amount)}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                ) : null}
              </div>

              {/* Approve config */}
              {!showDecline && (
                <div className="space-y-2">
                  <label className="flex items-start gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={alsoBulk}
                      onChange={(e) => setAlsoBulk(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-ink-slate">
                      Bulk-apply to past matching transactions this fiscal year (optional)
                      {preview.data && (
                        <span className="text-navy font-semibold">
                          {" "}({preview.data.counts.matched_transactions} txns)
                        </span>
                      )}
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={createRule}
                      onChange={(e) => setCreateRule(e.target.checked)}
                      className="mt-0.5"
                      disabled={!req.vendor_name}
                    />
                    <span className="text-ink-slate">
                      Create / update bank rule
                      {req.vendor_name ? (
                        <>: <strong>{req.vendor_name}</strong> → <strong>{req.target_account_name}</strong></>
                      ) : (
                        <span className="text-ink-light italic"> (account-level request — no vendor to key the rule on)</span>
                      )}
                    </span>
                  </label>
                </div>
              )}

              {/* Decline reason */}
              {showDecline && (
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-bold text-ink-slate">
                    Decline note (visible to client)
                  </label>
                  <textarea
                    value={declineNote}
                    onChange={(e) => setDeclineNote(e.target.value)}
                    placeholder="e.g. USPS charges for shipping invoices are correctly in Postage — Marketing is for promotional spend."
                    maxLength={1500}
                    rows={3}
                    className="mt-1 w-full px-3 py-2 text-xs border border-slate-200 rounded focus:border-violet-300 focus:outline-none"
                  />
                </div>
              )}

              {actionError && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
                  {actionError}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex items-center gap-2 justify-end">
                {!showDecline ? (
                  <>
                    <button
                      onClick={() => setShowDecline(true)}
                      disabled={acting}
                      className="px-3 py-1.5 border border-slate-300 rounded text-xs font-semibold text-ink-slate hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      <ThumbsDown size={12} /> Decline
                    </button>
                    <button
                      onClick={approve}
                      disabled={acting || (preview.data == null && !preview.error)}
                      className="px-4 py-1.5 bg-emerald-600 text-white rounded text-xs font-bold hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                      title="Applies the reclass + creates a bank rule if the vendor is known"
                    >
                      {acting ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                      {acting ? "Applying…" : "Approve & apply"}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => { setShowDecline(false); setDeclineNote(""); }}
                      disabled={acting}
                      className="px-3 py-1.5 border border-slate-300 rounded text-xs font-semibold text-ink-slate hover:bg-slate-50 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={decline}
                      disabled={acting}
                      className="px-4 py-1.5 bg-red-600 text-white rounded text-xs font-bold hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      {acting ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                      {acting ? "Declining…" : "Confirm decline"}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
