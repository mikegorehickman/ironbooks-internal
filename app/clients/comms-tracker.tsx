"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Mail, CreditCard, FileText, Sparkles, CheckCircle2, Circle, Copy, Loader2, BanIcon, RotateCcw,
} from "lucide-react";
import { StripeConnectModal } from "@/components/StripeConnectModal";

export interface CommsTrackerData {
  client_link_id: string;
  client_name: string;
  // Ask Client email
  ask_client_email_created_at: string | null;
  ask_client_email_sent_at: string | null;
  ask_client_email_body: string | null;
  // Stripe Connect request
  stripe_request_created_at: string | null; // most recent stripe_connect_tokens.created_at
  stripe_request_sent_confirmed_at: string | null;
  stripe_connection_status: string | null;
  /** True = bookkeeper has confirmed this client doesn't use Stripe.
   *  When set, the Stripe row renders as "Not applicable" with a
   *  small re-enable button; the action buttons and sent checkbox
   *  are hidden because they don't make sense. */
  stripe_not_required: boolean;
  // Cleanup PDF
  cleanup_completed_at: string | null;
  cleanup_range_start: string | null;
  cleanup_range_end: string | null;
  cleanup_pdf_sent_at: string | null;
}

/**
 * Three-tracker compact panel on the client card view. Each tracker
 * shows two booleans (created / sent) so the bookkeeper can scan a
 * card and know at a glance:
 *
 *   ✅ Ask Client email    [Created · Sent]
 *   ⚠  Stripe Request      [Created · NOT Sent]
 *   ⬜ Cleanup PDF         [Not yet · —]
 *
 * "Created" flips automatically when the platform produces the
 * artifact. "Sent" is a manual checkbox — we can't observe outbound
 * email so the bookkeeper confirms after pasting into Double.
 *
 * Each row also has a "do the next thing" action button:
 *   - Ask Client: Generate / Re-copy email
 *   - Stripe: Open Connect modal (generate link or recopy email)
 *   - Cleanup PDF: Download
 */
