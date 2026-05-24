"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Loader2, RefreshCw, Search, AlertTriangle, CheckCircle2, X,
  Send, ChevronDown, ChevronRight, Wallet, ArrowLeft, ArrowRight,
  AlertCircle, Mail, FileSpreadsheet,
} from "lucide-react";

interface Scan {
  id: string;
  status: string;
  created_at: string;
  uf_account_qbo_id: string | null;
  uf_payments_total: number;
  matched_count: number;
  orphan_count: number;
  total_uf_balance: number;
  total_orphan_amount: number;
  duration_ms: number | null;
  error_message: string | null;
  finalized_at: string | null;
  finalize_results: any;
}

interface Item {
  id: string;
  scan_id: string;
  qbo_payment_id: string;
  qbo_payment_txn_type: string;
  payment_date: string;
  payment_amount: number;
  customer_name: string | null;
  customer_qbo_id: string | null;
  applied_invoice_ids: string[];
  payment_memo: string;
  classification: "matched" | "orphan";
  matched_deposit_id: string | null;
  matched_deposit_date: string | null;
  matched_deposit_bank_account: string | null;
  resolution: string;
  resolution_target_account_id: string | null;
  resolution_target_account_name: string | null;
  resolution_notes: string | null;
  resolved_at: string | null;
  execution_error: string | null;
}

interface QboAccount {
  id: string;
  name: string;
  accountType: string;
}

const RESOLUTION_LABELS: Record<string, { label: string; color: string; description: string }> = {
  pending: { label: "Pending", color: "bg-amber-100 text-amber-800", description: "Decide what to do with this orphan" },
  owner_draw: { label: "Owner Draw", color: "bg-purple-100 text-purple-800", description: "Cash kept by owner — JE: Dr Owner Draw, Cr UF" },
  write_off: { label: "Write-off", color: "bg-red-100 text-red-800", description: "Not a real payment — JE: Dr Bad Debt (or similar), Cr UF" },
  duplicate_recategorize: { label: "Duplicate", color: "bg-blue-100 text-blue-800", description: "Real deposit exists elsewhere — bookkeeper finds + re-categorizes in QBO" },
  ask_client: { label: "Ask Client", color: "bg-orange-100 text-orange-800", description: "Queue for confirmation email — no auto-write" },
  manual_investigation: { label: "Investigate", color: "bg-gray-100 text-gray-700", description: "Flag, do nothing automated" },
  executed: { label: "Done ✓", color: "bg-emerald-100 text-emerald-700", description: "Posted to QBO" },
  failed: { label: "Failed", color: "bg-red-200 text-red-900", description: "QBO rejected this — see error" },
  skipped: { label: "Matched", color: "bg-gray-100 text-ink-slate", description: "Already deposited (no action)" },
};

