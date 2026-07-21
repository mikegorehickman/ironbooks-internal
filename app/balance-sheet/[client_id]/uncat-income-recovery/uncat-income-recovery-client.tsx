"use client";

import { useEffect, useMemo, useState } from "react";
import { playSound } from "@/lib/sounds";
import {
  Loader2, RefreshCw, AlertTriangle, CheckCircle2, X, Send,
  Sparkles, AlertCircle, Mail, Copy, Code, Search, FileSpreadsheet,
} from "lucide-react";

interface Scan {
  id: string;
  status: string;
  created_at: string;
  uncat_account_qbo_id: string | null;
  uncat_account_name: string | null;
  scan_from: string | null;
  scan_to: string | null;
  deposits_scanned: number;
  open_invoices_scanned: number;
  total_uncat_amount: number;
  exact_single_count: number;
  exact_multi_count: number;
  no_match_count: number;
  ai_status: string;
  ai_started_at: string | null;
  ai_finished_at: string | null;
  ai_duration_ms: number | null;
  ai_items_considered: number;
  ai_items_inferred: number;
  ai_error_message: string | null;
  duration_ms: number | null;
  error_message: string | null;
  finalized_at: string | null;
  finalize_results: any;
}

interface InvoiceCandidate {
  qbo_invoice_id: string;
  doc_number: string | null;
  customer_qbo_id: string | null;
  customer_name: string | null;
  txn_date: string;
  balance: number;
}

interface Item {
  id: string;
  qbo_txn_id: string;
  qbo_txn_type: string;
  qbo_line_id: string | null;
  txn_date: string;
  amount: number;
  description: string;
  private_note: string;
  bank_account_name: string | null;
  customer_qbo_id: string | null;
  customer_name: string | null;
  classification: "exact_single" | "exact_multi" | "ai_inferred" | "no_match";
  candidate_invoice_ids: InvoiceCandidate[];
  ai_inferred_customer_id: string | null;
  ai_inferred_customer_name: string | null;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  auto_approve_eligible: boolean;
  resolution: string;
  target_invoice_qbo_id: string | null;
  target_account_qbo_id: string | null;
  target_account_name: string | null;
  target_customer_qbo_id: string | null;
  target_customer_name: string | null;
  resolved_at: string | null;
  execution_error: string | null;
}

interface QboAccount {
  id: string;
  name: string;
  accountType: string;
}

const RESOLUTION_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "bg-amber-100 text-amber-800" },
  apply_to_invoice: { label: "Apply to invoice", color: "bg-emerald-100 text-emerald-800" },
  customer_deposits: { label: "Customer Deposits", color: "bg-blue-100 text-blue-800" },
  ask_client: { label: "Ask Client", color: "bg-orange-100 text-orange-800" },
  write_off: { label: "Write-off", color: "bg-red-100 text-red-800" },
  move_to_revenue: { label: "Move to revenue", color: "bg-teal-light text-teal-dark" },
  manual_investigation: { label: "Investigate", color: "bg-gray-100 text-gray-700" },
  executed: { label: "Done ✓", color: "bg-emerald-200 text-emerald-900" },
  failed: { label: "Failed", color: "bg-red-200 text-red-900" },
  skipped: { label: "Skipped", color: "bg-gray-100 text-ink-slate" },
};

