"use client";

/**
 * Unified CRM-Driven Cleanup — V2 review UI (workflow_version=2 runs only).
 *
 * V1 clients (Clean Cut Painters' in-flight run, etc.) keep rendering with
 * the legacy hardcore-cleanup-client.tsx component. The wrapper page branches
 * on run.workflow_version.
 *
 * Layout:
 *   - Top: customerSummary banner (CRM jobs vs QBO vs UF, sorted by mess)
 *   - 4 tab pills with counts: Duplicates / Missing Invoices / Unmatched Jobs / Unmatched Deposits
 *   - Each tab: virtualized table with per-row resolution picker + bulk-action bar
 *   - Unmatched Deposits tab: expandable rows showing suggested CRM job groupings (1:N)
 *   - Sticky footer: "Preview & Push to QBO" button → opens modal (next task #71)
 */

import { useState, useMemo, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Mail,
  Send,
  Eye,
  X as XIcon,
  FileText,
  Receipt,
  ArrowRightLeft,
  HelpCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────

interface Run {
  id: string;
  status: string;
  workflow_version: number;
  created_at: string;
  crm_source: string;
  crm_filename: string | null;
  crm_jobs_uploaded: number;
  qbo_invoices_scanned: number;
  duplicates_detected: number;
  total_phantom_ar: number;
  finalized_at: string | null;
  finalize_results: any;
}

interface Item {
  id: string;
  item_type:
    | "duplicate_invoice"
    | "missing_invoice"
    | "uf_match"
    | "unmatched_job"
    | "unmatched_uf";
  qbo_invoice_id: string | null;
  qbo_invoice_doc_number: string | null;
  qbo_invoice_date: string | null;
  qbo_invoice_amount: number | null;
  qbo_invoice_balance: number | null;
  qbo_customer_name: string | null;
  qbo_invoice_memo: string | null;
  surviving_qbo_invoice_doc_number: string | null;
  matched_crm_job_id: string | null;
  /** V2: array of CRM job UUIDs for 1:N bulk-deposit matches. */
  crm_job_ids: string[] | null;
  // UF snapshot fields (V2)
  uf_payment_id: string | null;
  uf_payment_date: string | null;
  uf_payment_amount: number | null;
  uf_customer_name: string | null;
  confidence: number;
  reasoning: string | null;
  resolution: string;
  resolution_target_account_id: string | null;
  resolution_target_account_name: string | null;
  resolution_notes: string | null;
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

type TabKey = "duplicates" | "missing" | "unmatched_jobs" | "unmatched_uf";

interface PreviewOp {
  item_id: string;
  kind: string;
  summary: string;
  body: any;
  warnings: string[];
}
interface PreviewBlocker {
  item_id: string;
  reason: string;
}
interface PreviewResponse {
  ok: boolean;
  total_resolved: number;
  ops: PreviewOp[];
  blockers: PreviewBlocker[];
  summary: {
    je_count: number;
    void_count: number;
    push_invoice_count: number;
    apply_payment_count: number;
    ask_client_count: number;
    manual_count: number;
    keep_count: number;
  };
}

const TABS: Array<{ key: TabKey; label: string; icon: any; matches: (i: Item) => boolean }> = [
  { key: "duplicates", label: "Duplicates", icon: Receipt, matches: (i) => i.item_type === "duplicate_invoice" },
  { key: "missing", label: "Missing Invoices", icon: FileText, matches: (i) => i.item_type === "missing_invoice" },
  { key: "unmatched_jobs", label: "Unmatched Jobs", icon: ArrowRightLeft, matches: (i) => i.item_type === "unmatched_job" },
  { key: "unmatched_uf", label: "Unmatched Deposits", icon: HelpCircle, matches: (i) => i.item_type === "unmatched_uf" },
];

function fmtMoney(n: number | null | undefined): string {
  const v = Number(n || 0);
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Main component ───────────────────────────────────────────────────────

export function UnifiedReviewClient({
  clientLinkId,
  clientName,
  initialRun,
}: {
  clientLinkId: string;
  clientName: string;
  initialRun: Run;
}) {
  const router = useRouter();
  const [run, setRun] = useState<Run>(initialRun);
  const [items, setItems] = useState<Item[]>([]);
  const [crmJobs, setCrmJobs] = useState<CrmJob[]>([]);
  const [accounts, setAccounts] = useState<QboAccount[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("duplicates");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** Preview modal state — populated when "Preview & Push" is clicked.
   *  Holds the ops list + blockers from /preview. Modal renders + waits
   *  for the bookkeeper to click "Confirm push" before firing /finalize. */
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pushing, setPushing] = useState(false);

  // Load run + items + crm_jobs. Accounts are loaded separately because
  // the run endpoint doesn't return them — same pattern as the v1 client.
  const loadRun = useCallback(
    async (runId: string) => {
      setLoading(true);
      try {
        const [runRes, acctRes] = await Promise.all([
          fetch(`/api/clients/${clientLinkId}/hardcore-cleanup/${runId}`),
          fetch(`/api/clients/${clientLinkId}/qbo-accounts`).catch(() => null),
        ]);
        if (!runRes.ok) throw new Error(`Failed to load run: HTTP ${runRes.status}`);
        const data = await runRes.json();
        setRun(data.run);
        setItems(data.items || []);
        // API returns snake_case crm_jobs; UI uses camelCase locally.
        setCrmJobs(data.crm_jobs || data.crmJobs || []);
        if (acctRes && acctRes.ok) {
          const a = await acctRes.json();
          setAccounts(
            (a.accounts || []).map((x: any) => ({
              id: x.id,
              name: x.name,
              accountType: x.accountType || x.account_type || "",
            }))
          );
        }
      } catch (e: any) {
        setError(e?.message || "Load failed");
      } finally {
        setLoading(false);
      }
    },
    [clientLinkId]
  );

  useEffect(() => {
    loadRun(initialRun.id);
  }, [loadRun, initialRun.id]);

  // Bucket counts
  const bucketCounts = useMemo(() => {
    const out: Record<TabKey, number> = {
      duplicates: 0,
      missing: 0,
      unmatched_jobs: 0,
      unmatched_uf: 0,
    };
    for (const i of items) {
      for (const t of TABS) {
        if (t.matches(i)) out[t.key]++;
      }
    }
    return out;
  }, [items]);

  // Pending counts per tab — drives the "X still pending" badges
  const pendingByTab = useMemo(() => {
    const out: Record<TabKey, number> = {
      duplicates: 0,
      missing: 0,
      unmatched_jobs: 0,
      unmatched_uf: 0,
    };
    for (const i of items) {
      if (i.resolution !== "pending") continue;
      for (const t of TABS) {
        if (t.matches(i)) out[t.key]++;
      }
    }
    return out;
  }, [items]);

  // Items for the active tab only
  const tabItems = useMemo(() => {
    const tab = TABS.find((t) => t.key === activeTab);
    if (!tab) return [];
    return items.filter(tab.matches);
  }, [items, activeTab]);

  // Resolved count across all tabs — drives the Push to QBO button
  const resolvedCount = useMemo(
    () =>
      items.filter(
        (i) => !["pending", "executed", "skipped", "failed"].includes(i.resolution)
      ).length,
    [items]
  );
  const pendingCount = useMemo(
    () => items.filter((i) => i.resolution === "pending").length,
    [items]
  );

  async function resolveItems(
    ids: string[],
    payload: {
      resolution: string;
      resolution_target_account_id?: string;
      resolution_target_account_name?: string;
      resolution_notes?: string;
    }
  ) {
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

  /** Open the preview modal: hits /preview to get the exact QBO ops the
   *  finalize step would run, shows them in a modal. Bookkeeper clicks
   *  "Confirm push" inside the modal to actually fire /finalize. */
  async function openPreview() {
    setPreviewLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/hardcore-cleanup/${run.id}/preview`,
        { method: "POST" }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setPreviewData(body as PreviewResponse);
    } catch (e: any) {
      setError(e?.message || "Preview failed");
    } finally {
      setPreviewLoading(false);
    }
  }

  /** Called from inside the preview modal when bookkeeper confirms. Fires
   *  the real /finalize endpoint and refreshes the run. */
  async function confirmPush() {
    setPushing(true);
    setError("");
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/hardcore-cleanup/${run.id}/finalize`,
        { method: "POST" }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setPreviewData(null);
      await loadRun(run.id);
    } catch (e: any) {
      setError(e?.message || "Push failed");
    } finally {
      setPushing(false);
    }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
        <Loader2 className="animate-spin mx-auto text-teal" size={24} />
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-24">
      {/* Header strip — run metadata + global stats */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-xs uppercase tracking-wide text-ink-slate font-bold">
              Run · {new Date(run.created_at).toLocaleString()}
            </div>
            <div className="text-sm text-navy mt-0.5">
              <span className="font-bold">{run.crm_source}</span>
              {run.crm_filename && <> · {run.crm_filename}</>}
              <span className="ml-2 text-ink-slate">
                · workflow v{run.workflow_version}
              </span>
            </div>
          </div>
          {run.status === "finalized" ? (
            <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2 py-1 rounded inline-flex items-center gap-1">
              <CheckCircle2 size={12} /> Finalized
            </span>
          ) : run.status === "review" ? (
            <span className="text-xs font-bold text-amber-700 bg-amber-50 px-2 py-1 rounded">
              In review
            </span>
          ) : (
            <span className="text-xs font-bold text-ink-slate bg-gray-100 px-2 py-1 rounded">
              {run.status}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="CRM jobs" value={String(run.crm_jobs_uploaded)} />
          <Stat label="QBO invoices" value={String(run.qbo_invoices_scanned)} />
          <Stat label="Duplicates" value={String(bucketCounts.duplicates)} tone={bucketCounts.duplicates > 0 ? "red" : "default"} />
          <Stat label="Unmatched UF" value={String(bucketCounts.unmatched_uf)} tone={bucketCounts.unmatched_uf > 0 ? "amber" : "default"} />
          <Stat label="Phantom A/R" value={fmtMoney(run.total_phantom_ar)} tone="red" />
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Tab pills */}
      <div className="flex items-center gap-1 border-b border-gray-200 overflow-x-auto">
        {TABS.map(({ key, label, icon: Icon }) => {
          const isActive = activeTab === key;
          const count = bucketCounts[key];
          const pending = pendingByTab[key];
          return (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors whitespace-nowrap ${
                isActive
                  ? "border-teal text-navy"
                  : "border-transparent text-ink-slate hover:text-navy hover:border-gray-200"
              }`}
            >
              <Icon size={15} />
              {label}
              <span
                className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                  pending > 0
                    ? "bg-amber-100 text-amber-800"
                    : count > 0
                    ? "bg-gray-200 text-ink-slate"
                    : "bg-gray-100 text-ink-light"
                }`}
              >
                {count}
                {pending > 0 && pending !== count && (
                  <span className="text-amber-600"> · {pending} pending</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {tabItems.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-sm text-ink-slate">
          {activeTab === "duplicates"
            ? "No duplicate invoices detected. ✓"
            : activeTab === "missing"
            ? "Every completed CRM job has a matching QBO invoice. ✓"
            : activeTab === "unmatched_jobs"
            ? "Every completed CRM job has a matching deposit. ✓"
            : "Every UF deposit ties to a CRM job. ✓"}
        </div>
      ) : (
        <TabContent
          tab={activeTab}
          items={tabItems}
          accounts={accounts}
          crmJobs={crmJobs}
          onResolve={resolveItems}
        />
      )}

      {/* Sticky push-to-QBO footer */}
      {resolvedCount > 0 && run.status === "review" && (
        <div className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-gray-200 shadow-lg px-6 py-3 flex items-center justify-between gap-3">
          <div className="text-sm text-navy">
            <span className="font-bold">{resolvedCount}</span> resolved
            {pendingCount > 0 && (
              <span className="ml-2 text-red-700 font-semibold">
                · ⚠ {pendingCount} still pending (will NOT push)
              </span>
            )}
          </div>
          <button
            onClick={openPreview}
            disabled={previewLoading || pushing}
            className="px-4 py-2 bg-teal hover:bg-teal-dark text-white font-bold text-sm rounded-lg disabled:opacity-60 inline-flex items-center gap-2"
          >
            {previewLoading ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
            {previewLoading ? "Building preview…" : `Preview & Push ${resolvedCount} to QBO`}
          </button>
        </div>
      )}

      {/* Preview-before-push modal — Mike's hard requirement. Shows the
          exact QBO ops finalize will execute, with blockers surfaced
          prominently. Confirm button fires /finalize. */}
      {previewData && (
        <PreviewModal
          data={previewData}
          pushing={pushing}
          onClose={() => setPreviewData(null)}
          onConfirm={confirmPush}
        />
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function Stat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "red" | "amber" }) {
  const colors: Record<typeof tone, string> = {
    default: "text-navy",
    red: "text-red-700",
    amber: "text-amber-700",
  };
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-slate font-bold">{label}</div>
      <div className={`text-lg font-bold mt-0.5 ${colors[tone]}`}>{value}</div>
    </div>
  );
}

function TabContent({
  tab,
  items,
  accounts,
  crmJobs,
  onResolve,
}: {
  tab: TabKey;
  items: Item[];
  accounts: QboAccount[];
  crmJobs: CrmJob[];
  onResolve: (ids: string[], payload: any) => Promise<void>;
}) {
  if (tab === "duplicates") return <DuplicatesTab items={items} accounts={accounts} onResolve={onResolve} />;
  if (tab === "missing") return <MissingInvoicesTab items={items} onResolve={onResolve} />;
  if (tab === "unmatched_jobs") return <UnmatchedJobsTab items={items} onResolve={onResolve} />;
  if (tab === "unmatched_uf") return <UnmatchedUfTab items={items} crmJobs={crmJobs} onResolve={onResolve} />;
  return null;
}

// ─── Duplicates tab ───────────────────────────────────────────────────────

function DuplicatesTab({
  items,
  accounts,
  onResolve,
}: {
  items: Item[];
  accounts: QboAccount[];
  onResolve: (ids: string[], payload: any) => Promise<void>;
}) {
  const pendingIds = items.filter((i) => i.resolution === "pending").map((i) => i.id);
  const suggestedBadDebt = useMemo(
    () => accounts.find((a) => /bad\s*debt|write[-\s]?off|uncollect/i.test(a.name)),
    [accounts]
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="space-y-3">
      {pendingIds.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm text-amber-900">
            <span className="font-bold">{pendingIds.length}</span> duplicate{pendingIds.length === 1 ? "" : "s"} pending —
            {suggestedBadDebt ? <> bulk write-off to <strong>{suggestedBadDebt.name}</strong>?</> : <> pick a write-off account.</>}
          </div>
          <div className="flex items-center gap-2">
            {suggestedBadDebt && (
              <button
                onClick={() =>
                  onResolve(pendingIds, {
                    resolution: "je_writeoff",
                    resolution_target_account_id: suggestedBadDebt.id,
                    resolution_target_account_name: suggestedBadDebt.name,
                  })
                }
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded"
              >
                Write off all → {suggestedBadDebt.name}
              </button>
            )}
            <button
              onClick={() => setPickerOpen(true)}
              className="px-3 py-1.5 bg-white border border-amber-300 text-amber-900 text-xs font-bold rounded hover:bg-amber-100"
            >
              Pick account…
            </button>
          </div>
        </div>
      )}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} onResolve={onResolve} accounts={accounts}>
            <div className="text-sm">
              <span className="font-semibold text-navy">
                {item.qbo_customer_name || "(no customer)"}
              </span>
              <span className="text-ink-slate ml-2">
                #{item.qbo_invoice_doc_number || item.qbo_invoice_id} · {item.qbo_invoice_date}
              </span>
              <div className="text-xs text-ink-slate mt-0.5">{item.reasoning}</div>
            </div>
            <div className="font-mono font-bold text-red-700 shrink-0">
              {fmtMoney(item.qbo_invoice_balance ?? item.qbo_invoice_amount)}
            </div>
          </ItemRow>
        ))}
      </div>
      {pickerOpen && (
        <BulkAccountPicker
          accounts={accounts}
          onClose={() => setPickerOpen(false)}
          onPick={(acct) => {
            setPickerOpen(false);
            onResolve(pendingIds, {
              resolution: "je_writeoff",
              resolution_target_account_id: acct.id,
              resolution_target_account_name: acct.name,
            });
          }}
        />
      )}
    </div>
  );
}

// ─── Missing invoices tab ─────────────────────────────────────────────────

function MissingInvoicesTab({
  items,
  onResolve,
}: {
  items: Item[];
  onResolve: (ids: string[], payload: any) => Promise<void>;
}) {
  const pendingIds = items.filter((i) => i.resolution === "pending").map((i) => i.id);
  return (
    <div className="space-y-3">
      {pendingIds.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm text-blue-900">
            <span className="font-bold">{pendingIds.length}</span> completed CRM job{pendingIds.length === 1 ? "" : "s"} with no QBO invoice.
            <span className="ml-1 text-xs">V2 will auto-push these via QBO createInvoice — for now, mark as manual handoff.</span>
          </div>
          <button
            onClick={() => onResolve(pendingIds, { resolution: "push_invoice" })}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded"
          >
            Mark all → push invoice (manual for V1)
          </button>
        </div>
      )}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} onResolve={onResolve}>
            <div className="text-sm">
              <span className="font-semibold text-navy">{item.qbo_customer_name}</span>
              <div className="text-xs text-ink-slate mt-0.5">{item.reasoning}</div>
            </div>
            <div className="font-mono font-bold text-blue-700 shrink-0">
              {fmtMoney(item.uf_payment_amount)}
            </div>
          </ItemRow>
        ))}
      </div>
    </div>
  );
}

// ─── Unmatched jobs tab ───────────────────────────────────────────────────

function UnmatchedJobsTab({
  items,
  onResolve,
}: {
  items: Item[];
  onResolve: (ids: string[], payload: any) => Promise<void>;
}) {
  return (
    <div className="space-y-3">
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-ink-slate">
        These CRM jobs are complete but no deposit was received. Likely still
        awaiting payment — usually informational only. Mark as <strong>keep</strong> to acknowledge.
      </div>
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} onResolve={onResolve}>
            <div className="text-sm">
              <span className="font-semibold text-navy">{item.qbo_customer_name}</span>
              <div className="text-xs text-ink-slate mt-0.5">{item.reasoning}</div>
            </div>
            <div className="font-mono font-bold text-ink-slate shrink-0">
              {fmtMoney(item.uf_payment_amount)}
            </div>
          </ItemRow>
        ))}
      </div>
    </div>
  );
}

