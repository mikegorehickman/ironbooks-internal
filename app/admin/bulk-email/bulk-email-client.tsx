"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { wrapBrandedEmail, applyMergeFields } from "@/lib/bulk-email";
import { renderUserSignature, type SignatureUser } from "@/lib/user-signature";
import {
  Mail, Send, Loader2, Search, Users, AlertTriangle, CheckCircle2, Save, FileText, Clock,
} from "lucide-react";

interface Recipient {
  client_link_id: string;
  client_name: string;
  first_name: string | null;
  email: string | null;
  login_email: string | null;
  has_portal: boolean;
  jurisdiction: string | null;
  in_production: boolean;
  bookkeeper_id: string | null;
  bookkeeper_name: string | null;
  subscribed: boolean;
  bounced: boolean;
}
type Kind = "operational" | "normal" | "resubscribe";
interface Template { id: string; name: string; subject: string; body_html: string; kind: Kind }
interface Campaign { id: string; subject: string; kind: string; status: string; recipient_count: number; sent_count: number; failed_count: number; created_at: string }

/** Plain text → simple branded-body HTML: blank-line paragraphs, **bold**, line breaks. */
function textToHtml(t: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return t.split(/\n\s*\n/).map((p) =>
    `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, "<br/>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</p>`
  ).join("");
}

