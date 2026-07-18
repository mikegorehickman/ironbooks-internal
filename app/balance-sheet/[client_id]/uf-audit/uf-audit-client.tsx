"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { playSound } from "@/lib/sounds";
import {
  Loader2, RefreshCw, Search, AlertTriangle, CheckCircle2, X,
  Send, ChevronDown, ChevronRight, Wallet, ArrowLeft, ArrowRight,
  AlertCircle, Mail, FileSpreadsheet, Copy, Code,
} from "lucide-react";

interface Scan {
  id: string;
  status: string;
  created_at: string;
  uf_account_qbo_id: string | null;
  uf_account_name: string | null;
  uf_account_current_balance: number | null;
  scan_from: string | null;
  scan_to: string | null;
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
  payment_ref_num: string | null;
  classification: "matched" | "orphan";
  matched_deposit_id: string | null;
  matched_deposit_date: string | null;
  matched_deposit_bank_account: string | null;
  probable_deposit_date: string | null;
  probable_deposit_amount: number | null;
  probable_deposit_bank: string | null;
  probable_match_kind: "exact" | "combination" | "tax_adjusted" | "tax_combination" | null;
  probable_match_note: string | null;
  suspected_duplicate: boolean;
  duplicate_of_payment_id: string | null;
  duplicate_reason: string | null;
  resolution: string;
  resolution_target_account_id: string | null;
  resolution_target_account_name: string | null;
  deposit_bank_account_id: string | null;
  deposit_bank_account_name: string | null;
  deposit_date: string | null;
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
  pending: { label: "Needs decision", color: "bg-amber-100 text-amber-800", description: "Decide what to do with this orphan" },
  owner_draw: { label: "Owner Draw", color: "bg-purple-100 text-purple-800", description: "Cash kept by owner — JE: Dr Owner Draw, Cr UF" },
  write_off: { label: "Write-off", color: "bg-red-100 text-red-800", description: "Not a real payment — JE: Dr Bad Debt (or similar), Cr UF" },
  duplicate_recategorize: { label: "Duplicate", color: "bg-blue-100 text-blue-800", description: "Real deposit exists elsewhere — bookkeeper finds + re-categorizes in QBO" },
  void_duplicate: { label: "Void duplicate", color: "bg-rose-100 text-rose-800", description: "Confirmed duplicate — VOIDS the duplicate Payment in QBO (removes the double-counted cash)" },
  void_pair: { label: "Void pair", color: "bg-rose-100 text-rose-900", description: "CRM duplicate pair — VOIDS the payment AND the invoice it was applied to. UF down, A/R down by any open invoice balance, income backed out. No bank involved." },
  create_deposit: { label: "Create deposit", color: "bg-teal-100 text-teal-800", description: "Real money still in UF — posts a Bank Deposit to sweep UF → the chosen bank account" },
  clear_duplicate: { label: "Clear duplicate", color: "bg-indigo-100 text-indigo-800", description: "Cash already in bank via a separate bank-feed deposit — posts a $0 deposit that clears UF and reverses the double-counted income. Bank + A/R untouched." },
  ask_client: { label: "Queued for client", color: "bg-orange-100 text-orange-800", description: "Added to the confirmation email — awaiting client reply, no auto-write" },
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
  // Email modal state — built when the bookkeeper clicks "Draft client email"
  const [emailDraft, setEmailDraft] = useState<{
    subject: string;
    email_text: string;
    email_html: string;
    customer_count: number;
    payment_count: number;
    total_amount: number;
  } | null>(null);
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailFilter, setEmailFilter] = useState<"ask_client" | "all_unresolved">("all_unresolved");

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
      playSound("scan_complete");
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
    deposit_bank_account_id?: string;
    deposit_bank_account_name?: string;
    deposit_date?: string;
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
    const voidCount = resolved.filter((i) => i.resolution === "void_duplicate").length;
    const voidPairCount = resolved.filter((i) => i.resolution === "void_pair").length;
    const depositCount = resolved.filter((i) => i.resolution === "create_deposit").length;
    const clearDupCount = resolved.filter((i) => i.resolution === "clear_duplicate").length;
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
          (voidCount > 0
            ? `  • ${voidCount} duplicate${voidCount === 1 ? "" : "s"} VOIDED in QBO (removes double-counted cash)\n`
            : "") +
          (voidPairCount > 0
            ? `  • ${voidPairCount} duplicate PAIR${voidPairCount === 1 ? "" : "S"} voided — payment + applied invoice (UF & A/R down, income backed out)\n`
            : "") +
          (depositCount > 0
            ? `  • ${depositCount} payment${depositCount === 1 ? "" : "s"} swept into the bank via Bank Deposit\n`
            : "") +
          (clearDupCount > 0
            ? `  • ${clearDupCount} duplicate${clearDupCount === 1 ? "" : "s"} cleared via $0 deposit (UF down, income reversed — bank & A/R untouched)\n`
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

  async function draftEmail(filter: "ask_client" | "all_unresolved") {
    if (!scan) return;
    setEmailLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/uf-audit/${scan.id}/email-draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filter }),
        }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.payment_count === 0) {
        setError(
          filter === "ask_client"
            ? "No orphans marked 'Ask Client' yet — try 'All unresolved' to draft for everything not yet finalized."
            : "No unresolved orphans — nothing to email about."
        );
        return;
      }
      setEmailDraft({
        subject: body.subject,
        email_text: body.email_text,
        email_html: body.email_html,
        customer_count: body.customer_count,
        payment_count: body.payment_count,
        total_amount: body.total_amount,
      });
    } catch (e: any) {
      setError(e?.message || "Failed to draft email");
    } finally {
      setEmailLoading(false);
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
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => draftEmail(emailFilter)}
              disabled={emailLoading || scan.orphan_count === 0}
              className="inline-flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs font-bold px-3 py-1.5 rounded-lg"
              title={`Draft a branded email to ${clientName}'s owner asking what happened to each orphan payment`}
            >
              {emailLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Mail size={12} />
              )}
              Draft client email
            </button>
            <button
              onClick={startScan}
              disabled={scanning}
              className="text-xs font-semibold text-ink-slate hover:text-navy inline-flex items-center gap-1 disabled:opacity-50"
            >
              <RefreshCw size={11} />
              Re-scan
            </button>
          </div>
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
          ) : scan.uf_payments_total === 0 ? (
            <>No Receive-Payments or Sales-Receipts in the scan window.</>
          ) : (
            "All UF payments are matched to deposits. 🎉"
          )}
        </div>

        {/* Account info line — always shows so the bookkeeper can verify
            we scanned the RIGHT account. Critical diagnostic when results
            look surprising. */}
        {(scan.uf_account_name || scan.uf_account_qbo_id) && (
          <div className="mt-2 text-[11px] text-ink-light flex items-center gap-2 flex-wrap">
            <span>
              Scanned:{" "}
              <strong className="text-ink-slate">
                {scan.uf_account_name || `Account ${scan.uf_account_qbo_id}`}
              </strong>
              {scan.uf_account_current_balance != null && (
                <>
                  {" "}
                  · Current QBO balance:{" "}
                  <strong className="text-ink-slate">
                    ${formatMoney(scan.uf_account_current_balance)}
                  </strong>
                </>
              )}
              {scan.scan_from && (
                <>
                  {" "}· Window: {scan.scan_from} → {scan.scan_to}
                </>
              )}
            </span>
          </div>
        )}

        {/* The "I have a real UF balance but the scanner found nothing"
            warning. Most common cause: previous bookkeeper posted customer
            payments as Journal Entries hitting UF (Dr UF / Cr A/R) instead
            of using the proper Receive Payment workflow. UF Audit only sees
            Payment + SalesReceipt today. Send the bookkeeper to BS COA
            viewer where they can drill straight into the UF transactions. */}
        {scan.uf_payments_total === 0 &&
          scan.uf_account_current_balance != null &&
          Math.abs(scan.uf_account_current_balance) >= 1 && (
            <div className="mt-3 p-3 bg-orange-50 border border-orange-300 rounded-lg text-xs text-orange-900">
              <div className="font-bold mb-1">
                ⚠ Heads up — UF balance is{" "}
                ${formatMoney(Math.abs(scan.uf_account_current_balance))} but the
                scanner found zero Receive-Payments or Sales-Receipts.
              </div>
              <div className="mb-2">
                That usually means the entries hitting Undeposited Funds were
                posted as <strong>Journal Entries</strong> or <strong>manual Deposits</strong> —
                not the proper Receive Payment workflow. UF Audit currently
                only scans Payment/SalesReceipt objects (extension to JE
                lines is on the roadmap).
              </div>
              <a
                href={`/balance-sheet/${clientLinkId}/coa`}
                className="font-bold underline hover:no-underline"
              >
                → Open BS COA viewer and drill into the UF account
              </a>{" "}
              to see the actual transactions, then post offsetting JEs
              manually until the JE-scanner ships.
            </div>
          )}
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

      {filter === "orphan" && orphanGroups.length > 0 && scan.status !== "finalized" && (
        <BulkApplyBar
          orphanItems={items.filter(
            (i) => i.classification === "orphan" && i.resolution !== "executed"
          )}
          groupCount={orphanGroups.length}
          accounts={accounts}
          onResolve={resolveGroup}
        />
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
                    ) : i.probable_deposit_date ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded" title={i.probable_match_note || undefined}>
                        <AlertTriangle size={10} />
                        likely deposited
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-red-100 text-red-700 px-1.5 py-0.5 rounded">
                        <AlertTriangle size={10} />
                        orphan
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-slate">
                    {i.matched_deposit_bank_account ? (
                      `${i.matched_deposit_bank_account} · ${i.matched_deposit_date}`
                    ) : i.probable_deposit_date ? (
                      <span className="text-amber-800" title={i.probable_match_note || undefined}>
                        ≈ {i.probable_deposit_bank || "bank"} · {i.probable_deposit_date}
                        {i.probable_deposit_amount != null && ` · $${i.probable_deposit_amount.toLocaleString()}`}
                        {i.probable_match_kind && i.probable_match_kind !== "exact" && ` (${i.probable_match_kind.replace("_", " ")})`}
                      </span>
                    ) : (
                      "—"
                    )}
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

      {emailDraft && (
        <EmailDraftModal
          clientName={clientName}
          draft={emailDraft}
          filter={emailFilter}
          onFilterChange={(f) => {
            setEmailFilter(f);
            setEmailDraft(null);
            draftEmail(f);
          }}
          onClose={() => setEmailDraft(null)}
        />
      )}
    </div>
  );
}

