"use client";

import { useMemo, useState } from "react";
import { Loader2, Play, Search, CheckCircle2, AlertTriangle } from "lucide-react";

interface ClientRow { id: string; client_name: string; jurisdiction: string }

interface Suspect {
  account: string;
  postings: number;
  total: number;
  employees: number;
  by_type: Record<string, number>;
  sample_memos: string[];
}
interface RowState {
  status: "idle" | "scanning" | "done" | "clean" | "reauth" | "error";
  overstated: number;
  paycheque_accounts: string[];
  employee_count: number;
  suspects: Suspect[];
  message?: string;
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

export function PayrollDoubleScanClient({ clients }: { clients: ClientRow[] }) {
  const [rows, setRows] = useState<Record<string, RowState>>(
    Object.fromEntries(clients.map((c) => [c.id, { status: "idle", overstated: 0, paycheque_accounts: [], employee_count: 0, suspects: [] } as RowState])),
  );
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const patch = (id: string, p: Partial<RowState>) => setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));

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
                          <span className="font-semibold text-navy">Legit paycheque accounts:</span> {r.paycheque_accounts.join(" · ") || "—"} · {r.employee_count} employees
                        </div>
                        {r.suspects.map((s) => (
                          <div key={s.account} className="border-l-2 border-red-300 pl-2">
                            <span className="font-semibold text-red-700">{s.account}</span> — {money(Math.abs(s.total))} across {s.postings} postings ({s.employees} employees)
                            {" · "}<span className="text-ink-light">types: {Object.entries(s.by_type).map(([k, v]) => `${k}×${v}`).join(", ")}</span>
                            {s.sample_memos.length > 0 && (
                              <div className="text-ink-light italic mt-0.5">e.g. {s.sample_memos.map((m) => `"${m}"`).join(", ")}</div>
                            )}
                          </div>
                        ))}
                        <div className="text-ink-light">Fix: reclass these net-pay lines to a Payroll Clearing account (separate reviewed step) — the gross paycheques stay put.</div>
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
