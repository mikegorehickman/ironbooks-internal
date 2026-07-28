"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, ChevronRight, Play, AlertTriangle, CheckCircle2, RefreshCw, ExternalLink } from "lucide-react";

/**
 * Fleet list (cached conformance) → per-client plan → run.
 * Merges are opt-out per account; the run rebuilds the plan server-side.
 */

interface Row {
  client_link_id: string;
  client_name: string;
  jurisdiction: string;
  cleanup_completed: boolean;
  conformance_pct: number | null;
  non_master: number | null;
  issue_count: number | null;
}

export function ConformanceClient() {
  const [clients, setClients] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/coa-conformance")
      .then((r) => r.json())
      .then((j) => (j.error ? setError(j.error) : setClients(j.clients || [])))
      .catch((e) => setError(e?.message || "Failed to load"));
  }, []);

  if (error) return <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>;
  if (!clients)
    return (
      <div className="flex items-center gap-2 text-sm text-ink-slate py-8 justify-center">
        <Loader2 size={16} className="animate-spin text-teal" /> Loading clients…
      </div>
    );

  const scanned = clients.filter((c) => c.conformance_pct != null);
  const at100 = scanned.filter((c) => (c.conformance_pct ?? 0) >= 100).length;
  const avg = scanned.length
    ? Math.round(scanned.reduce((s, c) => s + (c.conformance_pct ?? 0), 0) / scanned.length)
    : 0;

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <Stat label="Clients" value={String(clients.length)} />
        <Stat label="Average conformance" value={`${avg}%`} accent={avg < 90} />
        <Stat label="At 100%" value={String(at100)} accent={at100 === 0} />
        <Stat label="Never scanned" value={String(clients.length - scanned.length)} />
      </div>
      <div className="space-y-2">
        {clients.map((c) => (
          <ClientCard key={c.client_link_id} client={c} />
        ))}
      </div>
    </div>
  );
}