const CLASSIFICATION_LABELS: Record<string, { label: string; color: string }> = {
  exact_single: { label: "1 match", color: "bg-emerald-100 text-emerald-800" },
  exact_multi: { label: "Multiple", color: "bg-amber-100 text-amber-800" },
  ai_inferred: { label: "AI guess", color: "bg-teal-light text-teal-dark" },
  no_match: { label: "No match", color: "bg-gray-100 text-ink-slate" },
};

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function UncatIncomeRecoveryClient({
  clientLinkId,
  clientName,
  latestScan,
}: {
  clientLinkId: string;
  clientName: string;
  latestScan: Scan | null;
}) {
  const [scan, setScan] = useState<Scan | null>(latestScan);
  const [items, setItems] = useState<Item[]>([]);
  const [accounts, setAccounts] = useState<QboAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [retryingAi, setRetryingAi] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"needs_input" | "resolved" | "all">("needs_input");
  const [search, setSearch] = useState("");
  const [emailDraft, setEmailDraft] = useState<{
    subject: string;
    email_text: string;
    email_html: string;
    deposit_count: number;
    total_amount: number;
  } | null>(null);
  const [emailLoading, setEmailLoading] = useState(false);

  async function loadScan(sId: string) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/uncat-income/${sId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setScan(body.scan);
      setItems(body.items || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (latestScan && latestScan.id && latestScan.status !== "scanning") {
      loadScan(latestScan.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestScan?.id]);

  // Stuck-state escape: if scan has been "scanning" for >90s the user can reset
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (scan?.status !== "scanning") {
      setStuck(false);
      return;
    }
    const t = setTimeout(() => setStuck(true), 90_000);
    return () => clearTimeout(t);
  }, [scan?.status, scan?.id]);

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

  async function startScan() {
    if (scan && (scan.status === "review" || scan.status === "finalizing")) {
      if (!confirm("Starting a new scan will cancel your in-progress review. Continue?")) return;
    }
    setScanning(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/uncat-income/scan`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadScan(body.scan_id);
      playSound("scan_complete");
    } catch (e: any) {
      setError(e?.message || "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  async function retryAi() {
    if (!scan) return;
    setRetryingAi(true);
    setError("");
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/uncat-income/${scan.id}/retry-ai`,
        { method: "POST" }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadScan(scan.id);
    } catch (e: any) {
      setError(e?.message || "AI retry failed");
    } finally {
      setRetryingAi(false);
    }
  }

  async function resolveItems(
    itemIds: string[],
    payload: {
      resolution: string;
      target_invoice_qbo_id?: string;
      target_account_qbo_id?: string;
      target_account_name?: string;
      target_customer_qbo_id?: string;
      target_customer_name?: string;
      resolution_notes?: string;
    },
    options?: { skipReload?: boolean }
  ) {
    if (!scan) return;
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/uncat-income/${scan.id}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item_ids: itemIds, ...payload }),
        }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (!options?.skipReload) await loadScan(scan.id);
    } catch (e: any) {
      setError(e?.message || "Resolve failed");
    }
  }

  async function autoApproveAll() {
    const eligible = items.filter(
      (i) => i.auto_approve_eligible && i.resolution === "pending"
    );
    if (eligible.length === 0) return;
    if (
      !confirm(
        `Auto-approve ${eligible.length} exact match${eligible.length === 1 ? "" : "es"} (each under $10k)? Each will be set to "Apply to invoice" using its single matching open invoice.`
      )
    ) {
      return;
    }
    // Each item maps to its own (single) candidate invoice — resolve in bulk
    // by candidate group
    const byInvoice = new Map<string, string[]>();
    for (const it of eligible) {
      const inv = (it.candidate_invoice_ids || [])[0];
      if (!inv) continue;
      const key = inv.qbo_invoice_id;
      if (!byInvoice.has(key)) byInvoice.set(key, []);
      byInvoice.get(key)!.push(it.id);
    }
    // Fire all updates in parallel WITHOUT triggering per-call reloads
    // (was a slow N+1 loop with one full scan reload per invoice — ~10s
    // for a 30-match scan). Reload once at the end.
    await Promise.all(
      Array.from(byInvoice.entries()).map(([invoiceId, ids]) => {
        const sample = eligible.find(
          (it) => (it.candidate_invoice_ids || [])[0]?.qbo_invoice_id === invoiceId
        );
        const inv = sample?.candidate_invoice_ids?.[0];
        return resolveItems(
          ids,
          {
            resolution: "apply_to_invoice",
            target_invoice_qbo_id: invoiceId,
            target_customer_qbo_id: inv?.customer_qbo_id || undefined,
            target_customer_name: inv?.customer_name || undefined,
          },
          { skipReload: true }
        );
      })
    );
    if (scan) await loadScan(scan.id);
  }

  async function finalize() {
    if (!scan) return;
    const queue = items.filter(
      (i) => !["pending", "executed", "skipped", "failed"].includes(i.resolution)
    );
    if (queue.length === 0) {
      setError("Nothing to finalize — resolve at least one item first.");
      return;
    }
    const total = queue.reduce((s, i) => s + i.amount, 0);
    if (
      !confirm(
        `Finalize ${queue.length} resolved deposit${queue.length === 1 ? "" : "s"} (${fmtMoney(total)})? This will post JEs to QBO.`
      )
    ) {
      return;
    }
    setFinalizing(true);
    setError("");
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/uncat-income/${scan.id}/finalize`,
        { method: "POST" }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadScan(scan.id);
      // Partial/full failure → louder error sound so the bookkeeper doesn't
      // miss a botched post to QBO. Clean success stays silent (visual ✓ banner is enough).
      if (body.failed && body.failed > 0) {
        playSound("finalize_failed");
      }
    } catch (e: any) {
      setError(e?.message || "Finalize failed");
      playSound("finalize_failed");
    } finally {
      setFinalizing(false);
    }
  }

  async function draftEmail() {
    if (!scan) return;
    setEmailLoading(true);
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/uncat-income/${scan.id}/email-draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filter: "all_unresolved" }),
        }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setEmailDraft(body);
    } catch (e: any) {
      setError(e?.message || "Email draft failed");
    } finally {
      setEmailLoading(false);
    }
  }

  async function forceReset() {
    if (!scan) return;
    if (!confirm("Force-reset this scan? It will be marked as failed and you can start fresh.")) return;
    await fetch(`/api/clients/${clientLinkId}/uncat-income/scan`, { method: "POST" });
    window.location.reload();
  }

  // ─── DERIVED ───
  const filteredItems = useMemo(() => {
    let list = items;
    if (filter === "needs_input") {
      list = list.filter((i) => i.resolution === "pending");
    } else if (filter === "resolved") {
      list = list.filter((i) => i.resolution !== "pending");
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((i) =>
        [i.description, i.private_note, i.customer_name, i.bank_account_name]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q))
      );
    }
    return list;
  }, [items, filter, search]);

  const autoEligible = items.filter((i) => i.auto_approve_eligible && i.resolution === "pending").length;
  const resolvedCount = items.filter((i) => !["pending", "executed", "skipped", "failed"].includes(i.resolution)).length;
  const executedCount = items.filter((i) => i.resolution === "executed").length;

  // ─── RENDER ───
  if (scanning || scan?.status === "scanning") {
    return (
      <div className="space-y-4">
        <div className="p-6 bg-white border border-slate-200 rounded-lg flex flex-col items-center text-center">
          <Loader2 size={40} className="animate-spin text-teal mb-3" />
          <div className="font-bold text-navy">Scanning Uncategorized Income…</div>
          <div className="text-sm text-ink-slate mt-1 max-w-md">
            Pulling deposits + JEs that hit Uncategorized Income, fetching open A/R invoices, and matching by amount. Then asking Claude to identify customers from bank descriptions. Usually 20–60 seconds.
          </div>
          {stuck && (
            <div className="mt-4 p-3 bg-amber-50 border border-amber-300 rounded text-sm text-amber-900">
              <div className="font-bold mb-1">Taking longer than expected.</div>
              <div>Stuck for over 90 seconds. The server may have died mid-scan.</div>
              <button
                onClick={forceReset}
                className="mt-2 px-3 py-1 bg-amber-700 text-white rounded text-xs font-semibold hover:bg-amber-800"
              >
                Force reset and try again
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!scan || scan.status === "failed") {
    return (
      <div className="space-y-4">
        {scan?.status === "failed" && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
            <div className="font-bold mb-1">Previous scan failed</div>
            <div>{scan.error_message || "Unknown error"}</div>
          </div>
        )}
        <div className="p-6 bg-white border border-slate-200 rounded-lg">
          <h2 className="text-lg font-bold text-navy mb-2">Start a new scan</h2>
          <p className="text-sm text-ink-slate mb-4 max-w-2xl">
            We'll pull every deposit + journal entry that hit Uncategorized Income
            in the past 2 years from QuickBooks, and every still-open invoice on
            the A/R Aging. Then we'll match them by amount + customer + date, and
            use AI to identify the rest from bank descriptions like "ACH MARTEL CONST".
          </p>
          <button
            onClick={startScan}
            disabled={scanning}
            className="px-4 py-2 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark disabled:opacity-60"
          >
            {scanning ? "Scanning…" : "Run Scan"}
          </button>
          {error && (
            <div className="mt-3 text-sm text-red-700">
              <AlertCircle size={14} className="inline mr-1" />
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary header */}
      <div className="p-4 bg-white border border-slate-200 rounded-lg">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-bold text-navy">
              {scan.uncat_account_name || "Uncategorized Income"}
            </div>
            <div className="text-xs text-ink-slate mt-0.5">
              Scanned {scan.scan_from || "—"} to {scan.scan_to || "—"} ·{" "}
              {scan.deposits_scanned} deposits · {scan.open_invoices_scanned} open invoices · Total{" "}
              {fmtMoney(scan.total_uncat_amount)}
            </div>
            <div className="flex gap-4 mt-2 text-xs">
              <span className="text-emerald-700">
                <CheckCircle2 size={12} className="inline mr-1" />
                {scan.exact_single_count} exact match
              </span>
              <span className="text-amber-700">
                {scan.exact_multi_count} multi-candidate
              </span>
              <span className="text-ink-slate">{scan.no_match_count} no match</span>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <button
              onClick={startScan}
              disabled={scanning}
              className="px-3 py-1.5 border border-slate-300 rounded text-xs font-semibold hover:bg-slate-50"
            >
              <RefreshCw size={12} className="inline mr-1" />
              Re-scan
            </button>
          </div>
        </div>
      </div>

      {/* AI status banner — CRITICAL: surface every non-success state visibly */}
      <AiStatusBanner scan={scan} onRetry={retryAi} retrying={retryingAi} />

      {/* Auto-approve banner */}
      {autoEligible > 0 && scan.status === "review" && (
        <div className="p-4 bg-emerald-50 border border-emerald-300 rounded-lg flex items-center justify-between">
          <div>
            <div className="font-bold text-emerald-900">
              <Sparkles size={14} className="inline mr-1" />
              {autoEligible} deposit{autoEligible === 1 ? "" : "s"} have exactly one match (under $10k each)
            </div>
            <div className="text-xs text-emerald-700 mt-0.5">
              One click approves all of them at once, applying each to its matched invoice. You can still review or reject any of them afterward.
            </div>
          </div>
          <button
            onClick={autoApproveAll}
            className="px-3 py-1.5 bg-emerald-600 text-white rounded text-sm font-semibold hover:bg-emerald-700"
          >
            Accept all {autoEligible}
          </button>
        </div>
      )}

      {/* Filter + Search bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex bg-white border border-slate-200 rounded-lg p-0.5">
          {(["needs_input", "resolved", "all"] as const).map((f) => {
            const count =
              f === "needs_input"
                ? items.filter((i) => i.resolution === "pending").length
                : f === "resolved"
                ? items.filter((i) => i.resolution !== "pending").length
                : items.length;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-xs font-semibold rounded ${
                  filter === f ? "bg-teal text-white" : "text-ink-slate hover:bg-slate-50"
                }`}
              >
                {f === "needs_input" ? "Needs my input" : f === "resolved" ? "Resolved" : "All"}{" "}
                · {count}
              </button>
            );
          })}
        </div>
        <div className="flex-1 max-w-sm relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-ink-slate" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search description, customer, bank…"
            className="w-full pl-8 pr-2 py-1.5 text-sm border border-slate-200 rounded-lg"
          />
        </div>
        <button
          onClick={draftEmail}
          disabled={emailLoading || items.length === 0}
          className="px-3 py-1.5 border border-slate-300 rounded text-xs font-semibold hover:bg-slate-50 disabled:opacity-60"
        >
          <Mail size={12} className="inline mr-1" />
          {emailLoading ? "Drafting…" : "Draft client email"}
        </button>
        {resolvedCount > 0 && scan.status === "review" && (
          <button
            onClick={finalize}
            disabled={finalizing}
            className="px-3 py-1.5 bg-teal text-white rounded text-xs font-semibold hover:bg-teal-dark disabled:opacity-60 ml-auto"
          >
            <Send size={12} className="inline mr-1" />
            {finalizing ? "Posting to QBO…" : `Finalize ${resolvedCount} to QBO`}
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError("")} className="text-red-700 hover:text-red-900">
            <X size={14} />
          </button>
        </div>
      )}

      {scan.status === "finalized" && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-900 flex items-center gap-2">
          <CheckCircle2 size={14} />
          Finalized at {new Date(scan.finalized_at!).toLocaleString()} · {executedCount} executed
          {(scan.finalize_results as any)?.failed > 0 &&
            ` · ${(scan.finalize_results as any).failed} failed`}
        </div>
      )}

      {/* Items list */}
      {loading ? (
        <div className="p-6 text-center">
          <Loader2 size={24} className="animate-spin text-teal mx-auto" />
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="p-12 text-center text-ink-slate text-sm">
          {filter === "needs_input"
            ? "Nothing pending — all items resolved or none found."
            : filter === "resolved"
            ? "No items resolved yet."
            : "No items in this scan."}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredItems.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              accounts={accounts}
              onResolve={(payload) => resolveItems([item.id], payload)}
            />
          ))}
        </div>
      )}

      {emailDraft && (
        <EmailDraftModal draft={emailDraft} onClose={() => setEmailDraft(null)} />
      )}
    </div>
  );
}

