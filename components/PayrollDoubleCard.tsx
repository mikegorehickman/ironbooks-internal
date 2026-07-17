"use client";

import { useState } from "react";
import { Loader2, Search, AlertTriangle, CheckCircle2, Wrench } from "lucide-react";

/**
 * Per-client payroll double-count card for the CLEANUP flow (Mike 2026-07-17:
 * "this button needs to live in the cleanup process for each client so each
 * bookkeeper can do it"). Self-contained: check → review dated postings +
 * reasoning → resolve (move the duplicate cash net-pay to Payroll Clearing).
 * Same read-only scan + guarded resolve endpoints as the admin fleet page.
 */

interface SuspectPosting { date: string; amount: number; name: string | null; memo: string; txn_type: string; kind: "cash" | "invoice" }
interface Suspect {
  account: string; postings: number; total: number; employees: number;
  by_type: Record<string, number>; cash_total: number; invoice_total: number;
  reason: string; txns: SuspectPosting[];
}
interface Result {
  flagged: boolean; overstated: number; paycheque_accounts: string[];
  employee_count: number; suspects: Suspect[]; cash_total: number; invoice_total: number;
}

const money = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString()}`;

export function PayrollDoubleCard({ clientLinkId, clientName }: { clientLinkId: string; clientName: string }) {
  const [status, setStatus] = useState<"idle" | "scanning" | "done" | "clean" | "reauth" | "error">("idle");
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState("");
  const [resolveBusy, setResolveBusy] = useState<string | null>(null);
  const [resolveMsg, setResolveMsg] = useState<Record<string, string>>({});

  async function scan() {
    setStatus("scanning"); setErr("");
    try {
      const r = await fetch("/api/admin/payroll-double-scan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId }),
      });
      const d = await r.json();
      if (d.reauth) { setStatus("reauth"); return; }
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setRes(d);
      setStatus(d.flagged ? "done" : "clean");
    } catch (e: any) { setStatus("error"); setErr(e.message); }
  }

  async function resolve(s: Suspect) {
    if (!confirm(
      `Resolve ${clientName}: move ${money(s.cash_total)} of employee net-pay off "${s.account}" to a "Payroll Clearing" account?\n\n` +
      `Cash-basis dedupe — the QBO Payroll paycheques stay put as the wage record; these bank net-pay lines (year-to-date, including closed months) move to a balance-sheet clearing account so they stop double-counting labor. This rewrites the books.`,
    )) return;
    setResolveBusy(s.account); setResolveMsg((m) => ({ ...m, [s.account]: "" }));
    try {
      const r = await fetch("/api/admin/payroll-double-scan/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId, source_account_name: s.account }),
      });
      const d = await r.json();
      if (d.reauth) { setResolveMsg((m) => ({ ...m, [s.account]: "QBO reconnect needed" })); return; }
      if (d.tooLarge) { setResolveMsg((m) => ({ ...m, [s.account]: d.error })); return; }
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      const parts = [`${d.lines_moved} line(s) → Payroll Clearing`];
      if (d.created_clearing) parts.push("clearing account created");
      if (d.failures?.length) parts.push(`${d.failures.length} failed (closed period?)`);
      setResolveMsg((m) => ({ ...m, [s.account]: parts.join(" · ") }));
      setRes(d); setStatus(d.flagged ? "done" : "clean");
    } catch (e: any) { setResolveMsg((m) => ({ ...m, [s.account]: e.message })); }
    finally { setResolveBusy(null); }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <AlertTriangle size={16} className="text-amber-500" />
          <h3 className="font-bold text-navy text-sm">Payroll double-count check</h3>
        </div>
        <button
          onClick={scan}
          disabled={status === "scanning"}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark disabled:opacity-50"
        >
          {status === "scanning" ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
          {status === "idle" ? "Check now" : "Re-check"}
        </button>
      </div>
      <p className="text-[11px] text-ink-light mt-1">
        Finds crew pay booked twice — QBO Payroll paycheques (gross) plus the bank net-pay
        deposits/e-Transfers expensed to a second labor account. Cash basis: the cash that left the
        bank is the real expense; the paycheque stays as the wage record.
      </p>

      {status === "clean" && (
        <div className="mt-3 inline-flex items-center gap-1.5 text-sm text-emerald-700"><CheckCircle2 size={15} /> No payroll double-count found.</div>
      )}
      {status === "reauth" && <div className="mt-3 text-sm text-amber-700">QBO needs reconnecting for this client.</div>}
      {status === "error" && <div className="mt-3 text-sm text-red-600">{err}</div>}

      {status === "done" && res && (
        <div className="mt-3 space-y-3">
          <div className="text-sm">
            <span className="font-bold text-red-700">{money(res.overstated)} phantom labor</span>
            <span className="text-ink-slate"> · paycheques on {res.paycheque_accounts.join(", ") || "—"} · {res.employee_count} employees</span>
          </div>
          {res.suspects.map((s) => (
            <div key={s.account} className="border border-red-100 rounded-lg p-3 bg-red-50/30">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-bold px-1 py-0.5 rounded bg-emerald-100 text-emerald-800">
                  {s.cash_total !== 0 && s.invoice_total === 0 ? "CASH" : s.invoice_total !== 0 && s.cash_total === 0 ? "INVOICE" : "MIXED"}
                </span>
                <span className="font-semibold text-red-700 text-sm">{s.account}</span>
                <span className="text-xs text-ink-slate">{money(s.total)} · {s.postings} postings · {s.employees} employees</span>
                {s.cash_total !== 0 && (
                  <button
                    onClick={() => resolve(s)}
                    disabled={resolveBusy === s.account || !!resolveBusy}
                    className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-white bg-teal hover:bg-teal-dark px-2.5 py-1 rounded disabled:opacity-50"
                  >
                    {resolveBusy === s.account ? <Loader2 size={11} className="animate-spin" /> : <Wrench size={11} />}
                    Move cash to Payroll Clearing
                  </button>
                )}
              </div>
              {s.reason && <div className="text-[11px] text-ink-slate mt-1">{s.reason}</div>}
              {s.txns?.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                  <table className="text-[11px] w-full">
                    <thead className="text-ink-light">
                      <tr>
                        <th className="text-left pr-3 font-medium">Date</th>
                        <th className="text-left pr-3 font-medium">Payee</th>
                        <th className="text-right pr-3 font-medium">Amount</th>
                        <th className="text-left pr-3 font-medium">Type</th>
                        <th className="text-left font-medium">Memo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.txns.map((t, i) => (
                        <tr key={i} className="text-ink-slate">
                          <td className="pr-3 whitespace-nowrap">{t.date}</td>
                          <td className="pr-3">{t.name || "—"}</td>
                          <td className="pr-3 text-right whitespace-nowrap">{money(t.amount)}</td>
                          <td className="pr-3 whitespace-nowrap"><span className={t.kind === "cash" ? "text-emerald-700" : "text-slate-500"}>{t.txn_type}</span></td>
                          <td className="text-ink-light truncate max-w-[240px]">{t.memo}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {resolveMsg[s.account] && <div className="text-[11px] text-navy font-medium mt-1">{resolveMsg[s.account]}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
