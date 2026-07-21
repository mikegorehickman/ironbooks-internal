"use client";

import { useEffect, useState } from "react";
import { Loader2, X as XIcon, ArrowRight, Mail } from "lucide-react";

/**
 * Email history — every client-facing email we've logged for this client
 * (client_email_log), with live delivery/open/click tracking kept fresh by the
 * Resend webhook (migration 93 + 107). Replaces the old "recent activity" strip
 * on the Overview: the question a bookkeeper actually has is "did they see what
 * we sent?" A row opens the actual sent email (pulled back from Resend by
 * provider_message_id via /email-log/[logId]).
 */

interface EmailRow {
  id: string;
  email_type: string;
  subject: string | null;
  to_address: string;
  status: string;
  created_at: string;
  delivered_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  ask_client: "Question",
  ask_client_txns: "Transaction question",
  reclass_questions: "Categorization questions",
  statement_request: "Statement request",
  statements_ready: "Statements ready",
  docs_request: "Document request",
  portal_help: "Portal help",
  bs_statements: "Statements",
  stripe_connect: "Payment setup",
  general: "Email",
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "2-digit" });

/** Tracking pill — the whole point of this panel. */
function trackPill(e: EmailRow): { label: string; cls: string } {
  if (e.status === "bounced" || e.status === "complained")
    return { label: "Bounced", cls: "bg-red-50 text-[#954E44] border border-red-100" };
  if (e.status === "failed")
    return { label: "Failed", cls: "bg-red-50 text-[#954E44] border border-red-100" };
  if (e.clicked_at)
    return { label: "Clicked ✓", cls: "bg-teal-light text-teal-dark border border-teal-border" };
  if (e.opened_at)
    return { label: "Opened · no click", cls: "bg-gold-tint text-gold-deep border border-gold-border" };
  if (e.delivered_at || e.status === "delivered")
    return { label: "Not opened", cls: "bg-gray-50 text-ink-slate border border-gray-200" };
  return { label: "Sent", cls: "bg-gray-50 text-ink-slate border border-gray-200" };
}

export function EmailHistoryPanel({
  clientLinkId,
  onSendEmail,
  onOpenActivity,
}: {
  clientLinkId: string;
  onSendEmail: () => void;
  onOpenActivity?: () => void;
}) {
  const [emails, setEmails] = useState<EmailRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = () => {
    fetch(`/api/clients/${clientLinkId}/email-log?limit=12`)
      .then((r) => (r.ok ? r.json() : { emails: [] }))
      .then((j) => setEmails(j.emails || []))
      .catch(() => setEmails([]));
  };
  useEffect(load, [clientLinkId]);

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Email history</h2>
        <div className="ml-auto flex items-center gap-3">
          {onOpenActivity && (
            <button onClick={onOpenActivity} className="text-xs font-semibold text-teal hover:text-teal-dark">
              Activity →
            </button>
          )}
          <button onClick={onSendEmail} className="text-xs font-semibold text-teal hover:text-teal-dark">
            Send email →
          </button>
        </div>
      </div>

      {emails === null ? (
        <div className="flex items-center justify-center gap-2 text-sm text-ink-slate py-8">
          <Loader2 size={15} className="animate-spin text-teal" /> Loading…
        </div>
      ) : emails.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <Mail size={22} className="mx-auto text-ink-light mb-1.5" />
          <p className="text-sm text-ink-slate">No emails sent to this client yet.</p>
          <button onClick={onSendEmail} className="mt-2 text-xs font-semibold text-teal hover:text-teal-dark">
            Send the first one →
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {emails.map((e) => {
            const pill = trackPill(e);
            return (
              <li key={e.id}>
                <button
                  onClick={() => setOpenId(e.id)}
                  className="w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-gray-50/70 transition-colors"
                  title="View the sent email"
                >
                  <span className="text-xs text-ink-light tabular-nums w-12 shrink-0">{fmtDate(e.created_at)}</span>
                  <span className="text-sm text-navy truncate flex-1 min-w-0">
                    {e.subject || TYPE_LABEL[e.email_type] || "(no subject)"}
                  </span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${pill.cls}`}>
                    {pill.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {openId && (
        <ViewEmailModal
          clientLinkId={clientLinkId}
          logId={openId}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

// ─── View a sent email (pulled back from Resend) ──────────────────────────

function ViewEmailModal({
  clientLinkId,
  logId,
  onClose,
}: {
  clientLinkId: string;
  logId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/clients/${clientLinkId}/email-log/${logId}`)
      .then((r) => r.json())
      .then((j) => {
        setData(j);
        if (!j.resend && j.resend_error) setError(j.resend_error);
      })
      .catch((e) => setError(e?.message || "Couldn't load the email"));
  }, [clientLinkId, logId]);

  const stored = data?.stored;
  const resend = data?.resend;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(11,29,46,0.32)" }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-gray-100 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light">Sent email</div>
            <div className="text-sm font-bold text-navy truncate">
              {resend?.subject || stored?.subject || "(no subject)"}
            </div>
            <div className="text-[11px] text-ink-slate mt-0.5">
              To {stored?.to_address}
              {stored?.created_at ? ` · ${new Date(stored.created_at).toLocaleString()}` : ""}
              {stored?.opened_at ? " · opened" : stored?.delivered_at ? " · delivered" : ""}
            </div>
          </div>
          <button onClick={onClose} className="text-ink-light hover:text-navy shrink-0" aria-label="Close">
            <XIcon size={16} />
          </button>
        </div>
        <div className="overflow-y-auto p-5">
          {!data && !error ? (
            <div className="flex items-center gap-2 text-sm text-ink-slate py-6 justify-center">
              <Loader2 size={15} className="animate-spin text-teal" /> Loading the email…
            </div>
          ) : resend?.html ? (
            <div
              className="text-sm [&_img]:max-w-full"
              dangerouslySetInnerHTML={{ __html: resend.html }}
            />
          ) : resend?.text ? (
            <pre className="text-sm whitespace-pre-wrap font-sans text-navy">{resend.text}</pre>
          ) : (
            <div className="text-sm text-ink-slate">
              <p className="mb-2">The email body isn't retrievable{error ? ":" : "."}</p>
              {error && <p className="text-xs text-ink-light">{error}</p>}
              <p className="text-xs text-ink-light mt-2">
                Subject and delivery status are still tracked above.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
