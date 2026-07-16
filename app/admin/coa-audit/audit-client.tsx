"use client";

import { useState } from "react";
import { Loader2, Search, AlertTriangle, CheckCircle2, Wrench } from "lucide-react";

interface ClientRow {
  id: string;
  client_name: string;
}

interface MergeProposal {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  action: "merge" | "leave";
  targetId: string | null;
  targetName: string | null;
  confident: boolean;
  reason?: string;
}

interface Drift {
  totalActive: number;
  matched: number;
  wrongType: { id: string; name: string; currentType: string; masterType: string }[];
  nonMaster: { id: string; name: string; type: string }[];
  missingRequired: string[];
  conformancePct: number;
  mergeTargets?: { id: string; name: string }[];
  mergeProposals?: MergeProposal[];
  aiSuggestions?: boolean;
}

interface RowState {
  status: "idle" | "scanning" | "done" | "error" | "reauth";
  drift: Drift | null;
  applying?: boolean;
  fixMsg?: string;
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
  // Per-client selection of which fixes to apply.
  const [retypeSel, setRetypeSel] = useState<Record<string, Set<string>>>({});
  const [createSel, setCreateSel] = useState<Record<string, Set<string>>>({});
  // Merge: chosen target per source account (clientId → sourceId → targetId),
  // in-flight source, and per-source result message.
  const [mergeSel, setMergeSel] = useState<Record<string, Record<string, string>>>({});
  const [mergeBusy, setMergeBusy] = useState<string | null>(null);
  const [mergeMsg, setMergeMsg] = useState<Record<string, string>>({});

