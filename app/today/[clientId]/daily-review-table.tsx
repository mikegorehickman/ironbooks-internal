"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2, X, HelpCircle, AlertTriangle, Loader2, Sparkles,
  Square, CheckSquare, Filter,
} from "lucide-react";

interface QueueRow {
  id: string;
  qbo_transaction_id: string;
  qbo_line_id: string;
  vendor_name: string | null;
  transaction_date: string;
  transaction_amount: number | null;
  description: string | null;
  from_account_name: string | null;
  suggested_account_id: string | null;
  suggested_account_name: string | null;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  source: string | null;
  anomaly_flags: Array<{ code: string; message: string }> | null;
  decision: string;
  decided_at?: string | null;
  executed_at?: string | null;
}

interface Account {
  id: string;
  name: string;
  type?: string;
}

/**
 * Daily review table — one row per pending QBO line.
 *
 * Bookkeeper actions per row: Approve / Reject / Ask Client, plus a
 * searchable dropdown to override the suggested target account.
 *
 * Bulk actions across selected rows: Approve all / Reject all / Ask all.
 * Bulk-approve uses the existing per-row suggested account; rows with
 * no suggestion can't be bulk-approved — they show inline guidance to
 * approve individually with an override.
 *
 * Filters: confidence band (high / med / low), source (KB / rule / AI),
 * and "only anomalies" — saves the bookkeeper from scrolling past all
 * the obvious-approve rows to find the ones that need real eyeballs.
 *
 * Sort: anomaly-flagged rows first (forced eyeballs), then by amount
 * desc (bigger blast radius gets reviewed earlier).
 */
