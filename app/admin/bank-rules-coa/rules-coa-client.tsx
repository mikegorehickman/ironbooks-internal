"use client";

import { useEffect, useState } from "react";
import { Loader2, ChevronRight, CheckCircle2, AlertTriangle, RefreshCw, Wand2 } from "lucide-react";

/**
 * Fleet list → per-client plan → retarget. Broken targets get a dropdown of
 * the client's own jurisdiction master COA, pre-selected with the best
 * suggestion (known rename > name similarity). Nothing is written until
 * "Apply N retargets" — and the server re-validates every target against that
 * jurisdiction's master COA, so a US name can't land on a CA book.
 */

interface FleetRow {
  client_link_id: string;
  client_name: string;
  jurisdiction: string;
  total: number;
  on_master: number;
  off_master: number;
}

export function RulesCoaClient() {
  const [clients, setClients] = useState<FleetRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/bank-rules-coa")
      .then((r) => r.json())
      .then((j) => (j.error ? setError(j.error) : setClients(j.clients || [])))
      .catch((e) => setError(e?.message || "Failed to load"));
  }, []);

  if (error) return <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>;
  if (!clients)
    return (
      <div className="flex items-center gap-2 text-sm text-ink-slate py-8 justify-center">
        <Loader2 size={16} className="animate-spin text-teal" /> Loading rules…
      </div>
    );

  const needsWork = clients.filter((c) => c.off_master > 0);
  const totalOff = clients.reduce((s, c) => s + c.off_master, 0);
  const totalRules = clients.reduce((s, c) => s + c.total, 0);

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <Stat label="Clients with rules" value={String(clients.length)} />
        <Stat label="Rules total" value={String(totalRules)} />
        <Stat label="Off-master targets" value={String(totalOff)} accent={totalOff > 0} />
        <Stat label="Clients needing work" value={String(needsWork.length)} accent={needsWork.length > 0} />
      </div>
      <p className="text-[11px] text-ink-light mb-3">
        &ldquo;Off-master&rdquo; here is a ceiling — it counts anything not in the master chart, which
        includes legitimate bank/credit-card targets used by transfer rules. Open a client to
        separate those from genuinely broken ones against their live QuickBooks.
      </p>
      <div className="space-y-2">
        {clients.map((c) => (
          <ClientCard key={c.client_link_id} client={c} />
        ))}
      </div>
    </div>
  );
}

