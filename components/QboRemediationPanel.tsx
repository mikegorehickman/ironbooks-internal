"use client";

import { useState } from "react";
import { Loader2, Wrench, AlertTriangle, CheckCircle2, ShieldAlert, ChevronDown, ChevronRight } from "lucide-react";

type Payment = {
  id: string;
  amount: number;
  depositAccount: string | null;
  linkedToDeposit: boolean;
  date?: string | null;
  refNum?: string | null;
  method?: string | null;
  unappliedAmt?: number | null;
  sweptBy?: Array<{ date: string; amount: number; account: string | null }>;
};
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
  grossTotal?: number | null;
  lineSamples?: string[];
  customerId?: string | null;
  matchedDeposit?: {
    txn_id: string;
    date: string;
    account: string;
    amount: number;
    tax_label: string;
    confidence: string;
  } | null;
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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

  // Per-invoice remediation choice: "void" (default — remove the dupe invoice)
  // or "apply_deposit" (KEEP the invoice, apply its matched deposit to it —
  // for clients who actively use invoicing). Only pair-matched invoices can
  // take the keep path.
  const [invoiceActions, setInvoiceActions] = useState<Record<string, "void" | "apply_deposit">>({});
  const pairedCount = (preview?.invoices || []).filter((i) => i.matchedDeposit && i.customerId).length;

  function setAllPaired(action: "void" | "apply_deposit") {
    if (!preview) return;
    setInvoiceActions((prev) => {
      const next = { ...prev };
      for (const inv of preview.invoices) {
        if (inv.matchedDeposit && inv.customerId) next[inv.invoiceId] = action;
        else delete next[inv.invoiceId];
      }
      return next;
    });
  }

  async function run(dryRun: boolean) {
    if (!preview) return;
    const ids = [...selected];
    if (ids.length === 0) return;
    const keepCount = ids.filter((id) => invoiceActions[id] === "apply_deposit").length;
    const voidCount = ids.length - keepCount;
    if (!dryRun) {
      const anyReview = preview.invoices.some((i) => selected.has(i.invoiceId) && !i.safe);
      if (
        !confirm(
          `Remediate ${ids.length} invoice(s) for ${clientName} in QuickBooks?\n\n` +
            `• ${voidCount} VOID — invoice + phantom payment zeroed (deposit stays as revenue)\n` +
            `• ${keepCount} KEEP INVOICE — phantom payment voided, matched deposit applied to the invoice via A/R (invoice stays intact, revenue recognizes once off the invoice)\n\n` +
            (anyReview ? `⚠ Includes REVIEW invoices (a payment looked like real cash) — only do this if you've verified them.\n\n` : "") +
            `Closed periods are skipped automatically. Proceed?`
        )
      )
        return;
    }
    setBusy(dryRun ? "dry" : "write");
    setError(null);
    if (!dryRun) setResult(null);
    const totals: any = { would_void_invoices: 0, would_void_payments: 0, voided_invoices: 0, voided_payments: 0, would_apply_deposits: 0, applied_deposits: 0, skipped_closed: 0, skipped_review: 0, skipped_no_pair: 0, failed: 0, details: [] };
    let queue = ids;
    try {
      for (let pass = 0; pass < 25; pass++) {
        const res = await fetch("/api/admin/crm-invoice-remediation/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_link_id: clientLinkId, start, end, invoice_ids: queue, dry_run: dryRun, allow_review: allowReview, actions: invoiceActions }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        for (const k of ["would_void_invoices", "would_void_payments", "voided_invoices", "voided_payments", "would_apply_deposits", "applied_deposits", "skipped_closed", "skipped_review", "skipped_no_pair", "failed"]) totals[k] += d[k] || 0;
        totals.details.push(...(d.details || []));
        if (!d.remaining_ids?.length) break;
        queue = d.remaining_ids;
      }
      setResult({ dryRun, ...totals });
      if (!dryRun) {
        // Reload preview so remediated invoices drop off.
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
            {pairedCount > 0 && (
              <span className="ml-auto inline-flex items-center gap-1.5">
                <span className="text-ink-light">{pairedCount} deposit-matched:</span>
                <button onClick={() => setAllPaired("apply_deposit")} className="rounded border border-teal/40 px-2 py-0.5 font-semibold text-teal-dark hover:bg-teal-lighter/40">
                  all → keep invoice
                </button>
                <button onClick={() => setAllPaired("void")} className="rounded border border-gray-300 px-2 py-0.5 font-semibold text-ink-slate hover:bg-gray-50">
                  all → void
                </button>
              </span>
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
                  const isExpanded = !!expanded[inv.invoiceId];
                  return (
                    <InvoiceRow
                      key={inv.invoiceId}
                      inv={inv}
                      selectable={selectable}
                      isSelected={selected.has(inv.invoiceId)}
                      isExpanded={isExpanded}
                      action={invoiceActions[inv.invoiceId] === "apply_deposit" ? "apply_deposit" : "void"}
                      onSetAction={(a) => setInvoiceActions((m) => ({ ...m, [inv.invoiceId]: a }))}
                      onToggleSelect={() => toggle(inv.invoiceId)}
                      onToggleExpand={() =>
                        setExpanded((e) => ({ ...e, [inv.invoiceId]: !isExpanded }))
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </div>

          {result && (
            <div className={`mb-3 rounded-lg border px-3 py-2 text-xs ${result.dryRun ? "border-sky-200 bg-sky-50 text-sky-900" : result.failed ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
              {result.dryRun ? (
                <span><strong>Dry run:</strong> would void {result.would_void_invoices} invoice(s) + {result.would_void_payments} payment(s){result.would_apply_deposits ? `, would keep ${result.would_apply_deposits} invoice(s) + apply their deposits` : ""}. {result.skipped_closed} closed-period, {result.skipped_review} review, {result.skipped_no_pair || 0} no-pair skipped. Nothing written.</span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 size={13} /> <strong>Done:</strong> voided {result.voided_invoices} invoice(s) + {result.voided_payments} payment(s){result.applied_deposits ? `, kept ${result.applied_deposits} invoice(s) with their deposits applied via A/R` : ""}. {result.skipped_closed} closed-period, {result.skipped_review} review{result.skipped_no_pair ? `, ${result.skipped_no_pair} no-pair` : ""} skipped{result.failed ? `, ${result.failed} FAILED` : ""}.
                </span>
              )}
            </div>
          )}

          <p className="text-[11px] text-ink-light mb-3">
            Click a row&apos;s ▸ to see the full detail — payment date/method/ref#, where it deposited,
            which bank deposit swept it, the job lines, and why it&apos;s classified the way it is.
          </p>

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

/**
 * One invoice row + its expandable review detail: everything QBO knows about
 * the invoice and each linked payment, so a reviewer can decide phantom-vs-real
 * from the panel instead of opening QBO.
 */
function InvoiceRow({
  inv,
  selectable,
  isSelected,
  isExpanded,
  onToggleSelect,
  onToggleExpand,
  action,
  onSetAction,
}: {
  inv: Inv;
  selectable: boolean;
  isSelected: boolean;
  isExpanded: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  action: "void" | "apply_deposit";
  onSetAction: (a: "void" | "apply_deposit") => void;
}) {
  const paidAmount = (inv.grossTotal ?? 0) - (inv.balance ?? 0);
  const canKeep = !!(inv.matchedDeposit && inv.customerId);
  return (
    <>
      <tr className={inv.safe ? "hover:bg-gray-50" : "bg-amber-50/40"}>
        <td className="px-3 py-2">
          <input
            type="checkbox"
            checked={isSelected}
            disabled={!selectable}
            onChange={onToggleSelect}
            className="accent-red-600 disabled:opacity-40"
          />
        </td>
        <td className="px-3 py-2 whitespace-nowrap text-ink-slate">
          <button onClick={onToggleExpand} className="inline-flex items-center gap-1 hover:text-navy" title="Show full detail">
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {inv.docNumber ? `#${inv.docNumber}` : inv.invoiceId} · {inv.date}
          </button>
        </td>
        <td className="px-3 py-2 text-navy">{inv.customer || "—"}</td>
        <td className="px-3 py-2 text-right font-mono">{fmtC(inv.total)}</td>
        <td className="px-3 py-2 text-ink-slate">
          {inv.payments.length === 0
            ? "— (no payment)"
            : inv.payments
                .map((p) => p.depositAccount || "not set (usually Undeposited Funds)")
                .join(", ")}
        </td>
        <td className="px-3 py-2">
          {inv.action === "review" ? (
            <span className="text-amber-700 font-semibold inline-flex items-center gap-1">
              <AlertTriangle size={11} /> review
            </span>
          ) : canKeep ? (
            // Pair-matched: the bookkeeper chooses per invoice — void the dupe,
            // or keep the invoice and apply its matched deposit via A/R.
            <select
              value={action}
              onChange={(e) => onSetAction(e.target.value as "void" | "apply_deposit")}
              className={`text-[11px] font-semibold rounded border px-1.5 py-1 ${
                action === "apply_deposit"
                  ? "border-teal/40 bg-teal-lighter/40 text-teal-dark"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              <option value="void">void invoice (dupe)</option>
              <option value="apply_deposit">keep — apply deposit {fmtC(inv.matchedDeposit!.amount)}</option>
            </select>
          ) : inv.action === "void_invoice_only" ? (
            <span className="text-ink-slate">void invoice (no payment)</span>
          ) : (
            <span className="text-red-700 font-semibold">void payment + invoice</span>
          )}
        </td>
      </tr>
      {isExpanded && (
        <tr className={inv.safe ? "bg-gray-50/70" : "bg-amber-50/60"}>
          <td />
          <td colSpan={5} className="px-3 pb-3 pt-1">
            {/* Why it's classified this way */}
            <div className="text-[11px] text-ink-slate mb-2">
              <strong className="text-navy">Why:</strong> {inv.reason}
            </div>

            {/* Invoice facts */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-slate mb-2">
              <span>Invoice gross: <strong className="font-mono text-navy">{inv.grossTotal != null ? fmtC(inv.grossTotal) : "—"}</strong></span>
              <span>Recognized as income: <strong className="font-mono text-navy">{fmtC(inv.total)}</strong></span>
              <span>Open balance: <strong className="font-mono text-navy">{fmtC(inv.balance)}</strong></span>
              <span>Paid: <strong className="font-mono text-navy">{fmtC(paidAmount)}</strong></span>
              {inv.incomeAccounts.length > 0 && (
                <span>Income account{inv.incomeAccounts.length > 1 ? "s" : ""}: <strong className="text-navy">{inv.incomeAccounts.join(", ")}</strong></span>
              )}
            </div>
            {inv.lineSamples && inv.lineSamples.length > 0 && (
              <div className="text-[11px] text-ink-slate mb-2">
                Job lines: <span className="text-navy">{inv.lineSamples.join(" · ")}</span>
              </div>
            )}
            {inv.matchedDeposit && (
              <div className="text-[11px] mb-2 rounded border border-teal/30 bg-teal-lighter/30 px-2 py-1.5 text-teal-dark">
                <strong>Matched bank deposit:</strong> {fmtC(inv.matchedDeposit.amount)} on {inv.matchedDeposit.date} into{" "}
                {inv.matchedDeposit.account} ({inv.matchedDeposit.tax_label}, {inv.matchedDeposit.confidence}).
                Choosing <em>keep — apply deposit</em> voids the phantom payment and repoints this deposit line to
                Accounts Receivable + {inv.customer || "the customer"}, so the invoice stays intact and shows paid.
              </div>
            )}

            {/* Per-payment detail — the decision table */}
            {inv.payments.length > 0 && (
              <table className="w-full text-[11px] border border-gray-200 rounded bg-white">
                <thead className="bg-gray-100">
                  <tr className="text-[10px] uppercase tracking-wide text-ink-slate">
                    <th className="text-left font-semibold px-2 py-1.5">Payment</th>
                    <th className="text-right font-semibold px-2 py-1.5">Amount</th>
                    <th className="text-left font-semibold px-2 py-1.5">Method / Ref#</th>
                    <th className="text-left font-semibold px-2 py-1.5">Deposited to</th>
                    <th className="text-left font-semibold px-2 py-1.5">Swept into a bank deposit?</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {inv.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="px-2 py-1.5 whitespace-nowrap text-ink-slate">{p.date || "—"} · #{p.id}</td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {fmtC(p.amount)}
                        {p.unappliedAmt ? <span className="text-amber-700"> ({fmtC(p.unappliedAmt)} unapplied)</span> : null}
                      </td>
                      <td className="px-2 py-1.5 text-ink-slate">{[p.method, p.refNum && `#${p.refNum}`].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="px-2 py-1.5">
                        {p.depositAccount ? (
                          <span className={/undeposited|payments to deposit/i.test(p.depositAccount) ? "text-emerald-700 font-semibold" : "text-red-700 font-semibold"}>
                            {p.depositAccount}
                          </span>
                        ) : (
                          <span className="text-ink-slate">not set — QBO default is Undeposited Funds</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {p.sweptBy && p.sweptBy.length > 0 ? (
                          <span className="text-red-700 font-semibold">
                            YES — {p.sweptBy.map((d) => `${d.date} ${fmtC(d.amount)}${d.account ? ` → ${d.account}` : ""}`).join("; ")}
                            <span className="block text-[10px] font-normal text-red-600">this payment became real bank cash — voiding it removes money</span>
                          </span>
                        ) : (
                          <span className="text-emerald-700">
                            no — never deposited
                            <span className="block text-[10px] text-ink-light">the real cash likely arrived as the separate income deposit</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
