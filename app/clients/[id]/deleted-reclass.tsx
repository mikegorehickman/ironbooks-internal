"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Loader2, Search } from "lucide-react";

/**
 * "Deleted account cleanup" tool on the client P&L.
 *
 * QBO appends " (deleted)" to a deactivated account's name; when a transaction
 * still posts to that old id it lingers on the P&L as "Painting Revenue
 * (deleted)". This lets the bookkeeper sweep them in one place: each deleted
 * account is pre-paired with its live twin (same base name), and one click
 * reclasses every transaction on it — expenses, deposits AND journal entries,
 * via /api/clients/[id]/bulk-reclass — onto the chosen live account.
 *
 * It replaces the old passive "N deleted accounts still have a balance" warning:
 * same detection, now actionable. The reclass window matches the P&L on screen;
 * flip to "all of {year}" to sweep the whole year off an account at once.
 */

type DeletedRow = { name: string; amount: number };
type DeletedAcct = {
  id: string;
  name: string;
  fullyQualifiedName: string;
  classification: string;
  accountType: string;
  matchName: string;
  suggested_target: { id: string; name: string } | null;
};
type QboAcct = {
  id: string;
  name: string;
  fullyQualifiedName: string;
  accountType: string;
  classification: string;
};
type RowResult = { moved: number; failed: number; skipped: number; error?: string; failMsgs: string[] };

const money = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const normName = (s: string) =>
  String(s ?? "").toLowerCase().replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim();

