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
  qbo_invoice_id: string;
  qbo_invoice_doc_number: string | null;
  qbo_invoice_date: string | null;
  qbo_invoice_amount: number | null;
  qbo_invoice_balance: number | null;
  qbo_customer_id: string | null;
  qbo_customer_name: string | null;
  matched_crm_job_id: string | null;
  surviving_qbo_invoice_id: string | null;
  surviving_qbo_invoice_doc_number: string | null;
  confidence: number;
  reasoning: string | null;
  resolution: string;
  resolution_target_account_id: string | null;
  resolution_target_account_name: string | null;
  resolution_notes: string | null;
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
  direct_void: { label: "Void", color: "bg-purple-100 text-purple-800" },
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

  async function uploadCsv(file: File, crmSource: "drip_jobs" | "jobber" | "generic") {
    setUploading(true);
    setError("");
    try {
      const text = await file.text();
      const res = await fetch(`/api/clients/${clientLinkId}/hardcore-cleanup/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crm_source: crmSource, crm_filename: file.name, csv_text: text }),
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
    const total = resolved.reduce((s, i) => s + Number(i.qbo_invoice_balance || i.qbo_invoice_amount || 0), 0);
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
      {noActiveRun && <UploadCard onUpload={uploadCsv} uploading={uploading} />}

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
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="font-bold text-amber-900 text-sm">
                  {pendingCount} duplicate{pendingCount === 1 ? "" : "s"} need a resolution
                </div>
                <div className="text-xs text-amber-700 mt-0.5">
                  Tip: JE write-off preserves filed-period totals. Direct void only safe for open periods.
                  {suggestedBadDebt && (
                    <> Suggested target: <strong>{suggestedBadDebt.name}</strong>.</>
                  )}
                </div>
              </div>
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
                  JE write-off all pending → {suggestedBadDebt.name}
                </button>
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
              <button
                onClick={finalize}
                disabled={finalizing}
                className="ml-auto px-3 py-1.5 bg-teal text-white rounded text-xs font-bold hover:bg-teal-dark disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {finalizing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                {finalizing ? "Posting to QBO…" : `Finalize ${resolvedCount} to QBO`}
              </button>
            )}
          </div>

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

function UploadCard({
  onUpload,
  uploading,
}: {
  onUpload: (file: File, crm: "drip_jobs" | "jobber" | "generic") => void;
  uploading: boolean;
}) {
  const [crm, setCrm] = useState<"drip_jobs" | "jobber" | "generic">("drip_jobs");
  const [file, setFile] = useState<File | null>(null);

  return (
    <div className="p-6 bg-white border border-slate-200 rounded-lg space-y-4">
      <div>
        <h2 className="text-lg font-bold text-navy">Start a Hardcore BS Cleanup</h2>
        <p className="text-sm text-ink-slate mt-1">
          Upload the client's job report from their CRM. SNAP will cross-reference against
          QBO open invoices and flag duplicates. You review and pick resolutions before anything
          touches QBO.
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-wider text-ink-slate">CRM source</label>
        <div className="flex gap-2 flex-wrap">
          {[
            { v: "drip_jobs", label: "Drip Jobs" },
            { v: "jobber", label: "Jobber" },
            { v: "generic", label: "Generic CSV" },
          ].map((opt) => (
            <button
              key={opt.v}
              onClick={() => setCrm(opt.v as any)}
              className={`px-3 py-1.5 rounded-lg border text-sm font-semibold ${
                crm === opt.v
                  ? "bg-teal text-white border-teal"
                  : "bg-white text-ink-slate border-slate-300 hover:bg-slate-50"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-ink-light">
          We map column headers like "Customer / Client", "Amount / Total", "Date / Created", "Status".
          Generic mode uses a permissive header lookup. If parsing fails, you'll see a clear error.
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-wider text-ink-slate">CSV file</label>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="block w-full text-sm border border-slate-300 rounded-lg p-2"
        />
        {file && (
          <div className="text-xs text-ink-slate flex items-center gap-1">
            <FileText size={11} /> {file.name} · {(file.size / 1024).toFixed(1)} KB
          </div>
        )}
      </div>

      <button
        onClick={() => file && onUpload(file, crm)}
        disabled={!file || uploading}
        className="px-4 py-2 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark disabled:opacity-50 inline-flex items-center gap-2"
      >
        {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
        {uploading ? "Processing…" : "Upload + run detection"}
      </button>
    </div>
  );
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
  const total = items.reduce((s, i) => s + Number(i.qbo_invoice_balance || i.qbo_invoice_amount || 0), 0);
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
            {fmtMoney(item.qbo_invoice_balance || item.qbo_invoice_amount)}
          </div>
          <div className="text-[11px] text-ink-light">
            #{item.qbo_invoice_doc_number || item.qbo_invoice_id}
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
            <div className="text-[11px] text-purple-700 mt-1">
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
          <div className="bg-purple-50 border border-purple-200 rounded p-3">
            <div className="text-xs font-bold text-purple-900 mb-1">Direct void (open period only)</div>
            <div className="text-[11px] text-purple-800 mb-2">
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
                  className="px-2 py-1 bg-purple-600 text-white text-xs font-semibold rounded hover:bg-purple-700"
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
