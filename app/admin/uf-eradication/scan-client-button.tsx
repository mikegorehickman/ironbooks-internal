"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";

/**
 * Scan one client's Undeposited Funds from the fleet page.
 *
 * Deliberately per-client rather than a "scan all" button: a single scan pages
 * every Payment in a five-year window client-side (QBO won't let you filter on
 * DepositToAccountRef — see lib/uf-audit.ts:149), so 80-odd clients in one
 * request would blow the serverless timeout and give no partial result. A real
 * scan-all needs a background job; until then this is honest about what it does.
 */
export function ScanClientButton({
  clientLinkId,
  clientName,
}: {
  clientLinkId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/uf-audit/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `Scan failed (${res.status})`);
      router.refresh();
    } catch (e: any) {
      // Surfaced next to the row, not swallowed — a client that can't be scanned
      // is exactly the kind of thing that otherwise stays "unknown" forever.
      setError(e?.message || "Scan failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      {error && <span className="text-[11px] text-[#954E44] max-w-[280px] truncate">{error}</span>}
      <button
        onClick={scan}
        disabled={busy}
        title={`Scan ${clientName} — read-only against QuickBooks`}
        className="inline-flex items-center gap-1.5 bg-navy text-white text-[11px] font-semibold px-2.5 py-1 rounded-md hover:bg-navy-light disabled:opacity-50"
      >
        {busy ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
        {busy ? "Scanning…" : "Scan"}
      </button>
    </div>
  );
}
