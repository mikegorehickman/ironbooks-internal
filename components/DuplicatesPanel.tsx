"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Copy, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";

/**
 * Duplicates queue — shared by the reclass Duplicates stage (cleanup phase,
 * scoped to one client with a Scan button) and the /today production queue
 * (scoped to the bookkeeper's clients). Rows come from dup_findings.
 *
 * Tier meanings mirror lib/dup-sweep.ts: "certain" is the provable bank-fed
 * + manual twin (shows exactly which copy the engine would remove and why);
 * "likely" needs the human to pick which copy goes; "possible" is
 * informational. Removing = snapshot → void/delete in QBO, guards re-checked
 * live at click time.
 */

export interface DupRow {
  id: string;
  client_link_id: string;
  client_name?: string;
  kind: string;
  tier: "certain" | "likely" | "possible";
  account: string | null;
  name: string | null;
  amount: number | null;
  dates: string[];
  txn_types: string[];
  txn_ids: string[];
  doc_numbers: (string | null)[];
  note: string | null;
  remove_candidate: { txn_id: string; txn_type: string; reason: string } | null;
}

const money = (n: number | null) =>
  n == null ? "" : `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TIER_BADGE: Record<DupRow["tier"], { label: string; cls: string }> = {
  certain: { label: "PROVABLE", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  likely: { label: "LIKELY", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  possible: { label: "POSSIBLE", cls: "bg-gray-100 text-ink-slate border-gray-200" },
};

export function DuplicatesPanel({
  clientLinkId,
  clientIds,
  showScan = false,
  title = "Duplicates",
}: {
  /** Scope to one client (reclass stage) — enables the Scan button. */
  clientLinkId?: string;
  /** Scope to a set of clients (/today) — client-side filter. */
  clientIds?: string[] | null;
  showScan?: boolean;
  title?: string;
}) {
  const [rows, setRows] = useState<DupRow[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState("");

  async function load() {
    try {
      const url = clientLinkId
        ? `/api/dup-findings?client_link_id=${clientLinkId}`
        : "/api/dup-findings";
      const res = await fetch(url);
      const j = await res.json();
      if (res.ok) {
        let list: DupRow[] = j.findings || [];
        if (clientIds) list = list.filter((r) => clientIds.includes(r.client_link_id));
        setRows(list);
      } else setRows([]);
    } catch {
      setRows([]);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientLinkId]);

  async function scanNow() {
    if (!clientLinkId) return;
    setScanning(true);
    setScanMsg("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/dup-scan`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setScanMsg(
        j.found === 0
          ? "No duplicates found in the last 90 days. ✓"
          : `Found ${j.found} duplicate group${j.found === 1 ? "" : "s"} (${j.certain} provable · ${j.likely} likely).`
      );
      await load();
    } catch (e: any) {
      setScanMsg(`Scan failed: ${e?.message || "unknown"}`);
    } finally {
      setScanning(false);
    }
  }

  if (rows !== null && rows.length === 0 && !showScan) return null;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2 flex-wrap">
        <Copy size={15} className="text-teal" />
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">
          {title}
          {rows !== null && rows.length > 0 ? ` (${rows.length})` : ""}
        </h2>
        <span className="text-[11px] text-ink-light">same money entered twice — remove a copy or keep both</span>
        <div className="flex-1" />
        {showScan && (
          <button
            onClick={scanNow}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal border border-teal/30 hover:bg-teal/5 rounded-lg px-2.5 py-1.5 disabled:opacity-50"
          >
            {scanning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {scanning ? "Scanning…" : "Scan last 90 days"}
          </button>
        )}
      </div>
      {scanMsg && <div className="px-5 py-2 text-xs text-navy bg-teal-lighter border-b border-teal/20">{scanMsg}</div>}
      {rows === null ? (
        <div className="px-5 py-4 text-xs text-ink-slate flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" /> loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-4 text-xs text-ink-light">No open duplicate findings.</div>
      ) : (
        <div className="divide-y divide-gray-50">
          {rows.map((r) => (
            <FindingRow key={r.id} row={r} onDone={(id) => setRows((p) => (p || []).filter((x) => x.id !== id))} />
          ))}
        </div>
      )}
    </div>
  );
}

function FindingRow({ row, onDone }: { row: DupRow; onDone: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const badge = TIER_BADGE[row.tier];

  async function act(body: any, key: string, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(key);
    setError("");
    try {
      const res = await fetch(`/api/dup-findings/${row.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onDone(row.id);
    } catch (e: any) {
      setError(e?.message || "Failed");
    } finally {
      setBusy(null);
    }
  }

  const what = `${row.name || "same payee"} · ${money(row.amount)} in ${row.account || "?"}`;

  return (
    <div className="px-5 py-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
            {row.client_name && <span className="text-xs font-bold text-navy">{row.client_name}</span>}
            <span className="text-sm text-navy">
              <span className="font-semibold">{row.name || "Same payee"}</span> · {money(row.amount)} ×{row.txn_ids.length}
            </span>
          </div>
          <div className="text-xs text-ink-slate mt-0.5">
            {row.account} · {row.dates.join(", ")} · {row.txn_types.join("/")}
            {row.doc_numbers.filter(Boolean).length > 0 && <> · doc {row.doc_numbers.filter(Boolean).join(", ")}</>}
          </div>
          <div className="text-[11px] text-ink-light mt-0.5">{row.note}</div>
          {row.tier === "certain" && row.remove_candidate && (
            <div className="text-[11px] text-emerald-800 mt-0.5 flex items-center gap-1">
              <ShieldCheck size={11} /> {row.remove_candidate.reason}
            </div>
          )}
          {error && <div className="text-xs text-red-700 mt-1">{error}</div>}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
          {row.tier === "certain" && row.remove_candidate ? (
            <button
              onClick={() =>
                act(
                  { action: "remove", txn_id: row.remove_candidate!.txn_id },
                  "certain",
                  `Remove the hand-entered copy of ${what}?\n\nThe bank-fed copy stays. Snapshot is kept for restore.`
                )
              }
              disabled={!!busy}
              className="inline-flex items-center gap-1.5 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-3 py-2 disabled:opacity-50"
            >
              {busy === "certain" ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              Remove hand-entered copy
            </button>
          ) : (
            row.txn_ids.map((tid, i) => (
              <button
                key={tid}
                onClick={() =>
                  act(
                    { action: "remove", txn_id: tid },
                    tid,
                    `Remove copy ${i + 1} of ${what}?\n\nQBO id ${tid}. Reconciled/linked/closed-period copies are refused automatically. Snapshot kept for restore.`
                  )
                }
                disabled={!!busy}
                className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 border border-red-200 hover:bg-red-50 rounded-lg px-2.5 py-2 disabled:opacity-50"
              >
                {busy === tid ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
                Remove copy {i + 1}
              </button>
            ))
          )}
          <button
            onClick={() => act({ action: "keep" }, "keep")}
            disabled={!!busy}
            title="Not a duplicate — both are real; never show this pair again"
            className="inline-flex items-center gap-1 text-xs font-semibold text-ink-slate border border-gray-200 hover:border-gray-300 rounded-lg px-2.5 py-2 disabled:opacity-50"
          >
            {busy === "keep" ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
            Keep both
          </button>
        </div>
      </div>
    </div>
  );
}