export function CommsTracker({
  data,
  compact = false,
}: {
  data: CommsTrackerData;
  /** Compact = used inline on the client card (small). Otherwise
   *  a fuller variant suitable for a detail view. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [askEmail, setAskEmail] = useState<{
    text: string;
    html: string;
    transaction_count: number;
    vendor_count: number;
  } | null>(null);
  const [stripeModalOpen, setStripeModalOpen] = useState(false);

  async function toggleStripeNotRequired(next: boolean) {
    setBusy("stripe_not_required");
    setError("");
    try {
      if (next) {
        const reason =
          window.prompt(
            `Mark ${data.client_name} as not using Stripe?\n\nOptional: a short reason for the audit log (e.g. "cash-only", "uses Square only").`,
            ""
          );
        // null = user cancelled
        if (reason === null) {
          setBusy(null);
          return;
        }
        const res = await fetch(
          `/api/clients/${data.client_link_id}/stripe-not-required`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: reason || undefined }),
          }
        );
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (json.warning) {
          // surface the "still connected" warning inline; non-blocking.
          setError(json.warning);
        }
      } else {
        const res = await fetch(
          `/api/clients/${data.client_link_id}/stripe-not-required`,
          { method: "DELETE" }
        );
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
      }
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Toggle failed");
    } finally {
      setBusy(null);
    }
  }

  async function toggleSent(field: "ask_client_sent" | "stripe_request_sent" | "cleanup_pdf_sent", next: boolean) {
    setBusy(field);
    setError("");
    try {
      const res = await fetch(`/api/clients/${data.client_link_id}/comms-tracker`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Toggle failed");
    } finally {
      setBusy(null);
    }
  }

  async function generateAskClientEmail() {
    setBusy("ask_client_create");
    setError("");
    try {
      const res = await fetch(`/api/clients/${data.client_link_id}/ask-client-email`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setAskEmail({
        text: json.email_text,
        html: json.email_html,
        transaction_count: json.transaction_count,
        vendor_count: json.vendor_count,
      });
      // Auto-copy the HTML to clipboard so the bookkeeper can paste
      // straight into Double.
      try {
        if (typeof ClipboardItem !== "undefined") {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/html": new Blob([json.email_html], { type: "text/html" }),
              "text/plain": new Blob([json.email_text], { type: "text/plain" }),
            }),
          ]);
        } else {
          await navigator.clipboard.writeText(json.email_text);
        }
      } catch {
        // clipboard might be blocked; the modal still shows the body
      }
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Generate failed");
    } finally {
      setBusy(null);
    }
  }

  async function copyCachedAskEmail() {
    if (!data.ask_client_email_body) return;
    try {
      await navigator.clipboard.writeText(data.ask_client_email_body);
    } catch {
      // ignore
    }
  }

  const pdfHref =
    data.cleanup_range_start && data.cleanup_range_end
      ? `/api/reports/cleanup/${data.client_link_id}?start=${data.cleanup_range_start}&end=${data.cleanup_range_end}`
      : null;

  // Row state helpers
  const askCreated = !!data.ask_client_email_created_at;
  const askSent = !!data.ask_client_email_sent_at;
  const stripeCreated = !!data.stripe_request_created_at;
  const stripeSent = !!data.stripe_request_sent_confirmed_at;
  const stripeConnected = data.stripe_connection_status === "connected";
  const pdfCreated = !!data.cleanup_completed_at && !!pdfHref;
  const pdfSent = !!data.cleanup_pdf_sent_at;

  return (
    <>
      <div className={compact ? "text-xs" : "text-sm"}>
        {error && (
          <div className="mb-2 p-1.5 rounded bg-red-50 border border-red-200 text-[11px] text-red-800">
            {error}
          </div>
        )}
        <div className="space-y-1.5">
          <TrackerRow
            icon={Mail}
            iconColor="#0891B2"
            label="Ask Client email"
            createdLabel={
              askCreated
                ? `Generated ${formatAgo(data.ask_client_email_created_at!)}`
                : "Not generated yet"
            }
            createdOk={askCreated}
            sentChecked={askSent}
            onToggleSent={() => toggleSent("ask_client_sent", !askSent)}
            disabledToggle={!askCreated}
            actionLabel={askCreated ? "Re-copy" : "Generate"}
            onAction={
              askCreated && data.ask_client_email_body
                ? copyCachedAskEmail
                : generateAskClientEmail
            }
            actionBusy={busy === "ask_client_create"}
            toggleBusy={busy === "ask_client_sent"}
          />
          {data.stripe_not_required ? (
            // "Not applicable" variant — bookkeeper confirmed this
            // client doesn't use Stripe, suppresses every prompt.
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border bg-gray-100 border-gray-200 opacity-75">
              <BanIcon
                size={13}
                className="flex-shrink-0 text-ink-light"
              />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-bold text-ink-slate truncate line-through">
                  Stripe Connect
                </div>
                <div className="text-[10px] text-ink-light truncate">
                  Not required for this client
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleStripeNotRequired(false);
                }}
                disabled={busy === "stripe_not_required"}
                className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wider text-teal hover:text-teal-dark disabled:opacity-50 px-1.5 inline-flex items-center gap-1"
                title="Re-enable Stripe prompts for this client"
              >
                {busy === "stripe_not_required" ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <RotateCcw size={10} />
                )}
                Re-enable
              </button>
            </div>
          ) : (
            <TrackerRow
              icon={CreditCard}
              iconColor="#7C3AED"
              label="Stripe Connect"
              createdLabel={
                stripeConnected
                  ? "Connected ✓"
                  : stripeCreated
                  ? `Link generated ${formatAgo(data.stripe_request_created_at!)}`
                  : "No link yet"
              }
              createdOk={stripeCreated || stripeConnected}
              sentChecked={stripeConnected || stripeSent}
              onToggleSent={() =>
                !stripeConnected && toggleSent("stripe_request_sent", !stripeSent)
              }
              disabledToggle={!stripeCreated || stripeConnected}
              actionLabel="Stripe Link"
              onAction={() => setStripeModalOpen(true)}
              toggleBusy={busy === "stripe_request_sent"}
              extraSecondaryAction={{
                label: "Not needed",
                onClick: () => toggleStripeNotRequired(true),
                busy: busy === "stripe_not_required",
                title:
                  "Mark this client as not using Stripe — suppresses every Stripe prompt for them",
              }}
            />
          )}
          <TrackerRow
            icon={FileText}
            iconColor="#2D7A75"
            label="Cleanup PDF"
            createdLabel={
              pdfCreated
                ? `Ready (${data.cleanup_range_start} → ${data.cleanup_range_end})`
                : "Cleanup not complete yet"
            }
            createdOk={pdfCreated}
            sentChecked={pdfSent}
            onToggleSent={() => toggleSent("cleanup_pdf_sent", !pdfSent)}
            disabledToggle={!pdfCreated}
            actionLabel="Download"
            onAction={pdfHref ? () => window.open(pdfHref, "_blank") : undefined}
            disabledAction={!pdfHref}
            toggleBusy={busy === "cleanup_pdf_sent"}
          />
        </div>
      </div>

      {/* Ask client email modal (post-generation summary + recopy) */}
      {askEmail && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{
            backgroundColor: "rgba(15, 31, 46, 0.6)",
            backdropFilter: "blur(4px)",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setAskEmail(null);
          }}
        >
          <div className="bg-white rounded-2xl shadow-2xl max-w-xl w-full max-h-[80vh] flex flex-col p-6">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles size={18} className="text-teal" />
              <h3 className="text-lg font-bold text-navy">
                Ask Client email — {data.client_name}
              </h3>
            </div>
            <p className="text-xs text-ink-slate mb-3">
              Copied to clipboard. Paste into your email client and send to{" "}
              <strong>{data.client_name}</strong>. {askEmail.vendor_count}{" "}
              vendor{askEmail.vendor_count === 1 ? "" : "s"} from {askEmail.transaction_count}{" "}
              flagged transaction{askEmail.transaction_count === 1 ? "" : "s"}.
            </p>
            <pre className="text-xs font-mono whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-y-auto flex-1">
              {askEmail.text}
            </pre>
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={() => navigator.clipboard.writeText(askEmail.text)}
                className="inline-flex items-center gap-1.5 bg-navy hover:bg-ink-light text-white text-xs font-semibold px-3 py-1.5 rounded-md"
              >
                <Copy size={12} /> Copy plain text
              </button>
              <button
                onClick={() => setAskEmail(null)}
                className="text-xs font-semibold text-ink-slate hover:text-navy ml-auto"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {stripeModalOpen && (
        <StripeConnectModal
          onClose={() => setStripeModalOpen(false)}
          preselectedClientId={data.client_link_id}
        />
      )}
    </>
  );
}

