"use client";

import { useEffect, useState } from "react";
import { Mail, X as XIcon, CheckCircle2, Loader2, Clock, ChevronDown } from "lucide-react";

/**
 * AskClientComposer — the single "email the client a question" composer.
 *
 * Every ask-client surface (P&L / account drill, reclass questions, statement
 * or doc requests) opens THIS modal instead of its own: subject + editable
 * message, an optional transaction table with a "What was this for?" column,
 * a branded HTML body built one way, and a send that hits the one delivery
 * path (POST /api/clients/[id]/ask-client → lib/ask-client-email.ts) so the
 * unified client_email_log history is complete. Recent emails to the client
 * are shown inline so the bookkeeper doesn't double-ask.
 */

export interface AskClientRow {
  date: string;
  name?: string | null;
  memo?: string | null;
  amount: number;
}

interface RecentEmail {
  id: string;
  email_type: string;
  subject: string;
  status: string;
  created_at: string;
}

const BRAND = {
  teal: "#2D7A75",
  tealDark: "#1F5D58",
  navy: "#0F1F2E",
  slate: "#475569",
  border: "#CBD5E1",
  white: "#FFFFFF",
  tealLighter: "#F4F9F8",
};

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function AskClientComposer({
  clientLinkId,
  clientName,
  emailType = "ask_client",
  contextLabel,
  periodLabel,
  rows = [],
  defaultSubject,
  defaultIntro,
  extraContext,
  onClose,
  onSent,
}: {
  clientLinkId: string;
  clientName: string;
  /** client_email_log discriminator, e.g. "ask_client_txns". */
  emailType?: string;
  /** e.g. an account name — used in the default copy and audit context. */
  contextLabel?: string;
  /** e.g. "Jan 1 – Mar 31, 2026" — mentioned in the default intro. */
  periodLabel?: string;
  /** Optional transactions to render as a question table. */
  rows?: AskClientRow[];
  defaultSubject?: string;
  defaultIntro?: string;
  extraContext?: Record<string, any>;
  onClose: () => void;
  onSent?: (info: { recipients: string[]; messageId?: string | null }) => void;
}) {
  const firstName = (clientName || "there").split(/[ ,]/)[0] || "there";
  const n = rows.length;
  const hasRows = n > 0;

  const [subject, setSubject] = useState(
    defaultSubject ||
      (hasRows
        ? `Quick question on ${n} transaction${n === 1 ? "" : "s"} — ${clientName}`
        : `Quick question — ${clientName}`)
  );
  const [intro, setIntro] = useState(
    defaultIntro ||
      (hasRows
        ? `Hi ${firstName},\n\nWhile cleaning up your books${periodLabel ? ` (${periodLabel})` : ""} we came across ${n} transaction${n === 1 ? "" : "s"}${contextLabel ? ` under "${contextLabel}"` : ""} that we'd like to confirm before finalizing. Could you tell us what ${n === 1 ? "it was" : "each was"} for? Just fill in the last column or reply with a quick note.`
        : `Hi ${firstName},\n\nWe have a quick question about your books${contextLabel ? ` regarding ${contextLabel}` : ""}. When you have a moment, could you reply with the details below?`)
  );
  const [outro, setOutro] = useState(`Thanks so much,\nIronbooks`);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<
    | { ok: true; recipients: string[]; messageId?: string | null }
    | { ok: false; message: string }
    | null
  >(null);

  const [recent, setRecent] = useState<RecentEmail[] | null>(null);
  const [showRecent, setShowRecent] = useState(false);

  useEffect(() => {
    fetch(`/api/clients/${clientLinkId}/email-log?limit=5`)
      .then((r) => (r.ok ? r.json() : { emails: [] }))
      .then((j) => setRecent(j.emails || []))
      .catch(() => setRecent([]));
  }, [clientLinkId]);

  const rowsHtml = rows
    .map((t, i) => {
      const bg = i % 2 === 0 ? BRAND.white : BRAND.tealLighter;
      return `<tr style="background:${bg};">
        <td style="border:1px solid ${BRAND.border};padding:8px 10px;color:${BRAND.slate};white-space:nowrap;">${esc(t.date)}</td>
        <td style="border:1px solid ${BRAND.border};padding:8px 10px;color:${BRAND.navy};">${esc(t.name || t.memo || "—")}</td>
        <td style="border:1px solid ${BRAND.border};padding:8px 10px;text-align:right;color:${BRAND.navy};font-weight:600;">${money(t.amount)}</td>
        <td style="border:1px solid ${BRAND.border};padding:8px 10px;background:${BRAND.white};">&nbsp;</td>
      </tr>`;
    })
    .join("");
  const introHtml = intro.split("\n").map((l) => esc(l)).join("<br>");
  const outroHtml = outro.split("\n").map((l) => esc(l)).join("<br>");
  const tableHtml = hasRows
    ? `<table style="border-collapse:collapse;width:100%;font-size:13px;margin:6px 0 16px 0;border:1px solid ${BRAND.border};">
      <thead><tr style="background:${BRAND.teal};">
        <th style="border:1px solid ${BRAND.tealDark};padding:9px 10px;text-align:left;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.04em;">Date</th>
        <th style="border:1px solid ${BRAND.tealDark};padding:9px 10px;text-align:left;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.04em;">Description</th>
        <th style="border:1px solid ${BRAND.tealDark};padding:9px 10px;text-align:right;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.04em;">Amount</th>
        <th style="border:1px solid ${BRAND.tealDark};padding:9px 10px;text-align:left;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.04em;">What was this for?</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`
    : "";
  const html = `<div style="font-family:'Figtree',Helvetica,Arial,sans-serif;color:${BRAND.navy};max-width:640px;margin:0 auto;">
  <div style="background:${BRAND.navy};color:${BRAND.white};padding:16px 20px;border-radius:10px 10px 0 0;font-size:19px;font-weight:700;">Ironbooks</div>
  <div style="border:1px solid ${BRAND.border};border-top:none;padding:22px 20px;border-radius:0 0 10px 10px;">
    <p style="line-height:1.55;margin:0 0 14px 0;">${introHtml}</p>
    ${tableHtml}
    <p style="line-height:1.55;margin:0;">${outroHtml}</p>
  </div>
</div>`;
  const text = hasRows
    ? `${intro}\n\n${rows.map((t) => `• ${t.date} — ${t.name || t.memo || "—"} — ${money(t.amount)}  → what was this for? ______`).join("\n")}\n\n${outro}`
    : `${intro}\n\n${outro}`;

  async function send() {
    if (sending) return;
    setSending(true);
    setResult(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/ask-client`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          html,
          text,
          email_type: emailType,
          context: {
            account_name: contextLabel || null,
            transaction_count: hasRows ? n : null,
            ...(extraContext || {}),
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't send the email");
      const info = { recipients: json.recipients || [], messageId: json.message_id || null };
      setResult({ ok: true, ...info });
      onSent?.(info);
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || "Couldn't send the email" });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-navy flex items-center gap-2">
              <Mail size={18} className="text-teal" /> Ask {clientName}
            </h3>
            <p className="text-xs text-ink-slate mt-1">
              {hasRows
                ? `${n} transaction${n === 1 ? "" : "s"}${contextLabel ? ` from “${contextLabel}”` : ""}. Edit below, then send via Resend.`
                : "Edit below, then send via Resend."}
            </p>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy">
            <XIcon size={20} />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
          {/* Recent emails — avoid double-asking. */}
          {recent && recent.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-gray-50/60">
              <button
                type="button"
                onClick={() => setShowRecent((s) => !s)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-ink-slate"
              >
                <span className="flex items-center gap-1.5">
                  <Clock size={12} /> Recent emails to this client ({recent.length})
                </span>
                <ChevronDown size={14} className={showRecent ? "rotate-180 transition" : "transition"} />
              </button>
              {showRecent && (
                <div className="px-3 pb-2 space-y-1">
                  {recent.map((e) => (
                    <div key={e.id} className="flex items-center justify-between text-[11px] text-ink-slate">
                      <span className="truncate max-w-[70%]" title={e.subject}>
                        {e.subject}
                      </span>
                      <span className="text-ink-light">
                        {new Date(e.created_at).toLocaleDateString()} · {e.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">Subject</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">Message</label>
            <textarea
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              rows={hasRows ? 4 : 6}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy leading-relaxed"
            />
          </div>
          {hasRows && (
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">
                Transactions (preview)
              </label>
              <div className="rounded-lg border border-gray-200 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-teal text-white">
                      <th className="text-left px-3 py-2 font-semibold">Date</th>
                      <th className="text-left px-3 py-2 font-semibold">Description</th>
                      <th className="text-right px-3 py-2 font-semibold">Amount</th>
                      <th className="text-left px-3 py-2 font-semibold">What was this for?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t, i) => (
                      <tr key={i} className="border-b border-gray-50">
                        <td className="px-3 py-1.5 text-ink-slate whitespace-nowrap">{t.date}</td>
                        <td className="px-3 py-1.5 text-navy">{t.name || t.memo || "—"}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-navy">{money(t.amount)}</td>
                        <td className="px-3 py-1.5 text-ink-light italic">client fills in</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">Closing</label>
            <textarea
              value={outro}
              onChange={(e) => setOutro(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy leading-relaxed"
            />
          </div>
          {result?.ok && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800 flex items-start gap-2">
              <CheckCircle2 size={15} className="mt-0.5 flex-shrink-0" />
              <span>
                <strong>Sent via Resend</strong> to <strong>{result.recipients.join(", ")}</strong>.
                <span className="block text-xs text-green-700 mt-0.5">
                  Logged to this client&apos;s email history
                  {result.messageId ? ` · Resend id ${result.messageId.slice(0, 12)}…` : ""}.
                </span>
              </span>
            </div>
          )}
          {result && !result.ok && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{result.message}</div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between gap-3">
          <button onClick={onClose} className="text-sm font-semibold text-ink-slate hover:text-navy">
            Close
          </button>
          <button
            onClick={send}
            disabled={sending || (result?.ok ?? false)}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-60"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : result?.ok ? <CheckCircle2 size={14} /> : <Mail size={14} />}
            {sending ? "Sending…" : result?.ok ? "Sent" : "Send via Resend"}
          </button>
        </div>
      </div>
    </div>
  );
}
