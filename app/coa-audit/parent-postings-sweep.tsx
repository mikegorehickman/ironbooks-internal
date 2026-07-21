"use client";

import { useState } from "react";
import { Loader2, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";

interface Client { id: string; client_name: string; }
interface Child { id: string; name: string; }
interface ParentPosting { parent_id: string; parent_name: string; group: string; amount: number; children: Child[]; }
interface ClientResult { client_link_id: string; client_name: string; parents: ParentPosting[] }

const money = (n: number) => `$${Math.abs(Math.round(n)).toLocaleString()}`;
const CONCURRENCY = 4;

/**
 * Fleet sweep for ONE issue: transactions posted directly on a parent account
 * (QBO's "[Parent] – Other"). Scans every client read-only, then lets you move
 * each parent's stray postings onto a chosen sub-account. Self-contained — it
 * owns its state and hits /api/admin/coa-parent-postings/{scan,fix} directly,
 * so it doesn't touch the main audit grid.
 */
export function ParentPostingsSweep({ clients }: { clients: Client[] }) {
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<ClientResult[] | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [fixMsg, setFixMsg] = useState<Record<string, string>>({});
  const [fixBusy, setFixBusy] = useState<string>("");

  async function runScan() {
    setScanning(true); setResults(null); setOpen(true);
    setProgress({ done: 0, total: clients.length });
    const out: ClientResult[] = [];
    let idx = 0, done = 0;
    async function worker() {
      while (idx < clients.length) {
        const c = clients[idx++];
        try {
          const d = await (await fetch("/api/admin/coa-parent-postings/scan", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_link_id: c.id }),
          })).json();
          if (d?.parents?.length) out.push({ client_link_id: c.id, client_name: d.client_name || c.client_name, parents: d.parents });
        } catch { /* skip a client that errors (reauth, etc.) */ }
        done++; setProgress({ done, total: clients.length });
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, clients.length) }, worker));
    const amt = (r: ClientResult) => r.parents.reduce((s, p) => s + Math.abs(p.amount), 0);
    out.sort((a, b) => amt(b) - amt(a));
    setResults(out); setScanning(false);
  }

  async function move(clientId: string, clientName: string, p: ParentPosting) {
    const key = `${clientId}:${p.parent_id}`;
    const childId = pick[key];
    if (!childId) { setFixMsg((m) => ({ ...m, [key]: "pick a sub-account first" })); return; }
    const childName = p.children.find((c) => c.id === childId)?.name || "the sub-account";
    setFixBusy(key); setFixMsg((m) => ({ ...m, [key]: "" }));
    try {
      const body = { client_link_id: clientId, parent_account_id: p.parent_id, child_account_id: childId };
      const dry = await (await fetch("/api/admin/coa-parent-postings/fix", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      })).json();
      if (dry.error) { setFixMsg((m) => ({ ...m, [key]: dry.error })); return; }
      if (!dry.txns_found) { setFixMsg((m) => ({ ...m, [key]: "nothing to move (JE/Deposit postings are out of scope)" })); return; }
      if (!confirm(`Move ${dry.txns_found} transaction(s) / ${money(dry.amount_found)} off the parent "${p.parent_name}" → "${childName}" for ${clientName}?\n\nThis re-points those lines onto the sub-account in live QuickBooks.`)) {
        setFixMsg((m) => ({ ...m, [key]: "" })); return;
      }
      const r = await (await fetch("/api/admin/coa-parent-postings/fix", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, dry_run: false }),
      })).json();
      if (r.error) { setFixMsg((m) => ({ ...m, [key]: r.error })); return; }
      const parts = [`${r.moved_txns} moved`];
      if (r.skipped_closed) parts.push(`${r.skipped_closed} closed-skip`);
      if (r.failed) parts.push(`${r.failed} failed`);
      if (r.remaining) parts.push(`${r.remaining} left — run again`);
      setFixMsg((m) => ({ ...m, [key]: "✓ " + parts.join(" · ") }));
    } catch (e: any) {
      setFixMsg((m) => ({ ...m, [key]: e?.message || "failed" }));
    } finally {
      setFixBusy("");
    }
  }

  const totalParents = results?.reduce((s, r) => s + r.parents.length, 0) ?? 0;
  const totalAmt = results?.reduce((s, r) => s + r.parents.reduce((a, p) => a + Math.abs(p.amount), 0), 0) ?? 0;

  return (
    <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50/50 p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-2 min-w-0">
          <AlertTriangle size={16} className="text-amber-700 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-bold text-sm text-navy">Parent-account postings</div>
            <div className="text-[11px] text-ink-slate">
              Transactions booked directly on a parent (QBO&rsquo;s &ldquo;[Parent] &ndash; Other&rdquo;). Scans the whole fleet for just this, then moves them onto the right sub-account.
            </div>
          </div>
        </div>
        <button
          onClick={runScan}
          disabled={scanning}
          className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded bg-teal text-white hover:bg-teal-dark disabled:opacity-60 whitespace-nowrap"
        >
          {scanning ? <><Loader2 size={13} className="animate-spin" /> Scanning {progress.done}/{progress.total}…</> : <>Scan fleet</>}
        </button>
      </div>

      {results && !scanning && (
        <div className="mt-3">
          <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-xs font-semibold text-navy">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {results.length === 0
              ? "Fleet is clean — no parent-account postings found ✓"
              : `${results.length} client(s) · ${totalParents} parent account(s) · ${money(totalAmt)} on parents`}
          </button>

          {open && results.length > 0 && (
            <div className="mt-3 space-y-4">
              {results.map((r) => (
                <div key={r.client_link_id} className="rounded-lg border border-gray-200 bg-white p-3">
                  <div className="font-bold text-sm text-navy mb-2">{r.client_name}</div>
                  <div className="space-y-2">
                    {r.parents.map((p) => {
                      const key = `${r.client_link_id}:${p.parent_id}`;
                      return (
                        <div key={p.parent_id} className="flex items-center gap-2 flex-wrap text-xs border-t border-gray-50 pt-2 first:border-0 first:pt-0">
                          <div className="min-w-0 flex-1">
                            <span className="font-semibold text-navy">{p.parent_name}</span>
                            <span className="text-ink-light"> · {p.group} · </span>
                            <span className="font-mono text-amber-800">{money(p.amount)} on the parent</span>
                          </div>
                          {p.children.length === 0 ? (
                            <span className="text-[11px] text-red-600">no sub-accounts — add one in QBO first</span>
                          ) : (
                            <>
                              <select
                                value={pick[key] || ""}
                                onChange={(e) => setPick((m) => ({ ...m, [key]: e.target.value }))}
                                className="text-[11px] rounded border border-gray-300 px-1.5 py-1 bg-white max-w-[220px]"
                                title="Move the parent's postings onto this sub-account"
                              >
                                <option value="">Move to sub-account…</option>
                                {p.children.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                              </select>
                              <button
                                onClick={() => move(r.client_link_id, r.client_name, p)}
                                disabled={fixBusy === key || !pick[key]}
                                className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded bg-teal text-white hover:bg-teal-dark disabled:opacity-50"
                              >
                                {fixBusy === key ? <Loader2 size={11} className="animate-spin" /> : "Move"}
                              </button>
                            </>
                          )}
                          {fixMsg[key] && <span className="text-[11px] text-ink-slate w-full">{fixMsg[key]}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