// ─── AI STATUS BANNER ─────────────────────────────────────────────────────

function AiStatusBanner({
  scan,
  onRetry,
  retrying,
}: {
  scan: Scan;
  onRetry: () => void;
  retrying: boolean;
}) {
  if (!scan.ai_status || scan.ai_status === "not_attempted") return null;

  if (scan.ai_status === "running") {
    return (
      <div className="p-3 bg-teal-light border border-teal-border rounded text-sm text-teal-dark flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" />
        AI customer inference is running…
      </div>
    );
  }

  if (scan.ai_status === "success") {
    if (scan.ai_items_inferred === 0) return null;
    return (
      <div className="p-3 bg-teal-light border border-teal-border rounded text-xs text-teal-dark flex items-center gap-2">
        <Sparkles size={14} />
        AI identified {scan.ai_items_inferred} customer{scan.ai_items_inferred === 1 ? "" : "s"} from bank descriptions ({scan.ai_duration_ms != null ? `${(scan.ai_duration_ms / 1000).toFixed(1)}s` : ""}).
      </div>
    );
  }

  // Anything that isn't success → loud banner with retry button. NEVER silent.
  const color =
    scan.ai_status === "skipped"
      ? "amber"
      : scan.ai_status === "partial"
      ? "amber"
      : "red";
  const colors = {
    amber: "bg-amber-50 border-amber-300 text-amber-900",
    red: "bg-red-50 border-red-300 text-red-900",
  }[color];
  const label =
    scan.ai_status === "skipped"
      ? "AI inference was skipped"
      : scan.ai_status === "partial"
      ? "AI inference partially succeeded"
      : scan.ai_status === "timeout"
      ? "AI inference timed out"
      : "AI inference failed";

  return (
    <div className={`p-3 border rounded text-sm flex items-start gap-2 ${colors}`}>
      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
      <div className="flex-1">
        <div className="font-bold">{label}</div>
        <div className="text-xs mt-0.5">
          {scan.ai_error_message || "No additional detail."}
          {scan.ai_items_considered > 0 && (
            <> · Considered {scan.ai_items_considered}, inferred {scan.ai_items_inferred}.</>
          )}
        </div>
        <div className="text-xs mt-1 opacity-80">
          You can still resolve every deposit manually below — AI assist is optional.
        </div>
      </div>
      {scan.ai_status !== "skipped" || scan.ai_error_message?.includes("API_KEY") ? null : null}
      <button
        onClick={onRetry}
        disabled={retrying}
        className="px-2 py-1 border rounded text-xs font-semibold hover:bg-white/50 disabled:opacity-60 flex-shrink-0"
      >
        {retrying ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        <span className="ml-1">Retry AI</span>
      </button>
    </div>
  );
}

// ─── ITEM ROW ─────────────────────────────────────────────────────────────

function ItemRow({
  item,
  accounts,
  onResolve,
}: {
  item: Item;
  accounts: QboAccount[];
  onResolve: (payload: {
    resolution: string;
    target_invoice_qbo_id?: string;
    target_account_qbo_id?: string;
    target_account_name?: string;
    target_customer_qbo_id?: string;
    target_customer_name?: string;
  }) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const cls = CLASSIFICATION_LABELS[item.classification] || { label: item.classification, color: "bg-gray-100" };
  const res = RESOLUTION_LABELS[item.resolution] || { label: item.resolution, color: "bg-gray-100" };

  const candidates = item.candidate_invoice_ids || [];
  const isDone = ["executed", "skipped", "failed"].includes(item.resolution);

  return (
    <div className={`border rounded-lg ${item.resolution === "pending" ? "bg-white border-slate-200" : "bg-slate-50 border-slate-200"}`}>
      <div className="p-3 flex items-start gap-3">
        <div className="flex-shrink-0 w-24 text-right">
          <div className="font-bold text-navy">{fmtMoney(item.amount)}</div>
          <div className="text-xs text-ink-slate">{item.txn_date}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls.color}`}>{cls.label}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${res.color}`}>{res.label}</span>
            {item.bank_account_name && (
              <span className="text-[10px] text-ink-slate">{item.bank_account_name}</span>
            )}
            {item.customer_name && (
              <span className="text-xs font-semibold text-navy">{item.customer_name}</span>
            )}
          </div>
          <div className="text-xs text-ink-slate mt-1 truncate">
            {item.description || item.private_note || <span className="italic">(no description)</span>}
          </div>
          {item.ai_reasoning && (
            <div className="text-[11px] text-teal-dark mt-0.5 italic">
              <Sparkles size={10} className="inline mr-0.5" />
              {item.ai_reasoning}
              {item.ai_confidence && ` (${Math.round(item.ai_confidence * 100)}% confident)`}
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
            className="px-2 py-1 text-xs font-semibold border border-slate-300 rounded hover:bg-slate-50"
          >
            {expanded ? "Close" : "Resolve"}
          </button>
        )}
      </div>

      {expanded && !isDone && (
        <ResolutionPicker
          item={item}
          candidates={candidates}
          accounts={accounts}
          onResolve={(p) => {
            onResolve(p);
            setExpanded(false);
          }}
        />
      )}
    </div>
  );
}

