"use client";

import { useState } from "react";
import { Loader2, Search, AlertTriangle, CheckCircle2 } from "lucide-react";

interface ClientRow {
  id: string;
  client_name: string;
}

interface Drift {
  totalActive: number;
  matched: number;
  wrongType: { name: string; currentType: string; masterType: string }[];
  nonMaster: { name: string; type: string }[];
  missingRequired: string[];
  conformancePct: number;
}

interface RowState {
  status: "idle" | "scanning" | "done" | "error" | "reauth";
  drift: Drift | null;
  message?: string;
}

const EMPTY: RowState = { status: "idle", drift: null };

function scoreColor(pct: number) {
  if (pct >= 90) return "text-emerald-700";
  if (pct >= 70) return "text-amber-600";
  return "text-red-600";
}

export function CoaAuditClient({ clients }: { clients: ClientRow[] }) {
  const [rows, setRows] = useState<Record<string, RowState>>(
    Object.fromEntries(clients.map((c) => [c.id, { ...EMPTY }]))
  );
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  function patch(id: string, p: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));
  }

  async function scan(id: string): Promise<void> {
    patch(id, { status: "scanning", message: undefined });
    try {
      const res = await fetch("/api/admin/coa-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: id }),
      });
      const data = await res.json();
      if (data.reauth) return patch(id, { status: "reauth" });
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      patch(id, { status: "done", drift: data });
    } catch (e: any) {
      patch(id, { status: "error", message: e.message });
    }
  }

  async function scanAll() {
    setBusy(true);
    for (const c of clients) {
      // eslint-disable-next-line no-await-in-loop
      await scan(c.id);
    }
    setBusy(false);
  }

  const done = Object.values(rows).filter((r) => r.status === "done");
  const scored = done.length;
  const avg = scored ? Math.round(done.reduce((s, r) => s + (r.drift?.conformancePct ?? 0), 0) / scored) : 0;
  const needWork = done.filter((r) => (r.drift?.conformancePct ?? 100) < 90).length;

  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-50 rounded-xl text-sm text-blue-900">
        <strong>Read-only.</strong> This measures each client&apos;s live QuickBooks chart against the
        master COA — matched accounts, wrong types, non-master &ldquo;sprawl,&rdquo; and missing
        required accounts — and scores conformance. Nothing is written to QuickBooks. Use it to
        triage which clients need the standardization pass.
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={scanAll}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal text-white text-sm font-semibold hover:bg-teal-dark disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          Audit all clients
        </button>
        <div className="text-xs text-ink-slate">
          {scored}/{clients.length} audited
          {scored > 0 && <> · avg conformance <span className={`font-bold ${scoreColor(avg)}`}>{avg}%</span> · <span className="text-red-600 font-semibold">{needWork} below 90%</span></>}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Client</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Conformance</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Matched</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Wrong type</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Non-master</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Missing req.</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate"></th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => {
              const r = rows[c.id];
              const d = r.drift;
              return (
                <>
                  <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-medium text-navy">{c.client_name}</td>
                    <td className="px-4 py-2.5 text-right">
                      {r.status === "done" && d ? (
                        <span className={`font-bold ${scoreColor(d.conformancePct)}`}>{d.conformancePct}%</span>
                      ) : r.status === "scanning" ? (
                        <Loader2 size={13} className="animate-spin inline text-teal" />
                      ) : r.status === "reauth" ? (
                        <span className="text-amber-600 text-xs">QBO reconnect</span>
                      ) : r.status === "error" ? (
                        <span className="text-red-600 text-xs" title={r.message}>error</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-emerald-700">{d ? d.matched : "—"}</td>
                    <td className="px-4 py-2.5 text-right text-amber-700">{d ? d.wrongType.length : "—"}</td>
                    <td className="px-4 py-2.5 text-right text-orange-600">{d ? d.nonMaster.length : "—"}</td>
                    <td className="px-4 py-2.5 text-right text-red-600">{d ? d.missingRequired.length : "—"}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {d && (d.wrongType.length + d.nonMaster.length + d.missingRequired.length > 0) && (
                        <button
                          className="text-xs font-semibold text-ink-slate hover:text-navy mr-3 underline decoration-dotted"
                          onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                        >
                          {expanded === c.id ? "hide" : "detail"}
                        </button>
                      )}
                      <button onClick={() => scan(c.id)} disabled={busy} className="text-xs font-semibold text-teal hover:text-teal-dark disabled:opacity-50">
                        {r.status === "done" ? "re-scan" : "scan"}
                      </button>
                    </td>
                  </tr>
                  {expanded === c.id && d && (
                    <tr key={`${c.id}-d`} className="border-b border-gray-100 bg-gray-50/60">
                      <td colSpan={7} className="px-6 py-3 text-xs text-ink-slate space-y-2">
                        {d.wrongType.length > 0 && (
                          <div>
                            <span className="font-semibold text-amber-700 inline-flex items-center gap-1"><AlertTriangle size={11} /> Wrong type ({d.wrongType.length}):</span>{" "}
                            {d.wrongType.map((w) => `${w.name} (${w.currentType}→${w.masterType})`).join(" · ")}
                          </div>
                        )}
                        {d.nonMaster.length > 0 && (
                          <div>
                            <span className="font-semibold text-orange-600">Non-master ({d.nonMaster.length}):</span>{" "}
                            {d.nonMaster.map((n) => n.name).join(" · ")}
                          </div>
                        )}
                        {d.missingRequired.length > 0 && (
                          <div>
                            <span className="font-semibold text-red-600">Missing required ({d.missingRequired.length}):</span>{" "}
                            {d.missingRequired.join(" · ")}
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