function ClientCard({ client }: { client: FleetRow }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);

  async function call(action: string, extra: any = {}) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/admin/bank-rules-coa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: client.client_link_id, action, ...extra }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
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
    if (j) {
      setPlan(j);
      // Pre-select the top suggestion for each broken rule.
      const pre: Record<string, string> = {};
      for (const r of j.rows as any[]) {
        if (r.status === "broken" && r.suggestions?.[0]) pre[r.rule_id] = r.suggestions[0].name;
      }
      setChoices(pre);
    }
  }

  async function applyRetargets() {
    const mappings = Object.entries(choices)
      .filter(([, target]) => !!target)
      .map(([rule_id, target]) => ({ rule_id, target }));
    if (mappings.length === 0) return;
    if (!confirm(`Retarget ${mappings.length} rule${mappings.length === 1 ? "" : "s"} for ${client.client_name}?\n\nUpdates the stored category names in SNAP. Re-export their rules to push the fix into QBO.`)) return;
    const j = await call("retarget", { mappings });
    if (j) {
      setResult(j);
      await loadPlan();
    }
  }

  const broken = (plan?.rows || []).filter((r: any) => r.status === "broken");
  const liveOnly = (plan?.rows || []).filter((r: any) => r.status === "live_only");
  const chosenCount = Object.values(choices).filter(Boolean).length;

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
        <span className="text-xs text-ink-slate tabular-nums">{client.total} rules</span>
        {client.off_master > 0 ? (
          <span className="text-xs font-bold text-[#954E44] tabular-nums">{client.off_master} off-master</span>
        ) : (
          <span className="text-xs font-semibold text-emerald-700 inline-flex items-center gap-1">
            <CheckCircle2 size={12} /> all on master
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3">
          {busy === "plan" && (
            <div className="flex items-center gap-2 text-sm text-ink-slate py-3">
              <Loader2 size={14} className="animate-spin text-teal" /> Checking against the {client.jurisdiction} master COA and their live chart…
            </div>
          )}
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 mb-2">{error}</div>}
          {result && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 mb-2">
              Retargeted {result.updated} rule{result.updated === 1 ? "" : "s"}.
              {result.failed?.length > 0 && ` ${result.failed.length} failed.`}{" "}
              <strong>Re-export their rules</strong> to carry the fix into QBO.
            </div>
          )}

          {plan && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3 text-xs">
                <Pill label="on master" n={plan.summary.on_master} tone="emerald" />
                <Pill label="live-only (transfers etc.)" n={plan.summary.live_only} tone="gray" />
                <Pill label="broken — exports blank" n={plan.summary.broken} tone="rust" />
                {!plan.live_checked && (
                  <span className="text-[11px] text-amber-800">
                    live chart unavailable{plan.live_error ? ` (${plan.live_error})` : ""} — off-master shown as broken
                  </span>
                )}
              </div>

              {broken.length > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50/60 px-3 py-2.5">
                  <div className="text-xs font-bold text-[#954E44] flex items-center gap-1.5 mb-2">
                    <AlertTriangle size={12} /> {broken.length} rule{broken.length === 1 ? "" : "s"} name an account that exists nowhere — these export blank
                  </div>
                  <ul className="space-y-1.5">
                    {broken.map((r: any) => (
                      <li key={r.rule_id} className="rounded-lg border border-red-200 bg-white px-2.5 py-2">
                        <div className="text-[12px] text-navy">
                          <span className="font-semibold">{r.vendor_pattern}</span>
                          <span className="text-ink-slate"> → currently &ldquo;{r.target_account_name}&rdquo;</span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                          <span className="text-[11px] text-ink-slate shrink-0">Retarget to</span>
                          <select
                            value={choices[r.rule_id] || ""}
                            onChange={(e) => setChoices((c) => ({ ...c, [r.rule_id]: e.target.value }))}
                            className="text-[11px] px-1.5 py-1 rounded border border-gray-200 bg-white text-navy flex-1 min-w-[200px] max-w-[320px]"
                          >
                            <option value="">— leave as-is —</option>
                            {r.suggestions.length > 0 && (
                              <optgroup label="Suggested">
                                {r.suggestions.map((s: any) => (
                                  <option key={`s-${s.name}`} value={s.name}>
                                    {s.name} ({s.reason})
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            <optgroup label={`All ${plan.jurisdiction} master accounts`}>
                              {(plan.master_names || []).map((m: string) => (
                                <option key={m} value={m}>{m}</option>
                              ))}
                            </optgroup>
                          </select>
                          {r.suggestions?.[0]?.reason === "known rename" && (
                            <span className="text-[10px] font-bold text-teal-dark bg-teal-light border border-teal-border rounded-full px-1.5 py-0.5 inline-flex items-center gap-1">
                              <Wand2 size={9} /> known rename
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2.5 flex items-center gap-2">
                    <button
                      onClick={applyRetargets}
                      disabled={!!busy || chosenCount === 0}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-teal px-3.5 py-2 text-sm font-bold text-white hover:bg-teal-dark disabled:opacity-40"
                    >
                      {busy === "retarget" ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                      Apply {chosenCount} retarget{chosenCount === 1 ? "" : "s"}
                    </button>
                    <button
                      onClick={loadPlan}
                      disabled={!!busy}
                      className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-50"
                    >
                      <RefreshCw size={12} /> Re-check
                    </button>
                  </div>
                </div>
              )}

              {liveOnly.length > 0 && (
                <details className="group">
                  <summary className="cursor-pointer select-none text-xs font-semibold text-ink-slate hover:text-navy list-none">
                    ▸ {liveOnly.length} target{liveOnly.length === 1 ? "" : "s"} not on the master chart but live in QBO (usually transfer rules — left alone)
                  </summary>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {liveOnly.map((r: any) => (
                      <span key={r.rule_id} className="text-[10px] bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 text-ink-slate">
                        {r.vendor_pattern} → {r.target_account_name}
                      </span>
                    ))}
                  </div>
                </details>
              )}

              {broken.length === 0 && (
                <div className="text-xs text-emerald-800 inline-flex items-center gap-1.5">
                  <CheckCircle2 size={13} /> Every rule target resolves — this client&apos;s export will fill in cleanly.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Pill({ label, n, tone }: { label: string; n: number; tone: "emerald" | "rust" | "gray" }) {
  const cls =
    tone === "emerald" ? "bg-emerald-50 border-emerald-200 text-emerald-800"
      : tone === "rust" ? "bg-red-50 border-red-200 text-[#954E44]"
      : "bg-gray-50 border-gray-200 text-ink-slate";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold ${cls}`}>
      <span className="tabular-nums font-bold">{n}</span> {label}
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
