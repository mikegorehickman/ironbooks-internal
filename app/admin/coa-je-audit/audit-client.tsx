"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, AlertTriangle, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

interface ClientRow { id: string; client_name: string; }
interface JeLine { accountName: string; posting: string; amount: number; }
interface JeRow {
  jeId: string; txnDate: string; privateNote: string; totalAmount: number;
  lines: JeLine[]; affectedAccounts: string[];
}
interface ScanResult {
  client_name: string; scanned: number; matched_count: number; matched_any_count: number;
  total_affected_amount: number; rows: JeRow[]; error: string | null;
}

const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function CoaJeAuditClient() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [affectedAccounts, setAffectedAccounts] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [scanning, setScanning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ScanResult | { error: string }>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scanAll, setScanAll] = useState(false);

  useEffect(() => {
    fetch("/api/admin/coa-je-audit")
      .then((r) => r.json())
      .then((j) => { setClients(j.clients || []); setAffectedAccounts(j.affectedAccounts || []); setExcluded(j.excluded || []); })
      .catch(() => {});
  }, []);

  async function scan(id: string) {
    setScanning(id);
    try {
      const res = await fetch("/api/admin/coa-je-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientLinkId: id }),
      });
      const j = await res.json();
      setResults((r) => ({ ...r, [id]: res.ok ? j : { error: j.error || "scan failed" } }));
    } catch (e: any) {
      setResults((r) => ({ ...r, [id]: { error: e?.message || "scan failed" } }));
    } finally {
      setScanning(null);
    }
  }

  async function runAll() {
    setScanAll(true);
    for (const c of clients) {
      if (results[c.id]) continue;
      await scan(c.id); // sequential — QBO rate limits + keeps it gentle
    }
    setScanAll(false);
  }

  const done = clients.filter((c) => results[c.id]);
  const withHits = done.filter((c) => {
    const r = results[c.id] as ScanResult;
    return r && !("error" in r) && r.matched_count > 0;
  });
  const fleetTotal = done.reduce((s, c) => {
    const r = results[c.id] as ScanResult;
    return s + (r && !("error" in r) ? r.total_affected_amount : 0);
  }, 0);

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900">
        <div className="font-semibold flex items-center gap-1.5"><AlertTriangle size={15} /> Read-only inventory</div>
        <p className="text-xs mt-1 text-amber-800">
          Finds the lump “merge” journal entries that collapsed GL detail on the affected accounts.
          Nothing here changes QuickBooks. Excluded (confirmed clean): {excluded.join(", ") || "—"}.
        </p>
        <p className="text-xs mt-1 text-amber-800">
          Affected accounts scanned: {affectedAccounts.join(" · ")}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm text-ink-slate">
          {clients.length} affected clients · scanned {done.length} · {withHits.length} with merge-JEs
          {done.length > 0 && <> · <strong className="text-navy">{money(fleetTotal)}</strong> in collapsed detail found so far</>}
        </div>
        <button
          onClick={runAll}
          disabled={scanAll || scanning !== null}
          className="inline-flex items-center gap-1.5 rounded-lg bg-teal px-3.5 py-2 text-sm font-semibold text-white hover:bg-teal-dark disabled:opacity-60"
        >
          {scanAll ? <Loader2 size={14} className="animate-spin" /> : null}
          {scanAll ? "Scanning all…" : "Scan all clients"}
        </button>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden divide-y divide-gray-100">
        {clients.map((c) => {
          const r = results[c.id] as ScanResult | { error: string } | undefined;
          const isOpen = expanded.has(c.id);
          const hits = r && !("error" in r) ? r.matched_count : null;
          return (
            <div key={c.id}>
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <button
                  onClick={() => setExpanded((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })}
                  className="flex items-center gap-2 min-w-0 text-left"
                >
                  {isOpen ? <ChevronDown size={14} className="text-ink-slate" /> : <ChevronRight size={14} className="text-ink-slate" />}
                  <span className="text-sm font-semibold text-navy truncate">{c.client_name}</span>
                  {r && ("error" in r ? (
                    <span className="text-[11px] text-red-600">{r.error}</span>
                  ) : (
                    <span className={`text-[11px] font-bold ${hits ? "text-red-700" : "text-emerald-700"}`}>
                      {hits ? `${hits} merge-JE${hits === 1 ? "" : "s"} · ${money(r.total_affected_amount)}` : "clean"}
                    </span>
                  ))}
                </button>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Link href={`/clients/${c.id}`} className="text-ink-slate hover:text-navy" title="Open client"><ExternalLink size={14} /></Link>
                  <button
                    onClick={() => scan(c.id)}
                    disabled={scanning === c.id || scanAll}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-semibold text-ink-slate hover:text-navy hover:border-teal disabled:opacity-50"
                  >
                    {scanning === c.id ? <Loader2 size={12} className="animate-spin" /> : null}
                    {r ? "Re-scan" : "Scan"}
                  </button>
                </div>
              </div>
              {isOpen && r && !("error" in r) && r.rows.length > 0 && (
                <div className="px-4 pb-3 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-ink-slate">
                        <th className="py-1 pr-3">Date</th>
                        <th className="py-1 pr-3">JE id</th>
                        <th className="py-1 pr-3">Affected accounts</th>
                        <th className="py-1 pr-3">Memo</th>
                        <th className="py-1 pr-3 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.rows.map((je: JeRow) => (
                        <tr key={je.jeId} className="border-t border-gray-50">
                          <td className="py-1 pr-3 whitespace-nowrap text-ink-slate">{je.txnDate}</td>
                          <td className="py-1 pr-3 font-mono text-ink-light">{je.jeId}</td>
                          <td className="py-1 pr-3 text-navy">{je.affectedAccounts.join(", ")}</td>
                          <td className="py-1 pr-3 text-ink-slate truncate max-w-[240px]" title={je.privateNote}>{je.privateNote}</td>
                          <td className="py-1 pr-3 text-right font-mono text-navy whitespace-nowrap">{money(je.totalAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {isOpen && r && !("error" in r) && r.rows.length === 0 && (
                <div className="px-8 pb-3 text-xs text-ink-light">No merge-JEs on the affected accounts.</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
