"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  X, FileText, Copy, CheckCircle2, Mail, Send, Loader2,
} from "lucide-react";

interface InReviewClient {
  id: string;
  client_name: string;
  cleanup_review_submitted_at: string;
  cleanup_review_submitted_by_name: string | null;
  cleanup_range_start: string | null;
  cleanup_range_end: string | null;
}

/**
 * Senior-review modal. Walks the reviewing admin/lead through:
 *
 *   1. Open the PDF report (one click — new tab).
 *   2. Copy a branded email containing the PDF link, ready to paste
 *      into Double's client portal.
 *   3. Confirm sent + click Approve. Endpoint marks the client fully
 *      complete; client moves to Completed Accounts.
 *
 * The two "copy" buttons mirror the Stripe Connect Link pattern —
 * branded HTML for paste-into-Double, plus plain-text fallback.
 */
export function CleanupReviewModal({
  client,
  onClose,
}: {
  client: InReviewClient;
  onClose: () => void;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [pdfOpened, setPdfOpened] = useState(false);
  const [emailCopied, setEmailCopied] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pdfUrl =
    client.cleanup_range_start && client.cleanup_range_end
      ? `/api/reports/cleanup/${client.id}?start=${client.cleanup_range_start}&end=${client.cleanup_range_end}`
      : null;

  async function copyEmail() {
    const firstName = client.client_name.split(/[ ,]/)[0] || "there";
    // Use absolute URL so the PDF link works from a pasted email.
    const baseOrigin =
      typeof window !== "undefined" ? window.location.origin : "";
    const absolutePdf = pdfUrl ? `${baseOrigin}${pdfUrl}` : "";

    const html = buildEmailHtml(firstName, absolutePdf, client.client_name);
    const plain = buildEmailPlain(firstName, absolutePdf, client.client_name);

    try {
      if (typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plain], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(plain);
      }
      setEmailCopied(true);
      setTimeout(() => setEmailCopied(false), 2500);
    } catch (err: any) {
      setError(err?.message || "Could not copy email");
    }
  }

  async function approve() {
    setApproving(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${client.id}/approve-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onClose();
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Failed to approve");
      setApproving(false);
    }
  }

  const [rejecting, setRejecting] = useState(false);
  async function reject() {
    if (!notes.trim()) {
      setError("Add a note telling the bookkeeper what to fix before rejecting.");
      return;
    }
    setRejecting(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${client.id}/reject-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onClose();
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Failed to reject");
      setRejecting(false);
    }
  }

  if (!mounted) return null;

  const submittedAgo = (() => {
    const ms =
      Date.now() - new Date(client.cleanup_review_submitted_at).getTime();
    const hrs = Math.round(ms / (3600 * 1000));
    if (hrs < 1) return "less than an hour ago";
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  })();

  const content = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{
        backgroundColor: "rgba(15, 31, 46, 0.6)",
        backdropFilter: "blur(4px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-navy flex items-center gap-2">
              <FileText size={18} className="text-teal" />
              Review cleanup: {client.client_name}
            </h3>
            <p className="text-xs text-ink-slate mt-1">
              Submitted{" "}
              {client.cleanup_review_submitted_by_name && (
                <>
                  by{" "}
                  <span className="font-semibold text-navy">
                    {client.cleanup_review_submitted_by_name}
                  </span>{" "}
                </>
              )}
              {submittedAgo} ·{" "}
              {client.cleanup_range_start && client.cleanup_range_end ? (
                <span className="font-mono">
                  {client.cleanup_range_start} → {client.cleanup_range_end}
                </span>
              ) : (
                <span className="text-ink-light">no saved range</span>
              )}
            </p>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy">
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5 overflow-y-auto flex-1">
          {/* Step 1: Open PDF */}
          <div className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-wider text-ink-slate">
              Step 1 · Review the cleanup report
            </div>
            {pdfUrl ? (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setPdfOpened(true)}
                className="w-full inline-flex items-center justify-center gap-2 bg-white hover:bg-gray-50 border border-gray-200 text-navy text-sm font-semibold px-5 py-2.5 rounded-lg"
              >
                <FileText size={16} />
                {pdfOpened ? "Re-open PDF report" : "Open PDF report"}
                {pdfOpened && (
                  <CheckCircle2 size={14} className="text-green-600 ml-1" />
                )}
              </a>
            ) : (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                ⚠ No saved cleanup date range — PDF report can&apos;t be
                generated. Withdraw the review submission, run a cleanup so a
                range gets recorded, then resubmit.
              </div>
            )}
          </div>

          {/* Step 2: Copy email */}
          <div className="space-y-2 pt-2 border-t border-gray-100">
            <div className="text-xs font-bold uppercase tracking-wider text-ink-slate">
              Step 2 · Copy the branded email
            </div>
            <p className="text-xs text-ink-slate leading-relaxed">
              The clipboard will contain a branded email with the PDF link
              embedded. Paste it into your email client and send to{" "}
              <span className="font-semibold text-navy">{client.client_name}</span>.
            </p>
            <button
              onClick={copyEmail}
              disabled={!pdfUrl}
              className="w-full inline-flex items-center justify-center gap-2 bg-navy hover:bg-navy-deep disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            >
              {emailCopied ? <CheckCircle2 size={15} /> : <Mail size={15} />}
              {emailCopied ? "Copied to clipboard!" : "Copy branded email to clipboard"}
            </button>
          </div>

          {/* Step 3: Notes + approve / reject */}
          <div className="space-y-2 pt-2 border-t border-gray-100">
            <div className="text-xs font-bold uppercase tracking-wider text-ink-slate">
              Step 3 · Approve or send back
            </div>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Review notes (saved on the client; required to send back)"
              className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-xs text-navy"
            />
            {error && (
              <div className="p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
                {error}
              </div>
            )}
            <button
              onClick={approve}
              disabled={approving || rejecting}
              className="w-full inline-flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            >
              {approving ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Send size={16} />
              )}
              {approving
                ? "Approving…"
                : `Approve & mark ${client.client_name} complete`}
            </button>
            <button
              onClick={reject}
              disabled={approving || rejecting}
              className="w-full inline-flex items-center justify-center gap-2 border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-60 text-sm font-semibold px-5 py-2 rounded-lg"
              title="Bounce this cleanup back to the bookkeeper to rework — no client email is sent"
            >
              {rejecting ? <Loader2 size={16} className="animate-spin" /> : <X size={16} />}
              {rejecting ? "Sending back…" : "Reject — send back to bookkeeper"}
            </button>
            <p className="text-[11px] text-ink-light text-center">
              Approve confirms the PDF was sent and moves the client to Production.
              Reject bounces it back to the bookkeeper (Failed Review) with your
              note — no client email.
            </p>
          </div>
        </div>

        <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between">
          <button
            onClick={onClose}
            className="text-sm font-semibold text-ink-slate hover:text-navy"
          >
            Close (review later)
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