function ClientCard({ client }: { client: Row }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());

  async function call(action: string, extra: any = {}) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/admin/coa-conformance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: client.client_link_id, action, ...extra }),
      });
      const j = await res.json();
      if (!res.ok) {
        if (j.error === "cleanup_complete") {
          if (confirm(`${j.message}\n\nRun it anyway?`)) return call(action, { ...extra, allow_completed: true });
          return null;
        }
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      return j;
    } catch (e: any) {
      setError(e?.message || "Failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function loadPlan() {
    setResult(null);
    const j = await call("plan");
    if (j) { setPlan(j.plan); setSkip(new Set()); }
  }

  async function run() {
    if (!plan) return;
    const ids = plan.merges.map((m: any) => m.sourceId).filter((id: string) => !skip.has(id));
    if (!confirm(
      `Run conformance for ${client.client_name}?\n\n` +
      `• create ${plan.creates.length} missing master account(s)\n` +
      `• retype ${plan.retypes.length}\n` +
      `• merge ${ids.length} account(s) — real transactions reclassified, no JE\n\n` +
      `Writes to their live QuickBooks.`
    )) return;
    const j = await call("execute", { merge_source_ids: ids });
    if (j) { setResult(j.result); setPlan(j.plan); }
  }

  const pct = client.conformance_pct;
  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <button
        onClick={() => { setOpen((o) => !o); if (!open && !plan) loadPlan(); }}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        <ChevronRight size={15} className={`text-ink-light transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="font-semibold text-navy flex-1">{client.client_name}</span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${client.jurisdiction === "CA" ? "bg-red-50 text-red-700 border border-red-200" : "bg-sky-50 text-sky-700 border border-sky-200"}`}>
          {client.jurisdiction}
        </span>
        {client.cleanup_completed && (
          <span className="text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded">CLEANUP DONE</span>
        )}
        <span className={`text-xs font-bold tabular-nums ${pct == null ? "text-ink-light" : pct >= 95 ? "text-emerald-700" : pct >= 70 ? "text-gold-deep" : "text-[#954E44]"}`}>
          {pct == null ? "not scanned" : `${Math.round(pct)}%`}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3">
          {busy === "plan" && (
            <div className="flex items-center gap-2 text-sm text-ink-slate py-3">
              <Loader2 size={14} className="animate-spin text-teal" /> Reading their live chart…
            </div>
          )}
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 mb-2">{error}</div>}

          {result && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-900 mb-3">
              <div className="font-bold flex items-center gap-1.5">
                <CheckCircle2 size={13} /> Created {result.created.length} · retyped {result.retyped.length} · merged {result.merged.length}
                {result.failed.length > 0 && ` · ${result.failed.length} failed`}
              </div>
              {result.needs_qbo_merge.length > 0 && (
                <div className="mt-2 rounded border border-gold-border bg-gold-tint px-2.5 py-2 text-[#7c5210]">
                  <div className="font-bold mb-1">
                    {result.needs_qbo_merge.length} account(s) need a native merge in QuickBooks
                  </div>
                  <p className="mb-1.5">
                    Their remaining activity is income / deposits / paycheques, which the API can only
                    move by lump JE. Merge these in the QBO UI (Accounting → Chart of accounts → edit
                    the source, rename it to exactly the target name) — every transaction moves with
                    detail intact.
                  </p>
                  <ul className="space-y-0.5">
                    {result.needs_qbo_merge.map((n: any, i: number) => (
                      <li key={i}><strong>{n.source}</strong> → {n.target}</li>
                    ))}
                  </ul>
                </div>
              )}
              {result.failed.map((f: any, i: number) => (
                <div key={i} className="text-[11px] text-red-700 mt-0.5">{f.step}: {f.error}</div>
              ))}
            </div>
          )}

          {plan && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3 text-xs">
                <Pill n={plan.conformance_pct} label="% conformant" tone={plan.conformance_pct >= 95 ? "emerald" : "rust"} suffix />
                <Pill n={plan.creates.length} label="to create" tone="gray" />
                <Pill n={plan.retypes.length} label="to retype" tone="gray" />
                <Pill n={plan.merges.length} label="to merge" tone="emerald" />
                <Pill n={plan.unmatched.length} label="need a human" tone="rust" />
              </div>

              {plan.merges.length > 0 && (
                <details className="group" open>
                  <summary className="cursor-pointer select-none text-xs font-semibold text-ink-slate hover:text-navy list-none">
                    ▸ {plan.merges.length} merges — untick any you don&apos;t want
                  </summary>
                  <ul className="mt-1.5 space-y-1">
                    {plan.merges.map((m: any) => (
                      <li key={m.sourceId} className="flex items-center gap-2 text-[12px]">
                        <input
                          type="checkbox"
                          checked={!skip.has(m.sourceId)}
                          onChange={(e) => setSkip((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.delete(m.sourceId); else n.add(m.sourceId);
                            return n;
                          })}
                          className="accent-[#3E908D]"
                        />
                        <span className="text-navy">{m.sourceName}</span>
                        <span className="text-ink-light">→</span>
                        <span className="font-semibold text-teal-dark">{m.targetName}</span>
                        <span className="text-[10px] text-ink-light">({m.sourceType})</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {plan.unmatched.length > 0 && (
                <details className="group">
                  <summary className="cursor-pointer select-none text-xs font-semibold text-[#954E44] hover:text-navy list-none">
                    ▸ {plan.unmatched.length} accounts with no confident target — left alone
                  </summary>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {plan.unmatched.map((u: any) => (
                      <span key={u.id} className="text-[10px] bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 text-ink-slate" title={u.reason}>
                        {u.name}
                      </span>
                    ))}
                  </div>
                </details>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={run}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#954E44] px-3.5 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-40"
                >
                  {busy === "execute" ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                  Run conformance
                </button>
                <button
                  onClick={loadPlan}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-50"
                >
                  <RefreshCw size={12} /> Re-check
                </button>
                <Link
                  href={`/clients/${client.client_link_id}`}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal hover:text-teal-dark ml-auto"
                >
                  Client <ExternalLink size={10} />
                </Link>
              </div>
              {plan.merges.length > 0 && (
                <p className="text-[11px] text-ink-light flex items-start gap-1">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                  Merges move the real transactions and post no journal entries. Any account whose
                  residue is income / deposits / paycheques stays active and is listed for a QBO-UI merge.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Pill({ n, label, tone, suffix }: { n: number; label: string; tone: "emerald" | "rust" | "gray"; suffix?: boolean }) {
  const cls =
    tone === "emerald" ? "bg-emerald-50 border-emerald-200 text-emerald-800"
      : tone === "rust" ? "bg-red-50 border-red-200 text-[#954E44]"
      : "bg-gray-50 border-gray-200 text-ink-slate";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold ${cls}`}>
      <span className="tabular-nums font-bold">{suffix ? Math.round(n) : n}</span> {label}
    </span>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-light">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${accent ? "text-[#954E44]" : "text-navy"}`}>{value}</div>
    </div>
  );
}
