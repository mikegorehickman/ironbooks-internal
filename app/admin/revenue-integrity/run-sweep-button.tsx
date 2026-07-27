"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";

/**
 * Kicks off one of the fleet sweeps behind this page. Both are read-only
 * against QBO and self-chain through the fleet in chunks, so the button just
 * fires the first chunk and tells the user to come back.
 */
export function RunSweepButton({
  endpoint = "/api/admin/revenue-integrity-sweep",
  label = "Run revenue sweep",
  confirmText = "Scan every production client for deposits posted into revenue accounts?\n\nRead-only against QBO. Runs in chunks in the background — results appear on this page as they land.",
  variant = "primary",
}: {
  endpoint?: string;
  label?: string;
  confirmText?: string;
  variant?: "primary" | "secondary";
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const router = useRouter();

  async function run() {
    if (!confirm(confirmText)) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(endpoint, { method: "POST" });
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
        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50 ${
          variant === "primary"
            ? "bg-teal text-white hover:bg-teal/90"
            : "border border-gray-200 bg-white text-navy hover:border-teal hover:text-teal"
        }`}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        {label}
      </button>
    </div>
  );
}
