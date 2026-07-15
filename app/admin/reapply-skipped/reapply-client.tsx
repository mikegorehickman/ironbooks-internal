"use client";

import { useState } from "react";
import { Loader2, Play, Search, CheckCircle2, AlertTriangle } from "lucide-react";

interface ClientRow {
  id: string;
  client_name: string;
}

interface Summary {
  scanned: number;
  reapplied: number;
  confirmed: number;
  corrected: number;
  skipped_closed: number;
  skipped_no_account: number;
  failed: number;
  remaining: number;
}

interface RowState {
  status: "idle" | "scanning" | "scanned" | "applying" | "done" | "error";
  summary: Summary | null;
  message?: string;
}

const EMPTY: RowState = { status: "idle", summary: null };

export function ReapplySkippedClient({ clients }: { clients: ClientRow[] }) {
  const [rows, setRows] = useState<Record<string, RowState>>(
    Object.fromEntries(clients.map((c) => [c.id, { ...EMPTY }]))
  );
  const [busy, setBusy] = useState(false);

  function patch(id: string, p: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));
  }

  // Apply re-invokes until the client's queue is drained (route is budgeted
  // to ~40 txns/pass and returns remaining>0 when there's more).
  async function callOne(id: string, dryRun: boolean): Promise<void> {
    patch(id, { status: dryRun ? "scanning" : "applying", message: undefined });
    try {
      let acc: Summary | null = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await fetch("/api/admin/reapply-skipped", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_link_id: id, dry_run: dryRun }),
        });
        const data: Summary & { error?: string } = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        acc = acc
          ? {
              scanned: data.scanned,
              reapplied: acc.reapplied + data.reapplied,
              confirmed: acc.confirmed + data.confirmed,
              corrected: acc.corrected + data.corrected,
              skipped_closed: acc.skipped_closed + data.skipped_closed,
              skipped_no_account: acc.skipped_no_account + data.skipped_no_account,
              failed: acc.failed + data.failed,
              remaining: data.remaining,
            }
          : data;
        patch(id, { summary: acc });
        if (dryRun || data.remaining === 0) break;
      }
      patch(id, { status: dryRun ? "scanned" : "done", summary: acc });
    } catch (e: any) {
      patch(id, { status: "error", message: e.message });
    }
  }

  async function runAll(dryRun: boolean) {
    setBusy(true);
    for (const c of clients) {
      const r = rows[c.id];
      // When applying, skip clients a scan showed have nothing to re-apply.
      if (!dryRun && r?.status === "scanned" && (r.summary?.scanned ?? 0) === 0) continue;
      // eslint-disable-next-line no-await-in-loop
      await callOne(c.id, dryRun);
    }
    setBusy(false);
  }

  const processed = Object.values(rows).filter((r) => r.status !== "idle" && r.status !== "scanning").length;
  const totalScanned = Object.values(rows).reduce((s, r) => s + (r.summary?.scanned ?? 0), 0);
  const totalCorrected = Object.values(rows).reduce((s, r) => s + (r.status === "done" ? r.summary?.corrected ?? 0 : 0), 0);
  const totalReapplied = Object.values(rows).reduce((s, r) => s + (r.status === "done" ? r.summary?.reapplied ?? 0 : 0), 0);
  const totalFailed = Object.values(rows).reduce((s, r) => s + (r.summary?.failed ?? 0) + (r.status === "error" ? 1 : 0), 0);

  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-50 rounded-xl text-sm text-blue-900">
        <strong>Trust-but-verify.</strong> Reclass marks a transaction &ldquo;skipped — already in target
        account&rdquo; and writes nothing to QBO. That belief is sometimes wrong: the categorization
        never actually landed and the transaction is still uncategorized. This re-pushes the target to
        QBO for every such row so the drifted ones get fixed. It&apos;s idempotent (already-correct rows
        get a harmless no-op) and never touches closed periods. Scan first (read-only), then Apply.
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => runAll(true)}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 bg-white text-sm font-semibold text-navy hover:border-teal disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          Scan all (read-only)
        </button>
        <button
          onClick={() => {
            if (confirm(`Re-push every "already in target account" skip to QuickBooks for ${clients.length} clients? Idempotent — already-correct rows are unchanged; only ones that never landed get fixed. Closed periods untouched.`)) runAll(false);
          }}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal text-white text-sm font-semibold hover:bg-teal-dark disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          Re-apply to all
        </button>
        <div className="text-xs text-ink-slate ml-2">
          {processed}/{clients.length} processed · {totalScanned} skips found · {totalReapplied} re-pushed
          {totalCorrected > 0 && <span className="text-amber-700 font-semibold"> · {totalCorrected} actually fixed</span>}
          {totalFailed > 0 && <span className="text-red-600 font-semibold"> · {totalFailed} failed</span>}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Client</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Skips</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Fixed</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Status</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Actions</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => {
              const r = rows[c.id];
              const s = r.summary;
              return (
                <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-medium text-navy">{c.client_name}</td>
                  <td className="px-4 py-2.5 text-right">{r.status === "idle" ? "—" : s?.scanned ?? 0}</td>
                  <td className="px-4 py-2.5 text-right">
                    {r.status === "done"
                      ? <span className={s?.corrected ? "text-amber-700 font-semibold" : ""}>{s?.corrected ?? 0}</span>
                      : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.status === "idle" && <span className="text-ink-light">not scanned</span>}
                    {(r.status === "scanning" || r.status === "applying") && (
                      <span className="inline-flex items-center gap-1 text-teal"><Loader2 size={12} className="animate-spin" />{r.status}</span>
                    )}
                    {r.status === "scanned" && (
                      (s?.scanned ?? 0) === 0
                        ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} />nothing to re-apply</span>
                        : <span className="text-amber-700">{s?.scanned} to re-apply</span>
                    )}
                    {r.status === "done" && (
                      (s?.failed ?? 0) === 0
                        ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} />{s?.corrected ? `${s.corrected} fixed, ${s.confirmed} confirmed` : "all confirmed"}{s?.skipped_closed ? ` · ${s.skipped_closed} closed` : ""}</span>
                        : <span className="inline-flex items-center gap-1 text-red-600"><AlertTriangle size={12} />{s?.failed} failed</span>
                    )}
                    {r.status === "error" && (
                      <span className="text-red-600" title={r.message}>{(r.message || "error").slice(0, 60)}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <button onClick={() => callOne(c.id, true)} disabled={busy} className="text-xs font-semibold text-ink-slate hover:text-navy mr-3 disabled:opacity-50">Scan</button>
                    <button onClick={() => callOne(c.id, false)} disabled={busy} className="text-xs font-semibold text-teal hover:text-teal-dark disabled:opacity-50">Apply</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
