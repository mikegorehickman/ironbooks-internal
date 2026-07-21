"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Upload, FileText, Loader2, AlertCircle, X, CheckCircle2,
  Search, Send, Trash2, Eye, RefreshCw, Copy,
} from "lucide-react";

interface Run {
  id: string;
  status: string;
  created_at: string;
  crm_source: string;
  crm_filename: string | null;
  crm_jobs_uploaded: number;
  qbo_invoices_scanned: number;
  duplicates_detected: number;
  duplicates_resolved: number;
  duplicates_executed: number;
  total_phantom_ar: number;
  error_message: string | null;
  finalized_at: string | null;
  finalize_results: any;
}

interface Item {
  id: string;
  item_type: string;
  /** Null for v2 item types (missing_invoice / unmatched_job / unmatched_uf /
   *  uf_match) — they reference CRM jobs or UF deposits, not QBO invoices. */
  qbo_invoice_id: string | null;
  qbo_invoice_doc_number: string | null;
  qbo_invoice_date: string | null;
  qbo_invoice_amount: number | null;
  qbo_invoice_balance: number | null;
  qbo_customer_id: string | null;
  qbo_customer_name: string | null;
  matched_crm_job_id: string | null;
  surviving_qbo_invoice_id: string | null;
  surviving_qbo_invoice_doc_number: string | null;
  /** Set by the start route on missing_invoice + unmatched_job items —
   *  stashes the CRM job's expected dollar amount so the UI has something
   *  to display when there's no QBO invoice to source the amount from.
   *  Reused as the amount fallback in fmtMoney() calls. */
  uf_payment_amount: number | null;
  /** v2 UF-side fields, populated for unmatched_uf + uf_match items. */
  uf_payment_id: string | null;
  uf_payment_date: string | null;
  uf_customer_name: string | null;
  confidence: number;
  reasoning: string | null;
  resolution: string;
  resolution_target_account_id: string | null;
  resolution_target_account_name: string | null;
  resolution_notes: string | null;
  resolution_je_date: string | null;
  resolution_je_id: string | null;
  execution_error: string | null;
}

interface CrmJob {
  id: string;
  crm_job_id: string | null;
  job_name: string | null;
  customer_name: string;
  amount: number | null;
  job_date: string | null;
  job_status: string | null;
}

interface QboAccount {
  id: string;
  name: string;
  accountType: string;
}

const RESOLUTION_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "bg-amber-100 text-amber-800" },
  je_writeoff: { label: "JE write-off", color: "bg-red-100 text-red-800" },
  direct_void: { label: "Void", color: "bg-teal-light text-teal-dark" },
  keep: { label: "Keep", color: "bg-emerald-100 text-emerald-800" },
  manual: { label: "Manual", color: "bg-gray-100 text-ink-slate" },
  executed: { label: "Done ✓", color: "bg-emerald-200 text-emerald-900" },
  failed: { label: "Failed", color: "bg-red-200 text-red-900" },
  skipped: { label: "Skipped", color: "bg-gray-100 text-ink-slate" },
};