export function DailyReviewTable({
  rows,
  availableAccounts,
  readOnly,
}: {
  rows: QueueRow[];
  availableAccounts: Account[];
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<{ id: string; msg: string } | null>(null);
  const [overrides, setOverrides] = useState<Map<string, { id: string; name: string }>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ summary: any; results?: any[] } | null>(null);
  const [filter, setFilter] = useState<"all" | "high" | "med" | "low" | "anomalies">("all");

  const filteredRows = useMemo(() => {
    const arr = [...rows];
    const f = arr.filter((r) => {
      if (filter === "all") return true;
      const flags = Array.isArray(r.anomaly_flags) ? r.anomaly_flags : [];
      if (filter === "anomalies") return flags.length > 0;
      const c = r.ai_confidence ?? 0;
      if (filter === "high") return c >= 0.85;
      if (filter === "med") return c >= 0.5 && c < 0.85;
      if (filter === "low") return c < 0.5;
      return true;
    });
    f.sort((a, b) => {
      const af = Array.isArray(a.anomaly_flags) ? a.anomaly_flags.length : 0;
      const bf = Array.isArray(b.anomaly_flags) ? b.anomaly_flags.length : 0;
      if (bf !== af) return bf - af;
      return Math.abs(b.transaction_amount || 0) - Math.abs(a.transaction_amount || 0);
    });
    return f;
  }, [rows, filter]);

  // ─────────── single-row action ───────────
  async function act(row: QueueRow, action: "approve" | "approve_with_override" | "reject" | "ask_client") {
    setBusyId(row.id);
    setErrorId(null);
    try {
      const body: any = { action };
      if (action === "approve_with_override") {
        const o = overrides.get(row.id);
        if (!o) {
          setErrorId({ id: row.id, msg: "Pick a target account first" });
          setBusyId(null);
          return;
        }
        body.target_account_id = o.id;
        body.target_account_name = o.name;
      }
      const res = await fetch(`/api/daily-recon/queue/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErrorId({ id: row.id, msg: d.error || `Failed (${res.status})` });
        setBusyId(null);
        return;
      }
      router.refresh();
    } catch (e: any) {
      setErrorId({ id: row.id, msg: e?.message || "Network error" });
    } finally {
      setBusyId(null);
    }
  }

  // ─────────── bulk action ───────────
  async function bulkAct(action: "approve" | "reject" | "ask_client") {
    const ids = Array.from(selected);
    if (ids.length === 0) return;

    // Confirm — bulk approve actually posts to QBO, sr. should pause
    // long enough to read the count.
    const verbed =
      action === "approve" ? `approve & post ${ids.length}` :
      action === "reject" ? `reject ${ids.length}` :
      `mark ${ids.length} as "ask client" for`;
    const confirmMsg =
      action === "approve"
        ? `${verbed} entries to QuickBooks?\n\nReview the table first — entries without a suggested account will be skipped.`
        : `${verbed} entries?`;
    if (!window.confirm(confirmMsg)) return;

    setBulkBusy(true);
    setBulkResult(null);
    try {
      const res = await fetch(`/api/daily-recon/queue/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Bulk action failed");
        return;
      }
      setBulkResult(data);
      setSelected(new Set());
      router.refresh();
    } catch (e: any) {
      alert(e?.message || "Network error");
    } finally {
      setBulkBusy(false);
    }
  }

  function setOverride(rowId: string, accountId: string) {
    const acc = availableAccounts.find((a) => a.id === accountId);
    if (!acc) return;
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(rowId, { id: acc.id, name: acc.name });
      return next;
    });
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    const visibleIds = filteredRows.map((r) => r.id);
    const allSelected = visibleIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        visibleIds.forEach((id) => next.delete(id));
      } else {
        visibleIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  // Filter chip counts for "x of y" labelling
  const counts = useMemo(() => {
    let high = 0, med = 0, low = 0, anomalies = 0;
    for (const r of rows) {
      const c = r.ai_confidence ?? 0;
      if (c >= 0.85) high++;
      else if (c >= 0.5) med++;
      else low++;
      if (Array.isArray(r.anomaly_flags) && r.anomaly_flags.length > 0) anomalies++;
    }
    return { high, med, low, anomalies };
  }, [rows]);

  if (rows.length === 0) {
    return <div className="p-8 text-center text-ink-slate text-sm">Nothing to show.</div>;
  }

  const allVisibleSelected =
    filteredRows.length > 0 &&
    filteredRows.every((r) => selected.has(r.id));

  return (
    <div className="space-y-3">
      {/* Filter chips */}
      {!readOnly && (
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg border border-gray-100 text-xs flex-wrap">
          <Filter size={12} className="text-ink-slate" />
          <FilterChip
            active={filter === "all"}
            onClick={() => setFilter("all")}
            label={`All ${rows.length}`}
            tone="navy"
          />
          <FilterChip
            active={filter === "high"}
            onClick={() => setFilter("high")}
            label={`High conf ${counts.high}`}
            tone="emerald"
          />
          <FilterChip
            active={filter === "med"}
            onClick={() => setFilter("med")}
            label={`Medium ${counts.med}`}
            tone="amber"
          />
          <FilterChip
            active={filter === "low"}
            onClick={() => setFilter("low")}
            label={`Low ${counts.low}`}
            tone="red"
          />
          {counts.anomalies > 0 && (
            <FilterChip
              active={filter === "anomalies"}
              onClick={() => setFilter("anomalies")}
              label={`Anomalies ${counts.anomalies}`}
              tone="red"
            />
          )}
        </div>
      )}

      {/* Bulk action bar — only shows when something is selected */}
      {!readOnly && selected.size > 0 && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 bg-navy text-white rounded-xl shadow-md">
          <div className="text-sm">
            <strong>{selected.size}</strong> selected
            <button
              onClick={() => setSelected(new Set())}
              className="ml-3 text-xs text-white/70 hover:text-white underline underline-offset-2"
            >
              clear selection
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => bulkAct("approve")}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold disabled:opacity-50"
            >
              {bulkBusy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <CheckCircle2 size={12} />
              )}
              Approve & post {selected.size}
            </button>
            <button
              onClick={() => bulkAct("reject")}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-xs font-bold disabled:opacity-50"
            >
              <X size={12} /> Reject
            </button>
            <button
              onClick={() => bulkAct("ask_client")}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-navy hover:bg-navy text-white text-xs font-bold disabled:opacity-50"
            >
              <HelpCircle size={12} /> Ask client
            </button>
          </div>
        </div>
      )}

      {/* Bulk result toast */}
      {bulkResult && (
        <div className="px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-900 flex items-center gap-3">
          <CheckCircle2 size={16} className="text-emerald-600" />
          <span>
            <strong>{bulkResult.summary.succeeded}</strong> succeeded
            {bulkResult.summary.failed > 0 && (
              <> · <strong className="text-red-700">{bulkResult.summary.failed}</strong> failed</>
            )}
            {bulkResult.summary.skipped > 0 && (
              <> · {bulkResult.summary.skipped} skipped</>
            )}
          </span>
          {bulkResult.summary.failed > 0 && bulkResult.results && (
            <details className="text-xs">
              <summary className="cursor-pointer underline">show failures</summary>
              <ul className="mt-2 space-y-1">
                {bulkResult.results
                  .filter((r: any) => r.status === "failed" || r.status === "forbidden")
                  .map((r: any) => (
                    <li key={r.id} className="text-red-800">
                      <code className="text-[10px]">{r.id.slice(0, 8)}</code>: {r.error || r.status}
                    </li>
                  ))}
              </ul>
            </details>
          )}
          <button
            onClick={() => setBulkResult(null)}
            className="ml-auto text-xs text-emerald-700 hover:text-emerald-900 underline"
          >
            dismiss
          </button>
        </div>
      )}

      <div className="overflow-x-auto bg-white rounded-2xl border border-gray-100">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {!readOnly && (
                <th className="px-3 py-2.5 w-10">
                  <button
                    onClick={toggleAllVisible}
                    className="text-ink-slate hover:text-navy"
                    aria-label="Toggle all"
                    title="Select all visible"
                  >
                    {allVisibleSelected ? (
                      <CheckSquare size={14} className="text-teal" />
                    ) : (
                      <Square size={14} />
                    )}
                  </button>
                </th>
              )}
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Date</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Vendor</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Amount</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">→ AI Target</th>
              {!readOnly && (
                <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Override</th>
              )}
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Confidence</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Source</th>
              {!readOnly && (
                <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Action</th>
              )}
              {readOnly && (
                <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Decision</th>
              )}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => {
              const flags = Array.isArray(r.anomaly_flags) ? r.anomaly_flags : [];
              const isBusy = busyId === r.id;
              const err = errorId?.id === r.id ? errorId.msg : null;
              const conf = r.ai_confidence ?? 0;
              const isSelected = selected.has(r.id);

              return (
                <tr
                  key={r.id}
                  className={`border-b border-gray-100 ${
                    isSelected ? "bg-teal/5" : flags.length > 0 ? "bg-amber-50/40" : "hover:bg-gray-50"
                  }`}
                >
                  {!readOnly && (
                    <td className="px-3 py-2.5 align-top">
                      <button
                        onClick={() => toggleRow(r.id)}
                        className="text-ink-slate hover:text-navy"
                        aria-label={isSelected ? "Deselect" : "Select"}
                      >
                        {isSelected ? (
                          <CheckSquare size={14} className="text-teal" />
                        ) : (
                          <Square size={14} />
                        )}
                      </button>
                    </td>
                  )}
                  <td className="px-4 py-2.5 text-ink-slate align-top whitespace-nowrap">
                    {r.transaction_date}
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    <div className="font-medium text-navy">{r.vendor_name || "(no vendor)"}</div>
                    {r.description && (
                      <div className="text-xs text-ink-slate truncate max-w-xs">{r.description}</div>
                    )}
                    {flags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {flags.map((f, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 text-[10px] font-semibold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded"
                            title={f.message}
                          >
                            <AlertTriangle size={9} />
                            {f.code.replace(/_/g, " ")}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-navy align-top">
                    ${(r.transaction_amount || 0).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    <div className="text-navy">
                      {r.suggested_account_name || (
                        <span className="text-ink-slate italic">no target</span>
                      )}
                    </div>
                    {r.ai_reasoning && (
                      <div className="text-xs text-ink-slate italic truncate max-w-xs">
                        {r.ai_reasoning}
                      </div>
                    )}
                  </td>
                  {!readOnly && (
                    <td className="px-4 py-2.5 align-top">
                      {availableAccounts.length > 0 ? (
                        <select
                          value={overrides.get(r.id)?.id || ""}
                          onChange={(e) => setOverride(r.id, e.target.value)}
                          className="text-xs rounded border border-gray-200 px-2 py-1 max-w-xs"
                        >
                          <option value="">— keep AI pick —</option>
                          {availableAccounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-ink-light">no accounts loaded</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-2.5 align-top">
                    <ConfidenceBadge value={conf} />
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    <SourceBadge source={r.source} />
                  </td>
                  {!readOnly && (
                    <td className="px-4 py-2.5 align-top">
                      <div className="flex flex-col items-end gap-1.5">
                        <div className="flex gap-1.5">
                          <button
                            onClick={() =>
                              act(
                                r,
                                overrides.has(r.id) ? "approve_with_override" : "approve"
                              )
                            }
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-600 text-white font-semibold text-xs rounded hover:bg-emerald-700 disabled:opacity-50"
                            title="Approve: post to QuickBooks"
                          >
                            {isBusy ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : (
                              <CheckCircle2 size={11} />
                            )}
                            Approve
                          </button>
                          <button
                            onClick={() => act(r, "reject")}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 px-2 py-1 border border-red-300 text-red-700 text-xs rounded hover:bg-red-50 disabled:opacity-50"
                            title="Reject: skip, leaves QuickBooks untouched"
                          >
                            <X size={11} />
                            Reject
                          </button>
                          <button
                            onClick={() => act(r, "ask_client")}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 px-2 py-1 border border-teal-border text-teal-dark text-xs rounded hover:bg-teal-light disabled:opacity-50"
                            title="Ask: hold for client input, surfaces in next client email"
                          >
                            <HelpCircle size={11} />
                            Ask
                          </button>
                        </div>
                        {err && (
                          <span className="text-[11px] text-red-600 font-semibold">{err}</span>
                        )}
                      </div>
                    </td>
                  )}
                  {readOnly && (
                    <td className="px-4 py-2.5 align-top">
                      <DecisionBadge decision={r.decision} />
                    </td>
                  )}
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr>
                <td
                  colSpan={readOnly ? 7 : 9}
                  className="px-4 py-8 text-center text-sm text-ink-slate"
                >
                  No rows match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tone: "navy" | "emerald" | "amber" | "red";
}) {
  const activeStyles = {
    navy: "bg-navy text-white border-navy",
    emerald: "bg-emerald-600 text-white border-emerald-600",
    amber: "bg-amber-500 text-white border-amber-500",
    red: "bg-red-600 text-white border-red-600",
  }[tone];
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-lg border font-semibold transition-colors ${
        active ? activeStyles : "border-gray-200 text-ink-slate hover:border-navy/30"
      }`}
    >
      {label}
    </button>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    value >= 0.95 ? "bg-emerald-100 text-emerald-700"
    : value >= 0.7 ? "bg-amber-100 text-amber-700"
    : "bg-red-100 text-red-700";
  return <span className={`text-xs px-2 py-0.5 rounded ${color} font-semibold`}>{pct}%</span>;
}

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return <span className="text-xs text-ink-light">—</span>;
  const labels: Record<string, { label: string; color: string; icon?: React.ReactNode }> = {
    kb: { label: "KB", color: "bg-blue-50 text-blue-700 border-blue-100" },
    bank_rule: { label: "Bank rule", color: "bg-teal-light text-teal-dark border-teal-border" },
    ai: { label: "AI", color: "bg-teal-lighter text-teal border-teal/20", icon: <Sparkles size={9} /> },
    web_search: { label: "Web", color: "bg-teal-light text-teal-dark border-teal-border" },
    unmatched: { label: "Unmatched", color: "bg-gray-50 text-ink-slate border-gray-100" },
  };
  const cfg = labels[source] || labels.unmatched;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border ${cfg.color}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function DecisionBadge({ decision }: { decision: string }) {
  const cfg: Record<string, { label: string; color: string }> = {
    executed: { label: "Executed", color: "bg-emerald-100 text-emerald-700" },
    approved: { label: "Approved", color: "bg-emerald-100 text-emerald-700" },
    auto_approved: { label: "Auto-approved", color: "bg-teal-lighter text-teal" },
    rejected: { label: "Rejected", color: "bg-red-100 text-red-700" },
    ask_client: { label: "Ask client", color: "bg-teal-light text-teal-dark" },
    pending: { label: "Pending", color: "bg-amber-100 text-amber-700" },
  };
  const c = cfg[decision] || cfg.pending;
  return <span className={`text-xs px-2 py-0.5 rounded font-semibold ${c.color}`}>{c.label}</span>;
}