  function patch(id: string, p: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));
  }

  // When drift arrives, default every fixable item to selected + pre-fill each
  // merge's target with the suggestion.
  function seedSelection(id: string, d: Drift) {
    setRetypeSel((prev) => ({ ...prev, [id]: new Set(d.wrongType.map((w) => w.id)) }));
    setCreateSel((prev) => ({ ...prev, [id]: new Set(d.missingRequired) }));
    const m: Record<string, string> = {};
    for (const p of d.mergeProposals || []) if (p.action === "merge") m[p.sourceId] = p.targetId || "";
    setMergeSel((prev) => ({ ...prev, [id]: m }));
  }

  async function applyMerge(clientId: string, clientName: string, p: MergeProposal, targets: { id: string; name: string }[]) {
    const targetId = mergeSel[clientId]?.[p.sourceId] || "";
    if (!targetId) return;
    const targetName = targets.find((t) => t.id === targetId)?.name || "the target";
    if (!confirm(`Merge "${p.sourceName}" → "${targetName}" for ${clientName}?\n\nThis moves ALL year-to-date transactions (including already-closed months) onto "${targetName}" and deactivates "${p.sourceName}". This rewrites the books.`)) return;
    setMergeBusy(p.sourceId);
    setMergeMsg((m) => ({ ...m, [p.sourceId]: "" }));
    try {
      const res = await fetch("/api/admin/coa-audit/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientId, source_account_id: p.sourceId, target_account_id: targetId }),
      });
      const data = await res.json();
      if (data.reauth) { setMergeMsg((m) => ({ ...m, [p.sourceId]: "QBO reconnect needed" })); return; }
      if (data.tooLarge) { setMergeMsg((m) => ({ ...m, [p.sourceId]: data.error })); return; }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const parts = [`${data.linesMoved} line(s) moved`];
      if (data.inactivated) parts.push("source deactivated");
      if (data.failures?.length) parts.push(`${data.failures.length} failed`);
      setMergeMsg((m) => ({ ...m, [p.sourceId]: parts.join(" · ") }));
      // Re-scan to refresh conformance + drop the merged account.
      await scan(clientId);
    } catch (e: any) {
      setMergeMsg((m) => ({ ...m, [p.sourceId]: e.message }));
    } finally {
      setMergeBusy(null);
    }
  }

  async function scan(id: string): Promise<void> {
    patch(id, { status: "scanning", message: undefined, fixMsg: undefined });
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
      seedSelection(id, data);
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

  async function applyFix(id: string, clientName: string) {
    const retype = [...(retypeSel[id] || [])];
    const create = [...(createSel[id] || [])];
    if (retype.length === 0 && create.length === 0) return;
    if (!confirm(`Apply to ${clientName}'s live QuickBooks: ${retype.length} account re-type(s) + ${create.length} new account(s)? This re-writes the chart. (Merges/renames of other accounts are handled separately in the reviewed cleanup.)`)) return;
    patch(id, { applying: true, fixMsg: undefined });
    try {
      const res = await fetch("/api/admin/coa-audit/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: id, retype_account_ids: retype, create_account_names: create }),
      });
      const data = await res.json();
      if (data.reauth) { patch(id, { applying: false, fixMsg: "QBO needs reconnect" }); return; }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const parts: string[] = [];
      if (data.retyped?.length) parts.push(`${data.retyped.length} re-typed`);
      if (data.created?.length) parts.push(`${data.created.length} created`);
      if (data.failed?.length) parts.push(`${data.failed.length} failed`);
      patch(id, { applying: false, status: "done", drift: data.drift, fixMsg: parts.join(" · ") || "no changes" });
      if (data.drift) seedSelection(id, data.drift);
    } catch (e: any) {
      patch(id, { applying: false, fixMsg: e.message });
    }
  }

  function toggle(setter: typeof setRetypeSel, id: string, key: string) {
    setter((prev) => {
      const next = new Set(prev[id] || []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, [id]: next };
    });
  }

  const done = Object.values(rows).filter((r) => r.status === "done");
  const scored = done.length;
  const avg = scored ? Math.round(done.reduce((s, r) => s + (r.drift?.conformancePct ?? 0), 0) / scored) : 0;
  const needWork = done.filter((r) => (r.drift?.conformancePct ?? 100) < 90).length;

  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-50 rounded-xl text-sm text-blue-900">
        <strong>Audit + fix.</strong> Measures each client&apos;s live QuickBooks chart against the
        master COA (conformance %, wrong types, non-master sprawl, missing accounts). From the
        detail you can apply the <strong>safe, deterministic fixes</strong> — re-type accounts into
        the right section and create missing required accounts — after reviewing each. Merges and
        renames of non-master accounts (which move transactions) stay in the reviewed per-client
        cleanup.
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
              const fixable = d ? d.wrongType.length + d.missingRequired.length : 0;
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
                      {d && (fixable + d.nonMaster.length > 0) && (
                        <button
                          className="text-xs font-semibold text-ink-slate hover:text-navy mr-3 underline decoration-dotted"
                          onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                        >
                          {expanded === c.id ? "hide" : "review & fix"}
                        </button>
                      )}
                      <button onClick={() => scan(c.id)} disabled={busy || r.applying} className="text-xs font-semibold text-teal hover:text-teal-dark disabled:opacity-50">
                        {r.status === "done" ? "re-scan" : "scan"}
                      </button>
                    </td>
                  </tr>
                  {expanded === c.id && d && (
                    <tr key={`${c.id}-d`} className="border-b border-gray-100 bg-gray-50/60">
                      <td colSpan={7} className="px-6 py-3 text-xs text-ink-slate space-y-3">
                        {d.wrongType.length > 0 && (
                          <div>
                            <div className="font-semibold text-amber-700 inline-flex items-center gap-1 mb-1"><AlertTriangle size={11} /> Wrong type — re-type into the right section ({d.wrongType.length})</div>
                            <div className="space-y-0.5">
                              {d.wrongType.map((w) => (
                                <label key={w.id} className="flex items-center gap-2 cursor-pointer hover:text-navy">
                                  <input type="checkbox" checked={retypeSel[c.id]?.has(w.id) ?? false} onChange={() => toggle(setRetypeSel, c.id, w.id)} className="accent-teal" />
                                  <span className="font-medium text-navy">{w.name}</span>
                                  <span className="text-ink-light">{w.currentType} → {w.masterType}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {d.missingRequired.length > 0 && (
                          <div>
                            <div className="font-semibold text-red-600 mb-1">Missing required — create ({d.missingRequired.length})</div>
                            <div className="space-y-0.5">
                              {d.missingRequired.map((name) => (
                                <label key={name} className="flex items-center gap-2 cursor-pointer hover:text-navy">
                                  <input type="checkbox" checked={createSel[c.id]?.has(name) ?? false} onChange={() => toggle(setCreateSel, c.id, name)} className="accent-teal" />
                                  <span className="text-navy">{name}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {(() => {
                          const proposals = d.mergeProposals || [];
                          const merges = proposals.filter((p) => p.action === "merge");
                          const left = proposals.filter((p) => p.action !== "merge");
                          if (proposals.length === 0) return null;
                          return (
                            <div>
                              <div className="font-semibold text-orange-600 mb-1 flex items-center gap-2">
                                Merge duplicates into the master account ({merges.length})
                                {d.aiSuggestions && <span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded">AI-suggested</span>}
                              </div>
                              {merges.length > 0 ? (
                                <>
                                  <div className="text-ink-light mb-1.5">Approve one at a time — each moves all YTD transactions onto the target and deactivates the source.</div>
                                  <div className="space-y-1.5">
                                    {merges.map((p) => {
                                      const targets = d.mergeTargets || [];
                                      const sel = mergeSel[c.id]?.[p.sourceId] ?? "";
                                      return (
                                        <div key={p.sourceId} className="bg-white border border-orange-100 rounded-lg px-2.5 py-1.5">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-medium text-navy">{p.sourceName}</span>
                                            <span className="text-[10px] text-ink-light">[{p.sourceType}]</span>
                                            <span className="text-ink-light">→</span>
                                            <select
                                              value={sel}
                                              onChange={(e) => setMergeSel((prev) => ({ ...prev, [c.id]: { ...(prev[c.id] || {}), [p.sourceId]: e.target.value } }))}
                                              className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white text-navy max-w-[220px]"
                                            >
                                              <option value="">Pick target…</option>
                                              {targets.map((t) => (
                                                <option key={t.id} value={t.id}>{t.name}</option>
                                              ))}
                                            </select>
                                            {p.confident && sel === p.targetId && (
                                              <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">suggested</span>
                                            )}
                                            <button
                                              onClick={() => applyMerge(c.id, c.client_name, p, targets)}
                                              disabled={!sel || mergeBusy === p.sourceId || !!mergeBusy}
                                              className="text-[11px] font-bold text-white bg-orange-600 hover:bg-orange-700 px-2.5 py-1 rounded disabled:opacity-50 inline-flex items-center gap-1"
                                            >
                                              {mergeBusy === p.sourceId ? <Loader2 size={11} className="animate-spin" /> : null}
                                              Approve merge
                                            </button>
                                            {mergeMsg[p.sourceId] && (
                                              <span className="text-[11px] text-navy">{mergeMsg[p.sourceId]}</span>
                                            )}
                                          </div>
                                          {p.reason && <div className="text-[11px] text-ink-light mt-0.5 italic">{p.reason}</div>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </>
                              ) : (
                                <div className="text-ink-light">No obvious merges — every off-standard account is a real bank / asset / loan / income account or has no clear home.</div>
                              )}
                              {left.length > 0 && (
                                <details className="mt-1.5">
                                  <summary className="text-ink-light cursor-pointer">{left.length} account(s) left as-is (not merge candidates)</summary>
                                  <div className="text-[11px] text-ink-light mt-1 space-y-0.5 pl-2">
                                    {left.map((p) => (
                                      <div key={p.sourceId}><span className="font-medium text-navy">{p.sourceName}</span> <span className="opacity-70">[{p.sourceType}]</span>{p.reason ? ` — ${p.reason}` : ""}</div>
                                    ))}
                                  </div>
                                </details>
                              )}
                              <div className="text-ink-light mt-1 italic">Renames/deletes and anything without an obvious target still go through the full per-client COA cleanup.</div>
                            </div>
                          );
                        })()}
                        <div className="flex items-center gap-3 pt-1">
                          <button
                            onClick={() => applyFix(c.id, c.client_name)}
                            disabled={r.applying || ((retypeSel[c.id]?.size ?? 0) + (createSel[c.id]?.size ?? 0) === 0)}
                            className="inline-flex items-center gap-1.5 bg-teal text-white text-xs font-bold px-3 py-1.5 rounded-lg hover:bg-teal-dark disabled:opacity-50"
                          >
                            {r.applying ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                            Apply selected fixes ({(retypeSel[c.id]?.size ?? 0) + (createSel[c.id]?.size ?? 0)})
                          </button>
                          {r.fixMsg && (
                            <span className="text-[11px] inline-flex items-center gap-1 text-navy">
                              <CheckCircle2 size={11} className="text-emerald-600" /> {r.fixMsg}
                            </span>
                          )}
                        </div>
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
