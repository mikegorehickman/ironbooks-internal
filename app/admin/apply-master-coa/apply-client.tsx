"use client";

import { useState } from "react";
import { Loader2, Play, Search, CheckCircle2, AlertTriangle } from "lucide-react";

interface ClientRow {
  id: string;
  client_name: string;
  jurisdiction: string;
}

interface RowState {
  status: "idle" | "scanning" | "scanned" | "applying" | "done" | "error";
  missing: string[];
  created: string[];
  errors: { account: string; message: string }[];
  message?: string;
}

export function ApplyMasterCoaClient({ clients }: { clients: ClientRow[] }) {
  const [rows, setRows] = useState<Record<string, RowState>>(
    Object.fromEntries(clients.map((c) => [c.id, { status: "idle", missing: [], created: [], errors: [] } as RowState]))
  );
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  function patch(id: string, p: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));
  }

  async function callOne(id: string, dryRun: boolean): Promise<void> {
    patch(id, { status: dryRun ? "scanning" : "applying", message: undefined });
    try {
      const res = await fetch("/api/admin/apply-master-coa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: id, dry_run: dryRun }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      patch(id, {
        status: dryRun ? "scanned" : "done",
        missing: data.missing || [],
        created: data.created || [],
        errors: data.errors || [],
      });
    } catch (e: any) {
      patch(id, { status: "error", message: e.message });
    }
  }

  // Sequential loops — one client at a time keeps each request small and a
  // failure isolated to that client (no self-chaining server infrastructure).
  async function runAll(dryRun: boolean) {
    setBusy(true);
    for (const c of clients) {
      // When applying, skip clients already scanned clean.
      const r = rows[c.id];
      if (!dryRun && r?.status === "scanned" && r.missing.length === 0) continue;
      // eslint-disable-next-line no-await-in-loop
      await callOne(c.id, dryRun);
    }
    setBusy(false);
  }

  const scannedCount = Object.values(rows).filter((r) => r.status !== "idle" && r.status !== "scanning").length;
  const totalMissing = Object.values(rows).reduce((s, r) => s + (r.status === "done" ? 0 : r.missing.length), 0);
  const totalCreated = Object.values(rows).reduce((s, r) => s + r.created.length, 0);
  const totalErrors = Object.values(rows).reduce((s, r) => s + r.errors.length + (r.status === "error" ? 1 : 0), 0);

  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-50 rounded-xl text-sm text-blue-900">
        <strong>Additive only.</strong> This creates master accounts that are missing from each
        client&apos;s QuickBooks (with the correct type and parent). It never renames, merges, or
        deletes — those stay in the reviewed per-client COA cleanup. Scan first (reads only), then
        Apply.
      </div>

      <div className="flex items-center gap-2">
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
            if (confirm(`Create missing standard accounts in ${clients.length} clients' QuickBooks? Additive only — nothing is renamed or deleted.`)) runAll(false);
          }}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal text-white text-sm font-semibold hover:bg-teal-dark disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          Apply to all
        </button>
        <div className="text-xs text-ink-slate ml-2">
          {scannedCount}/{clients.length} processed · {totalMissing} accounts missing · {totalCreated} created
          {totalErrors > 0 && <span className="text-red-600 font-semibold"> · {totalErrors} errors</span>}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Client</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Jur.</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Missing</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Created</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Status</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Actions</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => {
              const r = rows[c.id];
              return (
                <>
                  <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-medium text-navy">{c.client_name}</td>
                    <td className="px-4 py-2.5 text-ink-slate">{c.jurisdiction}</td>
                    <td className="px-4 py-2.5 text-right">
                      {r.status === "idle" ? "—" : (
                        <button className="underline decoration-dotted" onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                          {r.missing.length}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">{r.created.length || (r.status === "done" ? 0 : "—")}</td>
                    <td className="px-4 py-2.5">
                      {r.status === "idle" && <span className="text-ink-light">not scanned</span>}
                      {(r.status === "scanning" || r.status === "applying") && (
                        <span className="inline-flex items-center gap-1 text-teal"><Loader2 size={12} className="animate-spin" />{r.status}</span>
                      )}
                      {r.status === "scanned" && (
                        r.missing.length === 0
                          ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} />complete</span>
                          : <span className="text-amber-700">{r.missing.length} to create</span>
                      )}
                      {r.status === "done" && (
                        r.errors.length === 0
                          ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} />applied</span>
                          : <span className="inline-flex items-center gap-1 text-red-600"><AlertTriangle size={12} />{r.errors.length} failed</span>
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
                  {expanded === c.id && r.missing.length > 0 && (
                    <tr key={`${c.id}-detail`} className="border-b border-gray-100 bg-gray-50/60">
                      <td colSpan={6} className="px-6 py-2 text-xs text-ink-slate">
                        <span className="font-semibold">Missing:</span> {r.missing.join(" · ")}
                        {r.errors.length > 0 && (
                          <div className="mt-1 text-red-600">
                            {r.errors.map((e, i) => <div key={i}>{e.account}: {e.message}</div>)}
                          </div>
                        )}
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