// ─── Unmatched UF tab — with expandable bulk-deposit picker ────────────────

function UnmatchedUfTab({
  items,
  crmJobs,
  onResolve,
}: {
  items: Item[];
  crmJobs: CrmJob[];
  onResolve: (ids: string[], payload: any) => Promise<void>;
}) {
  const pendingIds = items.filter((i) => i.resolution === "pending").map((i) => i.id);
  return (
    <div className="space-y-3">
      {pendingIds.length > 0 && (
        <div className="bg-teal-light border border-teal-border rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm text-teal-dark">
            <span className="font-bold">{pendingIds.length}</span> UF deposit{pendingIds.length === 1 ? "" : "s"} with no CRM job match.
            <span className="ml-1 text-xs">Bulk-generate "ask the client" emails for all, OR expand each to manually pick matching jobs.</span>
          </div>
          <button
            onClick={() => onResolve(pendingIds, { resolution: "ask_client" })}
            className="px-3 py-1.5 bg-navy hover:bg-navy-deep text-white text-xs font-bold rounded inline-flex items-center gap-1"
          >
            <Mail size={12} />
            Ask client about all
          </button>
        </div>
      )}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
        {items.map((item) => (
          <UnmatchedUfRow key={item.id} item={item} crmJobs={crmJobs} onResolve={onResolve} />
        ))}
      </div>
    </div>
  );
}

