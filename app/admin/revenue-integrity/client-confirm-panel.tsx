"use client";

import { useEffect, useState } from "react";
import { Loader2, Send, CheckCircle2, X as XIcon, UserCheck, RefreshCw } from "lucide-react";

/**
 * Client-confirm panel — lives inside a fleet-board Fix expander.
 *
 * Drives ar_match_sessions: preview what a session would contain (open
 * current-FY invoices + candidate deposits), send it (proposals-only or with
 * exact-match auto-apply — admin/lead), watch progress, and action the
 * proposals the client's answers produce (Apply match / Keep / Dismiss).
 */

const fmt = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n || 0)).toLocaleString();

const ANSWER_LABEL: Record<string, string> = {
  paid_matched: "picked a payment",
  paid_no_match: "paid — no candidate fit",
  not_owed: "not a real invoice",
  still_owed: "still owed",
};

export function ClientConfirmPanel({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/ar-match`);
      const j = await res.json();
      if (res.ok) {
        setSession(j.session);
        setItems(j.items || []);
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function act(body: any, key: string) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/ar-match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      return j;
    } catch (e: any) {
      setError(e?.message || "Failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function runPreview() {
    const j = await act({ action: "preview" }, "preview");
    if (j) setPreview(j);
  }

  async function send(autoApply: boolean) {
    if (
      !confirm(
        `Send ${preview?.count ?? "the"} open invoice${(preview?.count ?? 2) === 1 ? "" : "s"} to ${clientName} for confirmation?\n\n` +
          (autoApply
            ? `AUTO-APPLY is ON: when they confirm an exact-match payment (${preview?.exact_eligible ?? "?"} invoice(s) have one), the match posts to QBO immediately. All other answers land as proposals for you.`
            : "Proposals-only: every answer lands in your queue here — nothing posts to QBO without you.") +
          "\n\nThey get a branded email + a portal badge."
      )
    )
      return;
    const j = await act({ action: "create", auto_apply: autoApply }, "send");
    if (j) {
      setPreview(null);
      await load();
      if (!j.email_sent) setError(`Session created, but the email didn't send: ${j.email_error || "unknown"} — they'll still see the portal badge.`);
    }
  }

  async function resolve(itemId: string, action: "apply" | "keep" | "dismiss") {
    if (action === "apply" && !confirm("Apply this match to QBO? The deposit is repointed to A/R and pays the invoice down.")) return;
    setBusy(itemId + action);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/ar-match/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: itemId, action }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed");
    } finally {
      setBusy(null);
    }
  }

  const answered = items.filter((i) => i.answered_at);
  const proposals = items.filter((i) => i.outcome === "proposed");

  return (
    <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3.5">
      <div className="flex items-center gap-2 flex-wrap">
        <UserCheck size={14} className="text-teal" />
        <span className="text-xs font-bold uppercase tracking-wider text-navy">Client confirm</span>
        {session && (
          <span className="text-[11px] text-ink-slate">
            {session.status === "open"
              ? `sent ${new Date(session.created_at).toLocaleDateString()} · ${answered.length}/${items.length} answered${session.auto_apply ? " · auto-apply ON" : ""}`
              : `last session ${session.status} · ${answered.length}/${items.length} answered`}
          </span>
        )}
        <button
          onClick={load}
          className="ml-auto text-ink-light hover:text-navy"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Send controls — when there's no open session. */}
      {!loading && (!session || session.status !== "open") && (
        <div className="mt-2.5">
          {!preview ? (
            <button
              onClick={runPreview}
              disabled={busy === "preview"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-navy hover:border-teal hover:text-teal disabled:opacity-50"
            >
              {busy === "preview" ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              Preview what the client would see…
            </button>
          ) : (
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5">
              <div className="text-xs text-navy">
                <strong>{preview.count}</strong> open current-year invoice{preview.count === 1 ? "" : "s"} ·{" "}
                {fmt(preview.total_balance)} · <strong>{preview.with_candidates}</strong> with candidate payments,{" "}
                <strong>{preview.exact_eligible}</strong> exact
              </div>
              {preview.count > 0 ? (
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => send(false)}
                    disabled={!!busy}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-teal px-3 py-1.5 text-xs font-bold text-white hover:bg-teal-dark disabled:opacity-50"
                  >
                    {busy === "send" ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                    Send — proposals only
                  </button>
                  <button
                    onClick={() => send(true)}
                    disabled={!!busy || preview.exact_eligible === 0}
                    title={preview.exact_eligible === 0 ? "No exact-eligible candidates — nothing could auto-apply" : "Exact-match confirmations post to QBO immediately (admin/lead)"}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-teal bg-white px-3 py-1.5 text-xs font-bold text-teal-dark hover:bg-teal-light disabled:opacity-40"
                  >
                    <Send size={12} /> Send with auto-apply
                  </button>
                  <button onClick={() => setPreview(null)} className="text-xs text-ink-light hover:text-navy px-1.5">
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="mt-1 text-[11px] text-ink-slate">
                  Nothing to send — no open current-fiscal-year invoices. (Closed-year invoices never go to the client.)
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Open-session controls */}
      {!loading && session?.status === "open" && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-ink-slate">
            Waiting on the client — they see it at <code className="text-[10px]">/portal/invoice-check</code>.
          </span>
          <button
            onClick={async () => {
              if (!confirm("Cancel this session? The portal list disappears; answers already given are kept.")) return;
              await act({ action: "cancel" }, "cancel");
              await load();
            }}
            disabled={!!busy}
            className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-ink-light hover:text-red-600 disabled:opacity-50"
          >
            <XIcon size={11} /> Cancel session
          </button>
        </div>
      )}

      {/* Proposal queue — the answers needing a human. */}
      {proposals.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-gold-deep mb-1.5">
            Needs you — {proposals.length} proposal{proposals.length === 1 ? "" : "s"}
          </div>
          <ul className="space-y-1.5">
            {proposals.map((p) => {
              const cand = (p.candidates || []).find((c: any) => String(c.txn_id) === String(p.matched_deposit_id));
              return (
                <li key={p.id} className="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2">
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <span className="font-semibold text-navy">
                      #{p.doc_number || p.qbo_invoice_id} · {p.customer_name || "(no customer)"} · {fmt(p.balance)}
                    </span>
                    <span className="text-ink-slate">— client says: <strong>{ANSWER_LABEL[p.answer] || p.answer}</strong></span>
                    {cand && (
                      <span className="text-ink-slate">
                        ({fmt(cand.amount)} on {cand.date}{cand.exact_eligible ? ", exact" : ""})
                      </span>
                    )}
                  </div>
                  {p.client_note && (
                    <div className="text-[11px] text-ink-slate italic mt-0.5">&ldquo;{p.client_note}&rdquo;</div>
                  )}
                  {p.outcome_detail && (
                    <div className="text-[11px] text-gold-deep mt-0.5">{p.outcome_detail}</div>
                  )}
                  <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                    {p.answer === "paid_matched" && p.matched_deposit_id && (
                      <button
                        onClick={() => resolve(p.id, "apply")}
                        disabled={!!busy}
                        className="inline-flex items-center gap-1 rounded bg-teal px-2 py-1 text-[11px] font-bold text-white hover:bg-teal-dark disabled:opacity-50"
                      >
                        {busy === p.id + "apply" ? <Loader2 size={10} className="animate-spin" /> : <CheckCircle2 size={10} />}
                        Apply match to QBO
                      </button>
                    )}
                    {p.answer === "not_owed" && (
                      <span className="text-[11px] text-ink-slate">
                        Void via the remediation panel above (guarded path) →
                      </span>
                    )}
                    <button
                      onClick={() => resolve(p.id, "keep")}
                      disabled={!!busy}
                      className="rounded border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-ink-slate hover:text-navy disabled:opacity-50"
                    >
                      Keep as-is
                    </button>
                    <button
                      onClick={() => resolve(p.id, "dismiss")}
                      disabled={!!busy}
                      className="rounded px-2 py-1 text-[11px] font-semibold text-ink-light hover:text-red-600 disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Compact history of resolved answers. */}
      {answered.length > 0 && proposals.length === 0 && (
        <div className="mt-2 text-[11px] text-ink-slate">
          {items.filter((i) => i.outcome === "auto_applied").length} auto-applied ·{" "}
          {items.filter((i) => i.outcome === "applied_by_bookkeeper").length} applied by you ·{" "}
          {items.filter((i) => i.answer === "still_owed").length} confirmed still owed ·{" "}
          {items.filter((i) => i.outcome === "dismissed").length} dismissed
        </div>
      )}

      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
    </div>
  );
}