function fmtMoney(n: number | null | undefined): string {
  const v = Number(n || 0);
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function HardcoreCleanupClient({
  clientLinkId,
  clientName,
  latestRun,
}: {
  clientLinkId: string;
  clientName: string;
  latestRun: Run | null;
}) {
  const [run, setRun] = useState<Run | null>(latestRun);
  const [items, setItems] = useState<Item[]>([]);
  const [crmJobs, setCrmJobs] = useState<CrmJob[]>([]);
  const [accounts, setAccounts] = useState<QboAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  /** Opens the bulk-account-picker modal — needed when the chart of
   *  accounts has no auto-detected Bad Debt / Write-off account (the
   *  Clean Cut Painters case). */
  const [bulkPickerOpen, setBulkPickerOpen] = useState(false);
  /**
   * State for the "bulk JE for these N items" modal. When non-null, the
   * modal renders and lets the bookkeeper pick a target account + posting
   * date once and apply to every selected item. Closed by setting null.
   *
   * `kind` controls the modal's title + the account-type filter:
   *   "missing_invoice_je" → income-only accounts, "record this revenue" copy
   *   "writeoff"           → all writeoff-eligible accounts
   */
  const [bulkJeModal, setBulkJeModal] = useState<
    | {
        kind: "missing_invoice_je" | "writeoff";
        itemIds: string[];
        title: string;
        subtitle: string;
        accountFilter: "income" | "writeoff" | "choose";
        // Resolution to write on the items — usually "je_writeoff", but
        // could be different per kind.
        resolution: "je_writeoff";
      }
    | null
  >(null);
  // Default to showing only high-confidence (CRM-confirmed) duplicates.
  // Low-confidence Path B clusters can be false positives — change orders
  // / progress billings the CRM didn't include. Bookkeeper can toggle on.
  const [showLowConfidence, setShowLowConfidence] = useState(false);

  async function loadRun(rId: string) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/hardcore-cleanup/${rId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setRun(body.run);
      setItems(body.items || []);
      setCrmJobs(body.crm_jobs || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (latestRun && latestRun.id && latestRun.status !== "uploading" && latestRun.status !== "matching") {
      loadRun(latestRun.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestRun?.id]);

  useEffect(() => {
    fetch(`/api/clients/${clientLinkId}/qbo-accounts`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.accounts) return;
        setAccounts(
          d.accounts.map((a: any) => ({
            id: a.id,
            name: a.name,
            accountType: a.accountType || "",
          }))
        );
      })
      .catch(() => {});
  }, [clientLinkId]);

  /**
   * Submit one or more CSVs in a single hardcore-cleanup run. Server
   * concatenates the parsed CRM jobs from each file (using each file's
   * own crm_source for correct column mapping) and runs the matcher
   * once across the combined list. Lets the bookkeeper upload Jobber +
   * DripJobs together when a client uses both.
   */
  async function uploadCsvs(
    files: Array<{ file: File; crm: "drip_jobs" | "jobber" | "generic" | "stripe" }>
  ) {
    setUploading(true);
    setError("");
    try {
      const csvs = await Promise.all(
        files.map(async (f) => ({
          crm_source: f.crm,
          crm_filename: f.file.name,
          csv_text: await f.file.text(),
        }))
      );
      const res = await fetch(`/api/clients/${clientLinkId}/hardcore-cleanup/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvs }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadRun(body.run_id);
    } catch (e: any) {
      setError(e?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function resolveItems(
    ids: string[],
    payload: {
      resolution: string;
      resolution_target_account_id?: string;
      resolution_target_account_name?: string;
      resolution_notes?: string;
      resolution_je_date?: string;
    }
  ) {
    if (!run) return;
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/hardcore-cleanup/${run.id}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item_ids: ids, ...payload }),
        }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadRun(run.id);
    } catch (e: any) {
      setError(e?.message || "Resolve failed");
    }
  }

  async function finalize() {
    if (!run) return;
    const resolved = items.filter(
      (i) => !["pending", "executed", "skipped", "failed"].includes(i.resolution)
    );
    if (resolved.length === 0) {
      setError("Nothing to finalize — pick a resolution on at least one item first.");
      return;
    }
    const jeCount = resolved.filter((i) => i.resolution === "je_writeoff").length;
    const voidCount = resolved.filter((i) => i.resolution === "direct_void").length;
    const noOpCount = resolved.filter((i) => ["keep", "manual"].includes(i.resolution)).length;
    const total = resolved.reduce(
      (s, i) =>
        s +
        Number(
          i.qbo_invoice_balance ?? i.qbo_invoice_amount ?? i.uf_payment_amount ?? 0
        ),
      0
    );
    if (
      !confirm(
        `Finalize ${resolved.length} resolution${resolved.length === 1 ? "" : "s"} (${fmtMoney(total)} phantom A/R)?\n\n` +
          (jeCount > 0 ? `  • ${jeCount} JE write-off${jeCount === 1 ? "" : "s"} (preserve closed periods)\n` : "") +
          (voidCount > 0 ? `  • ${voidCount} direct void${voidCount === 1 ? "" : "s"} (current-period)\n` : "") +
          (noOpCount > 0 ? `  • ${noOpCount} marked keep/manual (no QBO write)\n` : "") +
          `\nThis pushes to QBO.`
      )
    )
      return;
    setFinalizing(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/hardcore-cleanup/${run.id}/finalize`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadRun(run.id);
    } catch (e: any) {
      setError(e?.message || "Finalize failed");
    } finally {
      setFinalizing(false);
    }
  }

  // Suggest a Bad Debt account from the chart
  const suggestedBadDebt = useMemo(
    () => accounts.find((a) => /bad\s*debt|write[-\s]?off|uncollect/i.test(a.name)) || null,
    [accounts]
  );

  const lowConfidenceCount = useMemo(
    () => items.filter((i) => i.confidence < 0.75 && i.resolution === "pending").length,
    [items]
  );

  // Group items by customer for cleaner review
  const grouped = useMemo(() => {
    let filtered = items;
    if (!showLowConfidence) {
      // Hide low-confidence (Path B no-CRM-match) by default — they're
      // often legitimate change orders / progress billings, not real dupes.
      // Resolved low-confidence items (keep / dismiss / done) stay visible
      // so the bookkeeper can audit their decisions.
      filtered = filtered.filter((i) => i.confidence >= 0.75 || i.resolution !== "pending");
    }
    if (search.trim()) {
      filtered = filtered.filter((i) =>
        [i.qbo_customer_name, i.qbo_invoice_doc_number, i.reasoning]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(search.toLowerCase()))
      );
    }
    const m = new Map<string, Item[]>();
    for (const i of filtered) {
      const key = i.qbo_customer_name || "(no customer)";
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(i);
    }
    return Array.from(m.entries()).sort((a, b) => {
      const sumA = a[1].reduce((s, i) => s + Number(i.qbo_invoice_balance || i.qbo_invoice_amount || 0), 0);
      const sumB = b[1].reduce((s, i) => s + Number(i.qbo_invoice_balance || i.qbo_invoice_amount || 0), 0);
      return sumB - sumA;
    });
  }, [items, search]);

  const pendingCount = items.filter((i) => i.resolution === "pending").length;
  const resolvedCount = items.filter(
    (i) => !["pending", "executed", "skipped", "failed"].includes(i.resolution)
  ).length;

  // ─── UPLOAD STATE (no run yet, or last run finalized/failed/cancelled) ───
  const noActiveRun = !run || ["finalized", "failed", "cancelled"].includes(run.status);

  return (
    <div className="space-y-4">
      {noActiveRun && <UploadCard onUpload={uploadCsvs} uploading={uploading} />}

      {run && (run.status === "uploading" || run.status === "matching") && (
        <div className="p-6 bg-white border border-slate-200 rounded-lg flex flex-col items-center text-center">
          <Loader2 size={32} className="animate-spin text-teal mb-3" />
          <div className="font-bold text-navy">
            {run.status === "uploading" ? "Parsing CRM data…" : "Cross-referencing against QBO…"}
          </div>
          <div className="text-xs text-ink-slate mt-1">
            Pulling open A/R + matching invoices to CRM jobs. Usually 10–30 seconds.
          </div>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError("")} className="text-red-700">
            <X size={14} />
          </button>
        </div>
      )}

      {run?.status === "failed" && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
          <div className="font-bold">Last run failed</div>
          <div className="text-xs">{run.error_message}</div>
        </div>
      )}

      {/* ─── REVIEW STATE ─── */}
      {run && ["review", "finalizing", "finalized"].includes(run.status) && (
        <>
          <div className="p-4 bg-white border border-slate-200 rounded-lg">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="text-xs text-ink-light">
                  Run from {new Date(run.created_at).toLocaleString()} · {run.crm_source} · {run.crm_filename || "(unnamed)"}
                </div>
                <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <Stat label="CRM jobs" value={run.crm_jobs_uploaded.toString()} />
                  <Stat label="QBO invoices" value={run.qbo_invoices_scanned.toString()} />
                  <Stat label="Duplicates" value={run.duplicates_detected.toString()} tone="red" />
                  <Stat label="Phantom A/R" value={fmtMoney(run.total_phantom_ar)} tone="red" />
                </div>
              </div>
              <button
                onClick={() => {
                  if (confirm("Start over with a new upload? The current run will be archived.")) {
                    setRun(null);
                    setItems([]);
                    setCrmJobs([]);
                  }
                }}
                className="px-3 py-1.5 border border-slate-300 rounded text-xs font-semibold hover:bg-slate-50 inline-flex items-center gap-1"
              >
                <RefreshCw size={12} />
                New run
              </button>
            </div>
          </div>

          {run.status === "finalized" && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-900 flex items-center gap-2">
              <CheckCircle2 size={14} />
              Finalized at {new Date(run.finalized_at!).toLocaleString()} ·{" "}
              {run.duplicates_executed} executed
              {(run.finalize_results as any)?.failed > 0 &&
                ` · ${(run.finalize_results as any).failed} failed`}
            </div>
          )}

          {/* Quick-pick toolbar */}
          {pendingCount > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-amber-900 text-sm">
                    {pendingCount} duplicate{pendingCount === 1 ? "" : "s"} need a resolution — ${" "}
                    {fmtMoney(
                      items
                        .filter((i) => i.resolution === "pending")
                        .reduce(
                          (s, i) =>
                            s +
                            Number(
                              i.qbo_invoice_balance ??
                                i.qbo_invoice_amount ??
                                i.uf_payment_amount ??
                                0
                            ),
                          0
                        )
                    )}{" "}
                    of phantom A/R
                  </div>
                  <div className="text-xs text-amber-700 mt-0.5">
                    Tip: JE write-off preserves filed-period totals. Direct void only safe for open periods.
                    {suggestedBadDebt ? (
                      <> Suggested target: <strong>{suggestedBadDebt.name}</strong>.</>
                    ) : (
                      <> No "Bad Debt" account found in QBO — use "Pick account" to choose one (e.g. Owner Equity, Sales Returns).</>
                    )}
                  </div>
                </div>
              </div>

              {/* Bulk-resolution actions — always render the pick-account button
                  so the workflow doesn't dead-end when the COA has no Bad Debt
                  account. The suggested-target shortcut still renders when
                  available for the one-click case. */}
              <div className="flex items-center gap-2 flex-wrap">
                {suggestedBadDebt && (
                  <button
                    onClick={() => {
                      const ids = items.filter((i) => i.resolution === "pending").map((i) => i.id);
                      if (ids.length === 0) return;
                      if (
                        !confirm(
                          `Mark all ${ids.length} pending duplicates as JE write-off → ${suggestedBadDebt.name}? ` +
                          `You can still change individual rows before finalize.`
                        )
                      )
                        return;
                      resolveItems(ids, {
                        resolution: "je_writeoff",
                        resolution_target_account_id: suggestedBadDebt.id,
                        resolution_target_account_name: suggestedBadDebt.name,
                      });
                    }}
                    className="px-3 py-1.5 bg-amber-600 text-white text-xs font-bold rounded hover:bg-amber-700"
                  >
                    JE write-off all → {suggestedBadDebt.name}
                  </button>
                )}
                <button
                  onClick={() => setBulkPickerOpen(true)}
                  className="px-3 py-1.5 bg-white border border-amber-300 text-amber-900 text-xs font-bold rounded hover:bg-amber-100"
                >
                  Bulk write-off → pick account…
                </button>
              </div>

              {/* Bulk account picker modal — opens when "Pick account" clicked.
                  Filtered to P&L + Equity accounts (typical write-off targets).
                  Type to search by name. Picking resolves all pending in one go. */}
              {bulkPickerOpen && (
                <BulkAccountPicker
                  accounts={accounts}
                  onClose={() => setBulkPickerOpen(false)}
                  onPick={(acct) => {
                    const ids = items
                      .filter((i) => i.resolution === "pending")
                      .map((i) => i.id);
                    setBulkPickerOpen(false);
                    if (ids.length === 0) return;
                    if (
                      !confirm(
                        `Mark all ${ids.length} pending duplicates as JE write-off → ${acct.name}?\n\n` +
                        `Total: ${fmtMoney(
                          items
                            .filter((i) => i.resolution === "pending")
                            .reduce(
                              (s, i) => s + Number(i.qbo_invoice_balance || i.qbo_invoice_amount || 0),
                              0
                            )
                        )}\n\nYou can still change individual rows before finalize.`
                      )
                    )
                      return;
                    resolveItems(ids, {
                      resolution: "je_writeoff",
                      resolution_target_account_id: acct.id,
                      resolution_target_account_name: acct.name,
                    });
                  }}
                />
              )}
            </div>
          )}

          {/* Filter */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex-1 max-w-sm relative">
              <Search size={14} className="absolute left-2.5 top-2.5 text-ink-slate" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search customer / invoice # / reasoning…"
                className="w-full pl-8 pr-2 py-1.5 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            {lowConfidenceCount > 0 && (
              <label className="inline-flex items-center gap-1.5 text-xs text-ink-slate cursor-pointer">
                <input
                  type="checkbox"
                  checked={showLowConfidence}
                  onChange={(e) => setShowLowConfidence(e.target.checked)}
                  className="rounded border-slate-300"
                />
                Include {lowConfidenceCount} low-confidence (no-CRM-match)
              </label>
            )}
            {resolvedCount > 0 && run.status === "review" && (
              <div className="ml-auto flex items-center gap-2">
                {/* Loud warning when finalize would skip pending items. Mike
                    hit this on Clean Cut — 78 sat pending, 1 was resolved,
                    Finalize processed just the 1 and looked like a success. */}
                {pendingCount > 0 && (
                  <span
                    className="text-[11px] font-semibold text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded inline-flex items-center gap-1"
                    title={`${pendingCount} unresolved items will NOT be processed. Use the bulk write-off above or pick a per-item resolution first.`}
                  >
                    ⚠ {pendingCount} still pending — will NOT be processed
                  </span>
                )}
                <button
                  onClick={finalize}
                  disabled={finalizing}
                  className="px-3 py-1.5 bg-teal text-white rounded text-xs font-bold hover:bg-teal-dark disabled:opacity-60 inline-flex items-center gap-1.5"
                >
                  {finalizing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                  {finalizing ? "Posting to QBO…" : `Finalize ${resolvedCount} to QBO`}
                </button>
              </div>
            )}
          </div>

          {/* Bulk actions grouped by item_type — the "process 82 items in
              one click" surface. Each item_type bucket shows count + sum
              and the bulk actions that make sense for that shape. */}
          {!loading && pendingCount > 0 && run.status === "review" && (
            <BulkActionsByType
              items={items}
              suggestedBadDebt={suggestedBadDebt}
              onResolveSimple={(ids, resolution) =>
                resolveItems(ids, { resolution })
              }
              onOpenJeModal={(opts) => setBulkJeModal(opts)}
            />
          )}

          {/* Bulk JE modal — opens from the bulk-action panel buttons.
              Combines income-account picker + posting-date input. */}
          {bulkJeModal && (
            <BulkJeModal
              accounts={accounts}
              title={bulkJeModal.title}
              subtitle={bulkJeModal.subtitle}
              accountFilter={bulkJeModal.accountFilter}
              defaultDate={new Date().toISOString().slice(0, 10)}
              onClose={() => setBulkJeModal(null)}
              onConfirm={({ accountId, accountName, jeDate, jeKind }) => {
                const ids = bulkJeModal.itemIds;
                setBulkJeModal(null);
                if (ids.length === 0) return;
                // Stash jeKind in resolution_notes so the audit trail records
                // whether the bookkeeper booked this as a revenue write-off
                // or a bad-debt expense. Finalize's JE direction is driven
                // by the picked account's accountType — Income on Cr side
                // for income picks, Expense on Dr side for bad-debt picks —
                // so the kind label is purely for traceability.
                resolveItems(ids, {
                  resolution: bulkJeModal.resolution,
                  resolution_target_account_id: accountId,
                  resolution_target_account_name: accountName,
                  resolution_je_date: jeDate,
                  resolution_notes: `bulk_je_kind:${jeKind}`,
                });
              }}
            />
          )}

          {loading ? (
            <div className="p-6 text-center"><Loader2 size={24} className="animate-spin text-teal mx-auto" /></div>
          ) : grouped.length === 0 ? (
            <div className="p-12 text-center text-ink-slate text-sm">
              {items.length === 0
                ? "No duplicates detected — congrats, the books here are clean."
                : "No items match your search."}
            </div>
          ) : (
            <div className="space-y-3">
              {grouped.map(([customer, rows]) => (
                <CustomerGroup
                  key={customer}
                  customer={customer}
                  items={rows}
                  crmJobs={crmJobs}
                  accounts={accounts}
                  suggestedBadDebt={suggestedBadDebt}
                  onResolve={resolveItems}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "red" | "default" }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-slate font-semibold">{label}</div>
      <div className={`text-lg font-bold ${tone === "red" ? "text-red-700" : "text-navy"}`}>{value}</div>
    </div>
  );
}

/**
 * Multi-CSV upload card. Bookkeeper adds one row per CRM file (Jobber,
 * DripJobs, etc.) and submits them as a single batch. Server merges
 * the parsed jobs and runs one detection pass across all sources, so a
 * client using both Jobber + DripJobs can reconcile against QBO in one
 * run instead of two.
 */
type UploadRow = {
  id: string;
  file: File | null;
  crm: "drip_jobs" | "jobber" | "generic" | "stripe";
};

function UploadCard({
  onUpload,
  uploading,
}: {
  onUpload: (
    files: Array<{ file: File; crm: "drip_jobs" | "jobber" | "generic" | "stripe" }>
  ) => void;
  uploading: boolean;
}) {
  // Default to one DripJobs row — preserves the prior "single Drip Jobs"
  // workflow for the common case. Bookkeeper can change source and/or
  // add more rows.
  const [rows, setRows] = useState<UploadRow[]>([
    { id: rowId(), file: null, crm: "drip_jobs" },
  ]);

  const ready = rows.filter((r) => r.file !== null);
  const totalKb =
    rows.reduce((s, r) => s + (r.file?.size || 0), 0) / 1024;

  function updateRow(id: string, patch: Partial<UploadRow>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, { id: rowId(), file: null, crm: "jobber" }]);
  }
  function removeRow(id: string) {
    setRows((rs) => (rs.length === 1 ? rs : rs.filter((r) => r.id !== id)));
  }

  return (
    <div className="p-6 bg-white border border-slate-200 rounded-lg space-y-4">
      <div>
        <h2 className="text-lg font-bold text-navy">Start a Hardcore BS Cleanup</h2>
        <p className="text-sm text-ink-slate mt-1">
          Upload the client&apos;s CRM job report. Most clients use one source —
          if yours uses more than one (e.g. Jobber + DripJobs), add each below
          and SNAP runs one combined detection pass against QBO open invoices.
          You review and pick resolutions before anything touches QBO.
        </p>
      </div>

      <div className="space-y-3">
        {rows.map((row, idx) => (
          <div
            key={row.id}
            className="border border-slate-200 rounded-lg p-3 bg-slate-50/40 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-slate">
                File {idx + 1}
              </span>
              {rows.length > 1 && (
                <button
                  onClick={() => removeRow(row.id)}
                  className="text-[11px] text-ink-light hover:text-red-600 inline-flex items-center gap-1"
                  title="Remove this file"
                >
                  <X size={11} /> Remove
                </button>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-slate">
                CRM source
              </label>
              <div className="flex gap-2 flex-wrap">
                {[
                  { v: "drip_jobs", label: "Drip Jobs" },
                  { v: "jobber", label: "Jobber" },
                  { v: "generic", label: "Generic CSV" },
                  { v: "stripe", label: "Stripe Payouts" },
                ].map((opt) => (
                  <button
                    key={opt.v}
                    onClick={() => updateRow(row.id, { crm: opt.v as any })}
                    className={`px-2.5 py-1 rounded-md border text-xs font-semibold ${
                      row.crm === opt.v
                        ? "bg-teal text-white border-teal"
                        : "bg-white text-ink-slate border-slate-300 hover:bg-slate-100"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-slate">
                CSV file
              </label>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) =>
                  updateRow(row.id, { file: e.target.files?.[0] || null })
                }
                className="block w-full text-sm border border-slate-300 rounded-lg p-2 bg-white"
              />
              {row.file && (
                <div className="text-xs text-ink-slate flex items-center gap-1">
                  <FileText size={11} /> {row.file.name} ·{" "}
                  {(row.file.size / 1024).toFixed(1)} KB
                </div>
              )}
            </div>
          </div>
        ))}

        <button
          onClick={addRow}
          disabled={uploading}
          className="text-xs font-semibold text-teal hover:text-teal-dark border border-dashed border-teal/40 hover:border-teal rounded-md px-3 py-2 inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          + Add another source (optional)
        </button>
        <div className="text-[11px] text-ink-light leading-snug">
          Column mapping uses each file&apos;s declared source. Combined
          payload max 4MB. Total queued: {ready.length} file
          {ready.length === 1 ? "" : "s"}
          {ready.length > 0 ? ` · ${totalKb.toFixed(1)} KB` : ""}.
        </div>
      </div>

      <button
        onClick={() => {
          const payload = ready.map((r) => ({ file: r.file as File, crm: r.crm }));
          if (payload.length > 0) onUpload(payload);
        }}
        disabled={ready.length === 0 || uploading}
        className="px-4 py-2 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark disabled:opacity-50 inline-flex items-center gap-2"
      >
        {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
        {uploading
          ? "Processing…"
          : ready.length > 1
          ? `Upload & detect (${ready.length} files)`
          : "Upload & detect"}
      </button>
    </div>
  );
}

function rowId(): string {
  return Math.random().toString(36).slice(2, 9);
}

function CustomerGroup({
  customer,
  items,
  crmJobs,
  accounts,
  suggestedBadDebt,
  onResolve,
}: {
  customer: string;
  items: Item[];
  crmJobs: CrmJob[];
  accounts: QboAccount[];
  suggestedBadDebt: QboAccount | null;
  onResolve: (
    ids: string[],
    payload: {
      resolution: string;
      resolution_target_account_id?: string;
      resolution_target_account_name?: string;
    }
  ) => void;
}) {
  // Same fallback as the per-row display — uf_payment_amount carries the
  // CRM job amount for missing_invoice / unmatched_job items that have no
  // QBO invoice. Without this fallback the group total renders as $0.00
  // for those types.
  const total = items.reduce(
    (s, i) =>
      s +
      Number(i.qbo_invoice_balance ?? i.qbo_invoice_amount ?? i.uf_payment_amount ?? 0),
    0
  );
  const pendingCount = items.filter((i) => i.resolution === "pending").length;

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
        <div>
          <div className="font-bold text-navy">{customer}</div>
          <div className="text-xs text-ink-slate">
            {items.length} duplicate{items.length === 1 ? "" : "s"} · {fmtMoney(total)} phantom A/R
          </div>
        </div>
        {pendingCount > 0 && suggestedBadDebt && (
          <button
            onClick={() => {
              const ids = items.filter((i) => i.resolution === "pending").map((i) => i.id);
              onResolve(ids, {
                resolution: "je_writeoff",
                resolution_target_account_id: suggestedBadDebt.id,
                resolution_target_account_name: suggestedBadDebt.name,
              });
            }}
            className="text-xs px-2 py-1 bg-amber-100 text-amber-900 rounded font-semibold hover:bg-amber-200"
          >
            JE write-off {pendingCount} → {suggestedBadDebt.name}
          </button>
        )}
      </div>
      <div className="divide-y divide-slate-100">
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            crmJobs={crmJobs}
            accounts={accounts}
            suggestedBadDebt={suggestedBadDebt}
            onResolve={onResolve}
          />
        ))}
      </div>
    </div>
  );
}

function ItemRow({
  item,
  crmJobs,
  accounts,
  suggestedBadDebt,
  onResolve,
}: {
  item: Item;
  crmJobs: CrmJob[];
  accounts: QboAccount[];
  suggestedBadDebt: QboAccount | null;
  onResolve: (
    ids: string[],
    payload: {
      resolution: string;
      resolution_target_account_id?: string;
      resolution_target_account_name?: string;
    }
  ) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const res = RESOLUTION_LABELS[item.resolution] || { label: item.resolution, color: "bg-gray-100" };
  const isDone = ["executed", "failed", "skipped"].includes(item.resolution);
  const crmJob = item.matched_crm_job_id
    ? crmJobs.find((j) => j.id === item.matched_crm_job_id)
    : null;

  const incomeAndExpenseAccounts = useMemo(
    () => accounts.filter((a) => /Expense|Income|Other/.test(a.accountType)),
    [accounts]
  );

  return (
    <div className="p-3 hover:bg-slate-50 transition-colors">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-28 text-right">
          <div className="font-bold text-navy text-sm">
            {/* Amount fallback order: qbo_invoice_balance (duplicate +
                survivor-related items) → qbo_invoice_amount → uf_payment_amount
                (where the start route stashed the CRM job's expected amount
                for missing_invoice + unmatched_job items, which have no QBO
                invoice and would otherwise render as $0). */}
            {fmtMoney(
              item.qbo_invoice_balance ??
                item.qbo_invoice_amount ??
                item.uf_payment_amount
            )}
          </div>
          <div className="text-[11px] text-ink-light">
            {item.qbo_invoice_doc_number || item.qbo_invoice_id
              ? `#${item.qbo_invoice_doc_number || item.qbo_invoice_id}`
              : "—"}
          </div>
          <div className="text-[11px] text-ink-slate">{item.qbo_invoice_date}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${res.color}`}>
              {res.label}
            </span>
            <span className="text-[10px] text-ink-light">
              {Math.round(item.confidence * 100)}% confident
            </span>
            {item.surviving_qbo_invoice_doc_number && (
              <span className="text-[11px] text-emerald-700">
                survivor: #{item.surviving_qbo_invoice_doc_number}
              </span>
            )}
          </div>
          {item.reasoning && (
            <div className="text-xs text-ink-slate mt-1 italic">{item.reasoning}</div>
          )}
          {crmJob && (
            <div className="text-[11px] text-teal-dark mt-1">
              CRM job: {crmJob.crm_job_id ? `#${crmJob.crm_job_id} · ` : ""}
              {crmJob.job_name || crmJob.customer_name} · {fmtMoney(crmJob.amount)} · {crmJob.job_date || "no date"}
            </div>
          )}
          {item.execution_error && (
            <div className="text-xs text-red-700 mt-1">
              <AlertCircle size={11} className="inline mr-0.5" />
              {item.execution_error}
            </div>
          )}
        </div>
        {!isDone && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-semibold px-2 py-1 border border-slate-300 rounded hover:bg-slate-50"
          >
            {expanded ? "Close" : "Resolve"}
          </button>
        )}
      </div>

      {expanded && !isDone && (
        <div className="mt-3 ml-31 pl-3 border-l-2 border-amber-200 space-y-2">
          {/* JE write-off — primary path */}
          <div className="bg-amber-50 border border-amber-200 rounded p-3">
            <div className="text-xs font-bold text-amber-900 mb-1">JE write-off (safe for closed periods)</div>
            <div className="text-[11px] text-amber-800 mb-2">
              Posts a JE today: Dr [target account], Cr A/R (for {item.qbo_customer_name}).
              Doesn't touch the original invoice — closed-period totals stay intact.
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer font-semibold text-amber-900">
                Pick target account
              </summary>
              <div className="mt-2 max-h-48 overflow-y-auto space-y-1">
                {suggestedBadDebt && (
                  <button
                    onClick={() => onResolve([item.id], {
                      resolution: "je_writeoff",
                      resolution_target_account_id: suggestedBadDebt.id,
                      resolution_target_account_name: suggestedBadDebt.name,
                    })}
                    className="block w-full text-left px-2 py-1 bg-amber-100 hover:bg-amber-200 rounded font-semibold"
                  >
                    ⭐ {suggestedBadDebt.name} <span className="text-ink-slate">({suggestedBadDebt.accountType})</span>
                  </button>
                )}
                {incomeAndExpenseAccounts.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => onResolve([item.id], {
                      resolution: "je_writeoff",
                      resolution_target_account_id: a.id,
                      resolution_target_account_name: a.name,
                    })}
                    className="block w-full text-left px-2 py-1 hover:bg-amber-50 rounded"
                  >
                    {a.name} <span className="text-ink-light">({a.accountType})</span>
                  </button>
                ))}
              </div>
            </details>
          </div>

          {/* Direct void */}
          <div className="bg-teal-light border border-teal-border rounded p-3">
            <div className="text-xs font-bold text-teal-dark mb-1">Direct void (open period only)</div>
            <div className="text-[11px] text-teal-dark mb-2">
              Voids the invoice in QBO. Use only when the invoice is in a period that hasn't been
              reported on — otherwise filed totals change.{" "}
              <strong>If the invoice has any payments applied, voiding leaves them as orphan
              customer overpayments.</strong>{" "}
              For paid-or-partially-paid invoices, prefer JE write-off.
            </div>
            {(() => {
              const partiallyPaid =
                item.qbo_invoice_balance != null &&
                item.qbo_invoice_amount != null &&
                Number(item.qbo_invoice_balance) < Number(item.qbo_invoice_amount);
              return (
                <button
                  onClick={() => {
                    const msg = partiallyPaid
                      ? `⚠ Invoice #${item.qbo_invoice_doc_number || item.qbo_invoice_id} appears to be partially paid ` +
                        `(balance $${item.qbo_invoice_balance} < amount $${item.qbo_invoice_amount}). ` +
                        `Voiding will leave orphan customer overpayments. Continue anyway?`
                      : `Void invoice #${item.qbo_invoice_doc_number || item.qbo_invoice_id} in QBO at finalize? ` +
                        `Only safe if the period hasn't been filed.`;
                    if (!confirm(msg)) return;
                    onResolve([item.id], { resolution: "direct_void" });
                  }}
                  className="px-2 py-1 bg-navy text-white text-xs font-semibold rounded hover:bg-navy-deep"
                >
                  <Trash2 size={11} className="inline mr-1" />
                  Mark for void
                </button>
              );
            })()}
          </div>

          {/* Keep / manual */}
          <div className="flex gap-2">
            <button
              onClick={() => onResolve([item.id], { resolution: "keep" })}
              className="flex-1 px-2 py-1.5 bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs rounded hover:bg-emerald-100"
            >
              <CheckCircle2 size={11} className="inline mr-1" />
              Keep — not a duplicate
            </button>
            <button
              onClick={() => onResolve([item.id], { resolution: "manual" })}
              className="flex-1 px-2 py-1.5 bg-slate-100 text-ink-slate text-xs rounded hover:bg-slate-200"
            >
              <Eye size={11} className="inline mr-1" />
              Mark manual — handle later
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Modal account picker for bulk writeoff. Filters to write-off-eligible
 * accounts (Expense / Equity / Income / COGS), searchable by name. Returns
 * the picked account via onPick + closes via onClose.
 *
 * Built inline to avoid a new shared component — specific enough to this
 * workflow that lifting it out would be premature. Factor out if a second
 * caller appears.
 */
function BulkAccountPicker({
  accounts,
  onPick,
  onClose,
  /**
   * Restrict the dropdown to specific account categories. Used by the
   * "bulk create JE for missing invoices" flow which only wants the
   * income side (Cr Income, Dr A/R) — surfacing Bad Debt or Equity
   * there would be a footgun.
   */
  accountTypeFilter = "writeoff",
  title,
  subtitle,
}: {
  accounts: QboAccount[];
  onPick: (acct: QboAccount) => void;
  onClose: () => void;
  accountTypeFilter?: "writeoff" | "income" | "all";
  title?: string;
  subtitle?: string;
}) {
  const [search, setSearch] = useState("");

  const eligible = accounts.filter((a) => {
    const t = (a.accountType || "").toLowerCase();
    if (accountTypeFilter === "income") {
      // Revenue side only — exclude Expense / COGS / Equity. We allow
      // both Income and Other Income (Intuit's classification for
      // miscellaneous receipts like late-fee income).
      return t.includes("income") || t.includes("revenue");
    }
    if (accountTypeFilter === "all") return true;
    // "writeoff" (default): expense / equity / income / revenue / COGS —
    // anything plausible for a balance-sheet writeoff JE.
    return (
      t.includes("expense") ||
      t.includes("equity") ||
      t.includes("income") ||
      t.includes("revenue") ||
      t.includes("cost of goods")
    );
  });
  const filtered = eligible.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4 pointer-events-none">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md pointer-events-auto overflow-hidden flex flex-col max-h-[80vh]">
          <div className="px-5 py-4 border-b border-gray-200">
            <div className="text-sm font-bold text-navy">
              {title || "Pick account to write off all pending duplicates"}
            </div>
            <div className="text-xs text-ink-slate mt-0.5">
              {subtitle ||
                "JE write-off preserves any closed-period totals. Common picks: Bad Debt, Owner Equity, Sales Returns."}
            </div>
          </div>
          <div className="px-4 py-2 border-b border-gray-100">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search accounts…"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-teal"
            />
          </div>
          <div className="flex-1 overflow-auto divide-y divide-gray-100">
            {filtered.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-ink-slate">
                {search
                  ? `No accounts match "${search}"`
                  : "No write-off-eligible accounts in this QBO. Create one in QBO first (e.g. 'Bad Debt' under Expense)."}
              </div>
            ) : (
              filtered.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onPick(a)}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-teal-lighter/40 transition-colors"
                >
                  <div className="font-semibold text-navy">{a.name}</div>
                  <div className="text-[11px] text-ink-slate">{a.accountType}</div>
                </button>
              ))
            )}
          </div>
          <div className="px-4 py-3 border-t border-gray-200 flex justify-end">
            <button
              onClick={onClose}
              className="text-xs font-semibold text-ink-slate hover:text-navy px-3 py-1.5"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Bulk actions panel — groups pending items by item_type and offers the
// resolutions that make sense for each shape. The 82-clicks problem on
// Clean Cut became 4-clicks once this landed.
// ────────────────────────────────────────────────────────────────────────

interface BulkOpts {
  kind: "missing_invoice_je" | "writeoff";
  itemIds: string[];
  title: string;
  subtitle: string;
  accountFilter: "income" | "writeoff" | "choose";
  resolution: "je_writeoff";
}

const ITEM_TYPE_LABELS: Record<string, string> = {
  duplicate_invoice: "Duplicate invoices",
  missing_invoice: "Missing invoices (CRM job → no QBO invoice)",
  orphan_uf_payment: "Orphan UF payments",
  stale_ar: "Stale A/R",
  unmatched_job: "Unmatched CRM jobs",
  unmatched_payment: "Unmatched payments",
};

function BulkActionsByType({
  items,
  suggestedBadDebt,
  onResolveSimple,
  onOpenJeModal,
}: {
  items: Item[];
  suggestedBadDebt: QboAccount | null;
  onResolveSimple: (ids: string[], resolution: string) => void;
  onOpenJeModal: (opts: BulkOpts) => void;
}) {
  // Bucket pending items by type. Only show groups with at least one
  // pending row — once everything is resolved the panel can collapse.
  const groups = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of items) {
      if (it.resolution !== "pending") continue;
      const arr = m.get(it.item_type) || [];
      arr.push(it);
      m.set(it.item_type, arr);
    }
    return Array.from(m.entries())
      .map(([type, rows]) => ({
        type,
        rows,
        ids: rows.map((r) => r.id),
        sum: rows.reduce(
          (s, r) => s + Number(r.qbo_invoice_balance ?? r.qbo_invoice_amount ?? 0),
          0
        ),
      }))
      .sort((a, b) => b.rows.length - a.rows.length);
  }, [items]);

  if (groups.length === 0) return null;

  function confirmAndResolve(ids: string[], resolution: string, label: string) {
    if (!confirm(`Mark all ${ids.length} items as ${label}?`)) return;
    onResolveSimple(ids, resolution);
  }

  return (
    <div className="rounded-xl border-2 border-teal/30 bg-teal-lighter/30 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-sm font-bold text-navy">
            Bulk actions ({groups.reduce((s, g) => s + g.rows.length, 0)} pending across {groups.length} type{groups.length === 1 ? "" : "s"})
          </div>
          <div className="text-xs text-ink-slate mt-0.5">
            Pick one action per type and resolve all rows at once. You can still tweak individual rows below before finalize.
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {groups.map((g) => (
          <div
            key={g.type}
            className="rounded-lg bg-white border border-gray-200 px-3 py-2.5 flex items-center gap-3 flex-wrap"
          >
            <div className="flex-1 min-w-[180px]">
              <div className="text-sm font-bold text-navy">
                {g.rows.length} × {ITEM_TYPE_LABELS[g.type] || g.type}
              </div>
              {g.sum > 0.01 && (
                <div className="text-[11px] text-ink-slate">
                  Total: <span className="font-mono">{fmtMoney(g.sum)}</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              {/* Action set per item_type */}
              {g.type === "duplicate_invoice" && (
                <>
                  <button
                    onClick={() => confirmAndResolve(g.ids, "direct_void", "Void in QBO")}
                    className="px-2.5 py-1 text-[11px] font-bold rounded bg-navy text-white hover:bg-navy-deep"
                    title="Void each QBO invoice. Open-period only."
                  >
                    Void all {g.rows.length}
                  </button>
                  <button
                    onClick={() =>
                      onOpenJeModal({
                        kind: "writeoff",
                        itemIds: g.ids,
                        title: `Write off ${g.rows.length} duplicate invoice${g.rows.length === 1 ? "" : "s"}`,
                        subtitle:
                          "Posts Dr {target} / Cr A/R for each row. Use when closed-period filed totals must stay intact.",
                        accountFilter: "writeoff",
                        resolution: "je_writeoff",
                      })
                    }
                    className="px-2.5 py-1 text-[11px] font-bold rounded bg-red-600 text-white hover:bg-red-700"
                  >
                    JE write-off all → pick account…
                  </button>
                </>
              )}

              {g.type === "missing_invoice" && (
                <>
                  <button
                    onClick={() =>
                      onOpenJeModal({
                        kind: "missing_invoice_je",
                        itemIds: g.ids,
                        title: `Create JE for ${g.rows.length} missing invoice${g.rows.length === 1 ? "" : "s"}`,
                        subtitle:
                          "Pick how to book the JE (write off revenue OR create bad debt), the target account, and the posting date. Same choice applies to every selected row.",
                        accountFilter: "choose",
                        resolution: "je_writeoff",
                      })
                    }
                    className="px-2.5 py-1 text-[11px] font-bold rounded bg-teal text-white hover:bg-teal-dark"
                  >
                    Bulk JE → write off revenue OR bad debt…
                  </button>
                  <button
                    onClick={() =>
                      confirmAndResolve(g.ids, "keep", "Keep (no QBO change)")
                    }
                    className="px-2.5 py-1 text-[11px] font-semibold rounded bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                  >
                    Mark all keep
                  </button>
                  <button
                    onClick={() =>
                      confirmAndResolve(g.ids, "manual", "Manual (skip for now)")
                    }
                    className="px-2.5 py-1 text-[11px] font-semibold rounded bg-white border border-gray-300 text-ink-slate hover:bg-gray-50"
                  >
                    Mark all manual
                  </button>
                </>
              )}

              {g.type === "stale_ar" && (
                <>
                  {suggestedBadDebt ? (
                    <button
                      onClick={() => {
                        if (!confirm(`Mark all ${g.rows.length} stale A/R items as JE write-off → ${suggestedBadDebt.name}?`)) return;
                        onResolveSimple(g.ids, "je_writeoff");
                      }}
                      className="px-2.5 py-1 text-[11px] font-bold rounded bg-amber-600 text-white hover:bg-amber-700"
                    >
                      JE write-off → {suggestedBadDebt.name}
                    </button>
                  ) : null}
                  <button
                    onClick={() =>
                      onOpenJeModal({
                        kind: "writeoff",
                        itemIds: g.ids,
                        title: `Write off ${g.rows.length} stale A/R balance${g.rows.length === 1 ? "" : "s"}`,
                        subtitle:
                          "Posts Dr {target} / Cr A/R. Typical target: Bad Debt or Sales Returns.",
                        accountFilter: "writeoff",
                        resolution: "je_writeoff",
                      })
                    }
                    className="px-2.5 py-1 text-[11px] font-semibold rounded bg-white border border-amber-300 text-amber-800 hover:bg-amber-50"
                  >
                    Pick different account…
                  </button>
                </>
              )}

              {g.type === "orphan_uf_payment" && (
                <span className="text-[11px] text-ink-slate italic">
                  Resolve per-row — apply_payment needs a target invoice picked individually.
                </span>
              )}

              {g.type === "unmatched_job" && (
                <>
                  <button
                    onClick={() => confirmAndResolve(g.ids, "keep", "Keep")}
                    className="px-2.5 py-1 text-[11px] font-semibold rounded bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                  >
                    Mark all keep
                  </button>
                  <button
                    onClick={() => confirmAndResolve(g.ids, "manual", "Manual")}
                    className="px-2.5 py-1 text-[11px] font-semibold rounded bg-white border border-gray-300 text-ink-slate hover:bg-gray-50"
                  >
                    Mark all manual
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Bulk JE modal — pick target account + posting date once, apply to N
// items. Combines BulkAccountPicker's filterable list with a date input
// at the bottom so the bookkeeper doesn't bounce between two modals.
// ────────────────────────────────────────────────────────────────────────

function BulkJeModal({
  accounts,
  title,
  subtitle,
  accountFilter,
  defaultDate,
  onClose,
  onConfirm,
}: {
  accounts: QboAccount[];
  title: string;
  subtitle: string;
  /**
   * `income` / `writeoff` lock the modal to that account category.
   * `choose` shows a two-card toggle at the top so the bookkeeper picks
   * "Write off revenue" (income side: Cr Income, Dr A/R — reduce revenue
   * to reflect that the CRM job didn't actually become recognized income)
   * vs "Create bad debt" (expense side: Dr Bad Debt, Cr A/R — book the
   * loss against an expense account). Switching the toggle flips the
   * account list filter live, no second modal.
   */
  accountFilter: "income" | "writeoff" | "choose";
  defaultDate: string;
  onClose: () => void;
  onConfirm: (opts: {
    accountId: string;
    accountName: string;
    jeDate: string;
    jeKind: "income" | "writeoff";
  }) => void;
}) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<QboAccount | null>(null);
  const [jeDate, setJeDate] = useState(defaultDate);
  // Kind selector. Locked when accountFilter is "income" or "writeoff";
  // live-toggleable when "choose". Default to "income" in choose mode —
  // write-off-revenue is the more common path for missing_invoice items
  // (revenue was reported elsewhere and shouldn't be doubled up).
  const [jeKind, setJeKind] = useState<"income" | "writeoff">(
    accountFilter === "writeoff" ? "writeoff" : "income"
  );
  const activeFilter: "income" | "writeoff" =
    accountFilter === "choose" ? jeKind : accountFilter;

  const eligible = useMemo(() => {
    return accounts.filter((a) => {
      const t = (a.accountType || "").toLowerCase();
      if (activeFilter === "income") {
        return t.includes("income") || t.includes("revenue");
      }
      // writeoff
      return (
        t.includes("expense") ||
        t.includes("equity") ||
        t.includes("income") ||
        t.includes("revenue") ||
        t.includes("cost of goods")
      );
    });
  }, [accounts, activeFilter]);

  const filtered = eligible.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase())
  );

  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(jeDate);
  const canConfirm = picked != null && dateValid;

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} aria-hidden="true" />
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4 pointer-events-none">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md pointer-events-auto overflow-hidden flex flex-col max-h-[85vh]">
          <div className="px-5 py-4 border-b border-gray-200">
            <div className="text-sm font-bold text-navy">{title}</div>
            <div className="text-xs text-ink-slate mt-0.5 leading-snug">{subtitle}</div>
          </div>

          {/* Kind toggle — only when caller asked for "choose" mode. Two
              cards, picks reset on change so the bookkeeper can't carry a
              stale income-account selection into a bad-debt JE. */}
          {accountFilter === "choose" && (
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/40">
              <label className="text-[11px] font-bold uppercase tracking-wider text-ink-slate block mb-2">
                JE kind
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (jeKind !== "income") {
                      setJeKind("income");
                      setPicked(null);
                      setSearch("");
                    }
                  }}
                  className={`text-left rounded-lg border-2 px-3 py-2.5 transition-colors ${
                    jeKind === "income"
                      ? "bg-teal-lighter/50 border-teal text-navy"
                      : "bg-white border-gray-200 hover:border-gray-300 text-ink-slate"
                  }`}
                >
                  <div className="text-xs font-bold">Write off revenue</div>
                  <div className="text-[10px] leading-snug mt-0.5">
                    Cr Income · Dr A/R. Use when the CRM job&apos;s revenue is already in QBO somewhere else, or shouldn&apos;t be recognized.
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (jeKind !== "writeoff") {
                      setJeKind("writeoff");
                      setPicked(null);
                      setSearch("");
                    }
                  }}
                  className={`text-left rounded-lg border-2 px-3 py-2.5 transition-colors ${
                    jeKind === "writeoff"
                      ? "bg-amber-50 border-amber-500 text-navy"
                      : "bg-white border-gray-200 hover:border-gray-300 text-ink-slate"
                  }`}
                >
                  <div className="text-xs font-bold">Create bad debt</div>
                  <div className="text-[10px] leading-snug mt-0.5">
                    Dr Bad Debt (expense) · Cr A/R. Use when the customer truly owed money that won&apos;t be collected.
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* Date picker */}
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/40">
            <label className="text-[11px] font-bold uppercase tracking-wider text-ink-slate block mb-1">
              JE posting date
            </label>
            <input
              type="date"
              value={jeDate}
              onChange={(e) => setJeDate(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-teal"
            />
            <p className="text-[10px] text-ink-light mt-1 leading-snug">
              Posts every JE on this date in QBO. Pick the CRM job period (or
              the cleanup "as-of" date) so the period totals reconcile.
            </p>
          </div>

          {/* Account search */}
          <div className="px-4 py-2 border-b border-gray-100">
            <label className="text-[11px] font-bold uppercase tracking-wider text-ink-slate block mb-1">
              Target account ({activeFilter === "income" ? "income only" : "writeoff-eligible"})
            </label>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search accounts…"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-teal"
            />
          </div>

          {/* Account list */}
          <div className="flex-1 overflow-auto divide-y divide-gray-100 max-h-[40vh]">
            {filtered.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-ink-slate">
                {search
                  ? `No accounts match "${search}"`
                  : activeFilter === "income"
                  ? "No income accounts found in this QBO. Create one first (e.g. 'Sales — Painting' under Income)."
                  : "No write-off-eligible accounts in this QBO."}
              </div>
            ) : (
              filtered.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setPicked(a)}
                  className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                    picked?.id === a.id
                      ? "bg-teal-lighter/60 border-l-4 border-teal"
                      : "hover:bg-teal-lighter/30"
                  }`}
                >
                  <div className="font-semibold text-navy">{a.name}</div>
                  <div className="text-[11px] text-ink-slate">{a.accountType}</div>
                </button>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between gap-3">
            <div className="text-[11px] text-ink-slate min-w-0 truncate">
              {picked ? (
                <>
                  Selected: <strong className="text-navy">{picked.name}</strong> · {jeDate}
                </>
              ) : (
                <>Pick an account to continue.</>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={onClose}
                className="text-xs font-semibold text-ink-slate hover:text-navy px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!canConfirm || !picked) return;
                  onConfirm({
                    accountId: picked.id,
                    accountName: picked.name,
                    jeDate,
                    jeKind: activeFilter,
                  });
                }}
                disabled={!canConfirm}
                className="text-xs font-bold text-white bg-teal hover:bg-teal-dark disabled:opacity-40 disabled:cursor-not-allowed rounded px-3 py-1.5"
              >
                Apply to all
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
