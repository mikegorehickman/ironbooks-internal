"use client";

import { useState } from "react";
import { Copy, Loader2, ArrowRight, Check } from "lucide-react";

/** One-time duplicate clean sweep across every cleaned-up client. */
export function DupSweepButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function run() {
    if (
      !confirm(
        "Run the duplicate clean sweep across every cleaned-up / production client?\n\n" +
          "Read-only: it detects duplicates and fills the review queues — nothing is deleted without a human click."
      )
    )
      return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin/dup-sweep", { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setMsg(`Sweeping ${j.targets} clients in the background — findings appear on /today and the reclass Duplicates stage as they land (a few minutes).`);
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || "unknown"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={run}
      disabled={busy}
      className="group w-full flex items-center justify-between rounded-xl bg-white border border-gray-200 px-5 py-3 hover:border-teal hover:bg-teal-lighter/40 transition-colors text-left disabled:opacity-60"
    >
      <div className="flex items-center gap-3">
        <div className="rounded-lg flex items-center justify-center w-9 h-9 bg-teal-light">
          {busy ? <Loader2 size={16} className="animate-spin text-teal" /> : msg ? <Check size={16} className="text-teal" /> : <Copy size={16} className="text-teal" />}
        </div>
        <div>
          <h3 className="font-bold text-sm text-navy">Duplicate clean sweep</h3>
          <p className="text-xs text-ink-slate">
            {msg || "Scan every cleaned-up client for duplicate revenue/expenses · read-only, fills the review queues"}
          </p>
        </div>
      </div>
      <ArrowRight size={16} className="text-ink-light group-hover:text-teal" />
    </button>
  );
}
