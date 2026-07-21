"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, ArrowRight, RefreshCw, AlertCircle, Sparkles, Wallet,
  CheckCircle2, Save, FileText, Landmark, CreditCard, FileSpreadsheet,
  HomeIcon, Search, Send, X, ExternalLink, ChevronRight, ChevronDown,
  Banknote, ScrollText, Scale,
} from "lucide-react";
import { ExternalInvoiceUpload } from "./external-invoice-upload";
import { UfAuditClient } from "./uf-audit/uf-audit-client";
import { QboRemediationPanel } from "@/components/QboRemediationPanel";

interface BSAccount {
  qbo_account_id: string;
  name: string;
  account_type: string;
  account_subtype: string | null;
  kind: "bank" | "credit_card" | "loan";
  last4: string | null;
  current_balance: number;
  currency: string | null;
}

type Category =
  | "personal"
  | "business_checking"
  | "business_savings"
  | "loan_cc";

interface RowState {
  category: Category | "";
  ending_balance: string;
  as_of_date: string;
  notes: string;
}

interface Suggestion {
  qbo_account_id: string;
  account_name: string;
  status: "matched" | "gap" | "no_balance";
  gap: number;
  summary: string;
  reasoning: string;
  je_lines: Array<{
    side: "debit" | "credit";
    account_hint: string;
    amount: number;
    description: string;
  }>;
  // Echoed back so the UI can show "QBO as-of date" vs "QBO right now"
  qbo_balance_at_date?: number;
  qbo_current_balance?: number;
}

interface GapTxn {
  txn_id: string;
  txn_type: string;
  date: string;
  doc_number: string | null;
  customer_or_vendor: string | null;
  memo: string;
  amount: number;
  cleared: boolean;
}

interface GapCandidate {
  txn: GapTxn;
  weight: number;
  reasons: string[];
}

interface GapAnalysis {
  total_transactions: number;
  uncleared_count: number;
  uncleared_total: number;
  candidates: GapCandidate[];
  notes: string[];
}

const CATEGORY_LABELS: Record<Category, string> = {
  personal: "Personal",
  business_checking: "Business Checking",
  business_savings: "Business Savings",
  loan_cc: "Loan / Credit Card",
};

const CATEGORY_ICON: Record<Category, any> = {
  personal: HomeIcon,
  business_checking: Landmark,
  business_savings: Wallet,
  loan_cc: CreditCard,
};

/**
 * Inline single-page form for Balance Sheet reconciliation. Every
 * bank / CC / loan account on the client's QBO COA renders as one row.
 * Bookkeeper picks a category (Personal / Business Checking / Business
 * Savings / Loan-CC), enters the statement ending balance + as-of
 * date, and clicks Save All at the bottom — we compute the gap per
 * row and surface adjusting-JE suggestions inline. No per-account
 * page navigation.
 *
 * Categories are sticky (saved on client_account_categories) so the
 * next BS cleanup session pre-fills.
 */
