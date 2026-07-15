"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2, Search, ArrowRight, CheckCircle2, AlertTriangle, Banknote, CalendarRange,
} from "lucide-react";
import { CrmPairsTable } from "@/components/crm-pairs-table";

const fmt = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n || 0)).toLocaleString();
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function RevenueCheckClient({
  clientLinkId,
  clientName,
  initialMode,
  isSenior,
  jobRange,
  nextHref,
}: {
  clientLinkId: string;
  clientName: string;
  initialMode: "standard" | "deposits_only";
  isSenior: boolean;
  jobRange: { start: string; end: string } | null;
  nextHref: string;
}) {
  const now = new Date();
  const thisYear = now.getFullYear();
  // Range presets — job range first (the cleanup window), then progressively
  // deeper history for historical cleanups hunting old duplicate invoices.
  const presets: { key: string; label: string; start: string; end: string }[] = [
    ...(jobRange ? [{ key: "job", label: "Cleanup range", start: jobRange.start, end: jobRange.end }] : []),
    { key: "ytd", label: "This year", start: `${thisYear}-01-01`, end: ymd(now) },
    { key: "1y", label: "Last 12 months", start: ymd(new Date(Date.UTC(thisYear - 1, now.getUTCMonth(), 1))), end: ymd(now) },
    { key: "2y", label: `Since Jan ${thisYear - 1}`, start: `${thisYear - 1}-01-01`, end: ymd(now) },
    { key: "all", label: `All history (since ${thisYear - 5})`, start: `${thisYear - 5}-01-01`, end: ymd(now) },
  ];
  const [preset, setPreset] = useState(presets[0].key);
  const [customStart, setCustomStart] = useState(presets[0].start);
  const [customEnd, setCustomEnd] = useState(presets[0].end);
  const isCustom = preset === "custom";
  const range = isCustom
    ? { start: customStart, end: customEnd }
    : presets.find((p) => p.key === preset) || presets[0];

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [mode, setMode] = useState(initialMode);
  const [modeBusy, setModeBusy] = useState(false);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/crm-invoice-pairs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId, start: range.start, end: range.end }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e: any) {
      setError(e?.message || "Check failed");
    } finally {
      setRunning(false);
    }
  }

  // Auto-run on first load with the default range — the step should show its
  // verdict without an extra click.
  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setDepositsOnly(next: "standard" | "deposits_only") {
    const label = next === "deposits_only" ? "CASH-DEPOSITS-ONLY" : "STANDARD";
    if (
      !confirm(
        `Set ${clientName} to ${label} revenue recognition?\n\n` +
          (next === "deposits_only"
            ? "Statements will recognize actual cash deposits only — CRM invoice income is excluded. Reversible."
            : "Statements go back to standard QBO cash-basis income (invoices count again).")
      )
    )
      return;
    setModeBusy(true);
    try {
      const res = await fetch("/api/admin/revenue-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId, mode: next }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setMode(next);
    } catch (e: any) {
      alert(`Mode change failed: ${e?.message || "unknown"}`);
    } finally {
      setModeBusy(false);
    }
  }

  const s = data?.summary;
  const verdictClean = s && !s.flagged;

  return (
    <div className="space-y-4">
      {/* Range picker — the historical-cleanup lever. */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4">
        <div className="flex items-center gap-2 mb-2 text-xs font-bold text-navy uppercase tracking-wide">
          <CalendarRange size={14} className="text-teal" /> Date range
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {presets.map((p) => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                preset === p.key
                  ? "bg-teal text-white border-teal"
                  : "bg-white text-ink-slate border-gray-200 hover:border-teal/50"
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setPreset("custom")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${
              isCustom ? "bg-teal text-white border-teal" : "bg-white text-ink-slate border-gray-200 hover:border-teal/50"
            }`}
          >
            Custom
          </button>
          {isCustom && (
            <span className="inline-flex items-center gap-1.5">
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)}
                className="text-xs border border-gray-300 rounded-lg px-2 py-1.5" />
              <span className="text-xs text-ink-slate">→</span>
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)}
                className="text-xs border border-gray-300 rounded-lg px-2 py-1.5" />
            </span>
          )}
          <button
            onClick={run}
            disabled={running}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-teal text-white px-3.5 py-2 text-xs font-bold hover:bg-teal-dark disabled:opacity-50"
          >
            {running ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
            {running ? "Checking…" : `Check ${range.start} → ${range.end}`}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      {/* Verdict */}
      {s && (
        <div
          className={`rounded-2xl border-2 p-4 ${
            s.flagged ? "border-amber-300 bg-amber-50" : "border-emerald-200 bg-emerald-50"
          }`}
        >
          <div className="flex items-start gap-2.5">
            {s.flagged ? (
              <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
            ) : (
              <CheckCircle2 size={18} className="text-emerald-600 shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0">
              <div className={`font-bold text-sm ${s.flagged ? "text-amber-900" : "text-emerald-900"}`}>
                {s.flagged ? "Likely duplicate invoice revenue" : "No double-count evidence in this range"}
              </div>
              <p className={`text-xs mt-0.5 ${s.flagged ? "text-amber-800" : "text-emerald-800"}`}>{s.reason}</p>
              <div className="flex flex-wrap gap-4 mt-2 text-xs">
                <span>Invoice income: <strong className="font-mono">{fmt(s.invoice_income_total)}</strong> ({s.invoice_txn_count} invoices)</span>
                <span>Deposits in income: <strong className="font-mono">{fmt(s.deposit_income_total)}</strong> ({s.deposit_count})</span>
                <span className="text-ink-light">Proven pairs (evidence): {s.pair_count} · {fmt(s.paired_deposit_total)}</span>
              </div>
              {s.flagged && (
                <div className="mt-2 text-xs bg-white/60 border border-amber-200 rounded-lg px-2.5 py-1.5 text-amber-900">
                  <strong>Scope of the fix:</strong> cash-deposits-only excludes <strong>every</strong> invoice —
                  all {fmt(s.invoice_income_total)} of CRM invoice income ({s.invoice_txn_count} invoices), not just
                  the {s.pair_count} pairs below. The pairs are proof of the duplication; the deposits stay as the real revenue.
                </div>
              )}
            </div>
          </div>

          {/* Mode control — the fix for the statements side. */}
          <div className="mt-3 pt-3 border-t border-black/5 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs">
              Revenue mode:{" "}
              <span className={`font-bold uppercase ${mode === "deposits_only" ? "text-teal-dark" : "text-ink-slate"}`}>
                {mode === "deposits_only" ? "cash deposits only" : "standard"}
              </span>
              {mode === "deposits_only" && (
                <span className="text-ink-slate"> — <strong>all</strong> {fmt(s.invoice_income_total)} of CRM invoice income is excluded from statements (every invoice).</span>
              )}
            </div>
            {isSenior ? (
              <button
                onClick={() => setDepositsOnly(mode === "deposits_only" ? "standard" : "deposits_only")}
                disabled={modeBusy}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold border disabled:opacity-50 ${
                  mode === "deposits_only"
                    ? "border-gray-300 text-ink-slate bg-white hover:bg-gray-50"
                    : "border-teal/40 bg-teal text-white hover:bg-teal-dark"
                }`}
              >
                {modeBusy ? <Loader2 size={12} className="animate-spin" /> : <Banknote size={12} />}
                {mode === "deposits_only" ? "Revert to standard" : "Set cash-deposits-only"}
              </button>
            ) : (
              s.flagged &&
              mode !== "deposits_only" && (
                <span className="text-[11px] text-amber-800">
                  Flag this to Mike or Lisa — setting deposits-only revenue is a senior action (Admin → CRM invoice revenue).
                </span>
              )
            )}
          </div>
        </div>
      )}

      {/* Pair evidence */}
      {data && <CrmPairsTable data={data} />}

      {/* Step navigation */}
      <div className="flex items-center justify-between pt-2">
        <p className="text-xs text-ink-slate max-w-lg">
          {verdictClean
            ? "Nothing to fix here — continue to Bank Rules."
            : s?.flagged
            ? "Review the pairs above before continuing. QBO-side remediation (matching deposits to their invoices) is coming as a guarded step; setting cash-deposits-only fixes the statements today."
            : ""}
        </p>
        <Link
          href={nextHref}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg shadow-md shrink-0"
        >
          Continue to Bank Rules <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  );
}
