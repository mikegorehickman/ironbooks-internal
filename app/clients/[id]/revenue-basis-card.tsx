"use client";

import { useState } from "react";
import { Loader2, Check, AlertTriangle } from "lucide-react";

/**
 * Revenue basis — the per-client answer to "when a job's money shows up twice,
 * which leg is the real revenue?"
 *
 * WHY THIS IS ON THE PROFILE. A client whose field CRM pushed invoices into QBO
 * and has since DISCONNECTED still trips both duplicate-revenue red flags at
 * month-end review (deposits_in_revenue and crm_invoice_revenue are in
 * RED_FLAG_APPROVAL_KEYS — lib/books-verification.ts), which HARD-BLOCKS the
 * close until someone fixes it or dismisses it with a reason, every single
 * month. A note can't clear a check. The state already existed
 * (client_links.revenue_recognition_mode) but was only settable from the
 * /admin/crm-invoice-revenue fleet screen — nowhere near the reviewer who hits
 * the block. This puts it where the client's other structural facts live.
 *
 * WHY IT IS GUARDED. deposits_only does not merely silence a warning: it
 * EXCLUDES invoice-recognized income via computeRevenueAdjustment. Flip it on a
 * client whose invoices ARE the real revenue and you understate them by the
 * invoice total. Senior-only, and it asks first.
 *
 * KNOWN INCOMPLETE, and the card says so. lib/revenue-recognition.ts is
 * imported by exactly three files, so the exclusion reaches only: the
 * bookkeeper's statements preview + the stored monthly_rec_runs.statements
 * (lib/monthly-rec.ts), the close email's At-a-Glance figures (which read that
 * snapshot), and the COGS / net-margin ratio gates (lib/books-verification.ts).
 * It does NOT reach the client's portal P&L (app/portal/profit-loss/page.tsx
 * fetches live), the portal dashboard, portal Ask-AI, or the PUBLISHED month-end
 * package (lib/month-end/package-builder.ts builds pl_snapshot from its own
 * overview path). So a deposits_only client's close email and portal P&L will
 * disagree until those paths apply the adjustment too. Don't let a bookkeeper
 * discover that from a client's question.
 *
 * Writes through the existing POST /api/admin/revenue-mode so there is ONE
 * write path and ONE audit trail (event_type revenue_recognition_mode_change,
 * old → new), rather than a second one on the client PATCH route.
 */

type Mode = "standard" | "deposits_only";

export function RevenueBasisCard({
  clientLinkId,
  clientName,
  initialMode,
  canEdit,
}: {
  clientLinkId: string;
  clientName: string;
  initialMode: Mode;
  canEdit: boolean;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [saving, setSaving] = useState<Mode | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function change(next: Mode) {
    if (next === mode || saving) return;
    if (
      next === "deposits_only" &&
      !window.confirm(
        `Set ${clientName} to deposits-only revenue?\n\n` +
          `Their statements will EXCLUDE income recognized by invoices, counting only actual ` +
          `cash deposits. Do this when the invoices duplicate the deposits — a CRM pushed them ` +
          `in and the client is no longer invoicing through it.\n\n` +
          `Do NOT do this if the invoices are the real revenue and the DEPOSITS are the ` +
          `duplicates — that understates revenue. Fix those on Revenue Check instead.`
      )
    ) {
      return;
    }
    setSaving(next);
    setError("");
    setSaved(false);
    try {
      const res = await fetch("/api/admin/revenue-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId, mode: next }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setMode(next);
      setSaved(true);
    } catch (e: any) {
      setError(e?.message || "Couldn't change the revenue basis");
    } finally {
      setSaving(null);
    }
  }

  const OPTIONS: { value: Mode; label: string; blurb: string }[] = [
    {
      value: "standard",
      label: "Invoices + deposits",
      blurb:
        "Normal. Every income posting counts, and the close flags it when invoices and deposits both recognize the same money.",
    },
    {
      value: "deposits_only",
      label: "Deposits only — not invoicing through a CRM",
      blurb:
        "Statements count actual cash deposits and exclude invoice-recognized income. For clients whose CRM pushed invoices into QuickBooks and has since been disconnected.",
    },
  ];

  return (
    <div className="bg-white border border-cardline rounded-2xl p-5">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="font-bold text-navy text-sm">Revenue basis</h3>
        {mode === "deposits_only" && (
          <span className="text-[10px] font-bold uppercase tracking-wide text-teal-dark bg-teal/10 border border-teal/30 rounded px-1.5 py-0.5">
            Deposits only
          </span>
        )}
        {saved && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
            <Check size={12} /> Saved
          </span>
        )}
      </div>
      <p className="text-[11px] text-ink-slate mt-1">
        Which leg counts when the same job&apos;s money lands twice. Also decides whether the
        duplicate-revenue checks block this client&apos;s close.
      </p>

      <div className="mt-3 space-y-2">
        {OPTIONS.map((o) => (
          <label
            key={o.value}
            className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${
              mode === o.value ? "border-teal ring-1 ring-teal/30 bg-teal/[0.03]" : "border-gray-200"
            } ${canEdit ? "cursor-pointer" : "opacity-70"}`}
          >
            <input
              type="radio"
              name={`revenue-basis-${clientLinkId}`}
              checked={mode === o.value}
              disabled={!canEdit || saving !== null}
              onChange={() => change(o.value)}
              className="mt-0.5 w-4 h-4 border-2 border-gray-300 text-teal focus:ring-teal"
            />
            <span className="min-w-0">
              <span className="text-xs font-semibold text-navy flex items-center gap-1.5">
                {o.label}
                {saving === o.value && <Loader2 size={11} className="animate-spin text-teal" />}
              </span>
              <span className="block text-[11px] text-ink-slate mt-0.5 leading-relaxed">{o.blurb}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === "deposits_only" && (
        <div className="mt-2.5 space-y-1.5">
          <div className="flex items-start gap-1.5 text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>
              Invoice income is being left out. Right when the invoices duplicate the deposits —
              wrong, and understated, if the invoices are the real revenue.
            </span>
          </div>
          <div className="text-[11px] text-ink-slate bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5">
            <strong className="text-navy">Applies to some surfaces, not all yet.</strong> The
            exclusion reaches your statements preview, the stored close snapshot, the client&apos;s
            close email figures, and the COGS / net-margin checks. It does <strong>not</strong> yet
            reach the client&apos;s portal Profit &amp; Loss or the published month-end package, so
            those still show the unadjusted total and will disagree with the email.
          </div>
        </div>
      )}

      {!canEdit && (
        <p className="mt-2 text-[11px] text-ink-light">
          Only an admin or lead can change this — it changes the revenue on statements the client
          receives.
        </p>
      )}
      {error && <p className="mt-2 text-[11px] text-red-700">{error}</p>}
    </div>
  );
}