function UnmatchedUfRow({
  item,
  crmJobs,
  onResolve,
}: {
  item: Item;
  crmJobs: CrmJob[];
  onResolve: (ids: string[], payload: any) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Suggest jobs from same customer with similar amounts
  const candidates = useMemo(() => {
    if (!item.uf_customer_name) return crmJobs;
    return crmJobs.filter((j) =>
      j.customer_name.toLowerCase().includes(item.uf_customer_name!.toLowerCase().split(" ")[0])
    );
  }, [crmJobs, item.uf_customer_name]);

  const pickedSum = useMemo(() => {
    return candidates
      .filter((c) => picked.has(c.id))
      .reduce((s, c) => s + (c.amount || 0), 0);
  }, [candidates, picked]);

  const targetAmount = Number(item.uf_payment_amount || 0);
  const matchOk = Math.abs(pickedSum - targetAmount) < 0.5;

  return (
    <div className={`${item.resolution === "ask_client" ? "bg-teal-light/30" : ""}`}>
      <div className="px-4 py-2.5 flex items-center justify-between gap-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 text-left flex items-center gap-2 min-w-0"
        >
          {expanded ? <ChevronDown size={14} className="text-ink-slate shrink-0" /> : <ChevronRight size={14} className="text-ink-slate shrink-0" />}
          <div className="min-w-0">
            <div className="text-sm font-semibold text-navy truncate">
              {item.uf_customer_name || "(no customer)"} · {fmtMoney(item.uf_payment_amount)}
            </div>
            <div className="text-xs text-ink-slate truncate">
              {item.uf_payment_date} · {item.qbo_invoice_memo || "(no memo)"}
            </div>
          </div>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {item.resolution !== "pending" && (
            <span className="text-[10px] font-bold uppercase bg-gray-200 text-ink-slate px-2 py-0.5 rounded">
              {item.resolution}
            </span>
          )}
          <button
            onClick={() => onResolve([item.id], { resolution: "ask_client" })}
            className="text-xs font-semibold text-teal-dark hover:text-teal-dark inline-flex items-center gap-1"
          >
            <Mail size={11} /> Ask client
          </button>
        </div>
      </div>
      {expanded && (
        <div className="px-8 py-3 bg-gray-50 border-t border-gray-100 space-y-2">
          <div className="text-xs font-bold text-ink-slate uppercase">
            Pick CRM jobs that this $ {fmtMoney(item.uf_payment_amount)} deposit pays off (bulk-deposit match):
          </div>
          {candidates.length === 0 ? (
            <div className="text-xs text-ink-slate italic">No similar-customer CRM jobs to pick from.</div>
          ) : (
            <>
              <div className="max-h-64 overflow-auto divide-y divide-gray-200 bg-white rounded border border-gray-200">
                {candidates.map((c) => {
                  const isPicked = picked.has(c.id);
                  return (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-gray-50"
                    >
                      <input
                        type="checkbox"
                        checked={isPicked}
                        onChange={(e) => {
                          const n = new Set(picked);
                          if (e.target.checked) n.add(c.id);
                          else n.delete(c.id);
                          setPicked(n);
                        }}
                      />
                      <span className="flex-1 truncate text-navy">
                        {c.customer_name}
                        {c.job_name && <span className="text-ink-slate"> · {c.job_name}</span>}
                      </span>
                      <span className="font-mono text-navy shrink-0">{fmtMoney(c.amount)}</span>
                    </label>
                  );
                })}
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-ink-slate">
                  Sum: <span className={`font-bold font-mono ${matchOk ? "text-emerald-700" : "text-red-700"}`}>{fmtMoney(pickedSum)}</span>
                  {" "}vs target <span className="font-mono">{fmtMoney(targetAmount)}</span>
                </span>
                <button
                  disabled={!matchOk || picked.size === 0}
                  onClick={() => {
                    onResolve([item.id], {
                      resolution: "apply_payment",
                      resolution_notes: `Bulk-deposit: applies to ${picked.size} CRM jobs`,
                    });
                    // TODO: persist crm_job_ids array via resolve endpoint — next iteration
                  }}
                  className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white text-xs font-bold rounded"
                >
                  Apply payment ({picked.size})
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Generic item row ─────────────────────────────────────────────────────

function ItemRow({
  item,
  onResolve,
  accounts,
  children,
}: {
  item: Item;
  onResolve: (ids: string[], payload: any) => Promise<void>;
  accounts?: QboAccount[];
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-gray-50">
      <div className="flex-1 min-w-0 flex items-start gap-3">
        {children}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {item.resolution === "pending" ? (
          <button
            onClick={() => onResolve([item.id], { resolution: "keep" })}
            className="text-xs text-ink-slate hover:text-navy inline-flex items-center gap-1"
          >
            <Check size={11} /> Keep
          </button>
        ) : (
          <span className="text-[10px] font-bold uppercase bg-gray-200 text-ink-slate px-2 py-0.5 rounded">
            {item.resolution}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Preview-before-push modal ────────────────────────────────────────────

function PreviewModal({
  data,
  pushing,
  onClose,
  onConfirm,
}: {
  data: PreviewResponse;
  pushing: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [expandedKinds, setExpandedKinds] = useState<Set<string>>(new Set(["je_writeoff", "direct_void"]));

  // Group ops by kind so the modal can render collapsible sections per type.
  // Cuts visual noise — bookkeeper expands the kinds they want to inspect.
  const opsByKind = useMemo(() => {
    const out = new Map<string, PreviewOp[]>();
    for (const op of data.ops) {
      const arr = out.get(op.kind) || [];
      arr.push(op);
      out.set(op.kind, arr);
    }
    return out;
  }, [data.ops]);

  const hasBlockers = data.blockers.length > 0;
  const totalExecutable = data.ops.length;
  // V2: push_invoice + apply_payment are real QBO writes too, not manual.
  const totalWritesToQbo =
    data.summary.je_count +
    data.summary.void_count +
    data.summary.push_invoice_count +
    data.summary.apply_payment_count;

  function toggleKind(k: string) {
    setExpandedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={pushing ? undefined : onClose} />
      <div className="fixed inset-4 md:inset-8 z-50 bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-w-5xl mx-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-bold text-navy">Preview — what will push to QBO</div>
            <div className="text-xs text-ink-slate mt-1">
              Review every operation below before confirming. Nothing has been
              written yet.
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={pushing}
            className="text-ink-slate hover:text-navy disabled:opacity-50"
            aria-label="Close"
          >
            <XIcon size={20} />
          </button>
        </div>

        {/* Summary strip */}
        <div className="px-6 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-4 flex-wrap text-xs">
          <span>
            <span className="font-bold text-navy">{totalExecutable}</span> ops planned
          </span>
          <span className="text-ink-slate">·</span>
          <span>
            <span className="font-bold text-emerald-700">{totalWritesToQbo}</span> real QBO writes
          </span>
          {data.summary.ask_client_count > 0 && (
            <>
              <span className="text-ink-slate">·</span>
              <span>
                <span className="font-bold text-teal-dark">{data.summary.ask_client_count}</span> ask-client emails
              </span>
            </>
          )}
          {/* push_invoice + apply_payment now ship as real QBO writes
              (V2), so they roll into totalWritesToQbo above. Kept this
              block empty to make the diff smaller. */}
          {hasBlockers && (
            <>
              <span className="text-ink-slate">·</span>
              <span>
                <span className="font-bold text-red-700">{data.blockers.length}</span> blocked
              </span>
            </>
          )}
        </div>

        {/* Blockers — always visible if any */}
        {hasBlockers && (
          <div className="px-6 py-3 bg-red-50 border-b border-red-200">
            <div className="text-sm font-bold text-red-800 mb-1.5">
              {data.blockers.length} item{data.blockers.length === 1 ? "" : "s"} blocked — fix before pushing
            </div>
            <ul className="text-xs text-red-700 space-y-0.5 max-h-32 overflow-auto">
              {data.blockers.map((b, i) => (
                <li key={i}>• {b.reason}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Body — ops grouped by kind */}
        <div className="flex-1 overflow-auto px-6 py-4 space-y-3">
          {opsByKind.size === 0 ? (
            <div className="text-center text-sm text-ink-slate py-12">
              No operations to preview. All resolved items are no-ops (keep/manual).
            </div>
          ) : (
            Array.from(opsByKind.entries()).map(([kind, ops]) => {
              const isOpen = expandedKinds.has(kind);
              return (
                <div key={kind} className="border border-gray-200 rounded-lg overflow-hidden">
                  <button
                    onClick={() => toggleKind(kind)}
                    className="w-full px-4 py-2.5 flex items-center justify-between bg-gray-50 hover:bg-gray-100"
                  >
                    <div className="flex items-center gap-2 text-sm font-bold text-navy">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      {opKindLabel(kind)} <span className="text-ink-slate font-normal">({ops.length})</span>
                    </div>
                    {opKindBadge(kind)}
                  </button>
                  {isOpen && (
                    <div className="divide-y divide-gray-100">
                      {ops.map((op) => (
                        <div key={op.item_id} className="px-4 py-2.5 text-xs">
                          <div className="text-navy">{op.summary}</div>
                          {op.warnings.length > 0 && (
                            <div className="text-amber-700 mt-1">
                              ⚠ {op.warnings.join(" · ")}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between gap-3">
          <button
            onClick={onClose}
            disabled={pushing}
            className="text-sm font-semibold text-ink-slate hover:text-navy disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={pushing || totalExecutable === 0}
            className="px-5 py-2 bg-teal hover:bg-teal-dark disabled:opacity-60 text-white font-bold text-sm rounded-lg inline-flex items-center gap-2"
          >
            {pushing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {pushing
              ? "Posting to QBO…"
              : `Confirm push (${totalExecutable} op${totalExecutable === 1 ? "" : "s"})`}
          </button>
        </div>
      </div>
    </>
  );
}

function opKindLabel(kind: string): string {
  switch (kind) {
    case "je_writeoff": return "JE write-offs";
    case "direct_void": return "Invoice voids";
    case "push_invoice": return "Create invoices";
    case "apply_payment": return "Apply UF payments";
    case "ask_client": return "Ask-client emails";
    case "keep": return "Marked keep";
    case "manual": return "Marked manual";
    default: return kind;
  }
}

function opKindBadge(kind: string) {
  const map: Record<string, { label: string; color: string }> = {
    je_writeoff: { label: "QBO WRITE", color: "bg-emerald-100 text-emerald-800" },
    direct_void: { label: "QBO WRITE", color: "bg-emerald-100 text-emerald-800" },
    push_invoice: { label: "QBO WRITE", color: "bg-emerald-100 text-emerald-800" },
    apply_payment: { label: "QBO WRITE", color: "bg-emerald-100 text-emerald-800" },
    ask_client: { label: "EMAIL", color: "bg-teal-light text-teal-dark" },
    keep: { label: "NO-OP", color: "bg-gray-100 text-ink-slate" },
    manual: { label: "NO-OP", color: "bg-gray-100 text-ink-slate" },
  };
  const cfg = map[kind] || { label: kind.toUpperCase(), color: "bg-gray-100 text-ink-slate" };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

// ─── Bulk account picker modal (shared with v1) ───────────────────────────

function BulkAccountPicker({
  accounts,
  onPick,
  onClose,
}: {
  accounts: QboAccount[];
  onPick: (acct: QboAccount) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const eligible = accounts.filter((a) => {
    const t = (a.accountType || "").toLowerCase();
    return (
      t.includes("expense") ||
      t.includes("equity") ||
      t.includes("income") ||
      t.includes("revenue") ||
      t.includes("cost of goods")
    );
  });
  const filtered = eligible.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4 pointer-events-none">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md pointer-events-auto overflow-hidden flex flex-col max-h-[80vh]">
          <div className="px-5 py-4 border-b border-gray-200">
            <div className="text-sm font-bold text-navy">Pick write-off account</div>
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
              <div className="px-4 py-8 text-center text-sm text-ink-slate">No accounts match</div>
            ) : (
              filtered.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onPick(a)}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-teal-lighter/40"
                >
                  <div className="font-semibold text-navy">{a.name}</div>
                  <div className="text-[11px] text-ink-slate">{a.accountType}</div>
                </button>
              ))
            )}
          </div>
          <div className="px-4 py-3 border-t border-gray-200 flex justify-end">
            <button onClick={onClose} className="text-xs font-semibold text-ink-slate px-3 py-1.5">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
