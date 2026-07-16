"use client";

import { useState } from "react";
import { Loader2, Wrench, AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";

type Payment = { id: string; amount: number; depositAccount: string | null; linkedToDeposit: boolean };
type Inv = {
  invoiceId: string;
  docNumber: string | null;
  customer: string | null;
  date: string;
  total: number;
  balance: number;
  incomeAccounts: string[];
  payments: Payment[];
  action: "void_payment_and_invoice" | "void_invoice_only" | "review";
  safe: boolean;
  reason: string;
};
type Preview = {
  summary: { total: number; safe: number; review: number; voidInvoiceOnly: number; safeInvoiceAmount: number; reviewInvoiceAmount: number };
  invoices: Inv[];
};

const fmt = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n || 0)).toLocaleString();
const fmtC = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * "Fix in QuickBooks" — the guarded bulk void of duplicate CRM invoices.
 * Preview (read-only) → dry-run → confirmed write. Voids each phantom UF
 * payment then the invoice; deposits are never touched. Senior-only.
 */
export function QboRemediationPanel({
  clientLinkId,
  clientName,
  start,
  end,
}: {
  clientLinkId: string;
  clientName: string;
  start: string;
  end: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allowReview, setAllowReview] = useState(false);
  const [busy, setBusy] = useState<"dry" | "write" | null>(null);
  const [result, setResult] = useState<any>(null);

  async function loadPreview() {
    setOpen(true);
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/crm-invoice-remediation/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId, start, end }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setPreview(j);
      // Pre-select the safe ones.
      setSelected(new Set(j.invoices.filter((i: Inv) => i.safe).map((i: Inv) => i.invoiceId)));
    } catch (e: any) {
      setError(e?.message || "Preview failed");
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  // Every invoice that CAN be selected right now: safe ones always, review
  // ones only when the "include review" box is ticked.
  const selectableIds = (preview?.invoices || [])
    .filter((i) => i.safe || allowReview)
    .map((i) => i.invoiceId);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  function toggleAll() {
    setSelected(allSelected ? new Set<string>() : new Set(selectableIds));
  }

  // Turning OFF "include review" must drop the now-unselectable review
  // invoices from the selection (else the count + void would still include them).
  function setAllowReviewSafe(next: boolean) {
    setAllowReview(next);
    if (!next && preview) {
      const reviewIds = new Set(preview.invoices.filter((i) => !i.safe).map((i) => i.invoiceId));
      setSelected((prev) => new Set([...prev].filter((id) => !reviewIds.has(id))));
    }
  }

  async function run(dryRun: boolean) {
    if (!preview) return;
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!dryRun) {
      const anyReview = preview.invoices.some((i) => selected.has(i.invoiceId) && !i.safe);
      if (
        !confirm(
          `Void ${ids.length} invoice(s) for ${clientName} in QuickBooks?\n\n` +
            `This voids each invoice + its phantom Undeposited-Funds payment (deposits are NOT touched). ` +
            `Documents stay in QBO at $0 with a Voided stamp.\n\n` +
            (anyReview ? `⚠ Includes REVIEW invoices (a payment looked like real cash) — only do this if you've verified them.\n\n` : "") +
            `Closed periods are skipped automatically. Proceed?`
        )
      )
        return;
    }
    setBusy(dryRun ? "dry" : "write");
    setError(null);
    if (!dryRun) setResult(null);
    const totals: any = { would_void_invoices: 0, would_void_payments: 0, voided_invoices: 0, voided_payments: 0, skipped_closed: 0, skipped_review: 0, failed: 0, details: [] };
    let queue = ids;
    try {
      for (let pass = 0; pass < 25; pass++) {
        const res = await fetch("/api/admin/crm-invoice-remediation/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_link_id: clientLinkId, start, end, invoice_ids: queue, dry_run: dryRun, allow_review: allowReview }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        for (const k of ["would_void_invoices", "would_void_payments", "voided_invoices", "voided_payments", "skipped_closed", "skipped_review", "failed"]) totals[k] += d[k] || 0;
        totals.details.push(...(d.details || []));
        if (!d.remaining_ids?.length) break;
        queue = d.remaining_ids;
      }
      setResult({ dryRun, ...totals });
      if (!dryRun) {
        // Reload preview so voided invoices drop off.
        await loadPreview();
      }
    } catch (e: any) {
      setError(e?.message || "Remediation failed");
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <div className="rounded-2xl border-2 border-red-200 bg-red-50/40 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <Wrench size={18} className="text-red-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-sm text-navy">Fix in QuickBooks — void the duplicate invoices</div>
              <p className="text-xs text-ink-slate mt-0.5 max-w-2xl">
                Writes to the live ledger: voids each recognized CRM invoice + its phantom
                Undeposited-Funds payment so revenue = deposits only. Preview + dry-run first;
                deposits are never touched.
              </p>
            </div>
          </div>
          <button
            onClick={loadPreview}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-50"
          >
            <Wrench size={13} /> Load QuickBooks fix
          </button>
        </div>
      </div>
    );
  }

  const s = preview?.summary;
  return (
    <div className="rounded-2xl border-2 border-red-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-3 font-bold text-sm text-navy">
        <Wrench size={16} className="text-red-600" /> Fix in QuickBooks — void duplicate invoices
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-ink-slate py-4">
          <Loader2 size={14} className="animate-spin" /> Pulling invoices + payment safety from QuickBooks…
        </div>
      )}
      {error && (
        <div className="mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}

      {s && preview && (
        <>
          <div className="flex flex-wrap gap-4 text-xs mb-3">
            <span><strong>{s.total}</strong> recognized invoices</span>
            <span className="text-emerald-700"><strong>{s.safe}</strong> safe to void ({fmt(s.safeInvoiceAmount)})</span>
            {s.review > 0 && <span className="text-amber-700"><strong>{s.review}</strong> need review ({fmt(s.reviewInvoiceAmount)})</span>}
          </div>

          {s.review > 0 && (
            <label className="flex items-start gap-2 mb-3 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 cursor-pointer">
              <input type="checkbox" checked={allowReview} onChange={(e) => setAllowReviewSafe(e.target.checked)} className="mt-0.5 accent-amber-600" />
              <span>
                <ShieldAlert size={12} className="inline mr-1 text-amber-600" />
                Include the {s.review} <strong>review</strong> invoices — only if you&apos;ve confirmed their payments aren&apos;t real cash. Off by default.
              </span>
            </label>
          )}

          <div className="flex items-center gap-3 mb-2 text-xs">
            <button
              onClick={toggleAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-1 font-semibold text-navy hover:bg-gray-50"
            >
              {allSelected ? "Clear all" : `Select all (${selectableIds.length})`}
            </button>
            <span className="text-ink-slate">{selected.size} selected</span>
            {!allowReview && s.review > 0 && (
              <span className="text-ink-light">· only {s.safe} safe invoice{s.safe === 1 ? "" : "s"} are selectable (tick the box above to include review)</span>
            )}
          </div>

          <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white mb-3 max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0">
                <tr className="text-[10px] uppercase tracking-wide text-ink-slate">
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="accent-red-600"
                      aria-label="Select all invoices"
                      title={allSelected ? "Clear all" : "Select all selectable invoices"}
                    />
                  </th>
                  <th className="text-left font-semibold px-3 py-2">Invoice</th>
                  <th className="text-left font-semibold px-3 py-2">Customer</th>
                  <th className="text-right font-semibold px-3 py-2">Amount</th>
                  <th className="text-left font-semibold px-3 py-2">Payment → account</th>
                  <th className="text-left font-semibold px-3 py-2">Plan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {preview.invoices.map((inv) => {
                  const selectable = inv.safe || allowReview;
                  return (
                    <tr key={inv.invoiceId} className={inv.safe ? "hover:bg-gray-50" : "bg-amber-50/40"}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(inv.invoiceId)}
                          disabled={!selectable}
                          onChange={() => toggle(inv.invoiceId)}
                          className="accent-red-600 disabled:opacity-40"
                        />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-ink-slate">
                        {inv.docNumber ? `#${inv.docNumber}` : inv.invoiceId} · {inv.date}
                      </td>
                      <td className="px-3 py-2 text-navy">{inv.customer || "—"}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmtC(inv.total)}</td>
                      <td className="px-3 py-2 text-ink-slate">
                        {inv.payments.length === 0
                          ? "— (no payment)"
                          : inv.payments.map((p) => p.depositAccount || "?").join(", ")}
                      </td>
                      <td className="px-3 py-2">
                        {inv.action === "review" ? (
                          <span className="text-amber-700 font-semibold inline-flex items-center gap-1">
                            <AlertTriangle size={11} /> review
                          </span>
                        ) : inv.action === "void_invoice_only" ? (
                          <span className="text-ink-slate">void invoice (no payment)</span>
                        ) : (
                          <span className="text-red-700 font-semibold">void payment + invoice</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {result && (
            <div className={`mb-3 rounded-lg border px-3 py-2 text-xs ${result.dryRun ? "border-sky-200 bg-sky-50 text-sky-900" : result.failed ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
              {result.dryRun ? (
                <span><strong>Dry run:</strong> would void {result.would_void_invoices} invoice(s) + {result.would_void_payments} payment(s). {result.skipped_closed} closed-period, {result.skipped_review} review skipped. Nothing written.</span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 size={13} /> <strong>Done:</strong> voided {result.voided_invoices} invoice(s) + {result.voided_payments} payment(s). {result.skipped_closed} closed-period, {result.skipped_review} review skipped{result.failed ? `, ${result.failed} FAILED` : ""}. Deposits untouched.
                </span>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <span className="text-xs text-ink-slate mr-auto">{selected.size} selected</span>
            <button
              onClick={() => run(true)}
              disabled={busy !== null || selected.size === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-ink-slate hover:bg-gray-50 disabled:opacity-50"
            >
              {busy === "dry" ? <Loader2 size={12} className="animate-spin" /> : null} Dry run
            </button>
            <button
              onClick={() => run(false)}
              disabled={busy !== null || selected.size === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50"
            >
              {busy === "write" ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
              Void {selected.size} in QuickBooks
            </button>
          </div>
        </>
      )}
    </div>
  );
}
