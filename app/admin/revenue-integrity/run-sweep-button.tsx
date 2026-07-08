"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";

export function RunSweepButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const router = useRouter();

  async function run() {
    if (
      !confirm(
        "Scan every production client for deposits posted into revenue accounts?\n\n" +
          "Read-only against QBO. Runs in chunks in the background — results appear on this page as they land."
      )
    )
      return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin/revenue-integrity-sweep", { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setMsg(`Sweeping ${j.targets} clients — refresh in a few minutes.`);
      setTimeout(() => router.refresh(), 20000);
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || "unknown"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-[11px] text-ink-slate">{msg}</span>}
      <button
        onClick={run}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg bg-teal text-white px-3 py-2 text-sm font-semibold hover:bg-teal/90 disabled:opacity-50"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        Run sweep
      </button>
    </div>
  );
}
