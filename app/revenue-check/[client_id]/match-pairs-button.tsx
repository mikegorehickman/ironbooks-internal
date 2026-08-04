"use client";

import { useState } from "react";
import { Loader2, Link2, AlertTriangle } from "lucide-react";

/**
 * MATCH the duplicate revenue — the fix, as opposed to hiding it.
 *
 * WHY. The Revenue Check step's only action was a reporting-mode flip to
 * cash-deposits-only, which excludes EVERY invoice from statements. On
 * RocketPainter that is all $50,295 across 20 invoices when only 5 pairs
 * ($8,694) are proven duplicates. Mike, 2026-08-04: "this should not revert to
 * cash — it should revert to matching the invoices."
 *
 * He's right, and the screen already said so in its own footer: "the deposit gets
 * linked to the invoice's payment, which clears Undeposited Funds and leaves the
 * revenue counted once." The mode flip is a presentation change — the duplication
 * stays in QuickBooks, the A/R subledger disappears from the statements, and the
 * 15 invoices that were never duplicated get excluded along with the 5 that were.
 *
 * The real executor already exists and match is already its default:
 * /api/admin/crm-invoice-remediation/apply links the bank deposit to the
 * invoice's Undeposited-Funds payment. The invoice stays PAID, UF clears, revenue
 * is recognized once, and the DEPOSIT TOTAL is unchanged — so the bank
 * reconciliation is untouched. Nothing is voided.
 *
 * This just makes that reachable from the step where the problem is found. It
 * previews first, and only `paid_in_qbo` pairs qualify — an invoice still open in
 * QBO has no payment to link the deposit to, so matching it would be meaningless.
 */

interface Pair {
  invoice: { txn_id: string; amount?: number; doc_number?: string | null; customer_name?: string | null; date?: string | null };
  deposit: { amount?: number; date?: string | null };
  scenario: string;
  confidence?: number | null;
}

export function MatchPairsButton({
  clientLinkId,
  pairs,
  start,
  end,
  isSenior,
  onDone,
}: {
  clientLinkId: string;
  pairs: Pair[];
  start: string;
  end: string;
  isSenior: boolean;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  // Only invoices already PAID in QBO have a payment for the deposit to link to.
  // An open invoice is a different problem — it needs the payment recording
  // first, which is the A/R side, not this fix.
  const matchable = (pairs || []).filter((p) => p.scenario === "paid_in_qbo");
  const notPaid = (pairs || []).length - matchable.length;
  const ids = matchable.map((p) => String(p.invoice.txn_id));
  const total =
    Math.round(matchable.reduce((s, p) => s + Math.abs(Number(p.invoice.amount) || 0), 0) * 100) / 100;
  const money = (n: number) =>
    `$${Math.abs(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  async function call(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/crm-invoice-remediation/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          invoice_ids: ids,
          start,
          end,
          dry_run: dryRun,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      if (dryRun) setPreview(j);
      else {
        setResult(j);
        setPreview(null);
        onDone?.();
      }
    } catch (e: any) {
      setError(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (!matchable.length) return null;

  if (result) {
    return (
      <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
        <strong>Matched.</strong> The deposits are now linked to their invoices&apos; payments —
        revenue counted once, Undeposited Funds cleared, deposit totals unchanged so the bank rec
        still ties. Re-run the check to confirm.
        {(result.remaining_ids?.length ?? 0) > 0 && (
          <div className="mt-1">
            {result.remaining_ids.length} left in this batch — run it again to finish.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3">
      {!preview ? (
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => call(true)}
            disabled={busy || !isSenior}
            title={
              isSenior
                ? "Link each deposit to its invoice's payment — the QBO-native fix"
                : "Matching is a senior action — flag this to Mike or Lisa"
            }
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold bg-teal text-white hover:bg-teal-dark disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
            Match {matchable.length} deposit{matchable.length === 1 ? "" : "s"} to their invoices (
            {money(total)})
          </button>
          <span className="text-[11px] text-amber-900">
            Fixes the duplication in QuickBooks. Revenue counted once, A/R kept, deposit totals
            unchanged.
          </span>
          {notPaid > 0 && (
            <span className="text-[11px] text-ink-slate">
              {notPaid} pair{notPaid === 1 ? "" : "s"} skipped — the invoice isn&apos;t paid in QBO,
              so there&apos;s no payment to link a deposit to.
            </span>
          )}
          {!isSenior && (
            <span className="text-[11px] text-amber-800">Senior action — flag to Mike or Lisa.</span>
          )}
        </div>
      ) : (
        <div className="rounded-lg border-2 border-teal/40 bg-white px-3 py-2.5 text-xs">
          <div className="font-bold text-navy">
            {preview.would_apply ?? preview.planned ?? matchable.length} invoice
            {(preview.would_apply ?? matchable.length) === 1 ? "" : "s"} · {money(total)}
          </div>
          <div className="text-ink-slate mt-1 leading-relaxed">
            Each deposit&apos;s duplicate income line becomes a link to the invoice&apos;s payment (plus
            a fee line where a processor withheld one). The invoice stays paid, UF clears, and the
            deposit total is unchanged — the bank reconciliation is not affected. Nothing is voided.
          </div>
          {(preview.skipped_review ?? 0) > 0 && (
            <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-[#8A6D2F]">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>
                {preview.skipped_review} skipped as &ldquo;review&rdquo; — real cash sits on the
                payment, so the plan isn&apos;t clearly safe. Handle those in Admin → CRM invoice
                revenue.
              </span>
            </div>
          )}
          <div className="flex items-center gap-2 mt-2.5">
            <button
              onClick={() => call(false)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold bg-teal text-white hover:bg-teal-dark disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
              Match them in QuickBooks
            </button>
            <button
              onClick={() => setPreview(null)}
              className="text-xs font-semibold text-ink-slate hover:text-navy"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <div className="text-[11px] text-[#954E44] mt-1">{error}</div>}
    </div>
  );
}
