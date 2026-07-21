"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Upload, FileText, Loader2, CheckCircle2, AlertCircle, AlertTriangle,
  Sparkles, ArrowRight, RefreshCw, FileSearch, Wallet, ScrollText,
  Info, Clipboard, ClipboardCheck, Zap, Calendar,
} from "lucide-react";
import type { UfAiResult } from "@/lib/uf-ai-prompt";

type Phase = "upload" | "analyzing" | "results" | "error";
type SourceMode = "qbo" | "csv";

/**
 * Drop-zone for a single CSV. We accept .csv via the file picker; raw
 * paste is supported via a textarea so bookkeepers can paste the QBO
 * export directly from Excel/Numbers without saving a file first.
 */
function CsvDropZone({
  label,
  description,
  value,
  onChange,
  expectedColumns,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (text: string) => void;
  expectedColumns: string[];
}) {
  const [hover, setHover] = useState(false);

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result || ""));
    reader.readAsText(file);
  }

  // Row count = lines that look like data (have at least 2 commas).
  // Header preview = first non-blank line. Both auto-update as the
  // bookkeeper pastes — instant feedback that "yes, the right file
  // is loaded."
  const stats = useMemo(() => {
    if (!value.trim()) return null;
    const lines = value.split(/\r?\n/).filter((l) => l.trim());
    const dataLines = lines.filter((l) => (l.match(/,/g) || []).length >= 2);
    return {
      totalLines: lines.length,
      dataLines: Math.max(0, dataLines.length - 1), // minus header
      sizeKb: (new Blob([value]).size / 1024).toFixed(1),
      header: lines[0] || "(no header detected)",
    };
  }, [value]);

  return (
    <div className="space-y-2">
      <div>
        <div className="font-bold text-navy text-sm">{label}</div>
        <div className="text-xs text-ink-light mt-0.5">{description}</div>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setHover(true); }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHover(false);
          const file = e.dataTransfer.files[0];
          if (file) handleFile(file);
        }}
        className={`rounded-xl border-2 border-dashed transition-colors ${
          hover
            ? "border-teal bg-teal/5"
            : value
            ? "border-emerald-200 bg-emerald-50/30"
            : "border-gray-200 hover:border-gray-300"
        }`}
      >
        <label className="cursor-pointer block px-5 py-4">
          <div className="flex items-center gap-3">
            {value ? (
              <CheckCircle2 size={20} className="text-emerald-600 flex-shrink-0" />
            ) : (
              <Upload size={20} className="text-ink-light flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              {value ? (
                <>
                  <div className="text-sm font-semibold text-emerald-800">
                    Loaded · {stats?.dataLines ?? 0} rows · {stats?.sizeKb}kb
                  </div>
                  <div className="text-[11px] text-ink-light truncate font-mono mt-0.5">
                    {stats?.header}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-sm font-semibold text-navy">
                    Drop .csv here, click to browse, or paste below
                  </div>
                  <div className="text-[11px] text-ink-light mt-0.5">
                    Expected columns: {expectedColumns.join(", ")}
                  </div>
                </>
              )}
            </div>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
          </div>
        </label>
      </div>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="…or paste CSV text here"
        rows={4}
        className="w-full text-[11px] font-mono border border-gray-200 rounded-lg p-2 focus:border-teal focus:ring-1 focus:ring-teal/30 outline-none"
      />

      {value && (
        <button
          onClick={() => onChange("")}
          className="text-[11px] text-ink-light hover:text-red-600"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/** Reusable tile for the dashboard hero summary */
function StatTile({
  label,
  value,
  hint,
  intent = "default",
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  intent?: "default" | "good" | "warn" | "bad";
  icon?: any;
}) {
  const intentClasses = {
    default: "border-gray-100 bg-white",
    good: "border-emerald-200 bg-emerald-50/40",
    warn: "border-amber-200 bg-amber-50/40",
    bad: "border-red-200 bg-red-50/40",
  }[intent];
  return (
    <div className={`rounded-2xl border-2 p-4 ${intentClasses}`}>
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
        {Icon && <Icon size={12} />} {label}
      </div>
      <div className="text-2xl font-black text-navy">{value}</div>
      {hint && <div className="text-xs text-ink-light mt-1">{hint}</div>}
    </div>
  );
}

function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}
function formatMoneyCompact(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

export function UfAiClient({
  clientLinkId,
  clientName,
  hasQbo,
}: {
  clientLinkId: string;
  clientName: string;
  hasQbo: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("upload");
  // Default to QBO live-pull when a connection exists — it's the
  // path that requires zero bookkeeper prep work. CSV is the fallback
  // for clients with dead tokens or one-off audits.
  const [source, setSource] = useState<SourceMode>(hasQbo ? "qbo" : "csv");
  const [arCsv, setArCsv] = useState("");
  const [ufCsv, setUfCsv] = useState("");
  // QBO mode date range — default trailing 12 months
  const today = new Date().toISOString().slice(0, 10);
  const oneYearAgo = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const [startDate, setStartDate] = useState(oneYearAgo);
  const [endDate, setEndDate] = useState(today);

  const [result, setResult] = useState<UfAiResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [resultMeta, setResultMeta] = useState<any>(null);
  const [copiedInstructions, setCopiedInstructions] = useState(false);

  const canAnalyzeCsv = arCsv.length > 50 && ufCsv.length > 50;
  const canAnalyze = source === "qbo" ? !!hasQbo : canAnalyzeCsv;

  const analyze = useCallback(async () => {
    setPhase("analyzing");
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/uf-ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          source === "qbo"
            ? {
                client_link_id: clientLinkId,
                source: "qbo",
                start_date: startDate,
                end_date: endDate,
              }
            : {
                client_link_id: clientLinkId,
                source: "csv",
                ar_csv_text: arCsv,
                uf_csv_text: ufCsv,
              }
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        // If QBO token is dead, surface a CTA to switch to CSV mode
        if (data.code === "qbo_token_dead") {
          setError(data.error || "QBO connection failed. Switch to CSV mode below.");
          setSource("csv");
          setPhase("upload");
          return;
        }
        setError(data.error || "Analysis failed.");
        setPhase("error");
        return;
      }
      setResult(data.result);
      setDuration(data.meta?.duration_ms ?? null);
      setResultMeta(data.meta || null);
      setPhase("results");
    } catch (e: any) {
      setError(e?.message || "Network error.");
      setPhase("error");
    }
  }, [clientLinkId, arCsv, ufCsv, source, startDate, endDate]);

  function resetAll() {
    setPhase("upload");
    setResult(null);
    setError(null);
    setDuration(null);
    setResultMeta(null);
  }

  function copyInstructions() {
    if (!result?.qbo_instructions) return;
    const text = result.qbo_instructions
      .map((step, i) => `${i + 1}. ${step}`)
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopiedInstructions(true);
    setTimeout(() => setCopiedInstructions(false), 2000);
  }

  // ────────────── UPLOAD PHASE ──────────────
  if (phase === "upload") {
    return (
      <div className="space-y-6">
        <details className="rounded-2xl border border-teal/20 bg-gradient-to-br from-teal/5 to-white p-4">
          <summary className="flex items-center gap-2 cursor-pointer font-bold text-navy text-sm">
            <Sparkles size={16} className="text-teal" />
            What is UF Reconcile?
          </summary>
          <p className="text-sm text-ink-slate mt-2 leading-relaxed">
            Claude reads the Accounts Receivable + Undeposited Funds transaction
            reports, matches payments to deposits, finds what&apos;s still stuck in
            UF, verifies the math, and writes step-by-step QuickBooks instructions
            to clear it.
          </p>
        </details>

        {/* Error from a failed prior attempt — surfaced here so it sits
            right above the source toggle when we auto-switched to CSV */}
        {error && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900 flex items-center gap-2">
            <AlertTriangle size={14} /> {error}
            <button onClick={() => setError(null)} className="ml-auto text-xs underline">dismiss</button>
          </div>
        )}

        {/* Source toggle — QBO live-pull is the default when there's a
            connection, with CSV as the fallback for dead-token clients
            or one-off audits */}
        <div className="bg-white rounded-2xl border border-gray-100 p-1.5 flex">
          <button
            onClick={() => setSource("qbo")}
            disabled={!hasQbo}
            title={!hasQbo ? "This client has no QuickBooks connection" : undefined}
            className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2 ${
              source === "qbo"
                ? "bg-teal text-white"
                : "text-ink-slate hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            }`}
          >
            <Zap size={14} />
            Pull live from QuickBooks
            {hasQbo && source === "qbo" && (
              <span className="text-[9px] uppercase font-bold tracking-wider bg-white/20 px-1.5 py-0.5 rounded">
                Fastest
              </span>
            )}
          </button>
          <button
            onClick={() => setSource("csv")}
            className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2 ${
              source === "csv"
                ? "bg-navy text-white"
                : "text-ink-slate hover:bg-gray-50"
            }`}
          >
            <Upload size={14} />
            Upload CSV exports
          </button>
        </div>

        {/* QBO live-pull config */}
        {source === "qbo" && (
          <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
            <div>
              <h3 className="font-bold text-navy text-sm">QuickBooks pull settings</h3>
              <p className="text-xs text-ink-light mt-1">
                We&apos;ll pull the Accounts Receivable and Undeposited Funds transaction
                lists straight from {clientName}&apos;s QuickBooks for the date range below.
                No exports needed.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] font-bold uppercase tracking-wider text-ink-slate mb-1.5 flex items-center gap-1.5">
                  <Calendar size={11} /> Start date
                </span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  max={endDate}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:border-teal focus:ring-1 focus:ring-teal/30 outline-none"
                />
              </label>
              <label className="block">
                <span className="text-[11px] font-bold uppercase tracking-wider text-ink-slate mb-1.5 flex items-center gap-1.5">
                  <Calendar size={11} /> End date
                </span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  min={startDate}
                  max={today}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:border-teal focus:ring-1 focus:ring-teal/30 outline-none"
                />
              </label>
            </div>

            {/* Quick presets — saves date-picker hunting for common ranges */}
            <div className="flex gap-2 flex-wrap">
              {[
                { label: "Last 30 days", days: 30 },
                { label: "Last 90 days", days: 90 },
                { label: "Last 12 months", days: 365 },
                { label: "Year to date", ytd: true },
              ].map((p) => (
                <button
                  key={p.label}
                  onClick={() => {
                    const end = new Date();
                    const start = new Date();
                    if (p.ytd) {
                      start.setMonth(0);
                      start.setDate(1);
                    } else if (p.days) {
                      start.setDate(start.getDate() - p.days);
                    }
                    setStartDate(start.toISOString().slice(0, 10));
                    setEndDate(end.toISOString().slice(0, 10));
                  }}
                  className="text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-gray-200 hover:border-teal/40 text-ink-slate hover:text-navy"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* CSV upload mode */}
        {source === "csv" && (
          <>
            <details className="bg-white rounded-2xl border border-gray-100 p-4">
              <summary className="text-xs font-bold text-navy cursor-pointer">
                How to export the CSVs from QBO →
              </summary>
              <ol className="mt-2 text-xs text-ink-slate space-y-1.5 list-decimal pl-5">
                <li>In QBO: <strong>Reports → Standard → Transaction List by Account</strong> (or Search → &quot;transaction report&quot;)</li>
                <li>Filter to the Accounts Receivable account → set date range → <strong>Export → To CSV</strong></li>
                <li>Repeat for the Undeposited Funds account with the same date range</li>
                <li>Drop both files below</li>
              </ol>
            </details>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <CsvDropZone
                label="1. Accounts Receivable CSV"
                description="Transaction list for the A/R account — shows payments routed into UF."
                value={arCsv}
                onChange={setArCsv}
                expectedColumns={["Date", "Transaction Type", "Name", "Amount", "Split"]}
              />
              <CsvDropZone
                label="2. Undeposited Funds CSV"
                description="Transaction list for the UF account — shows deposits that cleared and what's left."
                value={ufCsv}
                onChange={setUfCsv}
                expectedColumns={["Date", "Transaction Type", "Name", "Amount", "Split"]}
              />
            </div>
          </>
        )}

        <div className="flex items-center justify-between bg-white rounded-2xl border border-gray-100 p-4">
          <div className="text-sm">
            {source === "qbo" ? (
              hasQbo ? (
                <span className="text-emerald-700 font-semibold flex items-center gap-2">
                  <CheckCircle2 size={14} /> QuickBooks connected — ready to pull and analyze
                </span>
              ) : (
                <span className="text-red-700 font-semibold flex items-center gap-2">
                  <AlertCircle size={14} /> No QuickBooks connection — switch to CSV mode
                </span>
              )
            ) : canAnalyzeCsv ? (
              <span className="text-emerald-700 font-semibold flex items-center gap-2">
                <CheckCircle2 size={14} /> Both reports loaded — ready to analyze
              </span>
            ) : (
              <span className="text-ink-light">
                Drop both CSVs to enable analysis. Nothing is sent until you click Analyze.
              </span>
            )}
          </div>
          <button
            onClick={analyze}
            disabled={!canAnalyze}
            className="px-5 py-2.5 rounded-xl bg-teal text-white font-bold hover:bg-teal-dark disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            <Sparkles size={14} />
            {source === "qbo" ? "Pull & analyze" : "Analyze with Claude"}
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    );
  }

  // ────────────── ANALYZING PHASE ──────────────
  if (phase === "analyzing") {
    return (
      <div className="rounded-2xl border border-gray-100 bg-white p-12 text-center">
        <Loader2 size={32} className="animate-spin text-teal mx-auto mb-4" />
        <h3 className="font-bold text-navy text-lg">
          {source === "qbo"
            ? "Pulling reports from QuickBooks and sending to Claude…"
            : "Claude is reading your reports…"}
        </h3>
        <p className="text-sm text-ink-light mt-2 max-w-md mx-auto">
          {source === "qbo"
            ? `Fetching AR + UF transaction lists for ${startDate} → ${endDate}, then matching payments to deposits and drafting your QuickBooks cleanup steps. Usually 20–90 seconds.`
            : "Parsing transactions, matching payments to deposits, checking the balance, and drafting your QuickBooks cleanup steps. Usually 20–60 seconds."}
        </p>
        {source === "csv" && (
          <div className="mt-6 text-xs text-ink-light flex items-center justify-center gap-2">
            <FileText size={12} />
            {(arCsv.length / 1024).toFixed(1)}kb AR · {(ufCsv.length / 1024).toFixed(1)}kb UF
          </div>
        )}
      </div>
    );
  }

  // ────────────── ERROR PHASE ──────────────
  if (phase === "error") {
    return (
      <div className="rounded-2xl border-2 border-red-200 bg-red-50 p-6">
        <div className="flex items-start gap-3">
          <AlertCircle size={20} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-bold text-red-900">Analysis failed</h3>
            <p className="text-sm text-red-800 mt-1">{error}</p>
            <button
              onClick={resetAll}
              className="mt-4 px-4 py-2 rounded-lg bg-red-700 text-white text-sm font-bold hover:bg-red-800 inline-flex items-center gap-2"
            >
              <RefreshCw size={14} />
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ────────────── RESULTS PHASE ──────────────
  if (!result) return null;

  const balanceIntent: "good" | "warn" | "bad" =
    result.uf_balance.matches
      ? "good"
      : Math.abs(result.uf_balance.discrepancy || 0) > 100
      ? "bad"
      : "warn";
  const balanceLabel = result.uf_balance.matches
    ? "Verified ✓"
    : `Off by ${formatMoney(Math.abs(result.uf_balance.discrepancy || 0))}`;

  return (
    <div className="space-y-6">
      {/* Summary banner */}
      <div className="rounded-2xl border-2 border-teal/30 bg-gradient-to-br from-teal/5 to-white p-5">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-teal/10">
            <Sparkles size={20} className="text-teal" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-teal flex-wrap">
              Claude's analysis
              {duration && <span className="text-ink-light font-normal">· {(duration / 1000).toFixed(1)}s</span>}
              {resultMeta?.source === "qbo" && resultMeta?.qbo_pull && (
                <span className="text-ink-light font-normal">
                  · pulled live from QBO · {resultMeta.qbo_pull.ar_rows} AR rows ·{" "}
                  {resultMeta.qbo_pull.uf_rows} UF rows ·{" "}
                  {resultMeta.qbo_pull.date_range?.start} → {resultMeta.qbo_pull.date_range?.end}
                </span>
              )}
              {resultMeta?.source === "csv" && (
                <span className="text-ink-light font-normal">· from uploaded CSVs</span>
              )}
            </div>
            <p className="text-base text-navy mt-1 leading-relaxed">{result.summary}</p>
          </div>
          <button
            onClick={resetAll}
            className="text-xs font-bold text-ink-slate hover:text-navy px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 inline-flex items-center gap-1.5 flex-shrink-0"
          >
            <RefreshCw size={12} /> New analysis
          </button>
        </div>
      </div>

      {/* Hero stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          icon={Wallet}
          label="UF Balance"
          value={formatMoneyCompact(result.uf_balance.calculated_ending_balance)}
          hint={balanceLabel}
          intent={balanceIntent}
        />
        <StatTile
          icon={AlertTriangle}
          label="Open Items"
          value={String(result.totals.open_items_count)}
          hint={formatMoneyCompact(result.totals.open_items_amount)}
          intent={result.totals.open_items_count > 0 ? "warn" : "good"}
        />
        <StatTile
          icon={CheckCircle2}
          label="Matched"
          value={String(result.matched_payments.length)}
          hint={`${formatMoneyCompact(result.totals.deposits_clearing_uf_amount)} cleared`}
          intent="good"
        />
        <StatTile
          icon={ScrollText}
          label="Journal Entries"
          value={String(result.totals.journal_entries_count)}
          hint={result.totals.journal_entries_count ? `Net ${formatMoneyCompact(result.totals.journal_entries_net_amount)}` : "—"}
          intent="default"
        />
      </div>

      {/* Balance verification detail */}
      {!result.uf_balance.matches && (
        <div className="rounded-xl border-2 border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-amber-700 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-900">
              <strong>Balance mismatch:</strong> reported{" "}
              {result.uf_balance.reported_ending_balance != null
                ? formatMoney(result.uf_balance.reported_ending_balance)
                : "(not parseable)"}
              {" "}vs calculated {formatMoney(result.uf_balance.calculated_ending_balance)}.
              {result.uf_balance.discrepancy_explanation && (
                <div className="mt-1 text-amber-800">{result.uf_balance.discrepancy_explanation}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Flags */}
      {result.flags.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h3 className="font-bold text-navy mb-3 flex items-center gap-2">
            <AlertCircle size={16} /> Things to review
          </h3>
          <div className="space-y-2">
            {result.flags.map((f, i) => (
              <div
                key={i}
                className={`p-3 rounded-lg border ${
                  f.severity === "critical"
                    ? "bg-red-50 border-red-200"
                    : f.severity === "warning"
                    ? "bg-amber-50 border-amber-200"
                    : "bg-blue-50 border-blue-200"
                }`}
              >
                <div className="flex items-start gap-2">
                  {f.severity === "critical" ? (
                    <AlertCircle size={14} className="text-red-700 flex-shrink-0 mt-0.5" />
                  ) : f.severity === "warning" ? (
                    <AlertTriangle size={14} className="text-amber-700 flex-shrink-0 mt-0.5" />
                  ) : (
                    <Info size={14} className="text-blue-700 flex-shrink-0 mt-0.5" />
                  )}
                  <div>
                    <div className="font-bold text-sm text-navy">{f.title}</div>
                    <div className="text-xs text-ink-slate mt-0.5">{f.description}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Open items */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <h3 className="font-bold text-navy mb-1 flex items-center gap-2">
          <FileSearch size={16} /> Open items — still in Undeposited Funds
        </h3>
        <p className="text-xs text-ink-light mb-3">
          {result.open_items.length === 0
            ? "Nothing stuck in UF — clean."
            : `${result.open_items.length} payment${result.open_items.length === 1 ? "" : "s"} routed to UF with no matching deposit yet.`}
        </p>
        {result.open_items.length > 0 && (
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-bold uppercase tracking-wider text-ink-slate border-b border-gray-100">
                  <th className="text-left pb-2">Date</th>
                  <th className="text-left pb-2">Customer</th>
                  <th className="text-right pb-2">Amount</th>
                  <th className="text-right pb-2">Days old</th>
                  <th className="text-left pb-2">Memo / Notes</th>
                </tr>
              </thead>
              <tbody>
                {result.open_items.map((item, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="py-2 text-ink-slate whitespace-nowrap">{item.payment_date}</td>
                    <td className="py-2 font-medium text-navy">{item.customer || "(no customer)"}</td>
                    <td className="py-2 text-right font-mono font-semibold text-navy whitespace-nowrap">
                      {formatMoney(item.amount)}
                    </td>
                    <td className="py-2 text-right">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          item.days_old > 60
                            ? "bg-red-100 text-red-800"
                            : item.days_old > 30
                            ? "bg-amber-100 text-amber-800"
                            : "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {item.days_old}d
                      </span>
                    </td>
                    <td className="py-2 text-xs text-ink-slate">
                      {item.memo || "—"}
                      {item.notes && (
                        <div className="text-[10px] text-amber-700 mt-0.5">⚠ {item.notes}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* QBO instructions */}
      {result.qbo_instructions.length > 0 && (
        <div className="bg-gradient-to-br from-navy/[0.02] to-white rounded-2xl border-2 border-navy/15 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-navy flex items-center gap-2">
              <ScrollText size={16} /> QuickBooks cleanup steps
            </h3>
            <button
              onClick={copyInstructions}
              className="text-xs font-bold px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 inline-flex items-center gap-1.5"
            >
              {copiedInstructions ? (
                <><ClipboardCheck size={12} className="text-emerald-600" /> Copied</>
              ) : (
                <><Clipboard size={12} /> Copy all</>
              )}
            </button>
          </div>
          <ol className="space-y-2.5">
            {result.qbo_instructions.map((step, i) => (
              <li key={i} className="flex gap-3 text-sm">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-navy text-white text-xs font-bold flex items-center justify-center">
                  {i + 1}
                </span>
                <span className="text-ink-slate leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Matched payments (collapsed by default — verification only) */}
      {result.matched_payments.length > 0 && (
        <details className="bg-white rounded-2xl border border-gray-100 p-5">
          <summary className="font-bold text-navy cursor-pointer flex items-center gap-2">
            <CheckCircle2 size={16} className="text-emerald-600" />
            Matched payments ({result.matched_payments.length}) — spot-check the matcher
          </summary>
          <div className="overflow-x-auto -mx-5 px-5 mt-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-bold uppercase tracking-wider text-ink-slate border-b border-gray-100">
                  <th className="text-left pb-2">Payment</th>
                  <th className="text-left pb-2">Deposit</th>
                  <th className="text-left pb-2">Customer</th>
                  <th className="text-right pb-2">Amount</th>
                  <th className="text-left pb-2">Match</th>
                </tr>
              </thead>
              <tbody>
                {result.matched_payments.map((m, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="py-1.5 text-ink-slate whitespace-nowrap">{m.payment_date}</td>
                    <td className="py-1.5 text-ink-slate whitespace-nowrap">{m.deposit_date}</td>
                    <td className="py-1.5 text-navy font-medium">{m.customer}</td>
                    <td className="py-1.5 text-right font-mono">{formatMoney(m.amount)}</td>
                    <td className="py-1.5">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          m.match_confidence === "high"
                            ? "bg-emerald-100 text-emerald-800"
                            : m.match_confidence === "medium"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {m.match_confidence}
                      </span>
                      <span className="ml-2 text-[10px] text-ink-light">{m.match_basis}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Journal entries (collapsed) */}
      {result.journal_entries.length > 0 && (
        <details className="bg-white rounded-2xl border border-gray-100 p-5">
          <summary className="font-bold text-navy cursor-pointer flex items-center gap-2">
            <ScrollText size={16} />
            Journal entries touching UF ({result.journal_entries.length})
          </summary>
          <div className="overflow-x-auto -mx-5 px-5 mt-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-bold uppercase tracking-wider text-ink-slate border-b border-gray-100">
                  <th className="text-left pb-2">Date</th>
                  <th className="text-right pb-2">Amount</th>
                  <th className="text-left pb-2">Effect</th>
                  <th className="text-left pb-2">Memo</th>
                </tr>
              </thead>
              <tbody>
                {result.journal_entries.map((je, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="py-1.5 text-ink-slate whitespace-nowrap">{je.date}</td>
                    <td className="py-1.5 text-right font-mono">{formatMoney(je.amount)}</td>
                    <td className="py-1.5">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          je.effect === "increased_uf"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-teal-light text-teal-dark"
                        }`}
                      >
                        {je.effect === "increased_uf" ? "↑ UF" : "↓ UF"}
                      </span>
                    </td>
                    <td className="py-1.5 text-xs text-ink-slate">
                      {je.memo || "—"}
                      {je.notes && (
                        <div className="text-[10px] text-amber-700 mt-0.5">⚠ {je.notes}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