// ─── SUB-COMPONENTS ────────────────────────────────────────────────────

/**
 * One-shot resolution across EVERY orphan group. Same pickers as the
 * per-group bar; posts payment_ids for all non-executed orphans so already
 * finalized items are never touched. Per-group bars still override after.
 */
function BulkApplyBar({
  orphanItems,
  groupCount,
  accounts,
  onResolve,
}: {
  orphanItems: Item[];
  groupCount: number;
  accounts: QboAccount[];
  onResolve: (opts: any) => Promise<void>;
}) {
  const [pickedResolution, setPickedResolution] = useState<string>("");
  const [targetAccountId, setTargetAccountId] = useState<string>("");
  const [bankAccountId, setBankAccountId] = useState<string>("");
  const [depositDate, setDepositDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [applying, setApplying] = useState(false);

  const bankAccounts = accounts.filter((a) => /bank/i.test(a.accountType));
  const total = orphanItems.reduce((s, i) => s + i.payment_amount, 0);

  const targetSuggestions: Record<string, string[]> = {
    owner_draw: ["Owner", "Draw", "Distribution", "Shareholder"],
    write_off: ["Bad Debt", "Customer Discount", "Sales Discount"],
    clear_duplicate: ["Painting Income", "Sales", "Income", "Revenue", "Services"],
  };
  useEffect(() => {
    if (!pickedResolution) return;
    const sugg = targetSuggestions[pickedResolution];
    if (sugg) {
      for (const pattern of sugg) {
        const re = new RegExp(pattern, "i");
        const hit = accounts.find((a) => re.test(a.name));
        if (hit) {
          setTargetAccountId(hit.id);
          break;
        }
      }
    }
    if (
      (pickedResolution === "create_deposit" || pickedResolution === "clear_duplicate") &&
      !bankAccountId
    ) {
      const operating =
        bankAccounts.find((a) => /(checking|operating|current)/i.test(a.name)) ||
        bankAccounts[0];
      if (operating) setBankAccountId(operating.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedResolution]);

  const needsTarget =
    pickedResolution === "owner_draw" ||
    pickedResolution === "write_off" ||
    pickedResolution === "clear_duplicate";
  const needsBank =
    pickedResolution === "create_deposit" || pickedResolution === "clear_duplicate";
  const targetAccount = accounts.find((a) => a.id === targetAccountId);
  const bankAccount = bankAccounts.find((a) => a.id === bankAccountId);

  async function applyAll() {
    if (!pickedResolution || orphanItems.length === 0) return;
    if (
      !confirm(
        `Apply "${RESOLUTION_LABELS[pickedResolution]?.label || pickedResolution}" to ALL ${orphanItems.length} orphan payment${orphanItems.length === 1 ? "" : "s"} across ${groupCount} customer${groupCount === 1 ? "" : "s"} ($${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})?\n\nNothing posts to QBO until you click Finalize — you can still override individual groups after.`
      )
    )
      return;
    setApplying(true);
    try {
      await onResolve({
        payment_ids: orphanItems.map((i) => i.qbo_payment_id),
        resolution: pickedResolution,
        target_account_id: needsTarget ? targetAccountId : undefined,
        target_account_name: needsTarget && targetAccount ? targetAccount.name : undefined,
        deposit_bank_account_id: needsBank ? bankAccountId : undefined,
        deposit_bank_account_name: needsBank && bankAccount ? bankAccount.name : undefined,
        deposit_date: needsBank ? depositDate : undefined,
      });
      setPickedResolution("");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="bg-navy/[0.03] border-2 border-navy/20 rounded-2xl p-3 flex items-center gap-2 flex-wrap">
      <span className="text-xs font-bold text-navy uppercase tracking-wider">
        Apply to ALL {groupCount} groups:
      </span>
      <select
        value={pickedResolution}
        onChange={(e) => setPickedResolution(e.target.value)}
        className="px-2 py-1 rounded border border-gray-200 text-xs"
      >
        <option value="">— pick a resolution —</option>
        <option value="void_pair">Void pair — payment + invoice (UF & A/R down, no bank)</option>
        <option value="clear_duplicate">Clear duplicate — already deposited ($0 deposit)</option>
        <option value="create_deposit">Create bank deposit (sweep UF → bank)</option>
        <option value="void_duplicate">Void duplicate (payment only)</option>
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
          <option value="">
            {pickedResolution === "clear_duplicate"
              ? "— income account to offset —"
              : "— target account —"}
          </option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.accountType})
            </option>
          ))}
        </select>
      )}
      {needsBank && (
        <select
          value={bankAccountId}
          onChange={(e) => setBankAccountId(e.target.value)}
          className="px-2 py-1 rounded border border-gray-200 text-xs max-w-[260px]"
        >
          <option value="">
            {pickedResolution === "clear_duplicate"
              ? "— $0 deposit container bank (balance unchanged) —"
              : "— deposit into which bank? —"}
          </option>
          {bankAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
      {needsBank && (
        <label className="inline-flex items-center gap-1 text-[11px] text-ink-slate">
          <span className="font-semibold uppercase tracking-wider">Deposit date</span>
          <input
            type="date"
            value={depositDate}
            onChange={(e) => setDepositDate(e.target.value)}
            className="px-1.5 py-0.5 rounded border border-gray-200 text-xs"
            title="Use the date the money cleared on the bank statement"
          />
        </label>
      )}
      <button
        onClick={applyAll}
        disabled={
          applying ||
          !pickedResolution ||
          (needsTarget && !targetAccountId) ||
          (needsBank && !bankAccountId) ||
          (needsBank && !depositDate)
        }
        className="inline-flex items-center gap-1 px-3 py-1 rounded bg-navy hover:bg-ink-light text-white text-xs font-bold disabled:opacity-50"
      >
        {applying ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
        Apply to all {orphanItems.length}
      </button>
      {pickedResolution && (
        <span className="text-[11px] text-ink-light italic w-full">
          {RESOLUTION_LABELS[pickedResolution]?.description || ""}
        </span>
      )}
    </div>
  );
}

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
  const [bankAccountId, setBankAccountId] = useState<string>("");
  const [pickedResolution, setPickedResolution] = useState<string>("");
  // Bookkeeper-chosen deposit date. Defaults to today (the bank statement
  // date the bookkeeper is reconciling against), not the payment date —
  // that's the whole reason this exists.
  const [depositDate, setDepositDate] = useState<string>(() => {
    const existing = group.items.find((i) => i.deposit_date)?.deposit_date;
    return existing || new Date().toISOString().slice(0, 10);
  });
  const [askingClient, setAskingClient] = useState(false);
  const total = group.items.reduce((s, i) => s + i.payment_amount, 0);
  const dupCount = group.items.filter((i) => i.suspected_duplicate).length;

  // Bank-type accounts for the create_deposit target picker
  const bankAccounts = accounts.filter((a) => /bank/i.test(a.accountType));

  // Default target suggestions per resolution
  const targetSuggestions: Record<string, string[]> = {
    owner_draw: ["Owner", "Draw", "Distribution", "Shareholder"],
    write_off: ["Bad Debt", "Customer Discount", "Sales Discount"],
    clear_duplicate: ["Painting Income", "Sales", "Income", "Revenue", "Services"],
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

  const needsTarget =
    pickedResolution === "owner_draw" ||
    pickedResolution === "write_off" ||
    pickedResolution === "clear_duplicate";
  const needsBank =
    pickedResolution === "create_deposit" || pickedResolution === "clear_duplicate";
  const targetAccount = accounts.find((a) => a.id === targetAccountId);
  const bankAccount = bankAccounts.find((a) => a.id === bankAccountId);

  // Auto-pick the first/operating bank when a deposit-creating resolution is selected
  useEffect(() => {
    if (
      (pickedResolution !== "create_deposit" && pickedResolution !== "clear_duplicate") ||
      bankAccountId
    )
      return;
    const operating =
      bankAccounts.find((a) => /(checking|operating|current)/i.test(a.name)) ||
      bankAccounts[0];
    if (operating) setBankAccountId(operating.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedResolution]);

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
      deposit_bank_account_id: needsBank ? bankAccountId : undefined,
      deposit_bank_account_name: needsBank && bankAccount ? bankAccount.name : undefined,
      deposit_date: needsBank ? depositDate : undefined,
    });
    setPickedResolution("");
  }

  // One-click Ask Client: marks every payment in this group as needing
  // client confirmation. Surfaces in the "Draft client email" flow so the
  // bookkeeper can send one branded email per client covering all their
  // questioned orphans.
  async function applyAskClient() {
    setAskingClient(true);
    try {
      await onResolve({
        customer_qbo_id: group.customer_qbo_id,
        customer_name: group.customer_qbo_id ? undefined : group.customer_name,
        resolution: "ask_client",
      });
    } finally {
      setAskingClient(false);
    }
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
            {dupCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded font-bold bg-rose-100 text-rose-800">
                <Copy size={10} />
                {dupCount} suspected dup{dupCount === 1 ? "" : "s"}
              </span>
            )}
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
        {!scanFinalized && currentResolution !== "ask_client" && (
          <button
            onClick={applyAskClient}
            disabled={askingClient}
            title="Mark every payment in this group as needing client confirmation"
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-orange-100 text-orange-800 hover:bg-orange-200 text-[11px] font-bold disabled:opacity-50"
          >
            {askingClient ? <Loader2 size={11} className="animate-spin" /> : <Mail size={11} />}
            Ask Client
          </button>
        )}
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
                  <td className="px-3 py-1.5 text-ink-slate whitespace-nowrap">
                    {i.payment_date}
                    {i.payment_ref_num && (
                      <span className="ml-1 text-[10px] text-ink-light">#{i.payment_ref_num}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-ink-slate truncate max-w-sm">
                    {i.payment_memo}
                    {i.suspected_duplicate && i.duplicate_reason && (
                      <div className="text-[10px] text-rose-700 font-semibold mt-0.5 flex items-center gap-1">
                        <Copy size={9} />
                        {i.duplicate_reason}
                      </div>
                    )}
                  </td>
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
            <option value="void_pair">Void pair — payment + invoice (UF & A/R down, no bank)</option>
            <option value="clear_duplicate">Clear duplicate — already deposited ($0 deposit)</option>
            <option value="create_deposit">Create bank deposit (sweep UF → bank)</option>
            <option value="void_duplicate">Void duplicate (payment only)</option>
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
          {needsBank && (
            <select
              value={bankAccountId}
              onChange={(e) => setBankAccountId(e.target.value)}
              className="px-2 py-1 rounded border border-gray-200 text-xs max-w-[260px]"
            >
              <option value="">
                {pickedResolution === "clear_duplicate"
                  ? "— $0 deposit container bank (balance unchanged) —"
                  : "— deposit into which bank? —"}
              </option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          {needsBank && (
            <label className="inline-flex items-center gap-1 text-[11px] text-ink-slate">
              <span className="font-semibold uppercase tracking-wider">Deposit date</span>
              <input
                type="date"
                value={depositDate}
                onChange={(e) => setDepositDate(e.target.value)}
                className="px-1.5 py-0.5 rounded border border-gray-200 text-xs"
                title="Use the date the money actually cleared on the bank statement (not each payment's individual date)"
              />
            </label>
          )}
          <button
            onClick={apply}
            disabled={!pickedResolution || (needsTarget && !targetAccountId) || (needsBank && !bankAccountId) || (needsBank && !depositDate)}
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

/**
 * Branded copy-paste modal. Two copy buttons:
 *   - "Copy formatted" — writes BOTH text/html + text/plain to the clipboard
 *     via ClipboardItem, so pasting into Gmail / Double / Outlook preserves
 *     the branded layout. Plain-text fallback for things like Notepad.
 *   - "Copy plain" — just the plain-text version (when you want a
 *     no-formatting paste, e.g. into an SMS or a code block).
 */
function EmailDraftModal({
  clientName,
  draft,
  filter,
  onFilterChange,
  onClose,
}: {
  clientName: string;
  draft: {
    subject: string;
    email_text: string;
    email_html: string;
    customer_count: number;
    payment_count: number;
    total_amount: number;
  };
  filter: "ask_client" | "all_unresolved";
  onFilterChange: (f: "ask_client" | "all_unresolved") => void;
  onClose: () => void;
}) {
  const [copiedFormatted, setCopiedFormatted] = useState(false);
  const [copiedPlain, setCopiedPlain] = useState(false);
  const [copiedSubject, setCopiedSubject] = useState(false);
  const [copiedHtml, setCopiedHtml] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [preview, setPreview] = useState<"rendered" | "plain" | "html">("rendered");

  async function copyFormatted() {
    setCopyError("");
    try {
      // ClipboardItem with both text/html + text/plain — Gmail / Double /
      // Outlook all paste the HTML variant when pasted into rich-text fields;
      // plain text is the fallback for plain-text fields.
      if (typeof ClipboardItem === "undefined") {
        // Older browsers — fall back to plain text only
        await navigator.clipboard.writeText(draft.email_text);
        setCopiedPlain(true);
        setTimeout(() => setCopiedPlain(false), 2000);
        return;
      }
      const item = new ClipboardItem({
        "text/html": new Blob([draft.email_html], { type: "text/html" }),
        "text/plain": new Blob([draft.email_text], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      setCopiedFormatted(true);
      setTimeout(() => setCopiedFormatted(false), 2000);
    } catch (e: any) {
      setCopyError(
        "Clipboard blocked — use the Plain Text or HTML buttons below as a fallback."
      );
    }
  }

  async function copyPlain() {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(draft.email_text);
      setCopiedPlain(true);
      setTimeout(() => setCopiedPlain(false), 2000);
    } catch {
      setCopyError("Clipboard blocked — select the text manually below.");
    }
  }

  async function copyHtml() {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(draft.email_html);
      setCopiedHtml(true);
      setTimeout(() => setCopiedHtml(false), 2000);
    } catch {
      setCopyError("Clipboard blocked — select the HTML below manually.");
    }
  }

  async function copySubject() {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(draft.subject);
      setCopiedSubject(true);
      setTimeout(() => setCopiedSubject(false), 2000);
    } catch {
      setCopyError("Clipboard blocked.");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
      style={{ backgroundColor: "rgba(15, 31, 46, 0.6)", backdropFilter: "blur(4px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full my-8 flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Mail size={18} className="text-purple-600" />
              <h3 className="text-lg font-bold text-navy">
                Draft client email — {clientName}
              </h3>
            </div>
            <p className="text-xs text-ink-slate mt-1">
              {draft.payment_count} payment{draft.payment_count === 1 ? "" : "s"} across{" "}
              {draft.customer_count} customer{draft.customer_count === 1 ? "" : "s"} ·{" "}
              total ${draft.total_amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy">
            <X size={18} />
          </button>
        </div>

        {/* Filter toggle */}
        <div className="px-6 pt-3 flex items-center gap-2 text-xs">
          <span className="font-semibold text-ink-slate">Include:</span>
          <button
            onClick={() => onFilterChange("all_unresolved")}
            className={`px-2 py-1 rounded font-semibold ${
              filter === "all_unresolved"
                ? "bg-navy text-white"
                : "bg-white border border-gray-200 text-ink-slate hover:bg-gray-50"
            }`}
          >
            All unresolved orphans
          </button>
          <button
            onClick={() => onFilterChange("ask_client")}
            className={`px-2 py-1 rounded font-semibold ${
              filter === "ask_client"
                ? "bg-navy text-white"
                : "bg-white border border-gray-200 text-ink-slate hover:bg-gray-50"
            }`}
          >
            Only items marked &ldquo;Ask Client&rdquo;
          </button>
        </div>

        {/* Subject line */}
        <div className="px-6 pt-3 flex items-center gap-2 text-sm">
          <span className="text-xs font-semibold text-ink-slate uppercase tracking-wider w-16">Subject</span>
          <input
            type="text"
            value={draft.subject}
            readOnly
            className="flex-1 px-3 py-1.5 rounded-lg border border-gray-200 bg-gray-50 text-navy font-medium text-sm"
          />
          <button
            onClick={copySubject}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded bg-navy hover:bg-ink-light text-white text-xs font-semibold"
          >
            {copiedSubject ? <CheckCircle2 size={11} /> : <Copy size={11} />}
            {copiedSubject ? "Copied" : "Copy"}
          </button>
        </div>

        {/* Preview tabs */}
        <div className="px-6 pt-4 flex items-center gap-1 border-b border-gray-100">
          {(["rendered", "plain", "html"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPreview(p)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-t ${
                preview === p
                  ? "bg-gray-50 text-navy border-b-2 border-teal"
                  : "text-ink-slate hover:text-navy"
              }`}
            >
              {p === "rendered" && "Rendered preview"}
              {p === "plain" && "Plain text"}
              {p === "html" && "HTML source"}
            </button>
          ))}
        </div>

        {/* Preview body */}
        <div className="flex-1 overflow-y-auto bg-gray-50 px-6 py-4 max-h-[55vh]">
          {preview === "rendered" && (
            <div
              className="bg-white rounded border border-gray-200 p-2"
              // The rendered HTML is the same we're going to paste into the
              // bookkeeper's mail client. Sandboxed-ish: it's our own template
              // so safe to use dangerouslySetInnerHTML.
              dangerouslySetInnerHTML={{ __html: draft.email_html }}
            />
          )}
          {preview === "plain" && (
            <pre className="text-xs font-mono whitespace-pre-wrap bg-white border border-gray-200 rounded-lg p-4 text-navy">
              {draft.email_text}
            </pre>
          )}
          {preview === "html" && (
            <pre className="text-[10px] font-mono whitespace-pre-wrap bg-white border border-gray-200 rounded-lg p-4 text-ink-slate overflow-x-auto">
              {draft.email_html}
            </pre>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-6 py-4 border-t border-gray-100 bg-white rounded-b-2xl">
          {copyError && (
            <div className="text-xs text-red-700 font-semibold mb-2">{copyError}</div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={copyFormatted}
              className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2 rounded-lg"
            >
              {copiedFormatted ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copiedFormatted ? "Copied ✓" : "Copy formatted (paste anywhere)"}
            </button>
            <button
              onClick={copyPlain}
              className="inline-flex items-center gap-1.5 bg-navy hover:bg-ink-light text-white text-xs font-semibold px-3 py-2 rounded-lg"
            >
              {copiedPlain ? <CheckCircle2 size={11} /> : <Copy size={11} />}
              {copiedPlain ? "Copied" : "Copy plain text"}
            </button>
            <button
              onClick={copyHtml}
              className="inline-flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-ink-slate text-xs font-semibold px-3 py-2 rounded-lg"
              title="Copy the raw HTML — useful if you want to inspect / edit the source before sending"
            >
              {copiedHtml ? <CheckCircle2 size={11} /> : <Code size={11} />}
              {copiedHtml ? "Copied" : "Copy HTML"}
            </button>
            <button
              onClick={onClose}
              className="ml-auto text-xs font-semibold text-ink-slate hover:text-navy px-2"
            >
              Close
            </button>
          </div>
          <p className="text-[11px] text-ink-light mt-2 leading-relaxed">
            <strong>Tip:</strong> &ldquo;Copy formatted&rdquo; preserves the table layout when you
            paste into Gmail, Double, or Outlook. If you&rsquo;re pasting somewhere
            plain-text-only (terminal, Slack code block), use &ldquo;Copy plain text&rdquo; instead.
          </p>
        </div>
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
