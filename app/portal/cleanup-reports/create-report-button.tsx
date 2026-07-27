"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Sparkles } from "lucide-react";

/**
 * "Create a report" affordance for /portal/cleanup-reports.
 *
 * Collapsed: a single CTA button. Expanded: start/end date inputs
 * (prefilled to last calendar month) + quick presets + Generate.
 *
 * Generation runs server-side (live QBO pull + PDF render, up to ~60s);
 * on success the PDF is already saved in the client's portal folder, so
 * a router.refresh() makes it appear in "Your generated reports".
 */
export function CreateReportButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Default to last calendar month — the period clients most often need
  const now = new Date();
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const [start, setStart] = useState(iso(lastMonthStart));
  const [end, setEnd] = useState(iso(lastMonthEnd));

  function preset(months: number) {
    // N full calendar months ending with last month
    const e = new Date(now.getFullYear(), now.getMonth(), 0);
    const s = new Date(e.getFullYear(), e.getMonth() - (months - 1), 1);
    setStart(iso(s));
    setEnd(iso(e));
  }
  function presetYtd() {
    setStart(`${now.getFullYear()}-01-01`);
    setEnd(iso(now));
  }

  async function handleGenerate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await fetch("/api/portal/cleanup-report/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start, end }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Report generation failed");
      setDone(true);
      setOpen(false);
      router.refresh(); // saved file is already in storage — pull it into the list
    } catch (err: any) {
      setError(err?.message || "Something went wrong — try again");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => {
            setOpen(true);
            setDone(false);
          }}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white font-semibold text-sm px-4 py-2.5 rounded-lg transition-colors"
        >
          <Plus size={15} />
          Create a report
        </button>
        {done && (
          <span className="text-xs font-semibold text-emerald-700">
            Report saved below ✓
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white border border-teal/30 rounded-2xl p-4 md:p-5 space-y-4">
      <div className="flex items-center gap-2 text-navy">
        <Sparkles size={15} className="text-teal" />
        <span className="text-sm font-bold">Build a cleanup report for any period</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <PresetChip label="Last month" onClick={() => preset(1)} disabled={busy} />
        <PresetChip label="Last 3 months" onClick={() => preset(3)} disabled={busy} />
        <PresetChip label="Last 12 months" onClick={() => preset(12)} disabled={busy} />
        <PresetChip label="Year to date" onClick={presetYtd} disabled={busy} />
      </div>

      <div className="flex items-end gap-3 flex-wrap">
        <label className="text-xs text-ink-slate">
          <span className="block font-semibold mb-1">From</span>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            disabled={busy}
            className="rounded-lg border border-cardline px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-teal/40"
          />
        </label>
        <label className="text-xs text-ink-slate">
          <span className="block font-semibold mb-1">To</span>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            disabled={busy}
            className="rounded-lg border border-cardline px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-teal/40"
          />
        </label>
        <button
          onClick={handleGenerate}
          disabled={busy || !start || !end}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white font-semibold text-sm px-4 py-2.5 rounded-lg transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {busy ? "Building…" : "Generate report"}
        </button>
        <button
          onClick={() => setOpen(false)}
          disabled={busy}
          className="text-xs text-ink-slate hover:text-navy px-2 py-2.5"
        >
          Cancel
        </button>
      </div>

      {busy && (
        <div className="text-xs text-ink-slate">
          Pulling your live QuickBooks data and building the PDF — this can take
          up to a minute. Keep this tab open.
        </div>
      )}
      {error && <div className="text-xs text-rust">{error}</div>}
    </div>
  );
}

function PresetChip({
  label, onClick, disabled,
}: {
  label: string; onClick: () => void; disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-2.5 py-1 rounded-full border border-cardline bg-white text-xs font-semibold text-ink-slate hover:border-teal hover:text-teal-dark transition-colors disabled:opacity-50"
    >
      {label}
    </button>
  );
}
