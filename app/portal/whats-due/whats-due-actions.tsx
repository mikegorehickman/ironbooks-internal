"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, Undo2, Loader2, ChevronDown, ChevronRight } from "lucide-react";

export interface DismissibleBill {
  qbo_bill_id: string;
  vendor_name: string | null;
  doc_number: string | null;
  amount: number;
}

function fmtMoney(n: number): string {
  return Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/**
 * "Dismiss" a bill that isn't actually owed (duplicate, already paid, not
 * theirs). Persists via /api/portal/ap-dismissals, notifies the bookkeeper,
 * and the bill drops off this page. Replaces the old "Ask" button — bills
 * aren't transactions, so the transaction-Ask flow didn't fit.
 */
export function DismissBillButton({ bill }: { bill: DismissibleBill }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function dismiss() {
    const ok = window.confirm(
      `Dismiss bill ${bill.doc_number ? `#${bill.doc_number}` : ""}${
        bill.vendor_name ? ` from ${bill.vendor_name}` : ""
      } (${fmtMoney(bill.amount)})?\n\nUse this when it isn't actually owed (duplicate, already paid, not yours). Your bookkeeper is notified and will clear it in QuickBooks properly. You can restore it anytime from the "Dismissed" list at the bottom of this page.`
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/portal/ap-dismissals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qbo_bill_id: bill.qbo_bill_id,
          doc_number: bill.doc_number,
          vendor_name: bill.vendor_name,
          amount: bill.amount,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
      router.refresh();
    } catch {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={dismiss}
      disabled={busy}
      title="Not actually owed? Dismiss it — your bookkeeper is notified and it stays hidden from what you owe"
      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-md border border-slate-200 text-ink-slate hover:text-red-700 hover:border-red-300 hover:bg-red-50 transition-all disabled:opacity-40"
    >
      {busy ? <Loader2 size={11} className="animate-spin" /> : <><EyeOff size={11} /> Dismiss</>}
    </button>
  );
}

/**
 * Restore-able list of dismissed bills, collapsed by default. Mirror of the
 * A/R "Dismissed" section on the Who-owes-you page.
 */
export function DismissedBillsSection({ dismissed }: { dismissed: DismissibleBill[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (dismissed.length === 0) return null;

  async function restore(billId: string) {
    setBusyId(billId);
    try {
      const res = await fetch("/api/portal/ap-dismissals", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qbo_bill_id: billId }),
      });
      if (!res.ok) throw new Error("Failed");
      router.refresh();
    } catch {
      setBusyId(null);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-sm font-semibold text-ink-slate hover:text-navy"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <EyeOff size={13} />
        Dismissed — not actually owed ({dismissed.length})
      </button>
      {open && (
        <ul className="mt-3 divide-y divide-slate-100">
          {dismissed.map((b) => (
            <li key={b.qbo_bill_id} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0 text-sm">
                <span className="font-semibold text-navy">{b.vendor_name || "Unknown vendor"}</span>
                {b.doc_number && <span className="text-ink-light"> · #{b.doc_number}</span>}
                <span className="text-ink-slate"> · {fmtMoney(b.amount)}</span>
              </div>
              <button
                onClick={() => restore(b.qbo_bill_id)}
                disabled={busyId === b.qbo_bill_id}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-dark hover:underline disabled:opacity-40"
              >
                {busyId === b.qbo_bill_id ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