export function BalanceSheetLanding({
  clientLinkId,
  clientName,
}: {
  clientLinkId: string;
  clientName: string;
}) {
  const router = useRouter();

  // Deep-link section (#reconcile | #uf | #ar | #obe) — the wizard's "Fix"
  // buttons and the client-profile Continue banner land here and open the
  // right resolver. Read after mount so SSR + first client render match.
  const [sectionHash, setSectionHash] = useState("");
  useEffect(() => {
    const h = window.location.hash.replace("#", "");
    if (!h) return;
    setSectionHash(h);
    const t = setTimeout(
      () => document.getElementById(h)?.scrollIntoView({ behavior: "smooth", block: "start" }),
      250
    );
    return () => clearTimeout(t);
  }, []);

  const [accounts, setAccounts] = useState<BSAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<{ recons: number; cats: number } | null>(null);
  // Hardcore-cleanup CSV-less scan state. Posts to /hardcore-cleanup/start
  // with scan_mode=qbo_only — replaces the standalone /balance-sheet/uf-ar
  // tool by running the same UF↔A/R matcher inside hardcore-cleanup's
  // unified items/runs schema. Routes the bookkeeper to the review UI on
  // success so apply_payment items can be bulk-finalized to QBO.
  const [runningQboScan, setRunningQboScan] = useState(false);
  const [qboScanError, setQboScanError] = useState<string>("");
  const [qboScanResult, setQboScanResult] = useState<
    | {
        confident_matches: number;
        low_confidence_matches: number;
        unmatched: number;
        confident_apply_dollars: number;
        review_url: string;
      }
    | null
  >(null);
  // Payroll double-entry scan state. Posts to the scanner endpoint, which
  // creates a new hardcore_cleanup_run + items. On success we route the
  // bookkeeper straight to the review UI for that run.
  const [runningPayrollScan, setRunningPayrollScan] = useState(false);
  const [payrollScanError, setPayrollScanError] = useState<string>("");
  const [payrollScanResult, setPayrollScanResult] = useState<
    | { pairs_detected: number; total_double_booked_dollars: number; review_url: string }
    | null
  >(null);

  // Per-row "Investigate Gap" drawer state
  const [gapOpenFor, setGapOpenFor] = useState<string | null>(null);
  const [gapLoading, setGapLoading] = useState<string | null>(null);
  const [gapData, setGapData] = useState<
    Record<
      string,
      { window: { start: string; end: string }; transactions: GapTxn[]; analysis: GapAnalysis }
    >
  >({});

  // Per-row "Post JE to QBO" status
  const [postingJEFor, setPostingJEFor] = useState<string | null>(null);
  const [postedJEs, setPostedJEs] = useState<Record<string, { qbo_je_id: string; doc_number: string | null }>>({});
  const [jeErrors, setJEErrors] = useState<Record<string, string>>({});

  // Uploaded-statement auto-fill (Mike 2026-07-17): the latest matched
  // statement per QBO account prefills ending balance + as-of date, so the
  // bookkeeper reviews and approves instead of retyping numbers we already
  // extracted from the PDFs.
  const [stmtByAccount, setStmtByAccount] = useState<
    Record<string, { ending_balance: number; statement_end_date: string; display_name: string }>
  >({});
  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set());

  async function loadAccounts() {
    setLoading(true);
    setError("");
    try {
      const [accRes, prefillRes, stmtRes] = await Promise.all([
        fetch(`/api/clients/${clientLinkId}/bs-accounts`).then((r) => r.json()),
        fetch(
          `/api/balance-sheet/bank-recon-batch?client_link_id=${clientLinkId}`
        ).then((r) => r.json()),
        fetch(`/api/clients/${clientLinkId}/statements`)
          .then((r) => r.json())
          .catch(() => null),
      ]);

      if (accRes.error) throw new Error(accRes.error);
      const allAccts: BSAccount[] = [
        ...(accRes.accounts.bank || []),
        ...(accRes.accounts.credit_card || []),
        ...(accRes.accounts.loan || []),
      ];
      setAccounts(allAccts);

      // Latest MATCHED statement per QBO account — needs an extracted ending
      // balance + end date to be usable as recon input.
      const byAccount: Record<string, { ending_balance: number; statement_end_date: string; display_name: string }> = {};
      const stmts: any[] = Array.isArray(stmtRes?.statements)
        ? stmtRes.statements
        : Array.isArray(stmtRes)
        ? stmtRes
        : [];
      for (const s of stmts) {
        const acct = s?.matched_qbo_account_id != null ? String(s.matched_qbo_account_id) : "";
        if (!acct || s?.ending_balance == null || !s?.statement_end_date) continue;
        const endDate = String(s.statement_end_date).slice(0, 10);
        const cur = byAccount[acct];
        if (!cur || endDate > cur.statement_end_date) {
          byAccount[acct] = {
            ending_balance: Number(s.ending_balance),
            statement_end_date: endDate,
            display_name: s.display_name || s.original_name || "uploaded statement",
          };
        }
      }
      setStmtByAccount(byAccount);

      // Pre-fill rows: the bookkeeper's saved recon input wins; otherwise the
      // uploaded statement fills the balance + as-of automatically.
      const initial: Record<string, RowState> = {};
      const filled = new Set<string>();
      for (const a of allAccts) {
        const prior = prefillRes?.prefill?.[a.qbo_account_id];
        const st = byAccount[String(a.qbo_account_id)];
        const useStatement = st && prior?.statement_ending_balance == null;
        if (useStatement) filled.add(a.qbo_account_id);
        initial[a.qbo_account_id] = {
          category: prior?.category || "",
          ending_balance:
            prior?.statement_ending_balance?.toString() ?? (useStatement ? String(st.ending_balance) : ""),
          as_of_date: prior?.statement_as_of_date ?? (useStatement ? st.statement_end_date : ""),
          notes: prior?.notes ?? "",
        };
      }
      setAutoFilled(filled);
      setRows(initial);
    } catch (e: any) {
      setError(e.message || "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }

  // Overwrite the recon inputs from the uploaded statements (including rows
  // the bookkeeper already touched) — the "just approve it" path.
  function applyStatementData() {
    setRows((prev) => {
      const next = { ...prev };
      for (const [acct, st] of Object.entries(stmtByAccount)) {
        if (!next[acct]) continue;
        next[acct] = {
          ...next[acct],
          ending_balance: String(st.ending_balance),
          as_of_date: st.statement_end_date,
        };
      }
      return next;
    });
    setAutoFilled((prev) => {
      const next = new Set(prev);
      for (const acct of Object.keys(stmtByAccount)) next.add(acct);
      return next;
    });
  }

  useEffect(() => {
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientLinkId]);

  function updateRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    // Clear any prior save success since the input changed
    setSaveSuccess(null);
  }

  async function saveAll() {
    setSaving(true);
    setError("");
    setSaveSuccess(null);
    try {
      const entries = accounts
        .map((a) => {
          const r = rows[a.qbo_account_id];
          if (!r) return null;
          const hasBalance =
            r.ending_balance !== "" && r.ending_balance != null;
          const hasDate = !!r.as_of_date;
          if (!r.category && !hasBalance && !hasDate) return null;
          return {
            qbo_account_id: a.qbo_account_id,
            category: r.category || null,
            statement_ending_balance: hasBalance ? Number(r.ending_balance) : null,
            statement_as_of_date: hasDate ? r.as_of_date : null,
            notes: r.notes || null,
          };
        })
        .filter(Boolean);

      const res = await fetch("/api/balance-sheet/bank-recon-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId, entries }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);

      // Index suggestions by qbo_account_id for inline render
      const map: Record<string, Suggestion> = {};
      for (const s of json.suggestions || []) {
        map[s.qbo_account_id] = s;
      }
      setSuggestions(map);
      setSaveSuccess({
        recons: json.saved_recons || 0,
        cats: json.saved_categories || 0,
      });
    } catch (e: any) {
      setError(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function investigateGap(qboAccountId: string) {
    const sug = suggestions[qboAccountId];
    const row = rows[qboAccountId];
    if (!sug || !row?.as_of_date) return;
    setGapOpenFor(qboAccountId);
    if (gapData[qboAccountId]) return; // already loaded
    setGapLoading(qboAccountId);
    try {
      const res = await fetch("/api/balance-sheet/analyze-gap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          qbo_account_id: qboAccountId,
          statement_as_of_date: row.as_of_date,
          gap_amount: sug.gap,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setGapData((prev) => ({
        ...prev,
        [qboAccountId]: {
          window: json.window,
          transactions: json.transactions,
          analysis: json.analysis,
        },
      }));
    } catch (e: any) {
      setError(e.message || "Gap analysis failed");
      setGapOpenFor(null);
    } finally {
      setGapLoading(null);
    }
  }

  async function postJE(qboAccountId: string) {
    const sug = suggestions[qboAccountId];
    const row = rows[qboAccountId];
    if (!sug || !sug.je_lines.length || !row?.as_of_date) return;
    setPostingJEFor(qboAccountId);
    setJEErrors((p) => ({ ...p, [qboAccountId]: "" }));
    try {
      // Translate je_lines (which have account_hint) to the POST format.
      // For the account corresponding to this BS row, we already know the
      // QBO ID. For the OTHER side (Owner Equity / Interest Expense / etc),
      // we send the hint and let the server resolve.
      const lines = sug.je_lines.map((l) => {
        // Match the bank account by name (the hint when category is Personal
        // is the bank account itself).
        if (l.account_hint === sug.account_name) {
          return {
            qbo_account_id: qboAccountId,
            side: l.side,
            amount: l.amount,
            description: l.description,
          };
        }
        return {
          account_hint: l.account_hint,
          side: l.side,
          amount: l.amount,
          description: l.description,
        };
      });

      const res = await fetch("/api/balance-sheet/post-je", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          lines,
          txn_date: row.as_of_date,
          memo: `Adjusting entry from BS reconciliation — ${sug.summary}`,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.unresolved?.length) {
          const hints = json.unresolved.map((u: any) => u.account_hint).join(", ");
          throw new Error(
            `Couldn't auto-match: ${hints}. ${json.reason || ""} Pick the QBO account manually in QBO instead.`
          );
        }
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setPostedJEs((p) => ({
        ...p,
        [qboAccountId]: {
          qbo_je_id: json.qbo_je_id,
          doc_number: json.doc_number,
        },
      }));
    } catch (e: any) {
      setJEErrors((p) => ({ ...p, [qboAccountId]: e.message || "JE post failed" }));
    } finally {
      setPostingJEFor(null);
    }
  }

  async function runQboScan() {
    setRunningQboScan(true);
    setQboScanError("");
    setQboScanResult(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/hardcore-cleanup/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scan_mode: "qbo_only" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setQboScanResult({
        confident_matches: json.confident_matches,
        low_confidence_matches: json.low_confidence_matches,
        unmatched: json.unmatched,
        confident_apply_dollars: json.confident_apply_dollars,
        review_url: json.review_url,
      });
    } catch (e: any) {
      setQboScanError(e?.message || "QBO scan failed");
    } finally {
      setRunningQboScan(false);
    }
  }

  async function runPayrollScan() {
    setRunningPayrollScan(true);
    setPayrollScanError("");
    setPayrollScanResult(null);
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/payroll-double-entry-scan`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setPayrollScanResult({
        pairs_detected: json.pairs_detected,
        total_double_booked_dollars: json.total_double_booked_dollars,
        review_url: json.review_url,
      });
    } catch (e: any) {
      setPayrollScanError(e?.message || "Payroll scan failed");
    } finally {
      setRunningPayrollScan(false);
    }
  }

  // (Legacy runUFAR removed — replaced by runQboScan which routes UF↔A/R
  // matching through hardcore_cleanup's unified runs/items so apply_payment
  // resolutions can be bulk-finalized to QBO in one place. The standalone
  // /balance-sheet/uf-ar/[id]/review path stays available for in-flight
  // jobs until commit 3 sunsets it; new scans land on the new flow.)

  // Order accounts so banks come first, then CCs, then loans.
  const orderedAccounts = useMemo(() => {
    const order: Record<string, number> = { bank: 0, credit_card: 1, loan: 2 };
    return [...accounts].sort((a, b) => {
      const k = order[a.kind] - order[b.kind];
      if (k !== 0) return k;
      return a.name.localeCompare(b.name);
    });
  }, [accounts]);

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(n);

  return (
    <div className="space-y-6">
      {/* Guided BS cleanup wizard — primary path from kanban bs_cleanup stage */}
      <div className="rounded-2xl bg-navy text-white p-5 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold">Guided BS Cleanup</h2>
          <p className="text-xs text-white/70 mt-1">
            Health Score, module checklist, review queue, and QA gate — all in one wizard.
          </p>
        </div>
        <a
          href={`/balance-sheet/${clientLinkId}/cleanup`}
          className="flex-shrink-0 text-xs font-semibold px-4 py-2 rounded-lg bg-teal hover:bg-teal-dark transition-colors"
        >
          Open wizard →
        </a>
      </div>

      {/* Resolve issues — this page is the ONE place to fix the balance sheet.
          Each chip jumps to and opens its resolver below. */}
      <div className="rounded-2xl bg-white border border-gray-200 p-4">
        <div className="text-xs font-bold uppercase tracking-wide text-ink-slate mb-2">
          Resolve balance-sheet issues here
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            { id: "reconcile", label: "Reconcile accounts", icon: Scale },
            { id: "uf", label: "Undeposited Funds", icon: Banknote },
            { id: "ar", label: "A/R vs duplicates", icon: ScrollText },
            { id: "obe", label: "Opening Balance Equity", icon: Landmark },
          ].map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={() => setSectionHash(s.id)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200 text-navy hover:border-teal/50 hover:bg-teal/5"
            >
              <s.icon size={13} className="text-teal" /> {s.label}
            </a>
          ))}
        </div>
      </div>

      {/* Job-app CSV import card — sits above UF→A/R so the bookkeeper
          uploads source-of-truth invoices first; the duplicate detector
          downstream consumes the lineage_key to label estimate revisions
          vs real duplicates correctly. */}
      <ExternalInvoiceUpload clientLinkId={clientLinkId} />

      {/* Advanced scans — secondary, power-user tools. Collapsed by default
          so the Guided Cleanup wizard above stays the primary entry point. */}
      <details className="group space-y-6">
        <summary className="cursor-pointer list-none flex items-center gap-2 text-sm font-bold text-navy select-none">
          <ChevronRight size={16} className="text-ink-slate transition-transform group-open:rotate-90" />
          Advanced scans &amp; tools
          <span className="text-xs font-normal text-ink-light">
            (UF → A/R, payroll double-entries, AI reconcile, full COA)
          </span>
        </summary>

      {/* UF → A/R direct scan (no CSV required) — runs the same
          matchUFtoAR engine the legacy /balance-sheet/uf-ar tool used,
          but persists into hardcore_cleanup_runs/items so the bookkeeper
          can bulk-finalize in one place. Confident matches land as
          apply_payment resolutions ready for Finalize. */}
      <div className="rounded-2xl bg-gradient-to-br from-teal-lighter to-white border border-teal/30 p-5">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-teal-light flex-shrink-0">
            <Wallet size={18} className="text-teal" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-navy">
              Match Undeposited Funds to A/R (no CSV needed)
            </h2>
            <p className="text-xs text-ink-slate mt-1 leading-relaxed">
              Scans every QBO UF payment against open A/R invoices.
              Exact invoice refs (INV-1234 in memo) → auto-applied.
              Same customer + exact amount → auto-applied. Rest → manual
              picker. Confident matches push to QBO via Finalize.
            </p>
            {qboScanError && (
              <p className="mt-2 text-xs text-red-700 font-semibold">
                {qboScanError}
              </p>
            )}
            {qboScanResult && (
              <div className="mt-2 text-xs space-y-0.5">
                {qboScanResult.confident_matches === 0 &&
                qboScanResult.low_confidence_matches === 0 &&
                qboScanResult.unmatched === 0 ? (
                  <span className="text-green-700 font-semibold">
                    ✓ No Undeposited Funds payments to reconcile — UF is clean.
                  </span>
                ) : (
                  <>
                    <a
                      href={qboScanResult.review_url}
                      className="inline-flex items-center gap-1.5 text-teal font-bold hover:text-teal-dark underline"
                    >
                      {qboScanResult.confident_matches} ready-to-apply
                      {qboScanResult.confident_apply_dollars > 0 && (
                        <>
                          {" "}($
                          {qboScanResult.confident_apply_dollars.toLocaleString("en-US", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })})
                        </>
                      )}
                      {qboScanResult.low_confidence_matches > 0 && (
                        <>
                          {", "}
                          {qboScanResult.low_confidence_matches} need picker
                        </>
                      )}
                      {qboScanResult.unmatched > 0 && (
                        <>
                          {", "}
                          {qboScanResult.unmatched} unmatched
                        </>
                      )}
                      {" "}— review →
                    </a>
                  </>
                )}
              </div>
            )}
          </div>
          <button
            onClick={runQboScan}
            disabled={runningQboScan}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-xs font-semibold px-4 py-2 rounded-lg flex-shrink-0"
          >
            {runningQboScan ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {runningQboScan ? "Scanning…" : "Scan UF → A/R"}
            <ArrowRight size={12} />
          </button>
        </div>
      </div>

      {/* Payroll double-entry detector — finds QBO Payroll DDs that are
          mirrored by a Transfer/JE categorized against the same wages
          account (the canonical "P&L wages are 2× actual" bug). Lisa
          confirmed Clean Cut / BMD / Make it Happen all have this.
          Runs against last 24 months of payroll-account txns by default. */}
      <div className="rounded-2xl bg-gradient-to-br from-red-50 to-white border border-red-200 p-5">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-red-100 flex-shrink-0">
            <AlertCircle size={18} className="text-red-700" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-navy">
              Scan for QBO Payroll double-entries
            </h2>
            <p className="text-xs text-ink-slate mt-1 leading-relaxed">
              QBO Payroll&apos;s locked Paycheck/DD transactions sometimes get
              mirrored by a bookkeeper-recorded Transfer or JE that hits the
              same wages account — booking the expense twice. Finds matching
              pairs across the last 24 months so you can recategorize the
              duplicate side to a Payroll Clearing / transfer account.
            </p>
            {payrollScanError && (
              <p className="mt-2 text-xs text-red-700 font-semibold">
                {payrollScanError}
              </p>
            )}
            {payrollScanResult && (
              <div className="mt-2 text-xs">
                {payrollScanResult.pairs_detected === 0 ? (
                  <span className="text-green-700 font-semibold">
                    ✓ No double-entry pairs detected — payroll posting looks clean.
                  </span>
                ) : (
                  <a
                    href={payrollScanResult.review_url}
                    className="inline-flex items-center gap-1.5 text-red-700 font-bold hover:text-red-900 underline"
                  >
                    Found {payrollScanResult.pairs_detected} pair
                    {payrollScanResult.pairs_detected === 1 ? "" : "s"} totaling{" "}
                    ${payrollScanResult.total_double_booked_dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    {" "}of overstated wage expense — review →
                  </a>
                )}
              </div>
            )}
          </div>
          <button
            onClick={runPayrollScan}
            disabled={runningPayrollScan}
            className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold px-4 py-2 rounded-lg flex-shrink-0"
          >
            {runningPayrollScan ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <AlertCircle size={14} />
            )}
            {runningPayrollScan ? "Scanning…" : "Scan payroll"}
            <ArrowRight size={12} />
          </button>
        </div>
      </div>

      {/* UF AI Reconcile — CSV-driven, works without live QBO tokens.
          Bookkeeper exports AR + UF transaction reports from QBO, drops
          them here, Claude returns matched payments + open items + QBO
          cleanup steps. Especially useful when QBO refresh tokens are
          dead (the firm-level QBOA connection stays alive for exports
          even when SNAP's OAuth grant is broken). */}
      <div className="rounded-2xl bg-gradient-to-br from-teal/5 to-white border-2 border-teal/20 p-5">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-teal/10 flex-shrink-0">
            <Sparkles size={18} className="text-teal" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-bold text-navy">UF AI Reconcile</h2>
              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-teal text-white">NEW</span>
            </div>
            <p className="text-xs text-ink-slate mt-1 leading-relaxed">
              Upload the AR + Undeposited Funds CSVs from QuickBooks. Claude matches
              payments to deposits, finds what&apos;s still stuck, verifies the math, and
              writes step-by-step QuickBooks instructions to clear it. Works without a
              live QBO connection — paste the CSVs and go.
            </p>
          </div>
          <a
            href={`/balance-sheet/${clientLinkId}/uf-ai`}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-4 py-2 rounded-lg flex-shrink-0"
          >
            <Sparkles size={14} />
            Open UF Reconcile
            <ArrowRight size={12} />
          </a>
        </div>
      </div>

      {/* Standalone BS COA viewer — see every BS account, not just the
          bank/cc/loan subset shown below. Scrub-reclass entry per row. */}
      <div className="rounded-2xl bg-gradient-to-br from-slate-50 to-white border border-slate-200 p-5">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-slate-100 flex-shrink-0">
            <FileSpreadsheet size={18} className="text-slate-700" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-navy">View full Balance Sheet COA</h2>
            <p className="text-xs text-ink-slate mt-1 leading-relaxed">
              Live tree of every BS account in QBO — banks, A/R, A/P, fixed assets, all liabilities, equity. Click any row to reclass transactions out of it (e.g. fix what&apos;s stuck in Undeposited Funds, clean up A/R aging, move owner draws).
            </p>
          </div>
          <a
            href={`/balance-sheet/${clientLinkId}/coa`}
            className="inline-flex items-center gap-2 bg-slate-700 hover:bg-slate-800 text-white text-xs font-semibold px-4 py-2 rounded-lg flex-shrink-0"
          >
            <Search size={14} />
            Open BS COA
            <ArrowRight size={12} />
          </a>
        </div>
      </div>
      </details>

      {/* Account reconciliation form — the main event */}
      <div id="reconcile" className="rounded-2xl bg-white border border-gray-200 overflow-hidden scroll-mt-24">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-navy">
              Reconcile accounts for {clientName}
            </h2>
            <p className="text-xs text-ink-slate mt-1 leading-relaxed">
              Step 1 — Enter statement data: pick the category, enter the
              statement ending balance + as-of date, and hit Save.
              Step 2 — Review adjustments: we compute the gap vs QBO and
              propose adjusting journal entries inline for you to post.
              Categories are sticky across cleanup sessions.
            </p>
          </div>
          <button
            onClick={loadAccounts}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-60 flex-shrink-0"
            title="Re-pull from QBO"
          >
            {loading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            Refresh
          </button>
        </div>

        {/* Uploaded statements → recon inputs. The AI already extracted the
            ending balance + end date from each matched statement PDF; this
            surfaces that and fills the table so the bookkeeper approves
            instead of retyping. */}
        {!loading && Object.keys(stmtByAccount).length > 0 && (
          <div className="mx-5 mt-4 rounded-xl border border-teal-border bg-teal-light/70 px-4 py-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-navy leading-relaxed">
                <strong className="font-bold">
                  {Object.keys(stmtByAccount).length} account
                  {Object.keys(stmtByAccount).length === 1 ? " has" : "s have"} uploaded statements
                </strong>
                {autoFilled.size > 0 ? (
                  <>
                    {" "}— {autoFilled.size} row{autoFilled.size === 1 ? "" : "s"} below auto-filled with the
                    statement&apos;s ending balance + end date (marked{" "}
                    <span className="text-teal-dark font-semibold">from statement</span>). Review, then Save &amp;
                    Review Gaps.
                  </>
                ) : (
                  <> — your saved recon inputs are showing; click to overwrite them with the statement data.</>
                )}
              </div>
              <button
                onClick={applyStatementData}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-teal-border bg-white px-3 py-1.5 text-xs font-bold text-teal-dark hover:bg-teal-light"
              >
                <Sparkles size={12} /> Fill from statements
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="m-4 p-2.5 rounded-md bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {saveSuccess && (
          <div className="m-4 p-2.5 rounded-md bg-green-50 border border-green-200 text-xs text-green-900 flex items-start gap-2">
            <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" />
            <span>
              Saved {saveSuccess.recons} reconciliation entr
              {saveSuccess.recons === 1 ? "y" : "ies"} +{" "}
              {saveSuccess.cats} categor
              {saveSuccess.cats === 1 ? "y" : "ies"}. JE suggestions appear
              inline below.
            </span>
          </div>
        )}

        {loading && accounts.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-ink-slate">
            <Loader2 size={18} className="inline animate-spin mr-2 text-teal" />
            Fetching accounts from QuickBooks…
          </div>
        )}

        {orderedAccounts.length > 0 && (
          <>
            {/* Header row */}
            <div className="px-5 py-2.5 bg-gray-50 border-b border-gray-100 text-[10px] font-bold uppercase tracking-wider text-ink-slate grid items-center gap-3"
                 style={{ gridTemplateColumns: "minmax(180px,2fr) minmax(140px,1.4fr) 110px 130px 100px 32px" }}>
              <div>Account</div>
              <div>Category</div>
              <div>QBO balance</div>
              <div>Statement ending balance</div>
              <div>As-of date</div>
              <div></div>
            </div>

            <div className="divide-y divide-gray-100">
              {orderedAccounts.map((a) => {
                const r = rows[a.qbo_account_id] || {
                  category: "",
                  ending_balance: "",
                  as_of_date: "",
                  notes: "",
                };
                const sug = suggestions[a.qbo_account_id];
                return (
                  <div key={a.qbo_account_id}>
                    <div className="px-5 py-3 grid items-center gap-3"
                         style={{ gridTemplateColumns: "minmax(180px,2fr) minmax(140px,1.4fr) 110px 130px 100px 32px" }}>
                      {/* Account name + last4 */}
                      <div className="min-w-0">
                        <div className="font-semibold text-sm text-navy truncate">
                          {a.name}
                          {a.last4 && (
                            <span className="ml-1.5 font-mono text-xs text-ink-slate">
                              •••{a.last4}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-ink-light truncate">
                          {a.account_subtype || a.account_type}
                        </div>
                      </div>

                      {/* Category */}
                      <select
                        value={r.category}
                        onChange={(e) =>
                          updateRow(a.qbo_account_id, {
                            category: e.target.value as Category,
                          })
                        }
                        className="px-2 py-1.5 rounded border border-gray-200 focus:border-teal outline-none text-xs text-navy bg-white"
                      >
                        <option value="">— Pick —</option>
                        <option value="business_checking">
                          Business Checking
                        </option>
                        <option value="business_savings">
                          Business Savings
                        </option>
                        <option value="loan_cc">Loan / CC</option>
                        <option value="personal">Personal</option>
                      </select>

                      {/* QBO balance — show AS-OF the statement date when
                          we have one, with a small "current" caption for
                          context. Falls back to current_balance when no
                          statement date is entered. */}
                      <div className="text-xs font-mono text-right">
                        {(() => {
                          const sug = suggestions[a.qbo_account_id];
                          const hasAsOf =
                            sug?.qbo_balance_at_date != null &&
                            r.as_of_date;
                          if (hasAsOf) {
                            return (
                              <div>
                                <div className="text-navy">
                                  {fmt(sug!.qbo_balance_at_date!)}
                                </div>
                                <div className="text-[9px] text-ink-light">
                                  as of {r.as_of_date}
                                </div>
                                {sug!.qbo_current_balance != null &&
                                  Math.abs(
                                    sug!.qbo_current_balance -
                                      sug!.qbo_balance_at_date!
                                  ) > 0.01 && (
                                    <div className="text-[9px] text-ink-light">
                                      ({fmt(sug!.qbo_current_balance)} today)
                                    </div>
                                  )}
                              </div>
                            );
                          }
                          return (
                            <div className="text-ink-slate">
                              {fmt(a.current_balance)}
                            </div>
                          );
                        })()}
                      </div>

                      {/* Statement ending balance */}
                      <div className="flex flex-col min-w-0">
                        <input
                          type="number"
                          step="0.01"
                          value={r.ending_balance}
                          onChange={(e) =>
                            updateRow(a.qbo_account_id, {
                              ending_balance: e.target.value,
                            })
                          }
                          placeholder="0.00"
                          className="px-2 py-1.5 rounded border border-gray-200 focus:border-teal outline-none text-xs font-mono text-navy text-right"
                        />
                        {autoFilled.has(a.qbo_account_id) && stmtByAccount[String(a.qbo_account_id)] && (
                          <span
                            className="text-[9px] text-teal-dark mt-0.5 text-right truncate"
                            title={stmtByAccount[String(a.qbo_account_id)].display_name}
                          >
                            from statement
                          </span>
                        )}
                      </div>

                      {/* As-of date */}
                      <input
                        type="date"
                        value={r.as_of_date}
                        onChange={(e) =>
                          updateRow(a.qbo_account_id, {
                            as_of_date: e.target.value,
                          })
                        }
                        className="px-2 py-1.5 rounded border border-gray-200 focus:border-teal outline-none text-xs text-navy"
                      />

                      {/* Status indicator */}
                      <div className="flex items-center justify-center">
                        {sug && sug.status === "matched" && (
                          <CheckCircle2
                            size={16}
                            className="text-green-600"
                          />
                        )}
                        {sug && sug.status === "gap" && (
                          <AlertCircle
                            size={16}
                            className="text-amber-600"
                          />
                        )}
                      </div>
                    </div>

                    {/* JE suggestion (inline below row when saved) */}
                    {sug && sug.status !== "no_balance" && (
                      <div
                        className={`px-5 py-3 ml-12 mr-5 mb-3 rounded-lg border text-xs ${
                          sug.status === "matched"
                            ? "bg-green-50 border-green-200"
                            : "bg-amber-50 border-amber-200"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex-1">
                            <div
                              className={`font-bold text-sm ${
                                sug.status === "matched"
                                  ? "text-green-900"
                                  : "text-amber-900"
                              }`}
                            >
                              {sug.summary}
                              {sug.status === "gap" && (
                                <span className="ml-2 font-mono font-normal">
                                  {fmt(sug.gap)}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 leading-relaxed text-ink-slate">
                              {sug.reasoning}
                            </p>
                            {sug.je_lines.length > 0 && (
                              <div className="mt-3 bg-white border border-gray-200 rounded p-2">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1.5">
                                  Suggested journal entry
                                </div>
                                <table className="w-full text-[11px]">
                                  <thead>
                                    <tr className="text-ink-light">
                                      <th className="text-left font-semibold pr-3">Account</th>
                                      <th className="text-right font-semibold pr-3">DR</th>
                                      <th className="text-right font-semibold">CR</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sug.je_lines.map((line, i) => (
                                      <tr key={i} className="border-t border-gray-100">
                                        <td className="py-1 pr-3">
                                          <div className="font-semibold text-navy">
                                            {line.account_hint}
                                          </div>
                                          <div className="text-[10px] text-ink-light">
                                            {line.description}
                                          </div>
                                        </td>
                                        <td className="text-right font-mono pr-3">
                                          {line.side === "debit"
                                            ? fmt(line.amount)
                                            : ""}
                                        </td>
                                        <td className="text-right font-mono">
                                          {line.side === "credit"
                                            ? fmt(line.amount)
                                            : ""}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>

                                {/* Post-JE action */}
                                <div className="mt-2 pt-2 border-t border-gray-100">
                                  {postedJEs[a.qbo_account_id] ? (
                                    <div className="flex items-center gap-2 text-[11px] text-green-700">
                                      <CheckCircle2 size={12} />
                                      Posted to QBO as JE #{postedJEs[a.qbo_account_id].doc_number || postedJEs[a.qbo_account_id].qbo_je_id}
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <button
                                        onClick={() => postJE(a.qbo_account_id)}
                                        disabled={postingJEFor === a.qbo_account_id}
                                        className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-[11px] font-semibold px-3 py-1.5 rounded"
                                      >
                                        {postingJEFor === a.qbo_account_id ? (
                                          <Loader2 size={11} className="animate-spin" />
                                        ) : (
                                          <Send size={11} />
                                        )}
                                        {postingJEFor === a.qbo_account_id ? "Posting…" : "Post JE to QBO"}
                                      </button>
                                      {jeErrors[a.qbo_account_id] && (
                                        <span className="text-[10px] text-red-700">
                                          {jeErrors[a.qbo_account_id]}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}

                            {/* Investigate-gap link */}
                            {sug.status === "gap" && (
                              <div className="mt-2">
                                <button
                                  onClick={() => investigateGap(a.qbo_account_id)}
                                  disabled={gapLoading === a.qbo_account_id}
                                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-900 hover:text-amber-950 underline disabled:opacity-60"
                                >
                                  {gapLoading === a.qbo_account_id ? (
                                    <Loader2 size={11} className="animate-spin" />
                                  ) : (
                                    <Search size={11} />
                                  )}
                                  {gapLoading === a.qbo_account_id
                                    ? "Pulling transactions…"
                                    : gapOpenFor === a.qbo_account_id
                                    ? "Hide investigation"
                                    : "Investigate gap (find the offending transactions)"}
                                </button>

                                {gapOpenFor === a.qbo_account_id &&
                                  gapData[a.qbo_account_id] && (
                                    <GapInvestigation
                                      data={gapData[a.qbo_account_id]}
                                      fmt={fmt}
                                      onClose={() => setGapOpenFor(null)}
                                    />
                                  )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Save all */}
            <div className="px-5 py-4 border-t border-gray-100 bg-gray-50 flex items-center justify-between gap-3">
              <div className="text-xs text-ink-slate">
                Categories are sticky; reconciliation entries are
                history-preserving (each Save All inserts new rows).
              </div>
              <button
                onClick={saveAll}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-sm font-semibold px-5 py-2 rounded-lg"
              >
                {saving ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Save size={14} />
                )}
                {saving ? "Saving…" : "Save & Review Gaps"}
              </button>
            </div>
          </>
        )}

        {!loading && orderedAccounts.length === 0 && !error && (
          <div className="px-5 py-8 text-center text-sm text-ink-slate">
            No bank, credit-card, or loan accounts on this client&apos;s QBO.
          </div>
        )}
      </div>

      {/* ── Undeposited Funds — orphan-payment resolver, merged in-page ── */}
      <CollapsibleSection
        id="uf"
        currentHash={sectionHash}
        icon={Banknote}
        title="Undeposited Funds"
        subtitle="Find payments stuck in Undeposited Funds, match them to their real deposits, and post the clearing entries to QuickBooks. Whatever the client can't confirm becomes a one-click Ask."
      >
        <UfAuditClient clientLinkId={clientLinkId} clientName={clientName} latestScan={null} />
      </CollapsibleSection>

      {/* ── A/R vs CRM duplicates — the inflated-A/R fix ── */}
      <CollapsibleSection
        id="ar"
        currentHash={sectionHash}
        icon={ScrollText}
        title="Accounts Receivable — verify against duplicates"
        subtitle="Most inflated A/R is CRM invoices whose cash already arrived as a bank deposit. This checks every open invoice against the deposits and lets you void the duplicate invoice or apply the deposit to it — so A/R reflects what's genuinely still owed."
      >
        <ArSection clientLinkId={clientLinkId} clientName={clientName} />
      </CollapsibleSection>

      {/* ── Opening Balance Equity — one-click zero ── */}
      <CollapsibleSection
        id="obe"
        currentHash={sectionHash}
        icon={Landmark}
        title="Opening Balance Equity"
        subtitle="A clean balance sheet has $0 here. One click proposes the entry that moves whatever's sitting in OBE into Retained Earnings — you review it before it posts."
      >
        <ObeCard clientLinkId={clientLinkId} />
      </CollapsibleSection>
    </div>
  );
}

/**
 * Collapsible resolver section. Opens automatically when the page's deep-link
 * hash matches its id (so the wizard's "Fix →" buttons land open). Children
 * only mount while open, so the embedded UF audit / A/R panels don't fetch
 * QBO until the bookkeeper actually opens the section.
 */
function CollapsibleSection({
  id,
  currentHash,
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  id: string;
  currentHash: string;
  icon: any;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (currentHash === id) setOpen(true);
  }, [currentHash, id]);
  return (
    <section id={id} className="rounded-2xl bg-white border border-gray-200 overflow-hidden scroll-mt-24">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-gray-50/60"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon size={16} className="text-teal shrink-0" />
          <div className="min-w-0">
            <h2 className="text-base font-bold text-navy">{title}</h2>
            {subtitle && <p className="text-xs text-ink-slate mt-0.5 leading-relaxed">{subtitle}</p>}
          </div>
        </div>
        <ChevronDown size={18} className={`text-ink-slate shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="px-5 pb-5 border-t border-gray-100 pt-4">{children}</div>}
    </section>
  );
}

/**
 * A/R resolver — a look-back range selector feeding the shared CRM-invoice
 * remediation panel (void the duplicate invoice OR apply its matched deposit).
 * Default is "since last year" because the CRM double-counts usually go back
 * further than the current cleanup window.
 */
function ArSection({ clientLinkId, clientName }: { clientLinkId: string; clientName: string }) {
  const now = new Date();
  const year = now.getFullYear();
  const today = now.toISOString().slice(0, 10);
  const RANGES = [
    { key: "ytd", label: "This year", start: `${year}-01-01`, end: today },
    { key: "prev", label: `Since Jan ${year - 1}`, start: `${year - 1}-01-01`, end: today },
    { key: "all", label: `All history (since ${year - 5})`, start: `${year - 5}-01-01`, end: today },
  ];
  const [rangeKey, setRangeKey] = useState("prev");
  const range = RANGES.find((r) => r.key === rangeKey) || RANGES[1];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-ink-slate font-semibold">Look back:</span>
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setRangeKey(r.key)}
            className={`px-2.5 py-1 rounded-lg border font-semibold ${
              rangeKey === r.key ? "bg-teal text-white border-teal" : "border-gray-200 text-ink-slate hover:border-teal/50"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>
      {/* key forces a clean remount (resets the panel's preview) on range change */}
      <QboRemediationPanel
        key={`${range.start}-${range.end}`}
        clientLinkId={clientLinkId}
        clientName={clientName}
        start={range.start}
        end={range.end}
      />
    </div>
  );
}

/**
 * Opening Balance Equity one-click. Reads the live OBE balance + a proposed
 * zeroing entry (OBE → Retained Earnings) from /api/balance-sheet/obe, shows
 * the exact debits/credits, and posts via /api/balance-sheet/post-je on
 * confirm. Read-only until the bookkeeper clicks Post.
 */
function ObeCard({ clientLinkId }: { clientLinkId: string }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState<{ doc_number: string | null; qbo_je_id: string } | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    setPosted(null);
    try {
      const res = await fetch(`/api/balance-sheet/obe?client_link_id=${clientLinkId}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e: any) {
      setError(e?.message || "Couldn't read the OBE balance");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientLinkId]);

  async function postJE() {
    if (!data?.proposed_lines?.length) return;
    setPosting(true);
    setError("");
    try {
      const res = await fetch("/api/balance-sheet/post-je", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          lines: data.proposed_lines,
          txn_date: data.txn_date,
          memo: data.memo,
        }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || j.reason || `HTTP ${res.status}`);
      setPosted({ doc_number: j.doc_number ?? null, qbo_je_id: j.qbo_je_id });
    } catch (e: any) {
      setError(e?.message || "Post failed");
    } finally {
      setPosting(false);
    }
  }

  const money = (n: number) =>
    `$${Math.abs(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (loading) {
    return (
      <div className="text-sm text-ink-slate flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Reading Opening Balance Equity…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        <button onClick={load} className="text-xs font-bold px-3 py-1.5 rounded-lg border border-gray-200 hover:border-teal/50">
          Retry
        </button>
      </div>
    );
  }
  if (!data?.obe) {
    return <div className="text-sm text-emerald-700 flex items-center gap-2"><CheckCircle2 size={14} /> No Opening Balance Equity account on this file — nothing to clear.</div>;
  }
  if (data.is_clean) {
    return (
      <div className="text-sm text-emerald-700 flex items-center gap-2">
        <CheckCircle2 size={14} /> {data.obe.name} is already $0 — clean.
      </div>
    );
  }
  if (posted) {
    return (
      <div className="text-sm text-emerald-700 flex items-center gap-2">
        <CheckCircle2 size={14} /> Posted to QuickBooks as JE #{posted.doc_number || posted.qbo_je_id} — {data.obe.name} is now zeroed.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <span className="text-navy font-semibold">{data.obe.name}</span>
        <span className="font-mono text-red-700 font-bold">{money(data.obe.balance)}</span>
        <span className="text-xs text-ink-light">needs to be zeroed into {data.target?.name || "Retained Earnings"}</span>
      </div>
      <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
        <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-1.5">Proposed journal entry</div>
        <table className="w-full text-xs">
          <tbody>
            {(data.proposed_lines || []).map((l: any, i: number) => (
              <tr key={i} className="border-b border-gray-100 last:border-0">
                <td className="py-1.5 text-navy">{l.account_hint}</td>
                <td className="py-1.5 text-right font-mono text-ink-slate">{l.side === "debit" ? money(l.amount) : ""}</td>
                <td className="py-1.5 text-right font-mono text-ink-slate">{l.side === "credit" ? money(l.amount) : ""}</td>
              </tr>
            ))}
            <tr className="text-[10px] uppercase tracking-wider text-ink-light">
              <td></td>
              <td className="text-right pt-1">Debit</td>
              <td className="text-right pt-1">Credit</td>
            </tr>
          </tbody>
        </table>
      </div>
      <button
        onClick={postJE}
        disabled={posting}
        className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-sm font-semibold px-4 py-2 rounded-lg"
      >
        {posting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        {posting ? "Posting…" : "Post entry to QuickBooks"}
      </button>
    </div>
  );
}

/**
 * Inline gap-investigation drawer. Renders the heuristic analyzer's
 * ranked candidate list (likely duplicates / outliers / etc.) plus the
 * full transaction window so the bookkeeper can scan for whatever the
 * heuristics missed.
 */
function GapInvestigation({
  data,
  fmt,
  onClose,
}: {
  data: {
    window: { start: string; end: string };
    transactions: GapTxn[];
    analysis: GapAnalysis;
  };
  fmt: (n: number) => string;
  onClose: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const { window, transactions, analysis } = data;

  return (
    <div className="mt-3 bg-white border border-amber-300 rounded-lg p-3">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="text-xs font-bold text-amber-900">
            Gap investigation
          </div>
          <div className="text-[10px] text-ink-light">
            Scanned {analysis.total_transactions} transactions from{" "}
            <span className="font-mono">{window.start}</span> to{" "}
            <span className="font-mono">{window.end}</span>.{" "}
            {analysis.uncleared_count} uncleared totaling {fmt(analysis.uncleared_total)}.
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-ink-slate hover:text-navy"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

      {analysis.notes.length > 0 && (
        <div className="mb-3 p-2 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-900 space-y-1">
          {analysis.notes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </div>
      )}

      {analysis.candidates.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1.5">
            Most-likely culprits
          </div>
          <div className="space-y-1.5">
            {analysis.candidates.slice(0, 10).map((c, i) => (
              <div
                key={c.txn.txn_id || i}
                className="rounded border border-gray-200 bg-gray-50 p-2 text-[11px]"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-navy">
                    {c.txn.date}
                  </span>
                  <span className="font-mono text-navy">
                    {fmt(c.txn.amount)}
                  </span>
                  <span className="text-ink-slate truncate">
                    {c.txn.txn_type}
                    {c.txn.doc_number ? ` #${c.txn.doc_number}` : ""}
                    {c.txn.customer_or_vendor ? ` · ${c.txn.customer_or_vendor}` : ""}
                  </span>
                  {!c.txn.cleared && (
                    <span className="text-[9px] font-bold uppercase tracking-wider bg-amber-200 text-amber-900 px-1 py-0.5 rounded">
                      Uncleared
                    </span>
                  )}
                  <span
                    className="ml-auto text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-900 px-1 py-0.5 rounded"
                    title={`Heuristic weight ${(c.weight * 100).toFixed(0)}%`}
                  >
                    {(c.weight * 100).toFixed(0)}%
                  </span>
                </div>
                {c.txn.memo && (
                  <div className="text-ink-light truncate mt-0.5">
                    {c.txn.memo}
                  </div>
                )}
                <ul className="mt-1 text-[10px] text-amber-900 list-disc pl-4">
                  {c.reasons.map((r, j) => (
                    <li key={j}>{r}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {transactions.length > 0 && (
        <div>
          <button
            onClick={() => setShowAll((v) => !v)}
            className="text-[11px] font-semibold text-teal hover:text-teal-dark"
          >
            {showAll ? "Hide" : "Show"} all {transactions.length} transactions in the window
          </button>
          {showAll && (
            <div className="mt-2 max-h-[280px] overflow-y-auto rounded border border-gray-200">
              <table className="w-full text-[11px]">
                <thead className="bg-gray-50 sticky top-0">
                  <tr className="text-ink-slate text-left">
                    <th className="px-2 py-1.5 font-semibold">Date</th>
                    <th className="px-2 py-1.5 font-semibold">Type</th>
                    <th className="px-2 py-1.5 font-semibold">Name</th>
                    <th className="px-2 py-1.5 font-semibold">Memo</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Amount</th>
                    <th className="px-2 py-1.5 font-semibold text-center">Clr</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t, i) => (
                    <tr key={t.txn_id || i} className="border-t border-gray-100">
                      <td className="px-2 py-1 font-mono">{t.date}</td>
                      <td className="px-2 py-1 text-ink-slate">{t.txn_type}</td>
                      <td className="px-2 py-1 truncate max-w-[140px]" title={t.customer_or_vendor || ""}>
                        {t.customer_or_vendor || "—"}
                      </td>
                      <td className="px-2 py-1 truncate max-w-[180px] text-ink-light" title={t.memo}>
                        {t.memo || "—"}
                      </td>
                      <td className="px-2 py-1 font-mono text-right">
                        {fmt(t.amount)}
                      </td>
                      <td className="px-2 py-1 text-center">
                        {t.cleared ? (
                          <CheckCircle2 size={11} className="text-green-600 inline" />
                        ) : (
                          <span className="text-amber-700 text-[10px]">no</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
