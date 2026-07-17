"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Loader2, RefreshCw, ChevronDown, ChevronRight, AlertTriangle, ExternalLink,
} from "lucide-react";
import { DuplicatesPanel } from "@/components/DuplicatesPanel";

type Row = {
  client_link_id: string;
  client_name: string;
  certain: number;
  likely: number;
  possible: number;
  reversals: number;
  exposure: number;
  newest: string;
};

const fmt = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n || 0)).toLocaleString();

export function DuplicatesFleetClient({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [sweeping, setSweeping] = useState(false);
  const [msg, setMsg] = useState("");
  const [stats, setStats] = useState<{ scanned: number; found: number; errors: number; targets: number; samples: string[] } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // Browser-driven chunk loop with a no-progress guard — the server only
  // self-chains for cron runs (the after() chain dies unreliably on Vercel).
  async function runSweep() {
    if (
      !confirm(
        "Rescan the ENTIRE fleet for duplicate expenses (YTD window, all active clients incl. mid-cleanup)?\n\n" +
          "Read-only against QuickBooks — findings appear below as chunks finish. Takes several minutes."
      )
    )
      return;
    setSweeping(true);
    setMsg("Starting…");
    const acc = { scanned: 0, found: 0, errors: 0, targets: 0, samples: [] as string[] };
    try {
      let offset: number | null = 0;
      let lastOffset = -1;
      for (let i = 0; i < 80 && offset !== null; i++) {
        if (offset === lastOffset) break; // no-progress guard
        lastOffset = offset;
        const res: Response = await fetch(`/api/admin/dup-sweep?offset=${offset}`, { method: "POST" });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        acc.targets = j.targets ?? acc.targets;
        acc.scanned += j.chunk?.scanned || 0;
        acc.found += j.chunk?.found || 0;
        acc.errors += j.chunk?.errors || 0;
        if (j.chunk?.error_samples?.length && acc.samples.length < 10) acc.samples.push(...j.chunk.error_samples);
        setStats({ ...acc });
        offset = j.next_offset;
        setMsg(
          offset === null
            ? `Done — scanned ${acc.scanned} of ${acc.targets}, ${acc.found} findings.`
            : `${Math.min(offset, acc.targets)} of ${acc.targets} scanned…`
        );
      }
      setTimeout(() => router.refresh(), 1500);
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || "unknown"}`);
    } finally {
      setSweeping(false);
    }
  }

  const totals = rows.reduce(
    (a, r) => ({
      clients: a.clients + 1,
      actionable: a.actionable + r.certain + r.likely,
      exposure: a.exposure + r.exposure,
      reversals: a.reversals + r.reversals,
    }),
    { clients: 0, actionable: 0, exposure: 0, reversals: 0 }
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="grid grid-cols-4 gap-4 flex-1 mr-4">
          <Stat label="Clients with open findings" value={String(totals.clients)} accent={totals.clients > 0} />
          <Stat label="Actionable dups (certain + likely)" value={String(totals.actionable)} accent={totals.actionable > 0} />
          <Stat label="$ exposure" value={fmt(totals.exposure)} accent={totals.exposure > 0} />
          <Stat label="Refund pairs (verify only)" value={String(totals.reversals)} />
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={runSweep}
            disabled={sweeping}
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal text-white px-3 py-2 text-sm font-semibold hover:bg-teal/90 disabled:opacity-50"
          >
            {sweeping ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Run fleet sweep
          </button>
          {msg && <span className="text-[11px] text-ink-slate">{msg}</span>}
        </div>
      </div>

      {stats && (
        <div className="rounded-xl border border-gray-200 bg-white p-3 mb-4 text-xs text-ink-slate">
          <strong className="text-navy">Last sweep:</strong> {stats.scanned}/{stats.targets} scanned ·{" "}
          {stats.found} findings · {stats.errors} errored
          {stats.samples.length > 0 && (
            <ul className="mt-1 ml-4 list-disc text-red-700">
              {stats.samples.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-ink-light">
          No open duplicate findings. Run the fleet sweep — clients land here as chunks finish.
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-[11px] uppercase tracking-wide text-ink-slate">
                <th className="text-left font-semibold px-4 py-2.5">Client</th>
                <th className="text-right font-semibold px-3 py-2.5">Certain</th>
                <th className="text-right font-semibold px-3 py-2.5">Likely</th>
                <th className="text-right font-semibold px-3 py-2.5">Possible</th>
                <th className="text-right font-semibold px-3 py-2.5">Refund pairs</th>
                <th className="text-right font-semibold px-3 py-2.5">$ exposure</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const isOpen = !!open[r.client_link_id];
                const hot = r.certain + r.likely > 0;
                return (
                  <FleetRow
                    key={r.client_link_id}
                    r={r}
                    hot={hot}
                    isOpen={isOpen}
                    onToggle={() => setOpen((o) => ({ ...o, [r.client_link_id]: !isOpen }))}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FleetRow({
  r,
  hot,
  isOpen,
  onToggle,
}: {
  r: Row;
  hot: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className={hot ? "bg-amber-50/40 hover:bg-amber-50/70" : "hover:bg-gray-50"}>
        <td className="px-4 py-2.5">
          <button onClick={onToggle} className="flex items-center gap-1.5 text-left font-semibold text-navy hover:text-teal">
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {r.client_name}
            {hot && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-1.5 py-0.5">
                <AlertTriangle size={9} /> review
              </span>
            )}
          </button>
        </td>
        <td className="px-3 py-2.5 text-right font-mono text-red-700 font-semibold">{r.certain || "—"}</td>
        <td className="px-3 py-2.5 text-right font-mono text-amber-700 font-semibold">{r.likely || "—"}</td>
        <td className="px-3 py-2.5 text-right font-mono text-ink-slate">{r.possible || "—"}</td>
        <td className="px-3 py-2.5 text-right font-mono text-ink-slate">{r.reversals || "—"}</td>
        <td className="px-3 py-2.5 text-right font-mono text-navy font-semibold">{r.exposure ? fmt(r.exposure) : "—"}</td>
        <td className="px-3 py-2.5 text-right">
          <Link
            href={`/clients/${r.client_link_id}`}
            className="inline-flex items-center gap-1 text-xs font-semibold text-teal hover:underline"
          >
            <ExternalLink size={11} /> profile
          </Link>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={7} className="px-4 pb-4 pt-1 bg-gray-50/60">
            {/* The SAME panel the reclass flow uses — findings list with
                guarded one-click remove / keep. Zero duplicated logic. */}
            <DuplicatesPanel clientLinkId={r.client_link_id} title={`Duplicates — ${r.client_name}`} showScan />
          </td>
        </tr>
      )}
    </>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${accent ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-white"}`}>
      <div className={`text-lg font-bold ${accent ? "text-amber-800" : "text-navy"}`}>{value}</div>
      <div className="text-[11px] text-ink-slate">{label}</div>
    </div>
  );
}