export function DeletedAccountReclass({
  clientLinkId,
  start,
  end,
  deleted,
}: {
  clientLinkId: string;
  start: string;
  end: string;
  deleted: DeletedRow[];
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<DeletedAcct[] | null>(null);
  const [qbo, setQbo] = useState<QboAcct[] | null>(null);
  const [target, setTarget] = useState<Record<string, { id: string; name: string } | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [scope, setScope] = useState<"range" | "year">("range");

  const year = (end || start || "").slice(0, 4);
  const winStart = scope === "year" ? `${year}-01-01` : start;
  const winEnd = scope === "year" ? `${year}-12-31` : end;

  async function load() {
    setLoading(true);
    setLoadErr(null);
    try {
      const [dRes, qRes] = await Promise.all([
        fetch(`/api/clients/${clientLinkId}/deleted-accounts`),
        fetch(`/api/clients/${clientLinkId}/qbo-accounts`),
      ]);
      if (!dRes.ok) throw new Error((await dRes.json()).error || "Failed to load deleted accounts");
      const d = await dRes.json();
      const q = qRes.ok ? await qRes.json() : { accounts: [] };
      setMeta(d.accounts || []);
      setQbo(q.accounts || []);
      const t: Record<string, { id: string; name: string } | null> = {};
      for (const a of (d.accounts || []) as DeletedAcct[]) t[a.id] = a.suggested_target;
      setTarget((prev) => ({ ...t, ...prev }));
    } catch (e: any) {
      setLoadErr(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  function handleToggle() {
    const next = !open;
    setOpen(next);
    if (next && !meta && !loading) load();
  }

  // Join the P&L rows the parent already found (name + balance) to the endpoint
  // metadata (authoritative id + twin). A row with no metadata match can't be
  // reclassed by id — surfaced as such rather than silently dropped.
  const rows = useMemo(() => {
    const byMatch = new Map((meta || []).map((m) => [m.matchName, m] as const));
    return deleted.map((r) => ({ name: r.name, amount: r.amount, meta: byMatch.get(normName(r.name)) || null }));
  }, [meta, deleted]);

  async function reclassOne(acctId: string, acctName: string, tgt: { id: string; name: string }): Promise<RowResult> {
    const txRes = await fetch(
      `/api/clients/${clientLinkId}/account-transactions?account_id=${encodeURIComponent(acctId)}&start=${winStart}&end=${winEnd}&kind=pl`
    );
    if (!txRes.ok) throw new Error((await txRes.json()).error || "Couldn't load this account's transactions");
    const txd = await txRes.json();
    let queue: Array<{ id: string; type: string }> = (txd.transactions || []).map((t: any) => ({ id: t.id, type: t.type }));
    const res: RowResult = { moved: 0, failed: 0, skipped: 0, failMsgs: [] };
    if (queue.length === 0) return res;
    for (let pass = 0; pass < 25; pass++) {
      const r = await fetch(`/api/clients/${clientLinkId}/bulk-reclass`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_account_id: acctId,
          source_account_name: acctName,
          target_account_id: tgt.id,
          transactions: queue,
          create_rules: false,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      res.moved += d.moved_txns || 0;
      res.failed += d.failed || 0;
      res.skipped +=
        (d.skipped_unsupported || 0) + (d.skipped_linked || 0) + (d.skipped_closed || 0) +
        (d.skipped_no_source_line || 0) + (d.skipped_stale || 0);
      for (const f of d.failures || []) if (f?.message) res.failMsgs.push(f.message);
      if (!d.remaining?.length) break;
      queue = d.remaining;
    }
    return res;
  }

  async function runOne(m: DeletedAcct) {
    const tgt = target[m.id];
    if (!tgt) {
      setResults((r) => ({ ...r, [m.id]: { moved: 0, failed: 0, skipped: 0, error: "pick a target account first", failMsgs: [] } }));
      return;
    }
    setBusy(m.id);
    try {
      const res = await reclassOne(m.id, m.name, tgt);
      setResults((r) => ({ ...r, [m.id]: res }));
    } catch (e: any) {
      setResults((r) => ({ ...r, [m.id]: { moved: 0, failed: 0, skipped: 0, error: e?.message || "failed", failMsgs: [] } }));
    } finally {
      setBusy(null);
    }
  }

  async function runAll() {
    setRunningAll(true);
    for (const row of rows) {
      const m = row.meta;
      if (!m) continue;
      const tgt = target[m.id];
      if (!tgt) continue;
      const prev = results[m.id];
      if (prev && !prev.error && prev.moved > 0 && prev.failed === 0) continue; // already cleared
      setBusy(m.id);
      try {
        const res = await reclassOne(m.id, m.name, tgt);
        setResults((r) => ({ ...r, [m.id]: res }));
      } catch (e: any) {
        setResults((r) => ({ ...r, [m.id]: { moved: 0, failed: 0, skipped: 0, error: e?.message || "failed", failMsgs: [] } }));
      }
    }
    setBusy(null);
    setRunningAll(false);
  }

  const targetable = rows.filter((r) => r.meta && target[r.meta.id]).length;
  const anyBusy = busy !== null || runningAll;

  if (deleted.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <button onClick={handleToggle} className="flex items-center gap-1.5 text-left">
            {open ? <ChevronDown size={14} className="text-amber-700" /> : <ChevronRight size={14} className="text-amber-700" />}
            <span className="text-sm font-bold text-amber-900">
              {deleted.length} deleted account{deleted.length === 1 ? "" : "s"} still {deleted.length === 1 ? "has" : "have"} a balance
            </span>
          </button>
          <p className="text-xs text-amber-800 mt-0.5 leading-relaxed">
            Deleted in QuickBooks but transactions still post to them — so they show as &quot;(deleted)&quot; on the P&amp;L.
            {open
              ? " Pick where each should go (the live account of the same name is pre-selected) and reclass — expenses, deposits and journal entries all move."
              : " Expand to reclass their transactions onto the live accounts."}
          </p>

          {open && (
            <div className="mt-3">
              {loading ? (
                <div className="text-xs text-amber-800 flex items-center gap-1.5 py-2">
                  <Loader2 size={13} className="animate-spin" /> Loading deleted accounts…
                </div>
              ) : loadErr ? (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">{loadErr}</div>
              ) : (
                <>
                  {/* Scope + Reclass all */}
                  <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                    <div className="inline-flex rounded-lg border border-amber-300 overflow-hidden text-[11px] font-semibold">
                      {([["range", "This period"], ["year", `All of ${year}`]] as const).map(([k, label]) => (
                        <button
                          key={k}
                          onClick={() => setScope(k)}
                          disabled={anyBusy}
                          className={`px-2.5 py-1 ${scope === k ? "bg-amber-500 text-white" : "bg-white/60 text-amber-800 hover:bg-white"}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={runAll}
                      disabled={anyBusy || targetable === 0}
                      className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded bg-teal text-white hover:bg-teal-dark disabled:opacity-50"
                    >
                      {runningAll ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                      Reclass all ({targetable})
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    {rows.map((row, i) => {
                      const m = row.meta;
                      const res = m ? results[m.id] : undefined;
                      const rowBusy = m ? busy === m.id : false;
                      return (
                        <div key={`${row.name}-${i}`} className="rounded-lg border border-amber-200 bg-white px-3 py-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="min-w-0 flex-1">
                              <span className="text-xs font-semibold text-navy truncate">{row.name}</span>
                              <span className="ml-2 font-mono text-xs text-amber-800">{money(row.amount)}</span>
                            </div>
                            {!m ? (
                              <span className="text-[11px] text-red-600">account id not found — reclass from the drill instead</span>
                            ) : (
                              <>
                                <div className="w-52">
                                  <AccountPicker
                                    accounts={qbo || []}
                                    value={target[m.id]}
                                    disabled={anyBusy}
                                    onChange={(v) => setTarget((t) => ({ ...t, [m.id]: v }))}
                                  />
                                </div>
                                <button
                                  onClick={() => runOne(m)}
                                  disabled={anyBusy || !target[m.id]}
                                  className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded bg-teal text-white hover:bg-teal-dark disabled:opacity-50"
                                >
                                  {rowBusy ? <Loader2 size={11} className="animate-spin" /> : "Reclass"}
                                </button>
                              </>
                            )}
                          </div>
                          {res && (
                            <div className="mt-1.5 text-[11px]">
                              {res.error ? (
                                <span className="text-red-700">{res.error}</span>
                              ) : res.moved > 0 ? (
                                <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                                  <CheckCircle2 size={12} /> Moved {res.moved} to {target[m!.id]?.name}
                                  {res.failed > 0 && <span className="text-red-700 font-normal"> · {res.failed} failed</span>}
                                  {res.skipped > 0 && <span className="text-ink-slate font-normal"> · {res.skipped} skipped</span>}
                                </span>
                              ) : (
                                <span className="text-ink-slate">
                                  Nothing moved{res.failed > 0 ? ` · ${res.failed} failed` : ""}{res.skipped > 0 ? ` · ${res.skipped} skipped` : ""}
                                  {res.failed === 0 && res.skipped === 0 ? " — no transactions in this window" : ""}
                                </span>
                              )}
                              {res.failMsgs.length > 0 && (
                                <div className="mt-1 text-red-800 bg-red-50 border border-red-200 rounded px-2 py-1">
                                  {Array.from(new Set(res.failMsgs))[0]}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-amber-700 mt-2">
                    Moves this {scope === "year" ? "year's" : "period's"} transactions. Reload the page to see the updated P&amp;L.
                    Also fix the recurring/memorized transaction in QBO that&apos;s still feeding the deleted account.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Compact searchable single-select account picker. */
function AccountPicker({
  accounts,
  value,
  onChange,
  disabled,
}: {
  accounts: QboAcct[];
  value: { id: string; name: string } | null | undefined;
  onChange: (v: { id: string; name: string }) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const filtered = accounts
    .filter((a) => {
      if (!q) return true;
      const hay = `${a.fullyQualifiedName} ${a.accountType} ${a.classification}`.toLowerCase();
      return q.toLowerCase().split(" ").filter(Boolean).every((t) => hay.includes(t));
    })
    .slice(0, 60);
  return (
    <div className="relative">
      <div className="relative">
        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-light pointer-events-none" />
        <input
          type="text"
          value={open ? q : value?.name || ""}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Pick target account…"
          disabled={disabled}
          className="w-full text-[11px] border border-gray-300 rounded pl-6 pr-2 py-1 focus:outline-none focus:ring-1 focus:ring-teal disabled:bg-gray-50"
        />
      </div>
      {open && (
        <div className="absolute z-30 left-0 right-0 mt-0.5 max-h-52 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-2.5 py-1.5 text-[11px] text-ink-slate">No matching accounts</div>
          ) : (
            filtered.map((a) => (
              <button
                key={a.id}
                onMouseDown={(e) => { e.preventDefault(); onChange({ id: a.id, name: a.fullyQualifiedName }); setOpen(false); setQ(""); }}
                className="w-full text-left px-2.5 py-1 text-[11px] hover:bg-teal-lighter/40 truncate"
              >
                {a.fullyQualifiedName}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