function TrackerRow({
  icon: Icon,
  iconColor,
  label,
  createdLabel,
  createdOk,
  sentChecked,
  onToggleSent,
  disabledToggle,
  actionLabel,
  onAction,
  actionBusy,
  toggleBusy,
  disabledAction,
  extraSecondaryAction,
}: {
  icon: any;
  iconColor: string;
  label: string;
  createdLabel: string;
  createdOk: boolean;
  sentChecked: boolean;
  onToggleSent: () => void;
  disabledToggle?: boolean;
  actionLabel: string;
  onAction?: () => void;
  actionBusy?: boolean;
  toggleBusy?: boolean;
  disabledAction?: boolean;
  /** Optional secondary action — small text button. Used by the
   *  Stripe row's "Not needed" toggle. */
  extraSecondaryAction?: {
    label: string;
    onClick: () => void;
    busy?: boolean;
    title?: string;
  };
}) {
  const bothDone = createdOk && sentChecked;
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md border ${
        bothDone
          ? "bg-green-50 border-green-200"
          : createdOk
          ? "bg-amber-50 border-amber-200"
          : "bg-gray-50 border-gray-200"
      }`}
    >
      <Icon
        size={13}
        style={{ color: iconColor }}
        className="flex-shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-bold text-navy truncate">{label}</div>
        <div className="text-[10px] text-ink-slate truncate">{createdLabel}</div>
      </div>
      {/* Sent checkbox */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (!disabledToggle) onToggleSent();
        }}
        disabled={disabledToggle || toggleBusy}
        className="flex-shrink-0 p-1 rounded hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
        title={
          disabledToggle
            ? "Generate / connect first"
            : sentChecked
            ? "Sent — click to uncheck"
            : "Mark as sent to client"
        }
      >
        {toggleBusy ? (
          <Loader2 size={14} className="animate-spin text-ink-slate" />
        ) : sentChecked ? (
          <CheckCircle2 size={14} className="text-green-600" />
        ) : (
          <Circle size={14} className="text-ink-light" />
        )}
      </button>
      {/* Action button */}
      {onAction && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAction();
          }}
          disabled={actionBusy || disabledAction}
          className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wider text-teal hover:text-teal-dark disabled:opacity-50 disabled:cursor-not-allowed px-1.5"
        >
          {actionBusy ? "…" : actionLabel}
        </button>
      )}
      {/* Optional secondary action (e.g. "Not needed" for Stripe) */}
      {extraSecondaryAction && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            extraSecondaryAction.onClick();
          }}
          disabled={extraSecondaryAction.busy}
          title={extraSecondaryAction.title}
          className="flex-shrink-0 text-[10px] font-semibold text-ink-light hover:text-ink-slate disabled:opacity-50 px-1"
        >
          {extraSecondaryAction.busy ? "…" : extraSecondaryAction.label}
        </button>
      )}
    </div>
  );
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hrs = Math.round(ms / (3600 * 1000));
  if (hrs < 1) return "just now";
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
