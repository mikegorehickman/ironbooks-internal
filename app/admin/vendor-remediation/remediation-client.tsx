"use client";

import { useState } from "react";
import { Loader2, Search, Play, ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, ShieldCheck } from "lucide-react";

interface CandidateRow {
  reclassification_id: string;
  qbo_transaction_id: string;
  transaction_date: string | null;
  transaction_amount: number | null;
  vendor_name: string | null;
  description: string | null;
  current_account: string;
  target_account: string;
  target_vendor: string | null;
  kb_confidence: number;
}
interface Transition {
  kind: "move" | "set_payee";
  current_account: string;
  target_account: string;
  count: number;
  total_amount: number;
  sample_vendors: string[];
  rows: CandidateRow[];
}
interface ClientGroup {
  client_link_id: string;
  client_name: string;
  transitions: Transition[];
  total_rows: number;
}
interface ApplySummary {
  moved_lines: number;
  skipped_stale: number;
  skipped_closed: number;
  skipped_no_account: number;
  failed: number;
  dropped_by_revalidation: number;
  remaining_ids: string[];
}

const fmt$ = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export function VendorRemediationClient() {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [clients, setClients] = useState<ClientGroup[] | null>(null);
  const [scannedAt, setScannedAt] = useState("");
  // selection: set of "clientId|current|target" transition keys that are ON
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState<Record<string, "running" | "done" | "error">>({});
  const [applyMsg, setApplyMsg] = useState<Record<string, string>>({});
  const [applyAllRunning, setApplyAllRunning] = useState(false);
  // per-client apply progress: total rows at start vs rows still remaining
  const [progress, setProgress] = useState<Record<string, { total: number; left: number }>>({});
  // companies excluded from scope entirely (checkbox in the client header)
  const [excludedClients, setExcludedClients] = useState<Set<string>>(new Set());

  const tKey = (clientId: string, t: Transition) => `${clientId}|${t.current_account}|${t.target_account}`;

  async function scan() {
    setScanning(true);
    setScanError("");
    setClients(null);
    try {
      const res = await fetch("/api/admin/vendor-remediation/scan", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setClients(data.clients);
      setScannedAt(data.scanned_at);
      setDeselected(new Set());
      setApplying({});
      setApplyMsg({});
    } catch (e: any) {
      setScanError(e.message);
    }
    setScanning(false);
  }

  function selectedIdsFor(client: ClientGroup): string[] {
    return client.transitions
      .filter((t) => !deselected.has(tKey(client.client_link_id, t)))
      .flatMap((t) => t.rows.map((r) => r.reclassification_id));
  }

  async function applyClient(client: ClientGroup): Promise<void> {
    const cid = client.client_link_id;
    let ids = selectedIdsFor(client);
    if (ids.length === 0) return;
    setApplying((p) => ({ ...p, [cid]: "running" }));
    setApplyMsg((p) => ({ ...p, [cid]: `applying ${ids.length} rows…` }));
    const initialTotal = ids.length;
    setProgress((p) => ({ ...p, [cid]: { total: initialTotal, left: initialTotal } }));
    try {
      const totals: ApplySummary = {
        moved_lines: 0, skipped_stale: 0, skipped_closed: 0,
        skipped_no_account: 0, failed: 0, dropped_by_revalidation: 0, remaining_ids: [],
      };
      // Budget-chunked: keep re-invoking until the server reports nothing left.
      for (let pass = 0; pass < 20; pass++) {
        const res = await fetch("/api/admin/vendor-remediation/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_link_id: cid, reclassification_ids: ids }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        totals.moved_lines += data.moved_lines;
        totals.skipped_stale += data.skipped_stale;
        totals.skipped_closed += data.skipped_closed;
        totals.skipped_no_account += data.skipped_no_account;
        totals.failed += data.failed;
        totals.dropped_by_revalidation += data.dropped_by_revalidation;
        if (!data.remaining_ids?.length) { setProgress((p) => ({ ...p, [cid]: { total: initialTotal, left: 0 } })); break; }
        ids = data.remaining_ids;
        setProgress((p) => ({ ...p, [cid]: { total: initialTotal, left: ids.length } }));
        setApplyMsg((p) => ({ ...p, [cid]: `${initialTotal - ids.length} of ${initialTotal} done…` }));
      }
      const parts = [`${totals.moved_lines} moved`];
      if (totals.skipped_stale) parts.push(`${totals.skipped_stale} kept (human changed them since)`);
      if (totals.skipped_closed) parts.push(`${totals.skipped_closed} skipped (closed period)`);
      if (totals.skipped_no_account) parts.push(`${totals.skipped_no_account} skipped (account missing)`);
      if (totals.dropped_by_revalidation) parts.push(`${totals.dropped_by_revalidation} no longer candidates`);
      if (totals.failed) parts.push(`${totals.failed} FAILED`);
      setApplyMsg((p) => ({ ...p, [cid]: parts.join(" · ") }));
      setApplying((p) => ({ ...p, [cid]: totals.failed > 0 ? "error" : "done" }));
    } catch (e: any) {
      setApplying((p) => ({ ...p, [cid]: "error" }));
      setApplyMsg((p) => ({ ...p, [cid]: e.message }));
    }
  }

  async function applyAll() {
    if (!clients) return;
    const inScope = clients.filter((c) => !excludedClients.has(c.client_link_id));
    const totalRows = inScope.reduce((s, c) => s + selectedIdsFor(c).length, 0);
    if (!confirm(
      `Apply the selected re-categorizations to ${inScope.length} clients (${totalRows} transactions)?\n\n` +
      `This WRITES to each client's QuickBooks. Closed periods and lines a human has since changed are automatically skipped.`
    )) return;
    setApplyAllRunning(true);
    for (const c of clients) {
      if (excludedClients.has(c.client_link_id)) continue;
      if (applying[c.client_link_id] === "done") continue;
      // eslint-disable-next-line no-await-in-loop
      await applyClient(c);
    }
    setApplyAllRunning(false);
  }

  const grandTotalRows = clients?.reduce(
    (s, c) => s + (excludedClients.has(c.client_link_id) ? 0 : selectedIdsFor(c).length), 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-50 rounded-xl text-sm text-blue-900 space-y-1">
        <div>
          <strong>Step 1 — Scan (read-only).</strong> Finds transactions SNAP previously posted that the
          reviewed vendor rules now map to a different account. Nothing is written.
        </div>
        <div>
          <strong>Step 2 — Verify per account.</strong> Every change is grouped by client and by
          &ldquo;from → to&rdquo; account. Uncheck any group you don&apos;t want.
        </div>
        <div>
          <strong>Step 3 — Apply per client.</strong> Writes to QuickBooks with three automatic protections:
          closed periods untouched, lines a human moved since are kept, and every row is re-validated
          server-side before writing.
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={scan}
          disabled={scanning || applyAllRunning}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal text-white text-sm font-semibold hover:bg-teal-dark disabled:opacity-50"
        >
          {scanning ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          {clients ? "Re-scan fleet" : "Scan fleet (read-only)"}
        </button>
        {clients && clients.length > 0 && (
          <button
            onClick={applyAll}
            disabled={applyAllRunning || scanning || grandTotalRows === 0}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-navy text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {applyAllRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Apply all selected ({grandTotalRows} txns)
          </button>
        )}
        {scannedAt && (
          <span className="text-xs text-ink-slate">
            scanned {new Date(scannedAt).toLocaleString()} · {clients?.length ?? 0} clients ·{" "}
            {clients?.reduce((s, c) => s + c.total_rows, 0) ?? 0} candidates
          </span>
        )}
        {scanError && <span className="text-sm font-semibold text-red-600">{scanError}</span>}
      </div>

      {scanning && (
        <div className="p-8 text-center text-sm text-ink-slate bg-white rounded-2xl border border-gray-100">
          <Loader2 size={20} className="animate-spin inline-block mb-2" />
          <div>Scanning every executed transaction against the reviewed vendor rules…</div>
        </div>
      )}

      {clients && clients.length === 0 && (
        <div className="p-8 text-center text-sm text-ink-slate bg-white rounded-2xl border border-gray-100">
          <CheckCircle2 size={20} className="inline-block mb-2 text-emerald-600" />
          <div>Fleet is clean — no executed transactions disagree with the reviewed vendor rules.</div>
        </div>
      )}

      {clients?.map((client) => {
        const cid = client.client_link_id;
        const state = applying[cid];
        const selCount = selectedIdsFor(client).length;
        return (
          <div key={cid} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  title="Include this company in scope"
                  checked={!excludedClients.has(cid)}
                  disabled={state === "running" || applyAllRunning}
                  onChange={(e) => {
                    const next = new Set(excludedClients);
                    e.target.checked ? next.delete(cid) : next.add(cid);
                    setExcludedClients(next);
                  }}
                  className="w-4 h-4 rounded border-gray-300"
                />
                <span className={`font-semibold ${excludedClients.has(cid) ? "text-ink-light line-through" : "text-navy"}`}>{client.client_name}</span>
                <span className="text-xs text-ink-slate">{client.total_rows} candidate txns</span>
                {state === "running" && progress[cid] && (
                  <span className="flex items-center gap-2 ml-2">
                    <span className="w-36 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <span
                        className="block h-full bg-teal rounded-full transition-all duration-700"
                        style={{ width: `${Math.round(((progress[cid].total - progress[cid].left) / Math.max(1, progress[cid].total)) * 100)}%` }}
                      />
                    </span>
                    <span className="text-xs font-semibold text-teal-dark tabular-nums">
                      {Math.round(((progress[cid].total - progress[cid].left) / Math.max(1, progress[cid].total)) * 100)}%
                    </span>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {applyMsg[cid] && (
                  <span className={`text-xs font-medium ${state === "error" ? "text-red-600" : state === "done" ? "text-emerald-700" : "text-ink-slate"}`}>
                    {applyMsg[cid]}
                  </span>
                )}
                {state === "done" ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                    <ShieldCheck size={14} /> applied
                  </span>
                ) : (
                  <button
                    onClick={() => applyClient(client)}
                    disabled={state === "running" || applyAllRunning || selCount === 0}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-teal text-white hover:bg-teal-dark disabled:opacity-50"
                  >
                    {state === "running" ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                    Apply {selCount}
                  </button>
                )}
              </div>
            </div>
            <div className="divide-y divide-gray-50">
              {client.transitions.map((t) => {
                const key = tKey(cid, t);
                const on = !deselected.has(key);
                const isExpanded = expanded.has(key);
                return (
                  <div key={key}>
                    <div className="flex items-center gap-3 px-5 py-2.5 hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={state === "running" || state === "done"}
                        onChange={(e) => {
                          const next = new Set(deselected);
                          e.target.checked ? next.delete(key) : next.add(key);
                          setDeselected(next);
                        }}
                        className="w-4 h-4 rounded border-gray-300"
                      />
                      <button
                        onClick={() => {
                          const next = new Set(expanded);
                          isExpanded ? next.delete(key) : next.add(key);
                          setExpanded(next);
                        }}
                        className="flex items-center gap-2 flex-1 text-left"
                      >
                        {isExpanded ? <ChevronDown size={14} className="text-ink-light" /> : <ChevronRight size={14} className="text-ink-light" />}
                        <span className={`text-sm ${on ? "text-navy" : "text-ink-light line-through"}`}>
                          {t.kind === "set_payee" ? (
                            <>
                              <span className="font-medium">{t.current_account}</span>
                              <span className="ml-2 text-[11px] font-semibold uppercase tracking-wide text-teal-dark bg-teal-light rounded px-1.5 py-0.5">set missing payee</span>
                            </>
                          ) : (
                            <>
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-light mr-1">now</span>
                              <span className="font-medium line-through decoration-ink-light/50">{t.current_account}</span>
                              <span className="text-ink-light mx-1.5">→</span>
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-teal-dark mr-1">after</span>
                              <span className="font-semibold text-teal-dark">{t.target_account}</span>
                            </>
                          )}
                        </span>
                      </button>
                      <span className="text-xs text-ink-slate whitespace-nowrap">
                        {t.count} txn{t.count === 1 ? "" : "s"} · {fmt$(t.total_amount)}
                      </span>
                      <span className="text-xs text-ink-light truncate max-w-[220px]" title={t.sample_vendors.join(", ")}>
                        {t.sample_vendors.join(", ")}
                      </span>
                    </div>
                    {isExpanded && (
                      <div className="px-12 pb-3">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-ink-light">
                              <th className="py-1 pr-3 font-medium">Date</th>
                              <th className="py-1 pr-3 font-medium">Vendor / description</th>
                              <th className="py-1 pr-3 font-medium text-right">Amount</th>
                              <th className="py-1 font-medium">QBO payee to set</th>
                            </tr>
                          </thead>
                          <tbody>
                            {t.rows.slice(0, 50).map((r) => (
                              <tr key={r.reclassification_id} className="border-t border-gray-50">
                                <td className="py-1 pr-3 whitespace-nowrap text-ink-slate">{r.transaction_date || "—"}</td>
                                <td className="py-1 pr-3 text-navy">{r.vendor_name || r.description || "—"}</td>
                                <td className="py-1 pr-3 text-right text-ink-slate">
                                  {fmt$(Math.abs(r.transaction_amount ?? 0))}
                                </td>
                                <td className="py-1 text-ink-slate">{r.target_vendor || "—"}</td>
                              </tr>
                            ))}
                            {t.rows.length > 50 && (
                              <tr>
                                <td colSpan={4} className="py-1 text-ink-light">…and {t.rows.length - 50} more</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {clients && clients.length > 0 && (
        <div className="flex items-start gap-2 p-3 text-xs text-amber-800 bg-amber-50 rounded-lg">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span>
            Applying writes to the client&apos;s QuickBooks. Rows in closed periods, rows a human has
            re-categorized since, and rows whose target account is missing are skipped automatically and
            reported — never silently changed.
          </span>
        </div>
      )}
    </div>
  );
}