export function UfAuditClient({
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
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"orphan" | "matched" | "all">("orphan");

  async function loadScan(sId: string) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/uf-audit/${sId}`);
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

  // Pull live QBO accounts for resolution target dropdowns
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
    setScanning(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/uf-audit/scan`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadScan(body.scan_id);
    } catch (e: any) {
      setError(e?.message || "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  async function resolveGroup(opts: {
    customer_qbo_id?: string | null;
    customer_name?: string | null;
    payment_ids?: string[];
    resolution: string;
    target_account_id?: string;
    target_account_name?: string;
  }) {
    if (!scan) return;
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/uf-audit/${scan.id}/resolve-group`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadScan(scan.id);
    } catch (e: any) {
      setError(e?.message || "Resolve failed");
    }
  }

  async function finalize() {
    if (!scan) return;
    const resolved = items.filter(
      (i) => i.classification === "orphan" && !["pending", "executed", "skipped"].includes(i.resolution)
    );
    const ownerDrawCount = resolved.filter((i) => i.resolution === "owner_draw").length;
    const writeOffCount = resolved.filter((i) => i.resolution === "write_off").length;
    const noQboCount = resolved.filter((i) =>
      ["duplicate_recategorize", "ask_client", "manual_investigation"].includes(i.resolution)
    ).length;
    const total = resolved.reduce((s, i) => s + i.payment_amount, 0);

    if (resolved.length === 0) {
      setError("Nothing to finalize — resolve at least one orphan first.");
      return;
    }
    if (
      !confirm(
        `Finalize ${resolved.length} resolved orphan${resolved.length === 1 ? "" : "s"}?\n\n` +
          (ownerDrawCount > 0
            ? `  • ${ownerDrawCount} Owner Draw JE${ownerDrawCount === 1 ? "" : "s"}\n`
            : "") +
          (writeOffCount > 0
            ? `  • ${writeOffCount} Write-off JE${writeOffCount === 1 ? "" : "s"}\n`
            : "") +
          (noQboCount > 0
            ? `  • ${noQboCount} non-QBO resolution${noQboCount === 1 ? "" : "s"} (just marked done)\n`
            : "") +
          `\nTotal $ impact: $${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\n` +
          "One JE per (customer + resolution + target account) group. Each operation has its own try/catch — one failure doesn't poison the batch."
      )
    )
      return;

    setFinalizing(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/uf-audit/${scan.id}/finalize`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadScan(scan.id);
    } catch (e: any) {
      setError(e?.message || "Finalize failed");
    } finally {
      setFinalizing(false);
    }
  }

  // Group orphans by customer for the bulk-resolve UI
  const orphanGroups = useMemo(() => {
    const orphans = items.filter((i) => i.classification === "orphan");
    const byCust = new Map<string, { customer_name: string; customer_qbo_id: string | null; items: Item[] }>();
    for (const o of orphans) {
      const key = o.customer_qbo_id || `__name:${o.customer_name || "(no customer)"}`;
      if (!byCust.has(key)) {
        byCust.set(key, {
          customer_name: o.customer_name || "(no customer)",
          customer_qbo_id: o.customer_qbo_id,
          items: [],
        });
      }
      byCust.get(key)!.items.push(o);
    }
    const arr = Array.from(byCust.values());
    arr.sort(
      (a, b) =>
        b.items.reduce((s, i) => s + i.payment_amount, 0) -
        a.items.reduce((s, i) => s + i.payment_amount, 0)
    );
    return arr;
  }, [items]);

  // ── STAGE 1: no scan yet / failed / finalized → CTA ──
  const isFresh =
    !scan || scan.status === "failed" || scan.status === "finalized" || scan.status === "cancelled";

  if (isFresh && !scanning) {
    return (
      <div className="space-y-4">
        {error && <ErrorBanner msg={error} onClose={() => setError("")} />}
        <div className="bg-gradient-to-br from-teal-lighter to-white border border-teal/30 rounded-2xl p-6 space-y-3">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-teal-light flex-shrink-0">
              <Wallet size={20} className="text-teal" />
            </div>
            <div className="flex-1">
              <h2 className="font-bold text-navy">
                {scan ? "Re-scan Undeposited Funds" : "Scan Undeposited Funds for orphan payments"}
              </h2>
              <p className="text-sm text-ink-slate mt-1 leading-relaxed">
                Pulls every Receive-Payment entry posted to UF for {clientName} (last 2 years),
                then uses QBO&apos;s own LinkedTxn data to classify each as <em>matched</em>{" "}
                (Deposit exists) or <em>orphan</em> (no deposit — money never landed in any
                bank account). Orphans get grouped by customer for fast bulk resolution.
              </p>
            </div>
          </div>
          <button
            onClick={startScan}
            disabled={scanning}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-5 py-2.5 rounded-lg disabled:opacity-60"
          >
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            {scan ? "Re-scan" : "Scan UF"}
          </button>
          <p className="text-[11px] text-ink-light">
            Deterministic — no AI cost. Typical scan: 10-30s depending on QBO size.
          </p>
        </div>
        {scan && scan.status === "finalized" && (
          <FinalizedSummary scan={scan} items={items} clientLinkId={clientLinkId} />
        )}
        {scan && scan.status === "failed" && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-2xl text-sm">
            <div className="font-semibold text-red-900 mb-1">Previous scan failed</div>
            <div className="text-red-800 text-xs">{scan.error_message || "(no error message)"}</div>
          </div>
        )}
      </div>
    );
  }

  // ── STAGE 1.5: scanning ──
  if (scanning || (scan && scan.status === "scanning")) {
    const elapsedSec = scan
      ? Math.floor((Date.now() - new Date(scan.created_at).getTime()) / 1000)
      : 0;
    const stuck = elapsedSec > 90;
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center space-y-3">
        <Loader2 className="animate-spin text-teal mx-auto" size={36} />
        <div className="font-semibold text-navy">Scanning Undeposited Funds…</div>
        <p className="text-sm text-ink-slate max-w-md mx-auto">
          {stuck
            ? `Running for ${elapsedSec}s — may have hung. Reset and re-scan?`
            : "Pulling every UF payment + cross-referencing with QBO's deposit linkages."}
        </p>
        {stuck && (
          <button
            onClick={async () => {
              setScanning(false);
              setScan(null);
              setItems([]);
              await startScan();
            }}
            className="inline-flex items-center gap-2 bg-amber-100 hover:bg-amber-200 text-amber-900 font-semibold px-4 py-2 rounded-lg text-sm"
          >
            <RefreshCw size={14} />
            Reset and re-scan
          </button>
        )}
      </div>
    );
  }

  // ── STAGE 2 + 3: review + finalize ──
  if (!scan) return null;
  const resolvedCount = items.filter(
    (i) =>
      i.classification === "orphan" &&
      !["pending", "executed", "skipped"].includes(i.resolution)
  ).length;
  const pendingOrphans = items.filter(
    (i) => i.classification === "orphan" && i.resolution === "pending"
  ).length;

  const visibleItems = items.filter((i) => {
    if (filter === "orphan") return i.classification === "orphan";
    if (filter === "matched") return i.classification === "matched";
    return true;
  });

  return (
    <div className="space-y-4">
      {error && <ErrorBanner msg={error} onClose={() => setError("")} />}

      {/* Scan summary */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-teal-light flex-shrink-0">
            <Wallet size={18} className="text-teal" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-bold text-navy">UF Audit results</h2>
              <ScanStatusBadge status={scan.status} />
              <span className="text-xs text-ink-slate">
                {formatAgo(scan.created_at)}
                {scan.duration_ms ? ` · ${(scan.duration_ms / 1000).toFixed(1)}s` : ""}
              </span>
            </div>
          </div>
          <button
            onClick={startScan}
            disabled={scanning}
            className="text-xs font-semibold text-ink-slate hover:text-navy inline-flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw size={11} />
            Re-scan
          </button>
        </div>
        <div className="grid grid-cols-4 gap-3 mt-4 text-sm">
          <SummaryStat label="UF balance" value={`$${formatMoney(scan.total_uf_balance)}`} />
          <SummaryStat label="Total payments" value={scan.uf_payments_total} />
          <SummaryStat label="Matched" value={scan.matched_count} tone="emerald" />
          <SummaryStat label="Orphan" value={scan.orphan_count} tone="red" />
        </div>
        <div className="mt-3 text-xs text-ink-slate">
          {scan.orphan_count > 0 ? (
            <>
              <strong className="text-red-700">
                ${formatMoney(scan.total_orphan_amount)}
              </strong>{" "}
              of UF has no matching bank deposit — the money never landed in any bank account.
              Group by customer below and pick a resolution.
            </>
          ) : (
            "All UF payments are matched to deposits. 🎉"
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 text-sm">
        {(["orphan", "matched", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg font-semibold ${
              filter === f
                ? "bg-navy text-white"
                : "bg-white border border-gray-200 text-ink-slate hover:bg-gray-50"
            }`}
          >
            {f === "orphan" && `Orphans (${scan.orphan_count})`}
            {f === "matched" && `Matched (${scan.matched_count})`}
            {f === "all" && `All (${scan.uf_payments_total})`}
          </button>
        ))}
      </div>

      {/* Orphan groups (only shown on orphan filter) */}
      {filter === "orphan" && orphanGroups.length === 0 && (
        <div className="p-8 bg-white rounded-2xl border border-gray-100 text-center">
          <CheckCircle2 className="text-emerald-600 mx-auto" size={32} />
          <div className="font-semibold text-navy mt-2">No orphan UF payments</div>
          <p className="text-sm text-ink-slate mt-1">
            Every UF payment has a matching deposit. Books are clean here.
          </p>
        </div>
      )}

      {filter === "orphan" &&
        orphanGroups.map((g) => (
          <CustomerOrphanGroup
            key={g.customer_qbo_id || g.customer_name}
            group={g}
            accounts={accounts}
            scanFinalized={scan.status === "finalized"}
            onResolve={resolveGroup}
          />
        ))}

      {/* Matched items (read-only inspect) */}
      {filter !== "orphan" && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr className="text-left text-ink-slate text-xs">
                <th className="px-3 py-2 font-semibold">Date</th>
                <th className="px-3 py-2 font-semibold">Customer</th>
                <th className="px-3 py-2 font-semibold">Memo</th>
                <th className="px-3 py-2 font-semibold text-right">Amount</th>
                <th className="px-3 py-2 font-semibold">Classification</th>
                <th className="px-3 py-2 font-semibold">Deposit</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((i) => (
                <tr key={i.id} className="border-b border-gray-50 last:border-0">
                  <td className="px-3 py-2 text-ink-slate whitespace-nowrap">{i.payment_date}</td>
                  <td className="px-3 py-2 text-navy font-medium">{i.customer_name || "—"}</td>
                  <td className="px-3 py-2 text-xs text-ink-slate truncate max-w-xs">{i.payment_memo}</td>
                  <td className="px-3 py-2 text-right font-mono text-navy">
                    ${formatMoney(i.payment_amount)}
                  </td>
                  <td className="px-3 py-2">
                    {i.classification === "matched" ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
                        <CheckCircle2 size={10} />
                        matched
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-red-100 text-red-700 px-1.5 py-0.5 rounded">
                        <AlertTriangle size={10} />
                        orphan
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-slate">
                    {i.matched_deposit_bank_account
                      ? `${i.matched_deposit_bank_account} · ${i.matched_deposit_date}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Sticky finalize bar */}
      {resolvedCount > 0 && scan.status !== "finalized" && (
        <div className="sticky bottom-0 bg-white border-2 border-teal rounded-2xl p-4 shadow-lg flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <div className="font-bold text-navy">
              Ready to finalize {resolvedCount} resolved orphan{resolvedCount === 1 ? "" : "s"}
              {pendingOrphans > 0 && (
                <span className="font-normal text-xs text-amber-700 ml-2">
                  · {pendingOrphans} still pending
                </span>
              )}
            </div>
            <div className="text-xs text-ink-slate mt-0.5">
              One JE per (customer + resolution + target) group · each operation has its own try/catch
            </div>
          </div>
          <button
            onClick={finalize}
            disabled={finalizing || resolvedCount === 0}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-5 py-2.5 rounded-lg disabled:opacity-50"
          >
            {finalizing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {finalizing ? "Posting JEs to QBO…" : "Finalize · post JEs to QBO"}
          </button>
        </div>
      )}

      {scan.status === "finalized" && (
        <FinalizedSummary scan={scan} items={items} clientLinkId={clientLinkId} />
      )}
    </div>
  );
}

// ─── SUB-COMPONENTS ────────────────────────────────────────────────────

function CustomerOrphanGroup({
  group,
  accounts,
  scanFinalized,
  onResolve,
}: {
  group: { customer_name: string; customer_qbo_id: string | null; items: Item[] };
  accounts: QboAccount[];
  scanFinalized: boolean;
  onResolve: (opts: any) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [targetAccountId, setTargetAccountId] = useState<string>("");
  const [pickedResolution, setPickedResolution] = useState<string>("");
  const total = group.items.reduce((s, i) => s + i.payment_amount, 0);

  // Default target suggestions per resolution
  const targetSuggestions: Record<string, string[]> = {
    owner_draw: ["Owner", "Draw", "Distribution", "Shareholder"],
    write_off: ["Bad Debt", "Customer Discount", "Sales Discount"],
  };
  useEffect(() => {
    if (!pickedResolution) return;
    const sugg = targetSuggestions[pickedResolution];
    if (!sugg) return;
    for (const pattern of sugg) {
      const re = new RegExp(pattern, "i");
      const hit = accounts.find((a) => re.test(a.name));
      if (hit) {
        setTargetAccountId(hit.id);
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedResolution]);

  const needsTarget = pickedResolution === "owner_draw" || pickedResolution === "write_off";
  const targetAccount = accounts.find((a) => a.id === targetAccountId);

  const currentResolution = group.items.every((i) => i.resolution === group.items[0].resolution)
    ? group.items[0].resolution
    : "(mixed)";

  async function apply() {
    if (!pickedResolution) return;
    await onResolve({
      customer_qbo_id: group.customer_qbo_id,
      customer_name: group.customer_qbo_id ? undefined : group.customer_name,
      resolution: pickedResolution,
      target_account_id: needsTarget ? targetAccountId : undefined,
      target_account_name: needsTarget && targetAccount ? targetAccount.name : undefined,
    });
    setPickedResolution("");
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-ink-slate flex-shrink-0"
          aria-label="Expand"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-navy">{group.customer_name}</span>
            <span className="text-xs text-ink-slate">
              {group.items.length} payment{group.items.length === 1 ? "" : "s"}
            </span>
            {currentResolution !== "pending" && currentResolution !== "(mixed)" && (
              <ResolutionBadge resolution={currentResolution} />
            )}
            {currentResolution === "(mixed)" && (
              <span className="text-[11px] px-2 py-0.5 rounded font-bold bg-amber-100 text-amber-800">
                Mixed
              </span>
            )}
          </div>
        </div>
        <div className="font-mono text-base font-bold text-navy tabular-nums whitespace-nowrap">
          ${formatMoney(total)}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50/30">
          {/* Per-payment table */}
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr className="text-left text-ink-slate">
                <th className="px-3 py-1.5 font-semibold">Date</th>
                <th className="px-3 py-1.5 font-semibold">Memo</th>
                <th className="px-3 py-1.5 font-semibold text-right">Amount</th>
                <th className="px-3 py-1.5 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {group.items.map((i) => (
                <tr key={i.id} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 text-ink-slate whitespace-nowrap">{i.payment_date}</td>
                  <td className="px-3 py-1.5 text-xs text-ink-slate truncate max-w-sm">{i.payment_memo}</td>
                  <td className="px-3 py-1.5 text-right font-mono">${formatMoney(i.payment_amount)}</td>
                  <td className="px-3 py-1.5">
                    <ResolutionBadge resolution={i.resolution} />
                    {i.execution_error && (
                      <div className="text-[10px] text-red-700 font-semibold mt-0.5">{i.execution_error}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!scanFinalized && (
        <div className="border-t border-gray-100 bg-gray-50/20 p-3 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-navy uppercase tracking-wider">Resolve all as:</span>
          <select
            value={pickedResolution}
            onChange={(e) => setPickedResolution(e.target.value)}
            className="px-2 py-1 rounded border border-gray-200 text-xs"
          >
            <option value="">— pick a resolution —</option>
            <option value="owner_draw">Owner Draw (JE)</option>
            <option value="write_off">Write-off (JE)</option>
            <option value="duplicate_recategorize">Duplicate — handle in QBO</option>
            <option value="ask_client">Ask Client</option>
            <option value="manual_investigation">Manual investigation</option>
            <option value="pending">Reset to pending</option>
          </select>
          {needsTarget && (
            <select
              value={targetAccountId}
              onChange={(e) => setTargetAccountId(e.target.value)}
              className="px-2 py-1 rounded border border-gray-200 text-xs max-w-[260px]"
            >
              <option value="">— target account —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.accountType})
                </option>
              ))}
            </select>
          )}
          <button
            onClick={apply}
            disabled={!pickedResolution || (needsTarget && !targetAccountId)}
            className="inline-flex items-center gap-1 px-3 py-1 rounded bg-teal hover:bg-teal-dark text-white text-xs font-bold disabled:opacity-50"
          >
            <CheckCircle2 size={11} />
            Apply to {group.items.length}
          </button>
          {pickedResolution && (
            <span className="text-[11px] text-ink-light italic">
              {RESOLUTION_LABELS[pickedResolution]?.description || ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ResolutionBadge({ resolution }: { resolution: string }) {
  const c = RESOLUTION_LABELS[resolution] || RESOLUTION_LABELS.pending;
  return <span className={`text-[11px] px-2 py-0.5 rounded font-bold ${c.color}`}>{c.label}</span>;
}

function ScanStatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { color: string; label: string }> = {
    scanning: { color: "bg-blue-100 text-blue-700", label: "Scanning" },
    review: { color: "bg-amber-100 text-amber-700", label: "Review" },
    finalizing: { color: "bg-blue-100 text-blue-700", label: "Finalizing" },
    finalized: { color: "bg-emerald-100 text-emerald-700", label: "Finalized ✓" },
    failed: { color: "bg-red-100 text-red-700", label: "Failed" },
    cancelled: { color: "bg-gray-100 text-ink-slate", label: "Cancelled" },
  };
  const c = cfg[status] || cfg.review;
  return <span className={`text-xs px-2 py-0.5 rounded font-bold ${c.color}`}>{c.label}</span>;
}

function SummaryStat({ label, value, tone }: { label: string; value: any; tone?: "emerald" | "red" }) {
  const color =
    tone === "emerald" ? "text-emerald-700" : tone === "red" ? "text-red-700" : "text-navy";
  return (
    <div className="bg-gray-50 rounded-lg p-3 text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-[11px] text-ink-slate mt-0.5">{label}</div>
    </div>
  );
}

function ErrorBanner({ msg, onClose }: { msg: string; onClose: () => void }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2 text-sm">
      <AlertCircle size={16} className="text-red-700 flex-shrink-0 mt-0.5" />
      <div className="flex-1 text-red-900">{msg}</div>
      <button onClick={onClose} className="text-red-700 hover:text-red-900">
        <X size={14} />
      </button>
    </div>
  );
}

function FinalizedSummary({ scan, items, clientLinkId }: { scan: Scan; items: Item[]; clientLinkId: string }) {
  const exec = items.filter((i) => i.resolution === "executed").length;
  const failed = items.filter((i) => i.resolution === "failed").length;
  const total = items
    .filter((i) => i.resolution === "executed")
    .reduce((s, i) => s + i.payment_amount, 0);
  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 space-y-3">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="text-emerald-700 flex-shrink-0 mt-0.5" size={22} />
        <div className="flex-1">
          <h3 className="font-bold text-emerald-900 text-base">
            UF cleared · {exec} orphan{exec === 1 ? "" : "s"} resolved
          </h3>
          <p className="text-sm text-emerald-800 mt-1">
            Finalized {formatAgo(scan.finalized_at || scan.created_at)}.
            {total > 0 && (
              <>
                {" "}Total $ cleared: <strong>${formatMoney(total)}</strong>.
              </>
            )}
            {failed > 0 && (
              <span className="text-red-700 ml-2">
                {failed} failed — expand the customer groups above for the QBO error.
              </span>
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Link
          href={`/balance-sheet/${clientLinkId}/coa`}
          className="inline-flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-semibold px-4 py-2 rounded-lg"
        >
          <ArrowLeft size={13} />
          Back to BS COA
        </Link>
        <Link
          href={`/balance-sheet/${clientLinkId}`}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-900 hover:text-emerald-700 px-3 py-2"
        >
          BS workflow
          <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  );
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
function formatMoney(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
