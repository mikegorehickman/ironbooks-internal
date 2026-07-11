"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Play, ExternalLink, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";

interface ClientRow {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string;
  latest_job: { id: string; status: string; created_at: string } | null;
}

interface RowState {
  status: "idle" | "starting" | "started" | "blocked" | "error";
  jobId?: string;
  message?: string;
}

/** Statuses that mean a job is already in flight — starting another would 409. */
const ACTIVE = new Set(["executing", "in_review", "web_search_paused", "ai_paused"]);

export function BulkReclassClient({ clients }: { clients: ClientRow[] }) {
  const router = useRouter();
  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);
  const [rows, setRows] = useState<Record<string, RowState>>(
    Object.fromEntries(clients.map((c) => [c.id, { status: "idle" } as RowState]))
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  function patch(id: string, p: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));
  }

  async function startOne(c: ClientRow): Promise<void> {
    patch(c.id, { status: "starting", message: undefined });
    try {
      const res = await fetch("/api/reclass/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: c.id,
          workflow: "full_categorization",
          date_range_start: `${year}-01-01`,
          date_range_end: today,
          jurisdiction: c.jurisdiction,
          state_province: c.state_province,
          reason: "",
          source_account_id: null,
          source_account_name: null,
          auto_approve_threshold: 500,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.existing_job_id) {
        patch(c.id, { status: "blocked", jobId: data.existing_job_id, message: "active job exists" });
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      patch(c.id, { status: "started", jobId: data.job_id });
    } catch (e: any) {
      patch(c.id, { status: "error", message: e.message });
    }
  }

  // Sequential with a small stagger: each discovery immediately returns a
  // job id and does its AI work server-side in the background, but firing
  // 70 at once would stampede the Claude API. 3s spacing keeps ~5-10
  // discoveries overlapping at steady state.
  async function startMany(ids: string[]) {
    setBusy(true);
    for (const id of ids) {
      const c = clients.find((x) => x.id === id)!;
      // eslint-disable-next-line no-await-in-loop
      await startOne(c);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    setBusy(false);
  }

  const startableIds = clients
    .filter((c) => !(c.latest_job && ACTIVE.has(c.latest_job.status)) && rows[c.id]?.status === "idle")
    .map((c) => c.id);

  const startedCount = Object.values(rows).filter((r) => r.status === "started").length;
  const errorCount = Object.values(rows).filter((r) => r.status === "error").length;

  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-50 rounded-xl text-sm text-blue-900">
        <strong>Discovery only.</strong> Each start pulls the client&apos;s calendar-year
        transactions and runs KB + AI categorization, then stops at the normal review screen —
        <strong> nothing posts to QuickBooks from this page.</strong> Bookkeepers review and
        execute per client. Very large clients pause mid-AI with a Continue button on their
        review page (normal). Auto-approve threshold: $500, same as the wizard default.
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => startMany(startableIds)}
          disabled={busy || startableIds.length === 0}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal text-white text-sm font-semibold hover:bg-teal-dark disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          Start all startable ({startableIds.length})
        </button>
        <button
          onClick={() => startMany([...selected].filter((id) => rows[id]?.status === "idle"))}
          disabled={busy || selected.size === 0}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 bg-white text-sm font-semibold text-navy hover:border-teal disabled:opacity-50"
        >
          <Play size={14} />
          Start selected ({selected.size})
        </button>
        <button
          onClick={() => router.refresh()}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 bg-white text-xs font-semibold text-ink-slate hover:text-navy"
        >
          <RefreshCw size={13} />
          Refresh statuses
        </button>
        <span className="text-xs text-ink-slate ml-2">
          {startedCount} started this session
          {errorCount > 0 && <span className="text-red-600 font-semibold"> · {errorCount} errors</span>}
        </span>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-2.5 w-8"></th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Client</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Jur.</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Last full categorization</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">This session</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Actions</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => {
              const r = rows[c.id];
              const jobActive = c.latest_job && ACTIVE.has(c.latest_job.status);
              return (
                <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        e.target.checked ? next.add(c.id) : next.delete(c.id);
                        setSelected(next);
                      }}
                      className="w-4 h-4 rounded border-gray-300"
                    />
                  </td>
                  <td className="px-4 py-2.5 font-medium text-navy">{c.client_name}</td>
                  <td className="px-4 py-2.5 text-ink-slate">{c.jurisdiction}</td>
                  <td className="px-4 py-2.5">
                    {c.latest_job ? (
                      <Link href={`/reclass/${c.latest_job.id}/review`} className="text-xs underline decoration-dotted text-ink-slate hover:text-navy">
                        {c.latest_job.status} · {new Date(c.latest_job.created_at).toLocaleDateString()}
                      </Link>
                    ) : (
                      <span className="text-xs text-ink-light">never run</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {r.status === "idle" && (jobActive ? <span className="text-amber-700">job already active</span> : <span className="text-ink-light">—</span>)}
                    {r.status === "starting" && <span className="inline-flex items-center gap-1 text-teal"><Loader2 size={12} className="animate-spin" />starting</span>}
                    {r.status === "started" && r.jobId && (
                      <Link href={`/reclass/${r.jobId}/review`} className="inline-flex items-center gap-1 text-emerald-700 font-semibold hover:underline">
                        <CheckCircle2 size={12} />discovering — open review <ExternalLink size={11} />
                      </Link>
                    )}
                    {r.status === "blocked" && r.jobId && (
                      <Link href={`/reclass/${r.jobId}/review`} className="inline-flex items-center gap-1 text-amber-700 hover:underline">
                        <AlertTriangle size={12} />{r.message} — open <ExternalLink size={11} />
                      </Link>
                    )}
                    {r.status === "error" && <span className="text-red-600" title={r.message}>{(r.message || "error").slice(0, 60)}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => startOne(c)}
                      disabled={busy || r.status === "starting" || r.status === "started"}
                      className="text-xs font-semibold text-teal hover:text-teal-dark disabled:opacity-50"
                    >
                      Start
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