export function BulkEmailClient({ senderEmail, senderName, senderSignature }: { senderEmail: string; senderName: string; senderSignature: SignatureUser }) {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<Kind>("normal");
  const [jur, setJur] = useState("all");
  const [prod, setProd] = useState("all");
  const [bk, setBk] = useState("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Insert a merge field at the cursor (or append) and keep focus.
  function insertToken(token: string) {
    const el = bodyRef.current;
    if (!el) { setBodyText((b) => b + token); return; }
    const start = el.selectionStart ?? bodyText.length;
    const end = el.selectionEnd ?? bodyText.length;
    const next = bodyText.slice(0, start) + token + bodyText.slice(end);
    setBodyText(next);
    requestAnimationFrame(() => { el.focus(); const p = start + token.length; el.setSelectionRange(p, p); });
  }
  const [replyMode, setReplyMode] = useState<"bookkeeper" | "support">("bookkeeper");
  const [alsoPortal, setAlsoPortal] = useState(true);
  const [includeSignature, setIncludeSignature] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/admin/bulk-email/recipients");
        const d = await r.json();
        if (r.ok) setRecipients(d.recipients || []);
      } finally { setLoading(false); }
    })();
    fetch("/api/admin/email-templates").then((r) => r.json()).then((d) => setTemplates(d.templates || [])).catch(() => {});
    refreshCampaigns();
  }, []);
  const refreshCampaigns = () =>
    fetch("/api/admin/bulk-email/campaigns").then((r) => r.json()).then((d) => setCampaigns(d.campaigns || [])).catch(() => {});

  const bookkeepers = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of recipients) if (r.bookkeeper_id) m.set(r.bookkeeper_id, r.bookkeeper_name || "—");
    return [...m.entries()];
  }, [recipients]);

  // Eligibility depends on kind: bounced + no-email never; unsubscribed only blocks 'normal'.
  const isEligible = (r: Recipient) =>
    !!r.email && !r.bounced && (kind !== "normal" || r.subscribed);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return recipients.filter((r) =>
      (jur === "all" || r.jurisdiction === jur) &&
      (prod === "all" || (prod === "prod" ? r.in_production : !r.in_production)) &&
      (bk === "all" || r.bookkeeper_id === bk) &&
      (!s || r.client_name.toLowerCase().includes(s) || (r.email || "").includes(s))
    );
  }, [recipients, jur, prod, bk, q]);

  const eligibleFiltered = filtered.filter(isEligible);
  const selectedEligible = [...selected].filter((id) => {
    const r = recipients.find((x) => x.client_link_id === id);
    return r && isEligible(r);
  });

  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  const selectAll = () => setSelected(new Set(eligibleFiltered.map((r) => r.client_link_id)));
  const selectNone = () => setSelected(new Set());

  function loadTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setSubject(t.subject); setBodyText(t.body_html.replace(/<[^>]+>/g, "").trim()); setKind(t.kind);
  }

  async function saveTemplate() {
    const name = prompt("Template name?");
    if (!name) return;
    const res = await fetch("/api/admin/email-templates", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, subject, body_html: textToHtml(bodyText), kind }),
    });
    if (res.ok) { setMsg({ tone: "ok", text: "Template saved." }); fetch("/api/admin/email-templates").then((r) => r.json()).then((d) => setTemplates(d.templates || [])); }
    else setMsg({ tone: "err", text: "Couldn't save template." });
  }

  async function sendTest() {
    if (!subject || !bodyText) { setMsg({ tone: "err", text: "Add a subject and body first." }); return; }
    setBusy("test"); setMsg(null);
    const res = await fetch("/api/admin/bulk-email/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject, body_html: textToHtml(bodyText), kind, test_email: senderEmail, include_signature: includeSignature }),
    });
    setBusy(null);
    setMsg(res.ok ? { tone: "ok", text: `Test sent to ${senderEmail}.` } : { tone: "err", text: "Test send failed." });
  }

  // Click "Send" → open the per-recipient preview (so the sender sees exactly
  // how #firstname# resolves for each client) instead of a bare confirm.
  function send() {
    if (!subject || !bodyText) { setMsg({ tone: "err", text: "Add a subject and body first." }); return; }
    if (!selectedEligible.length) { setMsg({ tone: "err", text: "Select at least one eligible recipient." }); return; }
    setMsg(null);
    setPreviewOpen(true);
  }

  // Actual send — fired from the preview modal's "Confirm & send".
  async function doSend() {
    setPreviewOpen(false);
    setBusy("send"); setMsg(null);
    const res = await fetch("/api/admin/bulk-email/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject, body_html: textToHtml(bodyText), kind, client_ids: selectedEligible, also_portal: alsoPortal, reply_to_mode: replyMode, include_signature: includeSignature }),
    });
    const d = await res.json();
    setBusy(null);
    if (res.ok) { setMsg({ tone: "ok", text: `Sending to ${d.recipient_count} clients… they'll go out over the next minute.` }); setSelected(new Set()); setTimeout(refreshCampaigns, 1500); }
    else setMsg({ tone: "err", text: d.error || "Send failed." });
  }

  // Selected recipients (full objects) for the preview modal.
  const previewRecips: Recipient[] = previewOpen
    ? (selectedEligible
        .map((id) => recipients.find((r) => r.client_link_id === id))
        .filter(Boolean) as Recipient[])
    : [];

  const counts = {
    eligible: eligibleFiltered.length,
    unsub: filtered.filter((r) => !r.subscribed && r.email && !r.bounced).length,
    bounced: filtered.filter((r) => r.bounced).length,
    noEmail: filtered.filter((r) => !r.email).length,
  };

  return (
    <div className="space-y-5">
      {/* Kind */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4">
        <div className="text-xs font-bold uppercase tracking-wider text-ink-light mb-2">Email type</div>
        <div className="flex gap-2 flex-wrap">
          {([["operational", "Operational", "Must-receive · no unsubscribe"], ["normal", "Normal", "Marketing · unsubscribe-aware"], ["resubscribe", "Re-subscribe", "Ask opted-out clients back"]] as const).map(([k, label, sub]) => (
            <button key={k} onClick={() => setKind(k)}
              className={`text-left px-3 py-2 rounded-xl border ${kind === k ? "border-teal bg-teal-lighter" : "border-gray-200 hover:border-gray-300"}`}>
              <div className={`text-sm font-bold ${kind === k ? "text-teal-dark" : "text-navy"}`}>{label}</div>
              <div className="text-[11px] text-ink-light">{sub}</div>
            </button>
          ))}
        </div>
        {kind === "normal" && <p className="text-[11px] text-amber-700 mt-2">Unsubscribed clients are greyed out and won't be emailed.</p>}
        {kind === "operational" && <p className="text-[11px] text-ink-light mt-2">Operational email reaches everyone with an address, even unsubscribed clients. Use only for must-receive notices.</p>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(320px,380px)_1fr] gap-5 items-start">
        {/* Recipients */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Users size={15} className="text-teal" />
            <h3 className="text-sm font-bold text-navy">Recipients</h3>
            <span className="ml-auto text-[11px] font-semibold text-ink-slate bg-slate-100 rounded-full px-2 py-0.5">{selectedEligible.length} selected</span>
          </div>
          <div className="flex items-center gap-2 mb-2 flex-wrap text-xs">
            <select value={jur} onChange={(e) => setJur(e.target.value)} className="rounded-md border border-gray-200 px-2 py-1"><option value="all">All regions</option><option value="US">US</option><option value="CA">CA</option></select>
            <select value={prod} onChange={(e) => setProd(e.target.value)} className="rounded-md border border-gray-200 px-2 py-1"><option value="all">All stages</option><option value="prod">In production</option><option value="nonprod">In cleanup</option></select>
            <select value={bk} onChange={(e) => setBk(e.target.value)} className="rounded-md border border-gray-200 px-2 py-1 max-w-[140px]"><option value="all">All preparers</option>{bookkeepers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
            <div className="relative flex-1 min-w-[120px]"><Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-light" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-full rounded-md border border-gray-200 pl-6 pr-2 py-1" /></div>
          </div>
          <div className="flex items-center gap-3 mb-2 text-[11px]">
            <button onClick={selectAll} className="font-semibold text-teal hover:underline">Select all eligible ({counts.eligible})</button>
            <button onClick={selectNone} className="font-semibold text-ink-slate hover:underline">Clear</button>
            <span className="ml-auto text-ink-light">{counts.unsub} unsub · {counts.bounced} bounced · {counts.noEmail} no email</span>
          </div>
          {loading ? (
            <div className="py-8 text-center text-sm text-ink-slate"><Loader2 size={16} className="animate-spin inline text-teal" /> Loading clients…</div>
          ) : (
            <ul className="max-h-[46vh] overflow-y-auto divide-y divide-gray-50 border border-gray-100 rounded-lg">
              {filtered.map((r) => {
                const elig = isEligible(r);
                const reason = !r.email ? "no email" : r.bounced ? "bounced" : (!r.subscribed && kind === "normal") ? "unsubscribed" : "";
                return (
                  <li key={r.client_link_id} className={`flex items-center gap-2 px-3 py-2 ${elig ? "" : "opacity-50"}`}>
                    <input type="checkbox" disabled={!elig} checked={selected.has(r.client_link_id)} onChange={() => toggle(r.client_link_id)} className="rounded border-gray-300 text-teal" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-navy truncate">{r.client_name}{r.jurisdiction && <span className="text-[10px] text-ink-light ml-1.5">{r.jurisdiction}</span>}</div>
                      <div className="text-[11px] text-ink-light truncate">{r.email || "no email on file"}</div>
                    </div>
                    {reason && <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 rounded px-1.5 py-0.5 flex-shrink-0">{reason}</span>}
                  </li>
                );
              })}
              {filtered.length === 0 && <li className="px-3 py-6 text-center text-xs text-ink-light italic">No clients match.</li>}
            </ul>
          )}
        </div>

        {/* Composer */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
          <div className="flex items-center gap-2"><Mail size={15} className="text-teal" /><h3 className="text-sm font-bold text-navy">Compose</h3>
            {templates.length > 0 && <select onChange={(e) => e.target.value && loadTemplate(e.target.value)} className="ml-auto text-[11px] rounded-md border border-gray-200 px-2 py-1" defaultValue=""><option value="">Load template…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
          </div>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
            <span className="text-ink-light font-semibold">Insert:</span>
            <button type="button" onClick={() => insertToken("#firstname#")} className="font-semibold text-teal-dark bg-teal-lighter border border-teal/20 rounded-full px-2 py-0.5 hover:bg-teal-light">#firstname#</button>
            <button type="button" onClick={() => insertToken("#businessname#")} className="font-semibold text-teal-dark bg-teal-lighter border border-teal/20 rounded-full px-2 py-0.5 hover:bg-teal-light">#businessname#</button>
            <button type="button" onClick={() => insertToken("#loginemail#")} className="font-semibold text-teal-dark bg-teal-lighter border border-teal/20 rounded-full px-2 py-0.5 hover:bg-teal-light">#loginemail#</button>
            <span className="text-ink-light">— each client gets their own; preview before send</span>
          </div>
          <textarea ref={bodyRef} value={bodyText} onChange={(e) => setBodyText(e.target.value)} rows={9} placeholder={"Write your message…\n\nExample: Hi #firstname#, your June books are ready!\n\nBlank line = new paragraph. **bold** for emphasis.\n#firstname# / #businessname# / #loginemail# fill in per client — you'll preview each before sending."} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm resize-y font-mono" />
          <div className="flex items-center gap-3 flex-wrap text-xs text-ink-slate">
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={alsoPortal} onChange={(e) => setAlsoPortal(e.target.checked)} className="rounded border-gray-300 text-teal" /> Also post to portal inbox</label>
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={includeSignature} onChange={(e) => setIncludeSignature(e.target.checked)} className="rounded border-gray-300 text-teal" /> Include my signature</label>
            <label className="inline-flex items-center gap-1.5">Replies to:
              <select value={replyMode} onChange={(e) => setReplyMode(e.target.value as any)} className="rounded-md border border-gray-200 px-1.5 py-0.5"><option value="bookkeeper">Assigned preparer</option><option value="support">admin@ironbooks.com</option></select>
            </label>
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-1">Preview · branded Ironbooks template (sample merge)</div>
            <div className="rounded-lg border border-gray-200 overflow-auto max-h-[420px]"
              dangerouslySetInnerHTML={{
                __html: wrapBrandedEmail({
                  bodyHtml: applyMergeFields(
                    textToHtml(bodyText || "Your message goes here. The Ironbooks header, logo, and footer are added automatically."),
                    { firstName: "Daniel", businessName: "Acme Painting", loginEmail: "daniel@acmepainting.com" }
                  ) + (includeSignature ? renderUserSignature({ ...senderSignature, signature_enabled: true }) : ""),
                  footerHtml: kind === "normal"
                    ? "You're receiving this because you're an Ironbooks client. <span style=\"color:#1F5D58;font-weight:600;\">Unsubscribe</span> from updates like this."
                    : kind === "resubscribe"
                    ? "Want our updates again? <span style=\"color:#1F5D58;font-weight:700;\">Yes, resubscribe me</span>."
                    : null,
                }),
              }}
            />
          </div>
          {msg && <div className={`text-xs rounded px-2.5 py-1.5 ${msg.tone === "ok" ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>{msg.text}</div>}
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={send} disabled={busy !== null} className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2 rounded-lg disabled:opacity-50">{busy === "send" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send to {selectedEligible.length}</button>
            <button onClick={sendTest} disabled={busy !== null} className="inline-flex items-center gap-1.5 text-xs font-semibold border border-gray-200 px-3 py-2 rounded-lg hover:border-gray-300">{busy === "test" ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} Test to me</button>
            <button onClick={saveTemplate} className="inline-flex items-center gap-1.5 text-xs font-semibold border border-gray-200 px-3 py-2 rounded-lg hover:border-gray-300"><Save size={12} /> Save as template</button>
          </div>
        </div>
      </div>

      {previewOpen && (
        <SendPreviewModal
          recips={previewRecips}
          subject={subject}
          bodyText={bodyText}
          kind={kind}
          busy={busy}
          onConfirm={doSend}
          onCancel={() => setPreviewOpen(false)}
        />
      )}

      {/* History */}
      {campaigns.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 p-4">
          <div className="flex items-center gap-2 mb-3"><Clock size={15} className="text-teal" /><h3 className="text-sm font-bold text-navy">Recent campaigns</h3></div>
          <div className="divide-y divide-gray-50">
            {campaigns.map((c) => (
              <div key={c.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex-1 min-w-0 truncate text-navy">{c.subject}</span>
                <span className="text-[10px] uppercase font-semibold text-ink-light">{c.kind}</span>
                <span className="text-xs text-ink-slate">{c.sent_count}/{c.recipient_count} sent{c.failed_count > 0 && <span className="text-red-600"> · {c.failed_count} failed</span>}</span>
                {c.status === "sent" ? <CheckCircle2 size={14} className="text-emerald-600" /> : c.status === "sending" ? <Loader2 size={14} className="animate-spin text-teal" /> : <AlertTriangle size={14} className="text-amber-500" />}
                <span className="text-[10px] text-ink-light w-20 text-right">{new Date(c.created_at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Send-time preview: shows exactly how #firstname# resolves for every selected
 * client before anything goes out, so the sender can confirm the mapping. Rows
 * with no first name on file are flagged (they'll receive "there").
 */
function SendPreviewModal({
  recips, subject, bodyText, kind, busy, onConfirm, onCancel,
}: {
  recips: Recipient[];
  subject: string;
  bodyText: string;
  kind: Kind;
  busy: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const sample = recips[0];
  const noFirst = recips.filter((r) => !(r.first_name || "").trim()).length;
  // Whether the copy uses a login-email token, and how many chosen clients have
  // no portal login yet (those fall back to the address we're emailing).
  const usesLogin = /\{\{\s*(contact\.)?(login_?email|portal_?email|email|login)\s*\}\}|#\s*(login_?email|portal_?email|email|login)\s*#/i.test(`${subject}\n${bodyText}`);
  const noLogin = recips.filter((r) => !r.login_email).length;
  const firstLine = bodyText.split(/\n/).find((l) => l.trim()) || "";
  const sampleVars = sample ? { firstName: sample.first_name, businessName: sample.client_name, loginEmail: sample.login_email || sample.email } : {};
  const exSubject = sample ? applyMergeFields(subject, sampleVars) : subject;
  const exLine = sample ? applyMergeFields(firstLine, sampleVars) : firstLine;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-bold text-navy">Review personalization — {recips.length} client{recips.length === 1 ? "" : "s"}</h3>
          <p className="text-xs text-ink-slate mt-1">
            Each client gets their own <code className="bg-slate-100 rounded px-1">#firstname#</code>. Confirm the mapping below before sending — this is client-facing.
          </p>
        </div>

        {sample && (
          <div className="px-5 py-3 border-b border-gray-100 bg-slate-50 text-xs">
            <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-1">Example — {sample.client_name}</div>
            <div><span className="text-ink-light">Subject:</span> <span className="text-navy font-medium">{exSubject}</span></div>
            {firstLine && <div className="mt-0.5"><span className="text-ink-light">Opens:</span> <span className="text-navy">{exLine}</span></div>}
          </div>
        )}

        {noFirst > 0 && (
          <div className="px-5 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-800 flex items-center gap-1.5">
            <AlertTriangle size={13} className="flex-shrink-0" />
            {noFirst} {noFirst === 1 ? "client has" : "clients have"} no first name on file — they'll receive “there”. Edit their profile to fix.
          </div>
        )}

        {usesLogin && noLogin > 0 && (
          <div className="px-5 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-800 flex items-center gap-1.5">
            <AlertTriangle size={13} className="flex-shrink-0" />
            {noLogin} {noLogin === 1 ? "client has" : "clients have"} no portal login yet — <code className="bg-amber-100 rounded px-1 mx-0.5">#loginemail#</code> falls back to the address we're emailing (their contact email).
          </div>
        )}

        <div className="overflow-y-auto flex-1">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white border-b border-gray-100 text-ink-light">
              <tr>
                <th className="text-left font-semibold px-5 py-1.5">Client</th>
                <th className="text-left font-semibold px-2 py-1.5">#firstname# →</th>
                <th className="text-left font-semibold px-5 py-1.5">Email</th>
              </tr>
            </thead>
            <tbody>
              {recips.map((r) => {
                const fn = (r.first_name || "").trim();
                return (
                  <tr key={r.client_link_id} className="border-b border-gray-50">
                    <td className="px-5 py-1.5 text-navy truncate max-w-[200px]">{r.client_name}</td>
                    <td className={`px-2 py-1.5 font-semibold ${fn ? "text-teal-dark" : "text-amber-700"}`}>
                      {fn || "there"}{!fn && <span className="text-[10px] font-normal text-amber-600"> (no name)</span>}
                    </td>
                    <td className="px-5 py-1.5 text-ink-light truncate max-w-[200px]">{r.email}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center gap-2">
          <button onClick={onConfirm} disabled={busy !== null} className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2 rounded-lg disabled:opacity-50">
            {busy === "send" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Confirm &amp; send to {recips.length}
          </button>
          <button onClick={onCancel} disabled={busy !== null} className="text-sm font-semibold border border-gray-200 px-3 py-2 rounded-lg hover:border-gray-300">Cancel</button>
          <span className="ml-auto text-[10px] text-ink-light uppercase tracking-wider">{kind}</span>
        </div>
      </div>
    </div>
  );
}
