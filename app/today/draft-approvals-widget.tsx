"use client";

import { useState } from "react";
import { BadgeCheck, Loader2, FileWarning } from "lucide-react";

/**
 * Senior queue: clients who APPROVED their draft statements in the portal
 * and are waiting for the one-click DRAFT → VERIFIED graduation (Mike,
 * 2026-07-15: client approves → senior confirms, never automatic).
 * Also lists concerns/info the client sent back, so the senior sees what
 * they attested to before flipping the switch.
 */

export interface DraftApprovalRow {
  client_link_id: string;
  client_name: string;
  period_label: string;
  status: "approved" | "info_added" | "questions";
  answers: Record<string, boolean | null>;
  note: string | null;
  updated_at: string;
}

const ANSWER_LABELS: Record<string, { label: string; goodWhen: boolean }> = {
  revenue_complete: { label: "All revenue showing", goodWhen: true },
  accounts_complete: { label: "All accounts/cards/loans listed", goodWhen: true },
  cash_payments: { label: "Cash payments outside the books", goodWhen: false },
  tax_ok: { label: "Tax looks right", goodWhen: true },
};

export function DraftApprovalsWidget({ rows }: { rows: DraftApprovalRow[] }) {
  const [items, setItems] = useState(rows);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function graduate(clientLinkId: string, clientName: string) {
    if (!confirm(`Mark ${clientName}'s books VERIFIED? Their next statements go out without the DRAFT label.`)) return;
    setBusy(clientLinkId);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/statements-stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "verified" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || `Couldn't graduate (HTTP ${res.status})`);
        return;
      }
      setItems((prev) => prev.filter((r) => r.client_link_id !== clientLinkId));
    } catch (e: any) {
      setError(e?.message || "Couldn't graduate");
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) return null;

  return (
    <div className="bg-white rounded-2xl border border-indigo-200 overflow-hidden">
      <div className="px-4 py-3 bg-indigo-50/60 border-b border-indigo-100 flex items-center gap-2">
        <BadgeCheck size={16} className="text-indigo-600" />
        <span className="text-sm font-bold text-navy">Draft statement reviews from clients</span>
        <span className="text-xs text-ink-slate">— approve to graduate their books to verified</span>
      </div>
      {error && <div className="px-4 py-2 text-xs text-red-700 bg-red-50">{error}</div>}
      <div className="divide-y divide-gray-100">
        {items.map((r) => (
          <div key={r.client_link_id} className="px-4 py-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-navy">{r.client_name}</span>
                <span className="text-[11px] text-ink-slate">{r.period_label}</span>
                {r.status === "approved" ? (
                  <span className="text-[10px] font-bold bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded">
                    CLIENT APPROVED
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                    <FileWarning size={10} /> SENT INFO — REVIEW FIRST
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                {Object.entries(ANSWER_LABELS).map(([k, meta]) => {
                  const v = r.answers?.[k];
                  if (v === null || v === undefined) return null;
                  const good = v === meta.goodWhen;
                  return (
                    <span key={k} className={`text-[11px] ${good ? "text-emerald-700" : "text-amber-700 font-semibold"}`}>
                      {good ? "✓" : "⚠"} {meta.label}
                    </span>
                  );
                })}
              </div>
              {r.note && (
                <p className="text-[11px] text-ink-slate mt-1 whitespace-pre-wrap line-clamp-3" title={r.note}>
                  &ldquo;{r.note}&rdquo;
                </p>
              )}
            </div>
            {r.status === "approved" && (
              <button
                onClick={() => graduate(r.client_link_id, r.client_name)}
                disabled={busy === r.client_link_id}
                className="flex-shrink-0 inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-3 py-2 rounded-lg disabled:opacity-50"
              >
                {busy === r.client_link_id ? <Loader2 size={12} className="animate-spin" /> : <BadgeCheck size={12} />}
                Graduate to verified
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
