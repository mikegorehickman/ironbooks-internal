"use client";

import { useState } from "react";
import { Loader2, X as XIcon, Send, CheckCircle2 } from "lucide-react";

/**
 * Send-email drawer — email THIS client anything, from their profile. Opens
 * blank by default; template pills pre-fill subject + body for the common
 * sends (statements, chasing questions, portal help) but everything stays
 * freely editable. On send it (a) delivers a branded email via the shared
 * ask-client delivery path (logged + open/click tracked in Email history) and
 * (b) drops the same message into the client's portal inbox (portal_message
 * flag on the ask-client route) so they see it whether or not they open email.
 */

const BRAND = {
  navy: "#152F46",
  teal: "#3E908D",
  border: "#CBD4DC",
  slate: "#5B6672",
  white: "#FFFFFF",
};

interface Template {
  key: string;
  label: string;
  emailType: string;
  subject: (name: string) => string;
  body: (name: string) => string;
}

const TEMPLATES: Template[] = [
  {
    key: "blank",
    label: "Blank email",
    emailType: "general",
    subject: () => "",
    body: () => "",
  },
  {
    key: "statements",
    label: "Request statements",
    emailType: "statement_request",
    subject: (n) => `Statements needed to keep ${n}'s books current`,
    body: (n) =>
      `Hi there,\n\nTo keep ${n}'s books accurate and up to date, could you send over the following when you get a chance?\n\n• Bank statements (all business accounts)\n• Credit-card statements\n• Any loan / line-of-credit statements\n\nYou can reply to this email with them attached, or upload them in your portal. Thank you!`,
  },
  {
    key: "questions",
    label: "Chase open questions",
    emailType: "ask_client",
    subject: () => "Following up — a couple of open questions",
    body: (n) =>
      `Hi there,\n\nWe're finishing up ${n}'s books and still have a few open questions waiting on your reply. When you have a moment, could you take a look at the open items in your portal (or just reply here)?\n\nIt's the last thing holding up this period. Thank you!`,
  },
  {
    key: "ready",
    label: "Statements ready",
    emailType: "statements_ready",
    subject: (n) => `${n}'s latest financial statements are ready`,
    body: (n) =>
      `Hi there,\n\nGood news — ${n}'s latest financial statements are ready to view in your portal. They cover your Profit & Loss and Balance Sheet for the period.\n\nLog in any time to review them, and let us know if anything looks off. Thanks!`,
  },
  {
    key: "portal",
    label: "Portal login help",
    emailType: "portal_help",
    subject: () => "Your Ironbooks portal login",
    body: () =>
      `Hi there,\n\nHere's how to get into your Ironbooks portal, where you'll find your statements, open questions, and documents in one place.\n\nIf you've lost your login link, just reply to this email and we'll send a fresh one. Thanks!`,
  },
];

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildHtml(bodyText: string): string {
  const paras = bodyText
    .split(/\n{2,}/)
    .map((p) => `<p style="line-height:1.55;margin:0 0 14px 0;">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div style="font-family:'Figtree',Helvetica,Arial,sans-serif;color:${BRAND.navy};max-width:640px;margin:0 auto;">
  <div style="background:${BRAND.navy};color:${BRAND.white};padding:16px 20px;border-radius:10px 10px 0 0;font-size:19px;font-weight:700;">Ironbooks</div>
  <div style="border:1px solid ${BRAND.border};border-top:none;padding:22px 20px;border-radius:0 0 10px 10px;">
    ${paras}
  </div>
</div>`;
}

export function SendEmailDrawer({
  clientLinkId,
  clientName,
  clientEmail,
  onClose,
  onSent,
}: {
  clientLinkId: string;
  clientName: string;
  clientEmail?: string | null;
  onClose: () => void;
  onSent?: () => void;
}) {
  const [templateKey, setTemplateKey] = useState("blank");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [emailType, setEmailType] = useState("general");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  function pickTemplate(t: Template) {
    setTemplateKey(t.key);
    setEmailType(t.emailType);
    setSubject(t.subject(clientName));
    setBody(t.body(clientName));
    setResult(null);
  }

  async function send() {
    if (sending) return;
    if (!subject.trim() || !body.trim()) {
      setResult({ ok: false, message: "Add a subject and a message before sending." });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/ask-client`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          html: buildHtml(body.trim()),
          text: body.trim(),
          email_type: emailType,
          portal_message: true,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setResult({ ok: true, message: "Sent — and posted to their portal inbox." });
      onSent?.();
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || "Couldn't send the email" });
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      style={{ background: "rgba(11,29,46,0.32)" }}
      onClick={onClose}
    >
      <div
        className="bg-white h-full w-full max-w-[560px] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light">Send email</div>
            <div className="text-lg font-bold text-navy truncate">{clientName}</div>
            <div className="text-[11px] text-ink-slate mt-0.5">
              {clientEmail ? `to ${clientEmail}` : "to their contact email"} · also posts to their portal inbox
            </div>
          </div>
          <button onClick={onClose} className="text-ink-light hover:text-navy shrink-0" aria-label="Close">
            <XIcon size={18} />
          </button>
        </div>

        {/* Template pills */}
        <div className="px-5 pt-4 pb-3 border-b border-gray-100">
          <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-2">Start from</div>
          <div className="flex flex-wrap gap-1.5">
            {TEMPLATES.map((t) => (
              <button
                key={t.key}
                onClick={() => pickTemplate(t)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                  templateKey === t.key
                    ? "bg-teal text-white border-teal"
                    : "bg-white text-ink-slate border-gray-200 hover:border-teal/50 hover:text-teal"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Compose */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-light">Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject line"
              className="mt-1 w-full text-sm rounded-lg border border-gray-200 px-3 py-2 text-navy placeholder:text-ink-light focus:outline-none focus:border-teal"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-light">Message</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message…"
              rows={14}
              className="mt-1 w-full text-sm rounded-lg border border-gray-200 px-3 py-2 text-navy placeholder:text-ink-light focus:outline-none focus:border-teal resize-none leading-relaxed"
            />
          </label>
          {result && (
            <div
              className={`flex items-start gap-2 text-sm rounded-lg px-3 py-2 ${
                result.ok
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                  : "bg-red-50 border border-red-200 text-red-800"
              }`}
            >
              {result.ok && <CheckCircle2 size={15} className="mt-0.5 shrink-0" />}
              <span>{result.message}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
          <span className="text-[11px] text-ink-light">Delivery + opens tracked in Email history</span>
          {result?.ok ? (
            <button
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy-deep"
            >
              Done
            </button>
          ) : (
            <button
              onClick={send}
              disabled={sending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy-deep disabled:opacity-50"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send email
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
