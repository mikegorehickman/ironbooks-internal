"use client";

import { useMemo, useState } from "react";
import { Loader2, Play, Search, CheckCircle2, AlertTriangle, Wrench } from "lucide-react";

interface ClientRow { id: string; client_name: string; jurisdiction: string }

interface SuspectPosting { date: string; amount: number; name: string | null; memo: string; txn_type: string; kind: "cash" | "invoice" }
interface Suspect {
  account: string;
  postings: number;
  total: number;
  employees: number;
  by_type: Record<string, number>;
  sample_memos: string[];
  cash_total: number;
  invoice_total: number;
  reason: string;
  txns: SuspectPosting[];
}
interface RowState {
  status: "idle" | "scanning" | "done" | "clean" | "reauth" | "error";
  overstated: number;
  paycheque_accounts: string[];
  employee_count: number;
  suspects: Suspect[];
  cash_total: number;
  invoice_total: number;
  message?: string;
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

export function PayrollDoubleScanClient({ clients }: { clients: ClientRow[] }) {
  const [rows, setRows] = useState<Record<string, RowState>>(
    Object.fromEntries(clients.map((c) => [c.id, { status: "idle", overstated: 0, paycheque_accounts: [], employee_count: 0, suspects: [], cash_total: 0, invoice_total: 0 } as RowState])),
  );
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resolveBusy, setResolveBusy] = useState<string | null>(null);
  const [resolveMsg, setResolveMsg] = useState<Record<string, string>>({});
  const patch = (id: string, p: Partial<RowState>) => setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));

  async function applyResolve(clientId: string, clientName: string, s: Suspect) {
    const cash = Math.abs(s.cash_total);
    if (!confirm(
      `Resolve ${clientName}: move ${money(cash)} of employee net-pay off "${s.account}" to a "Payroll Clearing" account?\n\n` +
      `Cash-basis dedupe — the QBO Payroll paycheques stay put as the wage record; these bank net-pay lines (year-to-date, including closed months) move to a balance-sheet clearing account so they stop double-counting labor. This rewrites the books.`,
    )) return;
    const key = `${clientId}:${s.account}`;
    setResolveBusy(key);
    setResolveMsg((m) => ({ ...m, [key]: "" }));
    try {
      const res = await fetch("/api/admin/payroll-double-scan/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientId, source_account_name: s.account }),
      });
      const d = await res.json();
      if (d.reauth) { setResolveMsg((m) => ({ ...m, [key]: "QBO reconnect needed" })); return; }
      if (d.tooLarge) { setResolveMsg((m) => ({ ...m, [key]: d.error })); return; }
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      const parts = [`${d.lines_moved} line(s) → Payroll Clearing`];
      if (d.created_clearing) parts.push("clearing account created");
      if (d.failures?.length) parts.push(`${d.failures.length} failed (closed period?)`);
      setResolveMsg((m) => ({ ...m, [key]: parts.join(" · ") }));
      // The resolve returns fresh detection — update the row in place.
      patch(clientId, {
        status: d.flagged ? "done" : "clean",
        overstated: d.overstated || 0,
        suspects: d.suspects || [],
        cash_total: d.cash_total || 0,
        invoice_total: d.invoice_total || 0,
      });
    } catch (e: any) {
      setResolveMsg((m) => ({ ...m, [key]: e.message }));
    } finally {
      setResolveBusy(null);
    }
  }

  async function scanOne(id: string) {
    patch(id, { status: "scanning", message: undefined });
    try {
      const res = await fetch("/api/admin/payroll-double-scan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: id }),
      });
      const d = await res.json();
      if (d.reauth) { patch(id, { status: "reauth" }); return; }
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      patch(id, {
        status: d.flagged ? "done" : "clean",
        overstated: d.overstated || 0,
        paycheque_accounts: d.paycheque_accounts || [],
        employee_count: d.employee_count || 0,
        suspects: d.suspects || [],
        cash_total: d.cash_total || 0,
        invoice_total: d.invoice_total || 0,
      });
    } catch (e: any) {
      patch(id, { status: "error", message: e.message });
    }
  }

  // Sequential — one client per request keeps each small and failures isolated.
  async function scanAll() {
    setBusy(true);
    for (const c of clients) {
      // eslint-disable-next-line no-await-in-loop
      await scanOne(c.id);
    }
    setBusy(false);
  }

  const scanned = Object.values(rows).filter((r) => !["idle", "scanning"].includes(r.status)).length;
  const flagged = Object.values(rows).filter((r) => r.status === "done");
  const totalOverstated = flagged.reduce((s, r) => s + r.overstated, 0);

  // Flagged first (biggest $), then the rest in name order.
  const ordered = useMemo(() => {
    return [...clients].sort((a, b) => {
      const ra = rows[a.id], rb = rows[b.id];
      const fa = ra.status === "done" ? 1 : 0, fb = rb.status === "done" ? 1 : 0;
      if (fa !== fb) return fb - fa;
      if (fa && fb) return rb.overstated - ra.overstated;
      return a.client_name.localeCompare(b.client_name);
    });
  }, [clients, rows]);

  return (
    <div className="space-y-4">
      <div className="p-4 bg-amber-50 rounded-xl text-sm text-amber-900">
        <strong>Read-only triage.</strong> Finds clients where the same crew&apos;s pay is booked to
        <em> two </em> P&amp;L lines — QBO Payroll paycheques (gross) on one account, and the
        bank-feed net-pay deposits/e-Transfers expensed to a second labor account (the phantom
        line that overstates COGS). Nothing is changed here; the fix (reclass the net-pay lines to
        a payroll clearing account) is a separate reviewed step.
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={scanAll}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal text-white text-sm font-semibold hover:bg-teal-dark disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          Scan all clients (read-only)
        </button>
        <div className="text-xs text-ink-slate">
          {scanned}/{clients.length} scanned · <span className="font-semibold text-red-700">{flagged.length} flagged</span>
          {totalOverstated > 0 && <> · {money(totalOverstated)} phantom labor</>}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Client</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Status</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Phantom labor</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">2nd labor line</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate"></th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((c) => {
              const r = rows[c.id];
              const top = r.suspects[0];
              return (
                <>
                  <tr key={c.id} className={`border-b border-gray-100 ${r.status === "done" ? "bg-red-50/40" : "hover:bg-gray-50"}`}>
                    <td className="px-4 py-2.5 font-medium text-navy">
                      <a href={`/clients/${c.id}`} className="hover:text-teal hover:underline">{c.client_name}</a>
                    </td>
                    <td className="px-4 py-2.5">
                      {r.status === "idle" && <span className="text-ink-light">not scanned</span>}
                      {r.status === "scanning" && <span className="inline-flex items-center gap-1 text-teal"><Loader2 size={12} className="animate-spin" />scanning</span>}
                      {r.status === "clean" && <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} />clean</span>}
                      {r.status === "done" && <span className="inline-flex items-center gap-1 text-red-700 font-semibold"><AlertTriangle size={12} />double-count</span>}
                      {r.status === "reauth" && <span className="text-amber-700">QBO reconnect</span>}
                      {r.status === "error" && <span className="text-red-600" title={r.message}>{(r.message || "error").slice(0, 50)}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold text-navy">
                      {r.status === "done" ? money(r.overstated) : r.status === "clean" ? "—" : ""}
                    </td>
                    <td className="px-4 py-2.5 text-ink-slate">
                      {top ? <span>{top.account} <span className="text-ink-light">({top.postings} txns · {top.employees} ppl)</span></span> : ""}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {r.status === "done" && (
                        <button className="text-xs font-semibold text-teal hover:text-teal-dark mr-3" onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                          {expanded === c.id ? "Hide" : "Detail"}
                        </button>
                      )}
                      <button onClick={() => scanOne(c.id)} disabled={busy} className="text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-50">Scan</button>
                    </td>
                  </tr>
                  {expanded === c.id && r.suspects.length > 0 && (
                    <tr key={`${c.id}-d`} className="border-b border-gray-100 bg-gray-50/60">
                      <td colSpan={5} className="px-6 py-3 text-xs text-ink-slate space-y-2">
                        <div>
                          <span className="font-semibold text-navy">Payroll invoices (paycheques):</span> {r.paycheque_accounts.join(" · ") || "—"} · {r.employee_count} employees
                        </div>
                        {/* Cash-basis split: cash leaving the bank is the source of truth. */}
                        <div className="flex flex-wrap gap-3">
                          <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-800 px-2 py-0.5 rounded font-semibold">
                            Cash paid out (truth): {money(Math.abs(r.cash_total))}
                          </span>
                          {Math.abs(r.invoice_total) > 0 && (
                            <span className="inline-flex items-center gap-1 bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
                              Accrual/invoice on these lines: {money(Math.abs(r.invoice_total))}
                            </span>
                          )}
                        </div>
                        {r.suspects.map((s) => {
                          const cash = Math.abs(s.cash_total), inv = Math.abs(s.invoice_total);
                          const kind = cash > 0 && inv === 0 ? "CASH" : inv > 0 && cash === 0 ? "INVOICE" : "MIXED";
                          const key = `${c.id}:${s.account}`;
                          return (
                            <div key={s.account} className="border-l-2 border-red-300 pl-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${kind === "CASH" ? "bg-emerald-100 text-emerald-800" : kind === "INVOICE" ? "bg-slate-200 text-slate-700" : "bg-amber-100 text-amber-800"}`}>{kind}</span>
                                <span className="font-semibold text-red-700">{s.account}</span>
                                <span>— {money(Math.abs(s.total))} · {s.postings} postings · {s.employees} employees</span>
                                {kind === "MIXED" && <span className="text-ink-light">(cash {money(cash)} / invoice {money(inv)})</span>}
                                {cash > 0 && (
                                  <button
                                    onClick={() => applyResolve(c.id, c.client_name, s)}
                                    disabled={resolveBusy === key || !!resolveBusy}
                                    className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-white bg-teal hover:bg-teal-dark px-2.5 py-1 rounded disabled:opacity-50"
                                    title={`Move ${money(cash)} of net-pay to Payroll Clearing`}
                                  >
                                    {resolveBusy === key ? <Loader2 size={11} className="animate-spin" /> : <Wrench size={11} />}
                                    Move cash to clearing
                                  </button>
                                )}
                              </div>
                              {s.reason && <div className="text-ink-slate mt-0.5">{s.reason}</div>}
                              {s.txns?.length > 0 && (
                                <div className="mt-1 overflow-x-auto">
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
                                          <td className="pr-3 text-right whitespace-nowrap">{money(Math.abs(t.amount))}</td>
                                          <td className="pr-3 whitespace-nowrap"><span className={t.kind === "cash" ? "text-emerald-700" : "text-slate-500"}>{t.txn_type}</span></td>
                                          <td className="text-ink-light truncate max-w-[220px]">{t.memo}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                              {resolveMsg[key] && <div className="text-navy font-medium mt-0.5">{resolveMsg[key]}</div>}
                            </div>
                          );
                        })}
                        <div className="text-ink-light">Cash basis: the <span className="font-semibold">cash that left the bank</span> is the real expense. <span className="font-semibold">Move cash to clearing</span> keeps the paycheques as the wage record and moves the duplicate net-pay onto a balance-sheet Payroll Clearing account (nets to ~0 against the paycheques) — reviewed, one line at a time; closed-period locks are reported.</div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
