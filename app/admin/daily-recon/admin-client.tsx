"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Play, Loader2, Pause, PlayCircle, CheckCircle2, X, AlertTriangle, FlaskConical,
} from "lucide-react";

interface Client {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  cleanup_completed_at: string | null;
  daily_recon_enabled: boolean;
  daily_recon_paused: boolean;
  daily_recon_paused_reason: string | null;
  last_synced_at: string | null;
}

interface Run {
  id: string;
  client_link_id: string;
  client_name: string;
  run_at: string;
  fetched_from: string | null;
  fetched_to: string;
  transactions_pulled: number;
  auto_executed: number;
  queued_for_review: number;
  anomalies_count: number;
  duration_ms: number | null;
  status: string;
  error_message: string | null;
  dry_run: boolean;
}

export function DailyReconAdminClient({
  clients,
  runs,
}: {
  clients: Client[];
  runs: Run[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastDryRun, setLastDryRun] = useState<{
    clientId: string;
    result: any;
  } | null>(null);
  const [lookback, setLookback] = useState(7);

  async function toggle(clientId: string, field: "daily_recon_enabled" | "daily_recon_paused", value: boolean) {
    setBusyId(clientId);
    try {
      const res = await fetch(`/api/clients/${clientId}/daily-recon-flag`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || `Failed to update (${res.status})`);
      }
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function triggerDryRun(clientId: string) {
    setBusyId(clientId);
    setLastDryRun(null);
    try {
      const res = await fetch(
        `/api/daily-recon/run/${clientId}?dryRun=true&lookbackDays=${lookback}`,
        { method: "POST" }
      );
      const result = await res.json();
      setLastDryRun({ clientId, result });
    } catch (e: any) {
      alert(e?.message || "Network error");
    } finally {
      setBusyId(null);
    }
  }

  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResult, setBatchResult] = useState<any>(null);

  // Run the FULL production batch now (admin-session auth — works even when the
  // Vercel cron can't authenticate). Live run posts auto-categorizations to QBO.
  async function runAllNow(dry: boolean) {
    if (
      !dry &&
      !window.confirm(
        `Run daily recon for ALL ${enrolled.length} enrolled clients and post the high-confidence categorizations to QuickBooks now?`
      )
    )
      return;
    setBatchBusy(true);
    setBatchResult(null);
    try {
      const res = await fetch(`/api/cron/daily-recon?dryRun=${dry ? "true" : "false"}`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || `Failed (${res.status})`);
        return;
      }
      setBatchResult(data);
      router.refresh();
    } catch (e: any) {
      alert(e?.message || "Network error");
    } finally {
      setBatchBusy(false);
    }
  }

  const enrolled = clients.filter((c) => c.daily_recon_enabled);
  const notEnrolled = clients.filter((c) => !c.daily_recon_enabled);

  return (
    <div className="space-y-6">
      {/* Engine control + status */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4 text-sm space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-bold text-navy flex items-center gap-2">
              <Play size={16} className="text-teal" /> Daily recon engine
            </div>
            <div className="text-ink-slate leading-relaxed mt-1">
              <strong className="text-navy">{enrolled.length}</strong> clients enrolled. Auto-runs daily
              at 7am UTC via Vercel Cron — that requires{" "}
              <code className="bg-gray-100 px-1 rounded">CRON_SECRET</code> set in the Vercel production
              env, or the cron call 401s and nothing runs. Run it manually here anytime to verify or
              catch up.
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => runAllNow(true)}
              disabled={batchBusy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-ink-slate hover:border-teal hover:text-teal text-xs font-semibold disabled:opacity-50"
            >
              {batchBusy ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}
              Dry-run all
            </button>
            <button
              onClick={() => runAllNow(false)}
              disabled={batchBusy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-teal hover:bg-teal-dark text-white text-xs font-bold disabled:opacity-50"
            >
              {batchBusy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              Run all now (live)
            </button>
          </div>
        </div>
        {batchResult && (
          <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-xs text-ink-slate">
            <strong className="text-navy">{batchResult.eligible_clients}</strong> clients ·
            auto-executed <strong className="text-navy">{batchResult.totals?.auto_executed ?? 0}</strong> ·
            queued for review{" "}
            <strong className="text-navy">{batchResult.totals?.queued_for_review ?? 0}</strong> · errored{" "}
            <strong className="text-navy">{batchResult.totals?.errored ?? 0}</strong>
            {batchResult.dry_run && (
              <span className="text-amber-700 font-semibold"> · dry-run (nothing posted)</span>
            )}
          </div>
        )}
      </div>

      {/* Lookback slider */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex items-center gap-4">
        <label className="text-sm font-semibold text-navy whitespace-nowrap">
          Dry-run lookback:
        </label>
        <input
          type="range"
          min={1}
          max={30}
          value={lookback}
          onChange={(e) => setLookback(parseInt(e.target.value, 10))}
          className="flex-1"
        />
        <span className="text-sm font-mono text-navy w-20 text-right">{lookback} days</span>
      </div>

      {/* Last dry-run result */}
      {lastDryRun && (
        <div className="bg-white rounded-2xl border border-teal/30 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="text-teal" size={18} />
            <h3 className="font-bold text-navy">
              Dry-run result for{" "}
              {clients.find((c) => c.id === lastDryRun.clientId)?.client_name || lastDryRun.clientId}
            </h3>
          </div>
          <DryRunSummary result={lastDryRun.result} />
        </div>
      )}

      {/* Enrolled clients */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">
            Enrolled ({enrolled.length})
          </h2>
          <Link
            href="/today"
            className="text-xs font-semibold text-teal hover:text-teal-dark"
          >
            View Today board →
          </Link>
        </div>
        {enrolled.length === 0 ? (
          <div className="p-8 text-center text-sm text-ink-slate">
            No clients enrolled. Enable a client below to start piloting.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Client</th>
                <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Last synced</th>
                <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Status</th>
                <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Actions</th>
              </tr>
            </thead>
            <tbody>
              {enrolled.map((c) => (
                <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-navy">{c.client_name}</div>
                    <div className="text-xs text-ink-slate">
                      {c.jurisdiction} · {c.state_province || "—"}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-ink-slate">
                    {c.last_synced_at ? formatAgo(c.last_synced_at) : "never"}
                  </td>
                  <td className="px-4 py-2.5">
                    {c.daily_recon_paused ? (
                      <span
                        className="inline-flex items-center gap-1 text-xs font-semibold bg-red-100 text-red-700 px-2 py-0.5 rounded"
                        title={c.daily_recon_paused_reason || ""}
                      >
                        <Pause size={10} />
                        Paused
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded">
                        <CheckCircle2 size={10} />
                        Active
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="inline-flex gap-1.5">
                      <button
                        disabled={busyId === c.id}
                        onClick={() => triggerDryRun(c.id)}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded hover:bg-blue-200 disabled:opacity-50"
                        title="Run the worker once in dry-run mode (no QBO writes)"
                      >
                        {busyId === c.id ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                        Dry-run
                      </button>
                      {c.daily_recon_paused && (
                        <button
                          disabled={busyId === c.id}
                          onClick={() => toggle(c.id, "daily_recon_paused", false)}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-100 text-emerald-700 text-xs rounded hover:bg-emerald-200 disabled:opacity-50"
                        >
                          <PlayCircle size={11} />
                          Unpause
                        </button>
                      )}
                      <button
                        disabled={busyId === c.id}
                        onClick={() => toggle(c.id, "daily_recon_enabled", false)}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded hover:bg-gray-200 disabled:opacity-50"
                      >
                        <X size={11} />
                        Unenroll
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Eligible-but-not-enrolled */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">
            Eligible — cleanup complete ({notEnrolled.length})
          </h2>
        </div>
        {notEnrolled.length === 0 ? (
          <div className="p-8 text-center text-sm text-ink-slate">
            No additional eligible clients.
          </div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {notEnrolled.map((c) => (
                <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-navy">{c.client_name}</div>
                    <div className="text-xs text-ink-slate">
                      {c.jurisdiction} · {c.state_province || "—"} · cleanup complete{" "}
                      {c.cleanup_completed_at ? formatAgo(c.cleanup_completed_at) : ""}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      disabled={busyId === c.id}
                      onClick={() => toggle(c.id, "daily_recon_enabled", true)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 bg-teal text-white text-xs font-semibold rounded hover:bg-teal-dark disabled:opacity-50"
                    >
                      {busyId === c.id ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <CheckCircle2 size={11} />
                      )}
                      Enroll
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent runs */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">
            Recent runs (last 50)
          </h2>
        </div>
        {runs.length === 0 ? (
          <div className="p-8 text-center text-sm text-ink-slate">
            No runs yet. Trigger a dry-run on an enrolled client to populate this log.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">When</th>
                <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Client</th>
                <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Pulled</th>
                <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Auto-exec</th>
                <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Queued</th>
                <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Anomalies</th>
                <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-gray-100">
                  <td className="px-4 py-2.5 text-xs text-ink-slate whitespace-nowrap">
                    {formatAgo(r.run_at)}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-navy">{r.client_name}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-ink-slate">
                    {r.transactions_pulled}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-emerald-700">
                    {r.auto_executed}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-amber-700">
                    {r.queued_for_review}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-red-700">
                    {r.anomalies_count}
                  </td>
                  <td className="px-4 py-2.5">
                    <RunStatusBadge status={r.status} dryRun={r.dry_run} />
                    {r.error_message && (
                      <div
                        className="text-xs text-red-600 mt-1 max-w-xs truncate"
                        title={r.error_message}
                      >
                        {r.error_message}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function DryRunSummary({ result }: { result: any }) {
  if (result.error) {
    return (
      <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
        Error: {result.error}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-3 text-sm">
        <Stat label="Pulled" value={result.transactions_pulled} />
        <Stat label="Would auto-exec" value={result.auto_executed} tone="emerald" />
        <Stat label="Would queue" value={result.queued_for_review} tone="amber" />
        <Stat label="Anomalies" value={result.anomalies_count} tone="red" />
      </div>
      {Array.isArray(result.preview) && result.preview.length > 0 && (
        <details className="border border-gray-100 rounded">
          <summary className="px-3 py-2 cursor-pointer text-xs font-semibold text-navy bg-gray-50 hover:bg-gray-100">
            Preview {result.preview.length} line(s) — click to expand
          </summary>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-1.5 text-ink-slate">Vendor</th>
                  <th className="text-right px-3 py-1.5 text-ink-slate">$</th>
                  <th className="text-left px-3 py-1.5 text-ink-slate">→</th>
                  <th className="text-left px-3 py-1.5 text-ink-slate">Conf</th>
                  <th className="text-left px-3 py-1.5 text-ink-slate">Action</th>
                  <th className="text-left px-3 py-1.5 text-ink-slate">Anomalies</th>
                </tr>
              </thead>
              <tbody>
                {result.preview.map((p: any, i: number) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-3 py-1.5 font-mono">{p.vendor_name || "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono">
                      ${Math.abs(p.amount).toFixed(2)}
                    </td>
                    <td className="px-3 py-1.5">{p.suggested_account_name || "—"}</td>
                    <td className="px-3 py-1.5 font-mono">
                      {Math.round((p.confidence || 0) * 100)}%
                    </td>
                    <td className="px-3 py-1.5">
                      {p.would_auto_execute ? (
                        <span className="text-emerald-700 font-semibold">auto</span>
                      ) : (
                        <span className="text-amber-700">queue</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-red-700">
                      {(p.anomaly_flags || []).map((f: any) => f.code).join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <pre className="text-[10px] text-ink-slate font-mono bg-gray-50 p-2 rounded overflow-x-auto">
        {JSON.stringify({ ...result, preview: undefined }, null, 2)}
      </pre>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "emerald" | "amber" | "red" }) {
  const color =
    tone === "emerald" ? "text-emerald-700"
    : tone === "amber" ? "text-amber-700"
    : tone === "red" ? "text-red-700"
    : "text-navy";
  return (
    <div className="bg-gray-50 rounded p-3 text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-ink-slate mt-1">{label}</div>
    </div>
  );
}

function RunStatusBadge({ status, dryRun }: { status: string; dryRun: boolean }) {
  if (dryRun || status === "dry_run") {
    return <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold">Dry-run</span>;
  }
  if (status === "complete") {
    return <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">Complete</span>;
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-red-100 text-red-700 font-semibold">
        <AlertTriangle size={10} />
        Failed
      </span>
    );
  }
  return <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-ink-slate font-semibold">{status}</span>;
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
