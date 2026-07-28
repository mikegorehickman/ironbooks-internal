"use client";

import { CheckCircle2 } from "lucide-react";

/**
 * Deposit↔invoice pair table for the CRM duplicate-revenue workflow — the ONE
 * rendering shared by /admin/crm-invoice-revenue and the cleanup Revenue Check
 * step, so the two surfaces can never drift. Data shape = the response of
 * POST /api/admin/crm-invoice-pairs.
 */
export type CrmPair = {
  invoice: {
    txn_id: string;
    doc_number: string | null;
    customer: string | null;
    date: string;
    total: number;
    accounts: string[];
  };
  deposit: { txn_id: string; date: string; account: string; customer: string | null; amount: number };
  factor: number;
  tax_label: string;
  same_customer: boolean;
  confidence: string;
  invoice_balance: number | null;
  scenario: "paid_in_qbo" | "open" | "unknown";
};

const fmtC = (n: number) =>
  (n < 0 ? "-$" : "$") +
  Math.abs(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function CrmPairsTable({ data }: { data: any }) {
  const pairs: CrmPair[] = data?.pairs || [];
  const sc = data?.summary?.scenario_counts || {};
  if (pairs.length === 0) {
    return <div className="text-xs text-ink-light py-2">No deposit↔invoice pairs in the live pull.</div>;
  }
  return (
    <div>
      <div className="text-[11px] text-ink-slate mb-2">
        <span className="font-bold text-navy">{pairs.length} proven pairs</span> — the bank deposit
        and the invoice are the <strong>same money</strong>. The fix is to{" "}
        <strong>match</strong> them, not delete anything: the deposit gets linked to the invoice&apos;s
        payment, which clears Undeposited Funds and leaves the revenue counted once.{" "}
        {sc.paid_in_qbo ? <span>{sc.paid_in_qbo} paid in QBO (match deposit → payment). </span> : null}
        {sc.open ? <span>{sc.open} open — no payment to match; receive payment against the deposit. </span> : null}
      </div>
      <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white">
        <table className="w-full text-xs">
          <thead className="bg-gray-50">
            <tr className="text-[10px] uppercase tracking-wide text-ink-slate">
              <th className="text-left font-semibold px-3 py-2">Customer</th>
              <th className="text-left font-semibold px-3 py-2">Invoice</th>
              <th className="text-right font-semibold px-3 py-2">Invoice net</th>
              <th className="text-left font-semibold px-3 py-2">Deposit → account</th>
              <th className="text-right font-semibold px-3 py-2">Deposit</th>
              <th className="text-left font-semibold px-3 py-2">Match</th>
              <th className="text-left font-semibold px-3 py-2">QBO fix (match, don&apos;t delete)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {pairs.map((p, i) => (
              <tr key={i} className="hover:bg-gray-50">
                <td className="px-3 py-2 text-navy font-medium">
                  {p.invoice.customer || p.deposit.customer || "—"}
                </td>
                <td className="px-3 py-2 text-ink-slate whitespace-nowrap">
                  {p.invoice.doc_number ? `#${p.invoice.doc_number}` : p.invoice.txn_id} · {p.invoice.date}
                </td>
                <td className="px-3 py-2 text-right font-mono">{fmtC(p.invoice.total)}</td>
                <td className="px-3 py-2 text-ink-slate">
                  {p.deposit.account} · {p.deposit.date}
                </td>
                <td className="px-3 py-2 text-right font-mono">{fmtC(p.deposit.amount)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="text-teal-dark font-semibold">{p.tax_label}</span>
                  {p.same_customer && <CheckCircle2 size={11} className="inline ml-1 text-emerald-600" />}
                  <span className="text-ink-light ml-1">({p.confidence})</span>
                </td>
                <td className="px-3 py-2">
                  {p.scenario === "paid_in_qbo" ? (
                    <span className="text-teal-dark font-semibold">match deposit → invoice payment (clears UF)</span>
                  ) : p.scenario === "open" ? (
                    <span className="text-amber-700 font-semibold">open invoice — receive payment against this deposit</span>
                  ) : (
                    <span className="text-ink-light">match deposit → invoice</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