// ───── Branded email content ─────

function buildEmailHtml(firstName: string, pdfUrl: string, clientName: string) {
  const BRAND = {
    teal: "#2D7A75",
    tealDark: "#1F5D58",
    tealLighter: "#F4F9F8",
    navy: "#0F1F2E",
    slate: "#475569",
    lightSlate: "#94A3B8",
    border: "#CBD5E1",
    white: "#FFFFFF",
  };
  return `<div style="font-family:'Figtree','Helvetica Neue',Helvetica,Arial,sans-serif;color:${BRAND.navy};max-width:640px;margin:0 auto;background:${BRAND.white};">
  <div style="background:${BRAND.navy};color:${BRAND.white};padding:18px 22px;border-radius:10px 10px 0 0;">
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="vertical-align:middle;width:54px;padding-right:14px;">
          <img src="https://internal.ironbooks.com/logo.png" alt="Ironbooks" width="44" height="44" style="display:block;width:44px;height:auto;" />
        </td>
        <td style="vertical-align:middle;color:${BRAND.white};">
          <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;line-height:1.1;color:${BRAND.white};">Ironbooks</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-top:3px;letter-spacing:0.06em;text-transform:uppercase;">Cleanup &middot; Complete</div>
        </td>
      </tr>
    </table>
  </div>
  <div style="border:1px solid ${BRAND.border};border-top:none;padding:24px 22px;border-radius:0 0 10px 10px;background:${BRAND.white};">
    <p style="margin:0 0 14px 0;color:${BRAND.navy};line-height:1.55;">Hi ${firstName},</p>
    <p style="margin:0 0 14px 0;color:${BRAND.navy};line-height:1.55;">Your bookkeeping cleanup for <strong>${clientName}</strong> is complete. Attached is a full summary of everything we did — every account renamed, transaction reclassified, and rule created — so your books are now standardized and accurate going forward.</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${pdfUrl}" style="display:inline-block;background:${BRAND.teal};color:${BRAND.white};font-weight:600;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none;">Download Your Cleanup Report &rarr;</a>
    </div>
    <div style="background:${BRAND.tealLighter};border:1px solid ${BRAND.border};border-radius:8px;padding:14px 16px;margin:18px 0;">
      <div style="font-size:13px;font-weight:600;color:${BRAND.teal};margin-bottom:8px;">What's in the report</div>
      <ul style="margin:0;padding-left:18px;color:${BRAND.slate};font-size:13px;line-height:1.6;">
        <li><strong style="color:${BRAND.navy};">Chart of accounts</strong> standardized to industry best practice</li>
        <li><strong style="color:${BRAND.navy};">Transactions</strong> reclassified to the right accounts</li>
        <li><strong style="color:${BRAND.navy};">Bank rules</strong> so future transactions categorize automatically</li>
        <li><strong style="color:${BRAND.navy};">Stripe reconciliation</strong> with fees + customer attribution (if applicable)</li>
      </ul>
    </div>
    <p style="margin:18px 0 0 0;color:${BRAND.navy};line-height:1.55;">Going forward we&apos;ll handle your books month-over-month. If you have any questions about the cleanup, just reply to this email.</p>
    <p style="margin:14px 0 0 0;color:${BRAND.navy};line-height:1.55;">Kindly,<br>Ironbooks</p>
    <div style="border-top:2px solid ${BRAND.teal};margin:24px 0 12px 0;width:60px;"></div>
    <div style="color:${BRAND.lightSlate};font-size:11px;line-height:1.5;">If the button above doesn&apos;t work, copy and paste this URL into your browser:<br><span style="color:${BRAND.teal};word-break:break-all;">${pdfUrl}</span></div>
  </div>
</div>`;
}

function buildEmailPlain(firstName: string, pdfUrl: string, clientName: string) {
  return `Hi ${firstName},

Your bookkeeping cleanup for ${clientName} is complete. Attached is a full summary of everything we did — every account renamed, transaction reclassified, and rule created — so your books are now standardized and accurate going forward.

Download your cleanup report:
${pdfUrl}

What's in the report:
  • Chart of accounts standardized to industry best practice
  • Transactions reclassified to the right accounts
  • Bank rules so future transactions categorize automatically
  • Stripe reconciliation with fees + customer attribution (if applicable)

Going forward we'll handle your books month-over-month. If you have any questions about the cleanup, just reply to this email.

Kindly,
Ironbooks`;
}