// ─── RESOLUTION PICKER ────────────────────────────────────────────────────

function ResolutionPicker({
  item,
  candidates,
  accounts,
  onResolve,
}: {
  item: Item;
  candidates: InvoiceCandidate[];
  accounts: QboAccount[];
  onResolve: (p: any) => void;
}) {
  const [picked, setPicked] = useState<string>(candidates[0]?.qbo_invoice_id || "");

  // Smart default target accounts
  const customerDeposits = useMemo(
    () =>
      accounts.find(
        (a) => /customer.*deposit|prepayment|deferred.*revenue/i.test(a.name) && /Liability/i.test(a.accountType)
      ),
    [accounts]
  );
  const badDebt = useMemo(
    () =>
      accounts.find(
        (a) => /bad debt|write[-\s]?off/i.test(a.name)
      ),
    [accounts]
  );
  const incomeAccounts = useMemo(
    () => accounts.filter((a) => /Income/i.test(a.accountType) && !/uncategori/i.test(a.name)),
    [accounts]
  );

  return (
    <div className="border-t border-slate-200 p-3 bg-slate-50 space-y-2">
      {/* Apply to invoice */}
      {candidates.length > 0 && (
        <div className="p-2 bg-white border border-emerald-200 rounded">
          <div className="text-xs font-semibold text-emerald-900 mb-1">
            Apply to invoice ({candidates.length} candidate{candidates.length === 1 ? "" : "s"})
          </div>
          <div className="space-y-1">
            {candidates.slice(0, 5).map((c) => (
              <label
                key={c.qbo_invoice_id}
                className="flex items-center gap-2 text-xs cursor-pointer"
              >
                <input
                  type="radio"
                  name={`inv-${item.id}`}
                  checked={picked === c.qbo_invoice_id}
                  onChange={() => setPicked(c.qbo_invoice_id)}
                />
                <span className="font-mono">{c.doc_number || c.qbo_invoice_id}</span>
                <span className="text-ink-slate">·</span>
                <span>{c.customer_name || "(no customer)"}</span>
                <span className="text-ink-slate">·</span>
                <span>{c.txn_date}</span>
                <span className="text-ink-slate">·</span>
                <span className="font-semibold">{fmtMoney(c.balance)}</span>
              </label>
            ))}
          </div>
          <button
            onClick={() => {
              const c = candidates.find((c) => c.qbo_invoice_id === picked);
              onResolve({
                resolution: "apply_to_invoice",
                target_invoice_qbo_id: picked,
                target_customer_qbo_id: c?.customer_qbo_id || undefined,
                target_customer_name: c?.customer_name || undefined,
              });
            }}
            disabled={!picked}
            className="mt-2 px-2 py-1 bg-emerald-600 text-white rounded text-xs font-semibold hover:bg-emerald-700 disabled:opacity-60"
          >
            Apply to selected invoice
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {customerDeposits && (
          <button
            onClick={() =>
              onResolve({
                resolution: "customer_deposits",
                target_account_qbo_id: customerDeposits.id,
                target_account_name: customerDeposits.name,
              })
            }
            className="p-2 bg-white border border-blue-200 rounded text-xs text-left hover:bg-blue-50"
          >
            <div className="font-semibold text-blue-900">→ Customer Deposits</div>
            <div className="text-blue-700 text-[11px]">
              Prepayment, no invoice yet — moves to "{customerDeposits.name}"
            </div>
          </button>
        )}
        <button
          onClick={() =>
            onResolve({
              resolution: "ask_client",
            })
          }
          className="p-2 bg-white border border-orange-200 rounded text-xs text-left hover:bg-orange-50"
        >
          <div className="font-semibold text-orange-900">📧 Ask client</div>
          <div className="text-orange-700 text-[11px]">
            Add to confirmation email — no auto-write
          </div>
        </button>
        {badDebt && (
          <button
            onClick={() =>
              onResolve({
                resolution: "write_off",
                target_account_qbo_id: badDebt.id,
                target_account_name: badDebt.name,
              })
            }
            className="p-2 bg-white border border-red-200 rounded text-xs text-left hover:bg-red-50"
          >
            <div className="font-semibold text-red-900">✕ Write off</div>
            <div className="text-red-700 text-[11px]">
              Not a real sale — moves to "{badDebt.name}"
            </div>
          </button>
        )}
        <button
          onClick={() =>
            onResolve({
              resolution: "manual_investigation",
            })
          }
          className="p-2 bg-white border border-slate-200 rounded text-xs text-left hover:bg-slate-100"
        >
          <div className="font-semibold text-ink-slate">🔍 Investigate</div>
          <div className="text-ink-slate text-[11px]">Flag, do nothing automated</div>
        </button>
      </div>

      {/* Move to revenue picker */}
      {incomeAccounts.length > 0 && (
        <details className="p-2 bg-white border border-teal-border rounded">
          <summary className="text-xs font-semibold text-teal-dark cursor-pointer">
            → Move to revenue account
          </summary>
          <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
            {incomeAccounts.map((a) => (
              <button
                key={a.id}
                onClick={() =>
                  onResolve({
                    resolution: "move_to_revenue",
                    target_account_qbo_id: a.id,
                    target_account_name: a.name,
                  })
                }
                className="block w-full text-left text-xs px-2 py-1 hover:bg-teal-light rounded"
              >
                {a.name}{" "}
                <span className="text-ink-slate text-[10px]">({a.accountType})</span>
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ─── EMAIL DRAFT MODAL ────────────────────────────────────────────────────

function EmailDraftModal({
  draft,
  onClose,
}: {
  draft: {
    subject: string;
    email_text: string;
    email_html: string;
    deposit_count: number;
    total_amount: number;
  };
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"rendered" | "plain" | "html">("rendered");
  const [copyStatus, setCopyStatus] = useState("");

  async function copyRich() {
    try {
      const blob = new Blob([draft.email_html], { type: "text/html" });
      const textBlob = new Blob([draft.email_text], { type: "text/plain" });
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": blob, "text/plain": textBlob }),
      ]);
      setCopyStatus("Copied formatted email");
      setTimeout(() => setCopyStatus(""), 2000);
    } catch {
      setCopyStatus("Browser blocked rich copy — use Plain text instead");
      setTimeout(() => setCopyStatus(""), 3000);
    }
  }
  async function copyText(content: string, label: string) {
    await navigator.clipboard.writeText(content);
    setCopyStatus(`Copied ${label}`);
    setTimeout(() => setCopyStatus(""), 2000);
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div className="font-bold text-navy">Client confirmation email</div>
            <div className="text-xs text-ink-slate">
              {draft.deposit_count} deposit{draft.deposit_count === 1 ? "" : "s"} · {fmtMoney(draft.total_amount)} · Subject: <code className="bg-slate-100 px-1">{draft.subject}</code>
            </div>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy">
            <X size={20} />
          </button>
        </div>
        <div className="px-4 pt-3 flex items-center gap-2 flex-wrap">
          <div className="flex bg-slate-100 rounded p-0.5">
            {(["rendered", "plain", "html"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 text-xs font-semibold rounded ${tab === t ? "bg-white shadow-sm" : "text-ink-slate"}`}
              >
                {t === "rendered" ? "Preview" : t === "plain" ? "Plain text" : "HTML source"}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button
            onClick={copyRich}
            className="px-3 py-1.5 bg-teal text-white text-xs font-semibold rounded hover:bg-teal-dark"
          >
            <Copy size={12} className="inline mr-1" />
            Copy formatted (Gmail/Outlook)
          </button>
          <button
            onClick={() => copyText(draft.email_text, "plain text")}
            className="px-3 py-1.5 border border-slate-300 text-xs font-semibold rounded hover:bg-slate-50"
          >
            <FileSpreadsheet size={12} className="inline mr-1" />
            Copy plain
          </button>
          <button
            onClick={() => copyText(draft.email_html, "HTML")}
            className="px-3 py-1.5 border border-slate-300 text-xs font-semibold rounded hover:bg-slate-50"
          >
            <Code size={12} className="inline mr-1" />
            Copy HTML
          </button>
        </div>
        {copyStatus && (
          <div className="mx-4 mt-2 px-2 py-1 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800">
            {copyStatus}
          </div>
        )}
        <div className="flex-1 overflow-auto p-4">
          {tab === "rendered" && (
            <div
              className="border border-slate-200 rounded p-2 bg-slate-50"
              dangerouslySetInnerHTML={{ __html: draft.email_html }}
            />
          )}
          {tab === "plain" && (
            <pre className="text-xs font-mono whitespace-pre-wrap p-3 bg-slate-50 rounded border border-slate-200">
              {draft.email_text}
            </pre>
          )}
          {tab === "html" && (
            <pre className="text-[10px] font-mono whitespace-pre-wrap p-3 bg-slate-50 rounded border border-slate-200 max-h-[60vh]">
              {draft.email_html}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
