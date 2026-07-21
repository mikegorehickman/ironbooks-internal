"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2, RefreshCw, CheckCircle2, AlertCircle, XCircle,
  ArrowRight, Upload, Shield, FileText, Play, Lock,
  Building2, Wallet, FileSearch, Receipt, Coins,
  Users as UsersIcon, Calculator, HelpCircle, X, Send, ClipboardList, Mail, Copy, Sparkles,
} from "lucide-react";
import { MODULE_LABELS, MODULE_ORDER, type CleanupModule } from "@/lib/cleanup-system/types";
import { ProposedEntryRow } from "./proposed-entry-row";
import { parseEntryMeta } from "@/lib/cleanup-system/entry-meta";
import { StatementsReview, periodLabel, type Statements } from "@/app/production/rec-card";
import { FilePreviewModal } from "@/components/FilePreviewModal";

type WizardStep = "diagnose" | "modules" | "review" | "qa" | "deliver";

interface RunStatus {
  run: any;
  modules: any[];
  health_score: any;
  counts: { proposed: number; pending_review: number };
  cpa_flags: any[];
}

const GRADE_COLORS = {
  green: { tile: "from-emerald-50 to-emerald-100 border-emerald-200 text-emerald-900", chip: "bg-emerald-500" },
  yellow: { tile: "from-amber-50 to-amber-100 border-amber-200 text-amber-900", chip: "bg-amber-500" },
  red: { tile: "from-red-50 to-red-100 border-red-200 text-red-900", chip: "bg-red-500" },
} as const;

const GRADE_HEADLINE: Record<string, string> = {
  green: "Books look healthy",
  yellow: "Books need attention",
  red: "Books need significant cleanup",
};

/**
 * Module catalog — labels, icons, and the one-line "what it does" copy
 * that shows up next to each module card so bookkeepers don't have to
 * memorize what each module is for.
 */
/** Plain-English "what to actually do" per module — every What-needs-fixing
 *  line carries its suggestion + a Fix button (Mike 2026-07-17: "each line
 *  item needs a suggestion and action to it"). */
const MODULE_SUGGESTION: Record<string, string> = {
  undeposited_funds:
    "Match the stuck payments to their real deposits/invoices, then post the releases — Undeposited Funds module.",
  bank_recon:
    "Enter the statement ending balance (auto-fills once the statement PDF is uploaded) and post the reconciling entry — Bank Recon module.",
  accounts_receivable:
    "Verify what's genuinely still owed, apply stuck payments, void CRM-duplicate invoices — A/R module.",
  obe_uncategorized:
    "Zero Opening Balance Equity into the correct opening balances — OBE module.",
  loans:
    "Split loan payments into principal + interest against the loan statement — Loans module.",
  tax_payroll:
    "Tie payroll liabilities to the provider reports — Tax & Payroll module.",
  shareholder_draws:
    "Classify the owner activity as draws vs contributions — Owner Equity module.",
  accounts_payable:
    "Confirm which open bills are still really owed — A/P module.",
};

const MODULE_META: Record<CleanupModule, { icon: any; description: string; postsToQbo: boolean }> = {
  bank_recon: {
    icon: Building2,
    description: "Reconciles bank + credit card balances against statements. Proposes journal entries for unexplained gaps.",
    postsToQbo: true,
  },
  undeposited_funds: {
    icon: Wallet,
    description: "Matches stuck Undeposited Funds payments to the right open invoice. Posts ReceivePayment in QBO on execute.",
    postsToQbo: true,
  },
  accounts_receivable: {
    icon: FileSearch,
    description: "Connects to QuickBooks, reads open A/R + Undeposited Funds, and matches stuck payments to the right invoice — no upload needed. Also flags duplicate invoices. Posts ReceivePayment / voids on execute.",
    postsToQbo: true,
  },
  accounts_payable: {
    icon: Receipt,
    description: "Reviews open bills + vendor balances. Flags potential duplicate bills for cleanup.",
    postsToQbo: false,
  },
  loans: {
    icon: Coins,
    description: "Reconciles loan balances against lender statements. Proposes interest split / balance corrections.",
    postsToQbo: false,
  },
  shareholder_draws: {
    icon: UsersIcon,
    description: "Reviews shareholder distribution + loan accounts. Flags entries needing CPA sign-off.",
    postsToQbo: false,
  },
  tax_payroll: {
    icon: Calculator,
    description: "Checks sales tax payable + payroll liability accuracy against filed returns.",
    postsToQbo: false,
  },
  obe_uncategorized: {
    icon: HelpCircle,
    description: "Cleans up Opening Balance Equity + any remaining uncategorized accounts left over from migration.",
    postsToQbo: false,
  },
};

/** Plain-English label for the raw status enums coming back from the DB */
function moduleStatusLabel(status: string): string {
  switch (status) {
    case "locked": return "Ready to discover";
    case "ready": return "Ready to discover";
    case "discovering": return "Discovering issues…";
    case "reviewing": return "Awaiting your review";
    case "executing": return "Posting to QuickBooks…";
    case "complete": return "Complete";
    case "failed": return "Failed";
    case "skipped": return "Skipped";
    default: return status;
  }
}

/** Plain-English label for review tabs (DB enum values) */
const REVIEW_TAB_LABELS: Record<string, string> = {
  needs_review: "Needs review",
  auto_approve: "Auto-approved",
  approved: "Approved",
  flagged: "Flagged",
  skip: "Skipping",
};

function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/** Read one file into CSV text. Excel (.xlsx/.xls) is converted via SheetJS
 *  (lazy-imported so it only ships to the client when actually needed). */
async function fileToCsv(file: File): Promise<string> {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const first = wb.SheetNames[0];
    return first ? XLSX.utils.sheet_to_csv(wb.Sheets[first]) : "";
  }
  return file.text();
}

/** Merge several CSV blobs into one. Keeps the first file's header and drops
 *  a duplicate header row from each subsequent file so the matcher sees one
 *  clean table. Files with a different header are appended verbatim. */
function mergeCsv(texts: string[]): string {
  const blobs = texts.map((t) => t.trim()).filter(Boolean);
  if (blobs.length <= 1) return blobs[0] || "";
  const header = blobs[0].split(/\r?\n/)[0]?.trim();
  const out: string[] = blobs[0].split(/\r?\n/);
  for (let i = 1; i < blobs.length; i++) {
    const lines = blobs[i].split(/\r?\n/);
    const skipHeader = lines[0]?.trim() === header ? 1 : 0;
    out.push(...lines.slice(skipHeader));
  }
  return out.join("\n");
}

/**
 * Attach-CSV/Excel control. Primary affordance is attaching files (drop or
 * click-to-browse) — multiple .csv/.xlsx/.xls at once. Each file is parsed
 * client-side and merged into the single csv_text string the parent already
 * posts, so the downstream import flow is unchanged. A paste textarea remains
 * as a fallback when no file has been attached.
 */
function CsvAttach({
  value,
  onChange,
  placeholder = "…or paste CSV text here",
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  const [hover, setHover] = useState(false);
  const [attached, setAttached] = useState<{ name: string; text: string }[]>([]);
  const attachedRef = useRef(attached);
  attachedRef.current = attached;

  // If the parent clears value externally (e.g. after a successful import),
  // drop the attached-file chips so the control resets too.
  useEffect(() => {
    if (!value) setAttached([]);
  }, [value]);

  async function handleFiles(list: FileList | File[] | null) {
    const arr = Array.from(list || []);
    if (arr.length === 0) return;
    const parsed = await Promise.all(
      arr.map(async (f) => ({ name: f.name, text: await fileToCsv(f) }))
    );
    const next = [...attachedRef.current, ...parsed].filter((p) => p.text.trim());
    setAttached(next);
    onChange(mergeCsv(next.map((p) => p.text)));
  }

  function removeFile(idx: number) {
    const next = attached.filter((_, i) => i !== idx);
    setAttached(next);
    onChange(mergeCsv(next.map((p) => p.text)));
  }

  function clearAll() {
    setAttached([]);
    onChange("");
  }

  const rowCount = useMemo(() => {
    if (!value.trim()) return 0;
    const lines = value.split(/\r?\n/).filter((l) => l.trim());
    return Math.max(0, lines.length - 1); // minus header
  }, [value]);

  const hasFiles = attached.length > 0;

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => { e.preventDefault(); setHover(true); }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHover(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`rounded-xl border-2 border-dashed transition-colors ${
          hover
            ? "border-teal bg-teal/5"
            : value
            ? "border-emerald-200 bg-emerald-50/30"
            : "border-gray-200 hover:border-gray-300"
        }`}
      >
        <label className="cursor-pointer block px-4 py-3">
          <div className="flex items-center gap-3">
            {value ? (
              <CheckCircle2 size={18} className="text-emerald-600 flex-shrink-0" />
            ) : (
              <Upload size={18} className="text-ink-light flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0 text-xs font-semibold">
              {value ? (
                <span className="text-emerald-800">
                  {hasFiles
                    ? `${attached.length} file${attached.length === 1 ? "" : "s"} attached`
                    : "Pasted"} · {rowCount} row{rowCount === 1 ? "" : "s"}
                </span>
              ) : (
                <span className="text-navy">
                  Attach .csv or Excel files — drop here or click to browse (multiple OK)
                </span>
              )}
            </div>
            <input
              type="file"
              multiple
              accept=".csv,.xlsx,.xls,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              className="hidden"
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = ""; // allow re-selecting the same file
              }}
            />
          </div>
        </label>
      </div>

      {/* Attached-file chips */}
      {hasFiles && (
        <div className="flex flex-wrap gap-1.5">
          {attached.map((f, i) => (
            <span
              key={`${f.name}-${i}`}
              className="inline-flex items-center gap-1 text-[11px] bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md pl-2 pr-1 py-0.5"
            >
              <FileText size={11} className="flex-shrink-0" />
              <span className="truncate max-w-[160px]">{f.name}</span>
              <button
                type="button"
                onClick={() => removeFile(i)}
                className="text-emerald-700 hover:text-red-600"
                aria-label={`Remove ${f.name}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Paste fallback — only when no files are attached */}
      {!hasFiles && (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          className="w-full text-xs font-mono border border-gray-200 rounded-lg p-2 focus:border-teal focus:ring-1 focus:ring-teal/30 outline-none"
        />
      )}

      {value && (
        <button
          type="button"
          onClick={clearAll}
          className="text-[11px] text-ink-light hover:text-red-600"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

export function CleanupWizardClient({
  clientLinkId,
  clientName,
  runId,
  bsEnabled,
}: {
  clientLinkId: string;
  clientName: string;
  runId: string;
  bsEnabled?: boolean;
}) {
  const [step, setStep] = useState<WizardStep>("diagnose");
  const [postingId, setPostingId] = useState<string | null>(null);
  const [bsPushed, setBsPushed] = useState<boolean>(!!bsEnabled);
  const [pushingBs, setPushingBs] = useState(false);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [entries, setEntries] = useState<any[]>([]);
  const [qa, setQa] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [csvSource, setCsvSource] = useState("stripe");
  const [csvText, setCsvText] = useState("");
  const [activeModule, setActiveModule] = useState<CleanupModule | null>(null);
  const [reviewTab, setReviewTab] = useState("needs_review");
  const [attested, setAttested] = useState(false);
  const [aiSummary, setAiSummary] = useState("");
  const [crmSource, setCrmSource] = useState<"jobber" | "drip_jobs" | "generic">("jobber");
  const [crmCsv, setCrmCsv] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/cleanup/${runId}/status`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStatus(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  // Review-queue load errors surface as a readable message + retry instead
  // of a blank list / crashed page (Mike: "click review just errors out").
  const [reviewLoadError, setReviewLoadError] = useState<string | null>(null);
  const loadEntries = useCallback(async (module?: string, decision?: string) => {
    setReviewLoadError(null);
    try {
      const params = new URLSearchParams();
      if (module) params.set("module", module);
      if (decision) params.set("decision", decision);
      const res = await fetch(`/api/cleanup/${runId}/proposed?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setEntries(data.entries || []);
    } catch (e: any) {
      setEntries([]);
      setReviewLoadError(e?.message || "Couldn't load the review queue");
    }
  }, [runId]);

  // Poll for status updates every 5s during active work, but stop polling
  // once the run is complete/failed/cancelled — no point burning API calls
  // forever on a terminal state.
  useEffect(() => {
    refresh();
    const runStatus = status?.run?.status;
    const isTerminal = runStatus === "complete" || runStatus === "failed" || runStatus === "cancelled";
    if (isTerminal) return;
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh, status?.run?.status]);

  // Reset attestation any time you change which module you're reviewing —
  // attestation is a per-execute affirmation, never a sticky checkbox.
  useEffect(() => {
    setAttested(false);
  }, [activeModule]);

  // UF / A/R / OBE / bank reconciliation now resolve on the main Balance
  // Sheet page (all in one spot). "Fix →" for those deep-links there and
  // opens the right resolver; everything else still routes to its module.
  const MODULE_TO_LANDING_HASH: Record<string, string> = {
    undeposited_funds: "uf",
    accounts_receivable: "ar",
    obe_uncategorized: "obe",
    bank_recon: "reconcile",
  };

  // "Fix →" on a What-needs-fixing line: jump to the modules step and pulse
  // the module card that fixes it (for non-merged modules).
  const [focusModuleKey, setFocusModuleKey] = useState<string | null>(null);
  function jumpToModule(module?: string | null) {
    const hash = module ? MODULE_TO_LANDING_HASH[module] : undefined;
    if (hash) {
      window.location.assign(`/balance-sheet/${clientLinkId}#${hash}`);
      return;
    }
    setStep("modules");
    if (!module) return;
    setFocusModuleKey(module);
    setTimeout(() => {
      document.getElementById(`module-card-${module}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
    setTimeout(() => setFocusModuleKey(null), 3000);
  }

  async function importCsv() {
    if (!csvText.trim()) return;
    setActing(true);
    try {
      const res = await fetch(`/api/cleanup/${runId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: csvSource, csv_text: csvText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCsvText("");
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActing(false);
    }
  }

  async function discoverModule(mod: CleanupModule) {
    setActing(true);
    setActiveModule(mod);
    try {
      const body: Record<string, string> = {};
      if (mod === "accounts_receivable" && crmCsv.trim()) {
        body.crm_source = crmSource;
        body.crm_csv_text = crmCsv;
      }
      const res = await fetch(`/api/cleanup/${runId}/modules/${mod}/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStep("review");
      setReviewTab("needs_review");
      setTimeout(() => loadEntries(mod, "needs_review"), 1500);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActing(false);
    }
  }

  // Approve = post to QuickBooks immediately. One row, one synchronous QBO
  // write; the row reflects "Posted ✓" or the error inline.
  async function approveEntry(id: string) {
    setPostingId(id);
    setError("");
    try {
      const res = await fetch(`/api/cleanup/${runId}/proposed/${id}/approve-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Posting failed");
      if (data.posted === false && data.error) setError(data.error);
      await loadEntries(activeModule || undefined, reviewTab);
      await refresh();
    } catch (e: any) {
      setError(e.message);
      await loadEntries(activeModule || undefined, reviewTab);
    } finally {
      setPostingId(null);
    }
  }

  /**
   * Count how many entries the bulk-approve action will affect so we can
   * surface a confirmation dialog with a real number. Better than a vague
   * "approve all auto" — the bookkeeper sees "Approve 8 entries?" before
   * committing. Auto-approve is reversible (sets decision=approved on
   * already-auto-approved rows), but the next step posts to QBO so the
   * extra speed bump is worth it.
   */
  // Publish the cleaned balance sheet to the client portal (separate from the
  // P&L production promote). Until this is clicked, the portal BS + Cash Flow
  // stay hidden behind the "still cleaning up" placeholder.
  async function pushBalanceSheet() {
    if (
      !window.confirm(
        `Publish ${clientName}'s balance sheet to their client portal?\n\nThey'll be able to see their Balance Sheet and Cash Flow. Only do this once the BS is cleaned and approved.`
      )
    )
      return;
    setPushingBs(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/production`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bs_on", reason: "Published from BS Cleanup wizard" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't publish the balance sheet");
      setBsPushed(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPushingBs(false);
    }
  }

  function countAutoApprovable() {
    return entries.filter((e) => e.decision === "auto_approve" && !e.executed).length;
  }
  function countUfConfident() {
    return entries.filter((e) => {
      if (e.executed || !["needs_review", "auto_approve"].includes(e.decision)) return false;
      const meta = parseEntryMeta(e.ai_reasoning);
      const isConfident =
        meta?.type === "uf_match" &&
        (meta.kind === "exact_invoice_number" || meta.kind === "high_confidence");
      if (!isConfident) return false;
      // Only count entries that actually have an invoice target — otherwise
      // they'd silently skip at post time and the count would lie.
      const hasTarget =
        !!e.bookkeeper_override_target_id ||
        !!e.to_account_id ||
        (meta?.type === "uf_match" && !!meta.proposed_invoice_id);
      return hasTarget;
    }).length;
  }

  async function approveAllAuto() {
    const n = countAutoApprovable();
    if (n === 0) {
      setError("Nothing to bulk-approve in this module — try the Auto-approved tab to confirm.");
      return;
    }
    if (!window.confirm(`Approve and post ${n} auto-approved ${n === 1 ? "entry" : "entries"} to QuickBooks now?\n\nThis writes to the client's books immediately.`)) return;
    setActing(true);
    setError("");
    try {
      const approveRes = await fetch(`/api/cleanup/${runId}/proposed`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve_all_auto", module: activeModule }),
      });
      if (!approveRes.ok) {
        const d = await approveRes.json().catch(() => ({}));
        throw new Error(d.error || "Couldn't approve the entries — nothing was posted.");
      }
      // Post the just-approved batch to QBO (the click is the attestation).
      if (activeModule) {
        const execRes = await fetch(`/api/cleanup/${runId}/modules/${activeModule}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attested: true }),
        });
        if (!execRes.ok) {
          const d = await execRes.json().catch(() => ({}));
          throw new Error(d.error || "Approved, but posting to QuickBooks failed to start.");
        }
      }
      await refresh();
      await loadEntries(activeModule || undefined, reviewTab);
    } catch (e: any) {
      setError(e.message);
      await loadEntries(activeModule || undefined, reviewTab);
    } finally {
      setActing(false);
    }
  }

  async function approveUfConfident() {
    const n = countUfConfident();
    if (n === 0) {
      setError("No exact / high-confidence UF matches to bulk-approve right now.");
      return;
    }
    if (!window.confirm(`Approve and post ${n} UF ${n === 1 ? "match" : "matches"} (exact + high confidence) to QuickBooks now?\n\nThis writes to the client's books immediately.`)) return;
    setActing(true);
    setError("");
    try {
      const approveRes = await fetch(`/api/cleanup/${runId}/proposed`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve_uf_confident" }),
      });
      if (!approveRes.ok) {
        const d = await approveRes.json().catch(() => ({}));
        throw new Error(d.error || "Couldn't approve the matches — nothing was posted.");
      }
      const mod = activeModule || "undeposited_funds";
      const execRes = await fetch(`/api/cleanup/${runId}/modules/${mod}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attested: true }),
      });
      if (!execRes.ok) {
        const d = await execRes.json().catch(() => ({}));
        throw new Error(d.error || "Approved, but posting to QuickBooks failed to start.");
      }
      await refresh();
      await loadEntries(mod, reviewTab);
    } catch (e: any) {
      setError(e.message);
      await loadEntries(activeModule || "undeposited_funds", reviewTab);
    } finally {
      setActing(false);
    }
  }

  async function overrideInvoice(
    entryId: string,
    invoiceId: string,
    docNumber: string
  ) {
    const entry = entries.find((e) => e.id === entryId);
    await fetch(`/api/cleanup/${runId}/proposed/${entryId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: entry?.decision || "needs_review",
        override_target_id: invoiceId,
        override_target_name: docNumber,
      }),
    });
    await loadEntries(activeModule || undefined, reviewTab);
  }

  async function executeModule(mod: CleanupModule) {
    if (!attested) {
      setError("Tick the attestation box right before posting to QuickBooks.");
      return;
    }
    setActing(true);
    try {
      const res = await fetch(`/api/cleanup/${runId}/modules/${mod}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attested: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await refresh();
      setStep("modules");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActing(false);
    }
  }

  async function runQA() {
    setActing(true);
    try {
      const res = await fetch(`/api/cleanup/${runId}/qa`, { method: "POST" });
      const data = await res.json();
      setQa(data);
      setStep("qa");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActing(false);
    }
  }

  async function deliver(publish: boolean) {
    setActing(true);
    try {
      const res = await fetch(`/api/cleanup/${runId}/deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publish_to_portal: publish,
          ai_summary: aiSummary,
          ai_summary_reviewed: !!aiSummary,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "QA gate failed");
      setStep("deliver");
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActing(false);
    }
  }

  async function signOffFlag(flagId: string) {
    await fetch(`/api/cleanup/${runId}/cpa-flags`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flag_id: flagId, action: "sign_off" }),
    });
    await refresh();
  }

  // Derived: which steps the user has "completed" — used to render
  // checkmarks in the stepper instead of just a row of pills.
  const stepIsDone = useMemo(() => {
    const modules = status?.modules || [];
    const anyDiscovered = modules.some((m: any) =>
      ["reviewing", "executing", "complete"].includes(m.status)
    );
    const allDoneOrSkipped = modules.length > 0 && modules.every((m: any) =>
      ["complete", "skipped", "locked"].includes(m.status)
    );
    return {
      diagnose: !!status?.health_score,
      modules: anyDiscovered,
      review: modules.some((m: any) => (m.executed_count || 0) > 0),
      qa: qa?.passed,
      deliver: status?.run?.status === "complete",
      allModulesProcessed: allDoneOrSkipped,
    };
  }, [status, qa]);

  // Execute preview — what's about to hit QBO when bookkeeper clicks
  // the big button. Counted from the currently-loaded entries list.
  // Per-type labels are pluralized + plain-English so the preview reads
  // like a sentence instead of a SQL enum dump.
  const ENTRY_TYPE_PLURAL: Record<string, string> = {
    receive_payment: "payments to apply",
    void: "invoices to void",
    reclass: "reclassifications",
    journal_entry: "journal entries",
    bill_payment: "bill payments",
    invoice: "invoices to create",
  };
  const executePreview = useMemo(() => {
    const approved = entries.filter(
      (e) => (e.decision === "approved" || e.decision === "auto_approve") && !e.executed
    );
    const total = approved.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const byType: Record<string, number> = {};
    for (const e of approved) {
      byType[e.entry_type] = (byType[e.entry_type] || 0) + 1;
    }
    const breakdown = Object.entries(byType)
      .map(([t, n]) => `${n} ${ENTRY_TYPE_PLURAL[t] || t.replace("_", " ")}`)
      .join(" · ");
    return { count: approved.length, total, byType, breakdown };
  }, [entries]);

  if (loading && !status) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <Loader2 className="animate-spin text-teal" size={28} />
        <div className="text-sm text-ink-light">Loading cleanup run…</div>
      </div>
    );
  }

  const hs = status?.health_score;
  const grade = (hs?.overall_grade || "red") as keyof typeof GRADE_COLORS;
  const score = hs?.overall_score ?? 0;
  const gradeStyle = GRADE_COLORS[grade];

  const STEPS: { key: WizardStep; label: string; description: string }[] = [
    { key: "diagnose", label: "1. Diagnose", description: "Check the books' health" },
    { key: "modules", label: "2. Modules", description: "Run cleanup module by module" },
    { key: "review", label: "3. Review", description: "Approve what gets posted" },
    { key: "qa", label: "4. QA Gate", description: "Final safety checks" },
    { key: "deliver", label: "5. Deliver", description: "Publish to client portal" },
  ];

  return (
    <div className="space-y-6">
      {/* Persistent client+run strip — the TopBar above the AppShell shows
          this too, but once you've scrolled or switched tabs the wizard
          benefits from its own anchor so the bookkeeper never loses track
          of which client this run is for. */}
      <div className="flex items-center gap-2 text-xs text-ink-light">
        <span className="font-semibold text-navy">{clientName}</span>
        <span>·</span>
        <span>Cleanup run {runId.slice(0, 8)}</span>
        {status?.run?.status && (
          <>
            <span>·</span>
            <span className="capitalize">{status.run.status}</span>
          </>
        )}
      </div>

      {/* Real stepper — checkmarks on completed steps so progress is visible at a glance */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4">
        <div className="grid grid-cols-5 gap-2">
          {STEPS.map((s, idx) => {
            const isActive = step === s.key;
            const isDone = stepIsDone[s.key as keyof typeof stepIsDone];
            return (
              <button
                key={s.key}
                onClick={() => {
                  setStep(s.key);
                  if (s.key === "review") loadEntries(activeModule || undefined, reviewTab);
                }}
                className={`text-left p-3 rounded-xl border-2 transition-all ${
                  isActive
                    ? "border-teal bg-teal/5"
                    : isDone
                    ? "border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50"
                    : "border-gray-100 hover:border-gray-200"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  {isDone ? (
                    <CheckCircle2 size={14} className="text-emerald-600 flex-shrink-0" />
                  ) : isActive ? (
                    <span className="w-3.5 h-3.5 rounded-full bg-teal flex-shrink-0" />
                  ) : (
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 flex-shrink-0" />
                  )}
                  <div className={`text-xs font-bold ${isActive ? "text-teal" : isDone ? "text-emerald-800" : "text-ink-slate"}`}>
                    {s.label}
                  </div>
                </div>
                <div className="text-[11px] text-ink-light leading-snug">{s.description}</div>
              </button>
            );
          })}
        </div>
        <button onClick={refresh} className="mt-2 text-[11px] text-ink-light hover:text-navy flex items-center gap-1">
          <RefreshCw size={11} /> Refresh status
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm flex items-center gap-2">
          <AlertCircle size={14} />
          {error}
          <button onClick={() => setError("")} className="ml-auto text-xs underline">Dismiss</button>
        </div>
      )}

      {/* CPA flags banner — blocks delivery until signed off */}
      {(status?.cpa_flags || []).filter((f) => f.status === "open").length > 0 && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200">
          <div className="font-bold text-red-800 text-sm mb-2 flex items-center gap-2">
            <Shield size={14} />
            CPA flags — delivery blocked until each one is signed off
          </div>
          <div className="space-y-1.5">
            {(status?.cpa_flags || [])
              .filter((f) => f.status === "open")
              .map((f) => (
                <div key={f.id} className="flex items-center justify-between text-sm text-red-700 bg-white/60 rounded-lg px-3 py-2">
                  <span>{f.description}</span>
                  <button
                    onClick={() => signOffFlag(f.id)}
                    className="text-xs font-bold px-2.5 py-1 rounded border border-red-300 hover:bg-red-100"
                  >
                    Sign off
                  </button>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* P&L-only promote — always available while the run is active, so a
          bookkeeper can ship the client to production on P&L while the BS
          waits on client docs without hunting through the diagnose panels. */}
      {status?.run?.status !== "complete" && (
        <PLOnlyPromoteCard clientLinkId={clientLinkId} clientName={clientName} />
      )}

      {/* DIAGNOSE */}
      {step === "diagnose" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <div className={`rounded-2xl border-2 bg-gradient-to-br ${gradeStyle.tile} p-6 text-center`}>
              <div className="text-xs font-bold uppercase tracking-widest opacity-80">Health Score</div>
              <div className="text-6xl font-black my-2">{score}</div>
              <div className="text-sm font-bold">{GRADE_HEADLINE[grade]}</div>
            </div>
            <a
              href={`/balance-sheet/${clientLinkId}`}
              className="w-full mt-4 bg-teal text-white font-bold py-3 rounded-xl hover:bg-teal-dark transition-colors flex items-center justify-center gap-2"
            >
              Resolve on the Balance Sheet <ArrowRight size={14} />
            </a>
            <div className="mt-3 text-[11px] text-ink-light text-center">
              Undeposited Funds, A/R, Opening Balance Equity, and bank reconciliation
              all resolve on the main Balance Sheet page now. Nothing posts to QuickBooks
              until you approve and execute.
            </div>
          </div>

          <div className="lg:col-span-2 space-y-4">
            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <h3 className="font-bold text-navy mb-1">What needs fixing</h3>
              <p className="text-xs text-ink-light mb-3">
                Top issues detected — red dots are priority cleanup targets, amber dots are worth a look.
              </p>
              <div className="space-y-2">
                {((hs?.task_list as any[]) || []).slice(0, 8).map((t: any) => (
                  <div key={t.id} className="flex items-start gap-2 text-sm">
                    <span
                      className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
                        t.grade === "red" ? "bg-red-500" : "bg-amber-400"
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-navy">{t.title}</div>
                      <div className="text-xs text-ink-light">
                        {MODULE_SUGGESTION[t.module] || t.description}
                      </div>
                    </div>
                    <button
                      onClick={() => jumpToModule(t.module)}
                      className="shrink-0 mt-0.5 text-[11px] font-bold text-teal border border-teal/40 rounded-lg px-2.5 py-1 hover:bg-teal/5 inline-flex items-center gap-1"
                    >
                      Fix <ArrowRight size={10} />
                    </button>
                  </div>
                ))}
                {(!hs?.task_list || (hs.task_list as any[]).length === 0) && (
                  <div className="text-sm text-emerald-700 flex items-center gap-2">
                    <CheckCircle2 size={14} /> No issues detected — books look clean.
                  </div>
                )}
              </div>
            </div>

            {/* Statement coverage — every bank/CC account with a have-it /
                still-need-it check, plus the uploaded statements table. */}
            <StatementCoveragePanel clientLinkId={clientLinkId} />

            {/* Recommended fix input: upload the actual statements. */}
            <StatementAnalysisPanel runId={runId} onApplied={refresh} />

            <NeedFromClientPanel
              clientLinkId={clientLinkId}
              clientName={clientName}
              accountGrades={(hs?.account_grades as any[]) || []}
            />

            {/* Advanced / fallback: raw CSV or Excel export instead of PDFs. */}
            <details className="bg-white rounded-2xl border border-gray-100 px-5 py-3">
              <summary className="text-xs font-semibold text-ink-slate cursor-pointer flex items-center gap-2">
                <Upload size={13} /> Advanced: import a CSV / Excel export instead
              </summary>
              <p className="text-xs text-ink-light mt-2 mb-3">
                Have a Stripe, bank, or CRM export handy? Attach it to give the matcher more to work
                with. Most cleanups just use the statement PDFs above.
              </p>
              <div className="flex gap-2 mb-2 flex-wrap">
                {["stripe", "bank", "jobber", "drip_jobs", "loan_statement"].map((s) => (
                  <button
                    key={s}
                    onClick={() => setCsvSource(s)}
                    className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-colors ${
                      csvSource === s
                        ? "bg-teal text-white border-teal"
                        : "border-gray-200 hover:border-teal/40"
                    }`}
                  >
                    {s.replace("_", " ")}
                  </button>
                ))}
              </div>
              <CsvAttach value={csvText} onChange={setCsvText} rows={3} />
              <button
                onClick={importCsv}
                disabled={acting || !csvText.trim()}
                className="mt-2 text-xs font-bold px-3 py-1.5 rounded-lg bg-navy text-white disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {acting ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                Import CSV
              </button>
            </details>
          </div>
        </div>
      )}

      {/* MODULES */}
      {step === "modules" && (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-start justify-between mb-1">
            <div>
              <h3 className="font-bold text-navy">Module checklist</h3>
              <p className="text-xs text-ink-light mt-0.5">
                Work top to bottom. <strong className="text-navy">Bank Recon → UF → A/R</strong> is the recommended path.
                Each module discovers issues first, then you review, then you post to QuickBooks.
              </p>
            </div>
            {stepIsDone.allModulesProcessed && (
              <button
                onClick={runQA}
                disabled={acting}
                className="text-xs font-bold px-3 py-1.5 rounded-lg bg-navy text-white inline-flex items-center gap-1.5"
              >
                <Shield size={12} /> Run QA Gate
              </button>
            )}
          </div>

          <div className="mt-3 rounded-xl border border-teal/30 bg-teal/5 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs text-navy leading-relaxed">
              <strong>Undeposited Funds, A/R, and bank reconciliation now resolve on the main
              Balance Sheet page</strong> — statement auto-fill, the CRM-duplicate A/R check, and
              one-click Opening Balance Equity all live there. Those rows below link straight to them.
            </div>
            <a
              href={`/balance-sheet/${clientLinkId}`}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-teal text-white px-3 py-1.5 text-xs font-bold hover:bg-teal-dark"
            >
              Open Balance Sheet <ArrowRight size={12} />
            </a>
          </div>

          <div className="space-y-2 mt-4">
            {(status?.modules || [])
              // Only show modules still in the workflow (drops retired ones
              // like OBE for older runs) and order them per MODULE_ORDER.
              .filter((m: any) => MODULE_ORDER.includes(m.module))
              .sort(
                (a: any, b: any) =>
                  MODULE_ORDER.indexOf(a.module) - MODULE_ORDER.indexOf(b.module)
              )
              .map((m: any) => {
              const meta = MODULE_META[m.module as CleanupModule];
              const ModIcon = meta?.icon || ArrowRight;
              // Modules are ungated: any can be run individually, in any order.
              // A legacy "locked" row (from a pre-ungate run) is treated as ready.
              const isLocked = false;
              const isReady = m.status === "ready" || m.status === "locked";
              const isReviewing = m.status === "reviewing";
              const isComplete = m.status === "complete";
              const inFlight = ["discovering", "executing"].includes(m.status);
              // Modules whose discovery reads QBO directly (open A/R + UF) —
              // labelled "Scan QuickBooks" so the bookkeeper knows no upload
              // is needed, just a live read of QuickBooks.
              const isQboScan =
                m.module === "accounts_receivable" || m.module === "undeposited_funds";

              return (
                <div
                  key={m.module}
                  id={`module-card-${m.module}`}
                  className={
                    focusModuleKey === m.module
                      ? "rounded-xl ring-4 ring-teal/50 transition-shadow duration-700"
                      : "transition-shadow duration-700"
                  }
                >
                  <div
                    className={`flex items-start gap-3 p-4 rounded-xl border-2 transition-colors ${
                      isComplete
                        ? "border-emerald-200 bg-emerald-50/40"
                        : isReviewing
                        ? "border-amber-200 bg-amber-50/40"
                        : isLocked
                        ? "border-gray-100 bg-gray-50/50 opacity-60"
                        : "border-gray-100 hover:border-teal/30"
                    }`}
                  >
                    <div className={`flex-shrink-0 p-2 rounded-lg ${
                      isComplete ? "bg-emerald-100" : isReviewing ? "bg-amber-100" : "bg-gray-100"
                    }`}>
                      {isLocked ? (
                        <Lock size={16} className="text-gray-400" />
                      ) : inFlight ? (
                        <Loader2 size={16} className="animate-spin text-teal" />
                      ) : isComplete ? (
                        <CheckCircle2 size={16} className="text-emerald-600" />
                      ) : (
                        <ModIcon size={16} className="text-navy" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-bold text-navy text-sm">
                          {MODULE_LABELS[m.module as CleanupModule] || m.module}
                        </div>
                        {meta?.postsToQbo && (
                          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                            Posts to QBO
                          </span>
                        )}
                      </div>
                      {meta?.description && (
                        <div className="text-xs text-ink-light mt-1 leading-relaxed">{meta.description}</div>
                      )}
                      <div className="text-[11px] mt-2 flex items-center gap-3 flex-wrap">
                        <span className={`font-semibold ${
                          isComplete ? "text-emerald-700" :
                          isReviewing ? "text-amber-700" :
                          isLocked ? "text-gray-500" :
                          "text-ink-slate"
                        }`}>
                          {moduleStatusLabel(m.status)}
                        </span>
                        {(m.proposed_count || 0) > 0 && (
                          <span className="text-ink-light">
                            {m.proposed_count} proposed
                          </span>
                        )}
                        {(m.executed_count || 0) > 0 && (
                          <span className="text-emerald-700 font-semibold">
                            ✓ {m.executed_count} posted
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
                      {MODULE_TO_LANDING_HASH[m.module] ? (
                        // UF / A/R / bank recon resolve on the main Balance
                        // Sheet page now — this row just links there.
                        <a
                          href={`/balance-sheet/${clientLinkId}#${MODULE_TO_LANDING_HASH[m.module]}`}
                          className="text-xs font-bold px-3 py-2 rounded-lg bg-teal text-white hover:bg-teal-dark inline-flex items-center gap-1.5"
                        >
                          Resolve on Balance Sheet <ArrowRight size={12} />
                        </a>
                      ) : (
                      <>
                      {isReady && (
                        <button
                          onClick={() => discoverModule(m.module)}
                          disabled={acting}
                          className="text-xs font-bold px-3 py-2 rounded-lg bg-teal text-white hover:bg-teal-dark disabled:opacity-50 inline-flex items-center gap-1.5"
                        >
                          {acting && activeModule === m.module ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : isQboScan ? (
                            <>Scan QuickBooks <ArrowRight size={12} /></>
                          ) : (
                            <>Discover <ArrowRight size={12} /></>
                          )}
                        </button>
                      )}
                      {isReviewing && (
                        <button
                          onClick={() => {
                            setActiveModule(m.module);
                            setStep("review");
                            loadEntries(m.module, "needs_review");
                          }}
                          className="text-xs font-bold px-3 py-2 rounded-lg bg-amber-500 text-white hover:bg-amber-600 inline-flex items-center gap-1.5"
                        >
                          Review <ArrowRight size={12} />
                        </button>
                      )}
                      {/* Re-scan path — discovery is idempotent (the matcher
                          skips anything already staged), so the bookkeeper can
                          safely re-pull QBO after a fix or new transactions
                          land, even once the module is in review/complete. */}
                      {(isReviewing || isComplete) && (
                        <button
                          onClick={() => discoverModule(m.module)}
                          disabled={acting}
                          className="text-[11px] font-semibold px-3 py-1.5 rounded-lg border border-teal text-teal hover:bg-teal/5 disabled:opacity-50 inline-flex items-center gap-1.5"
                          title={isQboScan ? "Re-read open A/R + Undeposited Funds from QuickBooks and re-match" : "Re-run discovery for this module"}
                        >
                          {acting && activeModule === m.module ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <>{isQboScan ? "Re-scan QuickBooks" : "Re-discover"} <RefreshCw size={10} /></>
                          )}
                        </button>
                      )}
                      {/* Retry path for failed modules — without this the
                          bookkeeper gets stuck and has to refresh the page
                          or skip the module entirely. */}
                      {m.status === "failed" && (
                        <button
                          onClick={() => discoverModule(m.module)}
                          disabled={acting}
                          className="text-xs font-bold px-3 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                          title="Re-run discovery for this module"
                        >
                          {acting && activeModule === m.module ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <>Retry discover <RefreshCw size={11} /></>
                          )}
                        </button>
                      )}
                      {isComplete && (
                        <span className="text-xs font-bold text-emerald-700 px-2">Done</span>
                      )}
                      </>
                      )}
                    </div>
                  </div>

                  {/* These two modules only match payments → OPEN invoices.
                      Stuck UF payments whose invoices are closed (CRM
                      double-counts, money already deposited) need the UF
                      Audit — link it here so nobody dead-ends on a
                      0-result scan. */}
                  {isQboScan && (
                    <div className="ml-12 mb-2 mt-1 p-2.5 rounded-xl border border-teal/30 bg-teal-lighter/40 text-[11px] text-navy">
                      Scan found nothing but UF still has a balance? The stuck
                      payments aren&apos;t matchable to <em>open</em> invoices
                      (CRM duplicates, money already deposited).{" "}
                      <a
                        href={`/balance-sheet/${clientLinkId}/uf-audit`}
                        className="font-bold text-teal hover:underline"
                      >
                        → Open UF Audit
                      </a>{" "}
                      — it classifies by deposit existence and clears duplicates
                      in bulk (void pairs, $0 deposits, JEs).
                    </div>
                  )}

                  {/* CRM CSV upload — only shown when the A/R module is in
                      'ready' state (i.e. discovery hasn't run yet). Once it's
                      reviewing/executing/complete the CSV is locked in. */}
                  {m.module === "accounts_receivable" && isReady && (
                    <div className="ml-12 mb-2 p-3 rounded-xl border border-amber-100 bg-amber-50/50 mt-1">
                      <h4 className="text-xs font-bold text-navy mb-1 flex items-center gap-1.5">
                        <Upload size={11} /> CRM export (optional)
                      </h4>
                      <p className="text-[11px] text-ink-light mb-2">
                        Discover always clears <strong>Undeposited Funds → open invoices</strong> straight from QuickBooks — no upload needed.
                        Optionally attach a Jobber, DripJobs, or generic CRM <strong>invoice-level</strong> export to also catch duplicate invoices.
                        An <strong>A/R Aging Summary</strong> is recognized too, but it’s used only as a tie-out check (it has no invoice rows to match).
                      </p>
                      <div className="flex gap-2 mb-2">
                        {(["jobber", "drip_jobs", "generic"] as const).map((s) => (
                          <button
                            key={s}
                            onClick={() => setCrmSource(s)}
                            className={`text-xs font-semibold px-2 py-1 rounded border ${
                              crmSource === s ? "bg-teal text-white border-teal" : "border-gray-200"
                            }`}
                          >
                            {s.replace("_", " ")}
                          </button>
                        ))}
                      </div>
                      <CsvAttach
                        value={crmCsv}
                        onChange={setCrmCsv}
                        rows={2}
                        placeholder="…or paste CRM invoice CSV here"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* REVIEW */}
      {step === "review" && (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="mb-4">
            <h3 className="font-bold text-navy">
              Review {activeModule ? `· ${MODULE_LABELS[activeModule]}` : "queue"}
            </h3>
            <p className="text-xs text-ink-light mt-0.5">
              Each row is a proposed change — expand to see the exact debits and
              credits. <strong>Approving an entry posts it to QuickBooks right away.</strong>
            </p>
          </div>

          {/* Tabs with plain-English labels + counts */}
          <div className="flex gap-2 mb-4 flex-wrap">
            {["needs_review", "auto_approve", "flagged", "skip", "approved"].map((tab) => (
              <button
                key={tab}
                onClick={() => { setReviewTab(tab); loadEntries(activeModule || undefined, tab); }}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${
                  reviewTab === tab
                    ? "bg-navy text-white border-navy"
                    : "border-gray-200 hover:border-navy/30"
                }`}
              >
                {REVIEW_TAB_LABELS[tab] || tab}
              </button>
            ))}
          </div>

          {reviewLoadError && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-red-800">
                <strong>Couldn&apos;t load the review queue:</strong> {reviewLoadError}
              </div>
              <button
                onClick={() => loadEntries(activeModule || undefined, reviewTab)}
                className="shrink-0 text-xs font-bold px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-100"
              >
                Retry
              </button>
            </div>
          )}

          {/* Bulk-approve actions */}
          <div className="flex flex-wrap gap-2 mb-4">
            <button
              onClick={approveAllAuto}
              className="text-xs font-bold px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
              title="Approve every entry the matcher already auto-approved"
            >
              ✓ Approve all auto-approved
            </button>
            {(activeModule === "undeposited_funds" || activeModule === "accounts_receivable") && (
              <button
                onClick={approveUfConfident}
                className="text-xs font-bold px-3 py-1.5 rounded-lg bg-teal text-white hover:bg-teal-dark"
                title="Approve exact invoice-number matches + high-confidence amount matches in one click"
              >
                ✓ Approve exact + high confidence UF matches
              </button>
            )}
          </div>

          {/* A/R aging-summary tie-out (informational; not a proposed entry) */}
          {(() => {
            const mod = status?.modules?.find((m: any) => m.module === activeModule);
            const notes = mod?.discovery_notes;
            if (!notes || notes.type !== "ar_aging_reconciliation") return null;
            const tied = Math.abs(Number(notes.difference || 0)) <= 0.5;
            return (
              <div className={`mb-4 rounded-xl border p-4 ${tied ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${tied ? "bg-emerald-200 text-emerald-800" : "bg-amber-200 text-amber-800"}`}>
                    A/R Aging tie-out
                  </span>
                  {notes.as_of && <span className="text-[11px] text-ink-light">as of {notes.as_of}</span>}
                </div>
                <p className="text-xs text-navy leading-relaxed mb-2">{notes.message}</p>
                <div className="text-[11px] text-ink-slate flex flex-wrap gap-x-4 gap-y-1 mb-2">
                  <span>Aging total: <strong>{notes.aging_report_total != null ? `$${Number(notes.aging_report_total).toLocaleString()}` : "—"}</strong></span>
                  <span>QBO open A/R: <strong>${Number(notes.qbo_open_total).toLocaleString()}</strong></span>
                  <span>Difference: <strong className={tied ? "text-emerald-700" : "text-amber-700"}>${Number(notes.difference).toLocaleString()}</strong></span>
                </div>
                {Array.isArray(notes.rows) && notes.rows.filter((r: any) => r.status !== "match").length > 0 && (
                  <details className="mt-1">
                    <summary className="text-[11px] font-semibold text-navy cursor-pointer">
                      {notes.rows.filter((r: any) => r.status !== "match").length} customer(s) don’t tie out
                    </summary>
                    <div className="mt-2 max-h-48 overflow-y-auto">
                      <table className="w-full text-[11px]">
                        <thead className="text-ink-light">
                          <tr className="text-left">
                            <th className="py-1 pr-2">Customer</th>
                            <th className="py-1 pr-2 text-right">Aging</th>
                            <th className="py-1 pr-2 text-right">QBO</th>
                            <th className="py-1 pr-2 text-right">Diff</th>
                          </tr>
                        </thead>
                        <tbody>
                          {notes.rows.filter((r: any) => r.status !== "match").map((r: any, i: number) => (
                            <tr key={i} className="border-t border-black/5">
                              <td className="py-1 pr-2">{r.customer}</td>
                              <td className="py-1 pr-2 text-right">{r.aging_total != null ? `$${Number(r.aging_total).toLocaleString()}` : "—"}</td>
                              <td className="py-1 pr-2 text-right">{r.qbo_open_balance != null ? `$${Number(r.qbo_open_balance).toLocaleString()}` : "—"}</td>
                              <td className="py-1 pr-2 text-right font-semibold">${Number(r.difference).toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </div>
            );
          })()}

          {/* Entry list */}
          <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
            {entries.length === 0 && (
              <div className="text-center py-12 px-4 border-2 border-dashed border-gray-200 rounded-xl">
                <FileSearch size={28} className="mx-auto text-gray-300 mb-2" />
                <div className="text-sm font-semibold text-navy">No entries in this tab</div>
                <div className="text-xs text-ink-light mt-1 max-w-md mx-auto">
                  {reviewTab === "needs_review" && "Either the matcher auto-approved everything (check the Auto-approved tab), or there were no Undeposited Funds payments / open invoices to match. If you just clicked Discover, give it a few seconds and reopen this module."}
                  {reviewTab === "auto_approve" && "No entries hit the auto-approve threshold for this module."}
                  {reviewTab === "approved" && "You haven't approved any entries in this module yet."}
                  {reviewTab === "flagged" && "Nothing's flagged — good sign."}
                  {reviewTab === "skip" && "Nothing's been marked to skip."}
                </div>
                {activeModule && (
                  <button
                    onClick={() => setStep("modules")}
                    className="mt-3 text-xs font-bold text-teal hover:underline"
                  >
                    ← Back to modules
                  </button>
                )}
              </div>
            )}
            {entries.map((e) => (
              <ProposedEntryRow
                key={e.id}
                entry={e}
                onApprove={approveEntry}
                onOverrideInvoice={overrideInvoice}
                posting={postingId === e.id}
              />
            ))}
          </div>

          {/* Execute preview + button — only when there's something approved waiting */}
          {activeModule && executePreview.count > 0 && (
            <div className="mt-5 border-t border-gray-100 pt-5">
              <div className="rounded-xl border-2 border-navy/10 bg-navy/[0.02] p-4">
                <div className="text-xs font-bold uppercase tracking-wider text-navy mb-2">
                  Ready to post to QuickBooks
                </div>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-2xl font-black text-navy">{executePreview.count}</span>
                  <span className="text-sm text-ink-slate">
                    {executePreview.count === 1 ? "entry" : "entries"} totaling{" "}
                    <strong className="text-navy">{formatMoney(executePreview.total)}</strong>
                  </span>
                </div>
                <div className="text-xs text-ink-light">
                  {executePreview.breakdown}
                </div>

                <label className="flex items-start gap-2 text-xs text-navy mt-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={attested}
                    onChange={(e) => setAttested(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    <strong>I've reviewed these entries</strong> and confirm they're correct to post to this client's QuickBooks.
                  </span>
                </label>

                <button
                  onClick={() => executeModule(activeModule)}
                  disabled={acting || !attested}
                  className="mt-3 w-full flex items-center justify-center gap-2 bg-navy text-white font-bold py-3 rounded-xl hover:bg-[#0a1722] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {acting ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                  {acting ? "Posting to QuickBooks…" : `Post ${executePreview.count} ${executePreview.count === 1 ? "entry" : "entries"} now`}
                </button>
              </div>
            </div>
          )}

          {activeModule && executePreview.count === 0 && entries.length > 0 && (
            <div className="mt-5 text-center text-xs text-ink-light border-t border-gray-100 pt-4">
              Nothing approved yet for this module. Approve at least one entry above to enable posting.
            </div>
          )}
        </div>
      )}

      {/* QA */}
      {step === "qa" && (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="mb-4">
            <h3 className="font-bold text-navy flex items-center gap-2">
              <Shield size={16} /> QA Gate
            </h3>
            <p className="text-xs text-ink-light mt-0.5">
              Final safety checks before the cleanup is delivered to the client.
              All checks must pass before you can publish to the portal.
            </p>
          </div>
          {!qa && (
            <button
              onClick={runQA}
              disabled={acting}
              className="text-sm font-bold px-4 py-2 rounded-lg bg-teal text-white inline-flex items-center gap-2"
            >
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
              Run QA checks
            </button>
          )}
          {qa && (
            <div className="space-y-2">
              {(qa.checks || []).map((c: any) => (
                <div key={c.id} className="flex items-start gap-3 p-3 rounded-xl border border-gray-100">
                  {c.passed ? (
                    <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                  ) : (
                    <XCircle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
                  )}
                  <div>
                    <div className="text-sm font-semibold text-navy">{c.label}</div>
                    <div className="text-xs text-ink-light mt-0.5">{c.detail}</div>
                  </div>
                </div>
              ))}
              {qa.passed ? (
                <div className="mt-5 space-y-3">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-navy mb-1.5">
                      Summary for the client (shows on their portal)
                    </label>
                    <textarea
                      value={aiSummary}
                      onChange={(e) => setAiSummary(e.target.value)}
                      placeholder="Plain-language summary of what was cleaned up. Read this carefully before publishing — the client sees exactly what you write."
                      className="w-full h-28 text-sm border border-gray-200 rounded-lg p-3 focus:border-teal focus:ring-1 focus:ring-teal/30 outline-none"
                    />
                  </div>
                  <button
                    onClick={() => deliver(true)}
                    disabled={acting}
                    className="w-full bg-teal text-white font-bold py-3 rounded-xl disabled:opacity-50 flex items-center justify-center gap-2 hover:bg-teal-dark"
                  >
                    <FileText size={16} />
                    {acting ? "Publishing…" : "Deliver & publish to client portal"}
                  </button>
                </div>
              ) : (
                <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm">
                  <strong>QA gate failed</strong> — resolve the failing checks above before delivering.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* DELIVER */}
      {step === "deliver" && status?.run?.status === "complete" && (
        <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-2xl border-2 border-emerald-200 p-8 text-center">
          <CheckCircle2 size={48} className="text-emerald-600 mx-auto mb-3" />
          <h3 className="text-2xl font-black text-emerald-900 mb-2">Cleanup complete</h3>
          <p className="text-sm text-emerald-800 mb-6 max-w-md mx-auto">
            Report published to the client portal. Mark the engagement complete to close out, or jump back to your workflow.
          </p>

          {/* Publish the cleaned Balance Sheet to the portal — separate, explicit
              step so the client never sees the BS before it's approved here. */}
          <div className="mb-6 max-w-md mx-auto rounded-xl border border-emerald-300 bg-white p-4 text-left">
            {bsPushed ? (
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
                <CheckCircle2 size={16} className="text-emerald-600" />
                Balance Sheet is live in the client portal
              </div>
            ) : (
              <>
                <div className="text-sm font-bold text-navy mb-1">Balance Sheet not visible to the client yet</div>
                <p className="text-xs text-ink-slate mb-3">
                  The client&apos;s portal Balance Sheet &amp; Cash Flow stay hidden until you
                  publish them. Push now that the cleanup is approved.
                </p>
                <button
                  onClick={pushBalanceSheet}
                  disabled={pushingBs}
                  className="w-full inline-flex items-center justify-center gap-2 bg-navy text-white font-bold py-2.5 rounded-lg hover:bg-[#0a1722] disabled:opacity-50"
                >
                  {pushingBs ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                  {pushingBs ? "Publishing…" : "Publish Balance Sheet to client portal"}
                </button>
              </>
            )}
          </div>

          <div className="flex gap-3 justify-center flex-wrap">
            <a
              href={`/clients/${clientLinkId}`}
              className="text-sm font-bold px-4 py-2.5 rounded-lg border border-emerald-300 text-emerald-800 hover:bg-emerald-100 bg-white"
            >
              View client profile
            </a>
            <a
              href={`/portal/cleanup-reports`}
              className="text-sm font-bold px-4 py-2.5 rounded-lg border border-emerald-300 text-emerald-800 hover:bg-emerald-100 bg-white"
              target="_blank"
              rel="noopener"
              title="Sanity-check what the client will see (impersonates via View as client)"
            >
              Preview client view ↗
            </a>
            <button
              onClick={async () => {
                await fetch(`/api/clients/${clientLinkId}/complete-cleanup`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ note: `BS cleanup run ${runId} completed via wizard` }),
                });
                window.location.href = "/cleanup";
              }}
              className="text-sm font-bold px-5 py-2.5 rounded-lg bg-emerald-700 text-white hover:bg-emerald-800"
            >
              Mark cleanup complete →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Statement coverage ───────────────────────────────────────────────
   Every bank + credit-card account in QBO, each with a have-it / still-
   need-it check based on whether an uploaded statement is matched to it —
   so the bookkeeper sees at a glance which accounts are still missing
   statements. Below the checklist, the uploaded statements themselves in
   the same previewable table as the client profile. */

type CoverageAccount = { id: string; name: string; accountType: string; accountSubType: string };
type CoverageStatement = {
  id: string; display_name: string; matched_qbo_account_id: string | null;
  matched_account_name: string | null; last4: string | null; account_kind: string | null;
  statement_end_date: string | null; ending_balance: number | null; status: string; storage_path: string;
};

function StatementCoveragePanel({ clientLinkId }: { clientLinkId: string }) {
  const [accounts, setAccounts] = useState<CoverageAccount[] | null>(null);
  const [statements, setStatements] = useState<CoverageStatement[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [acctRes, stmtRes] = await Promise.all([
          fetch(`/api/clients/${clientLinkId}/qbo-accounts`),
          fetch(`/api/clients/${clientLinkId}/statements`),
        ]);
        if (cancelled) return;
        if (acctRes.ok) {
          const j = await acctRes.json();
          const all = (j.accounts || []) as CoverageAccount[];
          setAccounts(
            all.filter((a) => {
              const t = (a.accountType || "").toLowerCase();
              return t === "bank" || t === "credit card";
            })
          );
        } else {
          const j = await acctRes.json().catch(() => ({}));
          setLoadError(j.error || "Couldn't load QuickBooks accounts");
          setAccounts([]);
        }
        if (stmtRes.ok) {
          const j = await stmtRes.json();
          setStatements((j.statements || j || []) as CoverageStatement[]);
        }
      } catch (e: any) {
        if (!cancelled) { setLoadError(e?.message || "Load failed"); setAccounts([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [clientLinkId]);

  const money = (n: number | null) =>
    n == null ? "—" : `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // An account is "covered" if any matched statement points at it.
  const coveredIds = useMemo(() => {
    const s = new Set<string>();
    for (const st of statements) if (st.matched_qbo_account_id) s.add(String(st.matched_qbo_account_id));
    return s;
  }, [statements]);

  const covered = accounts?.filter((a) => coveredIds.has(String(a.id))).length ?? 0;
  const total = accounts?.length ?? 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      {preview && <FilePreviewModal path={preview.path} name={preview.name} onClose={() => setPreview(null)} />}
      <h3 className="font-bold text-navy mb-1 flex items-center gap-2">
        <Building2 size={14} /> Statement coverage
        {accounts && total > 0 && (
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${covered === total ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
            {covered}/{total} accounts
          </span>
        )}
      </h3>
      <p className="text-xs text-ink-light mb-3">
        Every bank &amp; credit-card account in QuickBooks — green if we have a statement matched to it, red if we still need it.
      </p>

      {accounts === null ? (
        <div className="text-sm text-ink-slate flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading accounts…</div>
      ) : loadError ? (
        <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{loadError}</div>
      ) : total === 0 ? (
        <div className="text-sm text-ink-light">No bank or credit-card accounts found in QuickBooks.</div>
      ) : (
        <ul className="space-y-1.5 mb-1">
          {accounts.map((a) => {
            const has = coveredIds.has(String(a.id));
            return (
              <li key={a.id} className="flex items-center gap-2 text-sm">
                {has ? <CheckCircle2 size={15} className="text-emerald-600 flex-shrink-0" /> : <XCircle size={15} className="text-red-500 flex-shrink-0" />}
                <span className="text-navy">{a.name}</span>
                <span className="text-[11px] text-ink-light">{(a.accountType || "").toLowerCase() === "credit card" ? "credit card" : "bank"}</span>
                {!has && <span className="ml-auto text-[11px] font-semibold text-red-600">statement needed</span>}
              </li>
            );
          })}
        </ul>
      )}

      {statements.length > 0 && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-2">Uploaded statements ({statements.length})</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-50">
                {statements.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="py-2 pr-2">
                      <button
                        type="button"
                        onClick={() => setPreview({ path: s.storage_path, name: s.display_name })}
                        className="inline-flex items-center gap-1.5 text-left text-navy hover:text-teal-dark hover:underline"
                        title="Click to preview"
                      >
                        <FileText size={14} className="text-teal-dark flex-shrink-0" />
                        <span className="truncate max-w-[240px]">{s.display_name}</span>
                      </button>
                    </td>
                    <td className="py-2 px-2 text-ink-slate whitespace-nowrap hidden sm:table-cell">
                      {s.matched_account_name || <span className="text-amber-700">not applied</span>}
                    </td>
                    <td className="py-2 px-2 text-ink-slate whitespace-nowrap hidden md:table-cell">{s.statement_end_date || "—"}</td>
                    <td className="py-2 pl-2 text-right font-mono text-navy whitespace-nowrap">{money(s.ending_balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Need from client ─────────────────────────────────────────────────
   Turns the diagnose results into a document-request checklist. Each
   flagged account maps to the statement/answer that unblocks its module:
   bank/CC → statements, loans → loan statement, owner accounts → a
   draws-vs-contributions answer, payroll → provider reports, UF → CRM
   job report. Sending reuses the messages pipeline (portal thread +
   branded email + delivery warning); clients attach files by replying
   in their portal Messages page.

   Statement date range is a client-friendly preset the bookkeeper picks
   (not the raw cleanup-period lock date) — clients find "year-to-date" or
   "last 6 months" easier to grab from online banking than an arbitrary
   date. "Tax year" assumes a calendar-year filer, true for the large
   majority of small trades businesses. */

interface ClientRequestItem {
  id: string;
  text: string;
}

type DateRangeMode = "ytd" | "six_months" | "last_tax_year";

const DATE_MODE_OPTIONS: { value: DateRangeMode; label: string }[] = [
  { value: "ytd", label: "Year-to-date" },
  { value: "six_months", label: "Last 6 months" },
  { value: "last_tax_year", label: `Tax year ${new Date().getFullYear() - 1}` },
];

function fmtMonthDayYear(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function dateRangeLabel(mode: DateRangeMode, now: Date = new Date()): string {
  if (mode === "six_months") {
    const start = new Date(now);
    start.setMonth(start.getMonth() - 6);
    return `for the last 6 months (${fmtMonthDayYear(start)} through today)`;
  }
  if (mode === "last_tax_year") {
    const lastYear = now.getFullYear() - 1;
    return `for tax year ${lastYear} (January 1 through December 31, ${lastYear})`;
  }
  const jan1 = new Date(now.getFullYear(), 0, 1);
  return `year-to-date (${fmtMonthDayYear(jan1)} through today)`;
}

/** What the three-way enumeration hands the panel (dry-run generate). */
interface EnumerationData {
  accounts: Array<{ label: string; kind: string; qbo_account_id: string | null; sources?: string[]; last4?: string | null }>;
  undeclared_asks?: Array<{ label: string; qbo_account_id: string | null }>;
  missing_from_qbo?: Array<{ name: string; kind: string }>;
  has_ob_form?: boolean;
}

function buildClientRequests(
  grades: Array<{ account_name: string; account_type: string; module: string | null }>,
  dateMode: DateRangeMode,
  enumData?: EnumerationData | null,
  coveredIds?: Set<string>
): ClientRequestItem[] {
  const rangeLabel = dateRangeLabel(dateMode);
  const items: ClientRequestItem[] = [];
  const seen = new Set<string>();
  const push = (id: string, text: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    items.push({ id, text });
  };

  // ── Three-way enumeration first (QBO COA + bank-feed evidence + the
  // accounts the client attested to at onboarding): ONE named line per
  // bank / credit-card / loan account that doesn't already have a matched
  // statement uploaded. This is the complete list — the grade-derived
  // items below only add the non-statement asks when it's available.
  const hasEnum = !!enumData?.accounts?.length;
  if (hasEnum) {
    for (const a of enumData!.accounts) {
      if (a.qbo_account_id && coveredIds?.has(String(a.qbo_account_id))) continue; // statement already on file
      // No last-4 we can trust → the QBO name alone ("Main Account") can't tell
      // the client which real bank account we mean, so ask them to identify it
      // instead of sending a noisy "send statements for Main Account" line.
      const unidentified = (a.kind === "bank" || a.kind === "credit_card") && !a.last4;
      if (a.kind === "loan") {
        push(`loan-${a.label}`, `Most recent loan statement for "${a.label}" showing the current balance and payment breakdown`);
      } else if (unidentified) {
        const acctWord = a.kind === "credit_card" ? "credit card" : "bank account";
        push(
          `bank-${a.label}`,
          `You have a ${acctWord} labelled "${a.label}" in QuickBooks, but we don't have the last 4 digits to match it — please tell us which bank/card this is and its last 4 digits, then send its statements ${rangeLabel} (PDF or CSV).`
        );
      } else if (a.kind === "credit_card") {
        push(`cc-${a.label}`, `Credit card statements for "${a.label}" ${rangeLabel} — PDF or CSV`);
      } else {
        push(`bank-${a.label}`, `Bank statements for "${a.label}" ${rangeLabel} — PDF or CSV`);
      }
    }
    // In the books but never declared at onboarding — the personal-card net.
    for (const u of enumData!.undeclared_asks || []) {
      const nm = u.label || "this account";
      push(
        `undeclared-${nm}`,
        `"${nm}" shows activity in your books but wasn't on your onboarding account list — is it a business account we should keep reconciling, or personal?`
      );
    }
  }

  const ownerAccounts: string[] = [];
  for (const g of grades) {
    const name = g.account_name;
    const type = (g.account_type || "").toLowerCase();
    switch (g.module) {
      case "bank_recon":
        if (hasEnum) break; // enumeration already listed every bank/CC account
        if (type.includes("credit")) {
          push(`cc-${name}`, `Credit card statements for "${name}" ${rangeLabel} — PDF or CSV`);
        } else {
          push(`bank-${name}`, `Bank statements for "${name}" ${rangeLabel} — PDF or CSV`);
        }
        break;
      case "loans":
        if (hasEnum) break; // enumeration already listed every loan account
        push(`loan-${name}`, `Most recent loan statement for "${name}" showing the current balance and payment breakdown`);
        break;
      case "shareholder_draws":
        ownerAccounts.push(name);
        break;
      case "tax_payroll":
        push("payroll", "Latest payroll reports from your payroll provider (Gusto, ADP, etc.) and your most recent payroll tax filing");
        break;
      case "undeposited_funds":
        push("crm", "An export CSV of all completed jobs over the last 12 months, including job name, date, total amount, and tax collected (if any).");
        break;
      case "accounts_payable":
        push("ap", "A quick review of your open bills — which do you still actually owe?");
        break;
      default:
        break;
    }
  }
  if (ownerAccounts.length > 0) {
    push(
      "owner",
      `A quick note on ${ownerAccounts.map((n) => `"${n}"`).join(" and ")}: was this activity owner draws, owner contributions, or business expenses?`
    );
  }
  // No onboarding form on file → we have no declared-account baseline, so we
  // can't tell which in-books accounts are "new." Instead of asking about each
  // one, ask one catch-all so the client volunteers anything we're missing.
  if (enumData && enumData.has_ob_form === false) {
    push(
      "catch_all_accounts",
      "Are there any other accounts, loans, credit cards, or personal accounts that you use for business? If so, please share the type and last 4 digits of the account number here."
    );
  }
  return items;
}

function NeedFromClientPanel({
  clientLinkId,
  clientName,
  accountGrades,
}: {
  clientLinkId: string;
  clientName: string;
  accountGrades: any[];
}) {
  const [dateMode, setDateMode] = useState<DateRangeMode>("ytd");

  // Three-way account enumeration (QBO COA + bank-feed evidence + onboarding
  // attestation) via the statement-requests engine in DRY-RUN — display only,
  // no request rows created until the bookkeeper actually sends. Statements
  // already uploaded+matched drop their account off the ask list.
  const [enumData, setEnumData] = useState<EnumerationData | null>(null);
  const [coveredIds, setCoveredIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [genRes, stmtRes] = await Promise.all([
          fetch(`/api/clients/${clientLinkId}/statement-requests/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dry_run: true }),
          }),
          fetch(`/api/clients/${clientLinkId}/statements`),
        ]);
        if (cancelled) return;
        if (genRes.ok) setEnumData(await genRes.json());
        if (stmtRes.ok) {
          const j = await stmtRes.json();
          const s = new Set<string>();
          for (const st of (j.statements || j || []) as any[]) {
            if (st?.matched_qbo_account_id) s.add(String(st.matched_qbo_account_id));
          }
          setCoveredIds(s);
        }
      } catch {
        /* enumeration is best-effort — the grade-derived list still renders */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientLinkId]);

  const suggested = useMemo(
    () => buildClientRequests(accountGrades || [], dateMode, enumData, coveredIds),
    [accountGrades, dateMode, enumData, coveredIds]
  );
  const hasStatementItems = suggested.some((i) => i.id.startsWith("bank-") || i.id.startsWith("cc-"));
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [extra, setExtra] = useState("");
  const [sending, setSending] = useState(false);
  const [sentInfo, setSentInfo] = useState<{ count: number; emailWarning: string | null } | null>(null);
  const [error, setError] = useState("");
  const [emailModalOpen, setEmailModalOpen] = useState(false);

  const isChecked = (id: string) => checked[id] !== false; // default checked
  const selected = suggested.filter((i) => isChecked(i.id));
  const extraTrimmed = extra.trim();
  const totalCount = selected.length + (extraTrimmed ? 1 : 0);

  if (suggested.length === 0) return null;

  const requestItems = [
    ...selected.map((i) => i.text),
    ...(extraTrimmed ? [extraTrimmed] : []),
  ];

  // Branded email preview + Resend send + copy — same modal pattern as
  // the UF audit email tool.
  const copyButton = (
    <button
      type="button"
      onClick={() => setEmailModalOpen(true)}
      disabled={totalCount === 0}
      className="inline-flex items-center gap-2 bg-white hover:bg-gray-50 border border-gray-200 text-navy text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-40"
    >
      <Mail size={14} />
      Preview &amp; send email
    </button>
  );

  async function send() {
    if (totalCount === 0 || sending) return;
    setSending(true);
    setError("");
    try {
      const lines = selected.map((i, idx) => `${idx + 1}. ${i.text}`);
      if (extraTrimmed) lines.push(`${lines.length + 1}. ${extraTrimmed}`);
      const body = [
        `Hi! We're deep-cleaning your books right now and need a few things from you to finish the job:`,
        ``,
        ...lines,
        ``,
        `The easiest way to get these to us: reply to this message in your portal and attach the files (PDF, CSV, Excel, or photos all work). For the questions, just type your answer in the reply.`,
      ].join("\n");
      const res = await fetch(`/api/clients/${clientLinkId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "message",
          subject: `We need ${totalCount} thing${totalCount === 1 ? "" : "s"} to finish cleaning up your books`,
          body,
          // Track this send so its status is visible + syncable from Resend.
          email_log_type: "bs_statements",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send");

      // Also create structured statement requests for the bank/CC/loan items,
      // so the client sees a self-clearing checklist by their upload panel.
      const statementItems = selected
        .map((i) => {
          if (i.id.startsWith("bank-")) return { label: `Bank statement — ${i.id.slice(5)}`, account_name: i.id.slice(5), account_kind: "bank" };
          if (i.id.startsWith("cc-")) return { label: `Credit-card statement — ${i.id.slice(3)}`, account_name: i.id.slice(3), account_kind: "credit_card" };
          if (i.id.startsWith("loan-")) return { label: `Loan statement — ${i.id.slice(5)}`, account_name: i.id.slice(5), account_kind: "loan" };
          return null;
        })
        .filter(Boolean);
      if (statementItems.length > 0) {
        await fetch(`/api/clients/${clientLinkId}/statement-requests`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: statementItems }),
        }).catch(() => {});
      }

      const d = data.email_delivery;
      setSentInfo({
        count: totalCount,
        emailWarning:
          d && !d.sent
            ? d.reason === "no_portal_user"
              ? "The client has no portal login yet — they won't see this until they're invited. Follow up directly."
              : "The notification email failed to send — the message is in their portal, but follow up directly."
            : null,
      });
      loadEmailLog(); // refresh the sent-status line
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  // Sent-request email history (client_email_log, email_type bs_statements) —
  // delivery status kept live by the Resend webhook; "View email" pulls the
  // actual sent email back from Resend.
  const [emailLog, setEmailLog] = useState<any[]>([]);
  const [previewLogId, setPreviewLogId] = useState<string | null>(null);
  async function loadEmailLog() {
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/email-log?type=bs_statements&limit=5`);
      if (res.ok) {
        const j = await res.json();
        setEmailLog(j.emails || []);
      }
    } catch {
      /* best-effort */
    }
  }
  useEffect(() => {
    loadEmailLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientLinkId]);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      {emailModalOpen && (
        <RequestDocsEmailModal
          clientLinkId={clientLinkId}
          clientName={clientName}
          items={requestItems}
          onClose={() => setEmailModalOpen(false)}
        />
      )}
      <h3 className="font-bold text-navy mb-1 flex items-center gap-2">
        <ClipboardList size={14} /> Need from client
      </h3>
      <p className="text-xs text-ink-light mb-3">
        One named line per bank, credit-card, and loan account — from QuickBooks, bank-feed
        activity, and what the client declared at onboarding — minus anything with a statement
        already uploaded. Uncheck what you don&apos;t need, then send it as one portal message +
        email. The client replies with attachments right in their portal.
      </p>

      {(enumData?.missing_from_qbo?.length || 0) > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>Declared at onboarding but not in QuickBooks yet:</strong>{" "}
          {enumData!.missing_from_qbo!.map((m) => `${m.name} (${m.kind.replace("_", " ")})`).join(", ")} — create
          the account{enumData!.missing_from_qbo!.length === 1 ? "" : "s"} in QBO (bookkeeper action; the
          statement line is still requested below).
        </div>
      )}

      {sentInfo ? (
        <div className="space-y-3">
          <div className="text-sm text-emerald-700 flex items-center gap-2">
            <CheckCircle2 size={14} /> Request for {sentInfo.count} item
            {sentInfo.count === 1 ? "" : "s"} sent — replies land on your Today queue.
          </div>
          {sentInfo.emailWarning && (
            <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-1.5">
              <AlertCircle size={13} className="flex-shrink-0 mt-0.5" /> {sentInfo.emailWarning}
            </div>
          )}
          {/* Manual fallback: paste-ready email for clients with no portal. */}
          <div className="flex items-center gap-2">{copyButton}</div>
          <p className="text-xs text-ink-light">
            Don&apos;t want to wait on the docs? Use the{" "}
            <strong className="text-navy">&ldquo;Send to Production&rdquo;</strong> card at the top
            of this page to ship them on P&amp;L now.
          </p>
        </div>
      ) : (
        <>
          {hasStatementItems && (
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <span className="text-xs font-semibold text-ink-slate">Statement period:</span>
              <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
                {DATE_MODE_OPTIONS.map((opt, idx) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setDateMode(opt.value)}
                    className={`text-xs font-semibold px-3 py-1.5 transition-colors ${idx > 0 ? "border-l border-gray-200" : ""} ${
                      dateMode === opt.value ? "bg-teal text-white" : "bg-white text-ink-slate hover:bg-gray-50"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1.5 mb-3">
            {suggested.map((item) => (
              <label key={item.id} className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={isChecked(item.id)}
                  onChange={(e) => setChecked((c) => ({ ...c, [item.id]: e.target.checked }))}
                  className="mt-0.5 accent-teal"
                />
                <span className={isChecked(item.id) ? "text-navy" : "text-ink-light line-through"}>
                  {item.text}
                </span>
              </label>
            ))}
          </div>
          <input
            type="text"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder="Anything else to ask for? (optional)"
            maxLength={500}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3"
          />
          {error && (
            <div className="p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800 mb-2">
              {error}
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={send}
              disabled={totalCount === 0 || sending}
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-40"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send request to client ({totalCount})
            </button>
            {copyButton}
          </div>
        </>
      )}

      {/* Sent-request history — was the email sent, and what did it look like
          (synced from Resend). Delivery status is kept live by the Resend
          webhook (sent → delivered → opened). */}
      {emailLog.length > 0 && (
        <div className="mt-4 pt-3 border-t border-gray-100">
          <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-2">
            Request emails sent
          </div>
          <ul className="space-y-1.5">
            {emailLog.map((e) => {
              const meta = emailStatusMeta(e);
              return (
                <li key={e.id} className="flex items-center gap-2 text-xs flex-wrap">
                  <span className={`inline-flex items-center gap-1 font-semibold px-1.5 py-0.5 rounded ${meta.cls}`}>
                    <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" /> {meta.label}
                  </span>
                  <span className="text-ink-slate">{new Date(e.created_at).toLocaleString()}</span>
                  <span className="text-ink-light truncate max-w-[220px]">→ {e.to_address}</span>
                  <button
                    onClick={() => setPreviewLogId(e.id)}
                    className="ml-auto text-teal font-semibold hover:underline inline-flex items-center gap-1"
                  >
                    <FileText size={11} /> View email
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {previewLogId && (
        <EmailPreviewModal
          clientLinkId={clientLinkId}
          logId={previewLogId}
          onClose={() => setPreviewLogId(null)}
        />
      )}
    </div>
  );
}

/** Colour + label for a client_email_log row's current delivery state. */
function emailStatusMeta(e: any): { label: string; cls: string } {
  const s = String(e?.status || "sent");
  if (e?.opened_at || s === "opened" || s === "clicked")
    return { label: "opened", cls: "bg-emerald-100 text-emerald-700" };
  if (e?.delivered_at || s === "delivered")
    return { label: "delivered", cls: "bg-teal/15 text-teal-dark" };
  if (s === "bounced" || s === "complained" || s === "failed")
    return { label: s, cls: "bg-red-100 text-red-700" };
  return { label: "sent", cls: "bg-gray-100 text-ink-slate" };
}

/**
 * Pulls a sent request email back from Resend (via /email-log/[logId]) and
 * shows the exact HTML the client received + its live delivery status —
 * the "sync from Resend" so the bookkeeper can confirm what went out.
 */
function EmailPreviewModal({
  clientLinkId,
  logId,
  onClose,
}: {
  clientLinkId: string;
  logId: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/clients/${clientLinkId}/email-log/${logId}`);
        const j = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setData(j);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientLinkId, logId]);

  const stored = data?.stored;
  const resend = data?.resend;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-bold text-navy text-sm truncate">{stored?.subject || "Request email"}</div>
            <div className="text-[11px] text-ink-light truncate">
              {stored?.to_address}
              {resend?.last_event ? ` · Resend: ${resend.last_event}` : stored ? ` · ${emailStatusMeta(stored).label}` : ""}
            </div>
          </div>
          <button onClick={onClose} className="text-ink-light hover:text-navy shrink-0"><X size={16} /></button>
        </div>
        <div className="overflow-auto flex-1">
          {loading ? (
            <div className="p-8 text-center text-sm text-ink-slate flex items-center justify-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Pulling the email from Resend…
            </div>
          ) : error ? (
            <div className="p-5 text-xs text-red-800">{error}</div>
          ) : resend?.html ? (
            <iframe title="Sent email" className="w-full h-[60vh] bg-white" srcDoc={resend.html} />
          ) : (
            <div className="p-5 space-y-2">
              <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {data?.resend_error || "Couldn't pull the rendered email from Resend."} Showing what we recorded instead.
              </div>
              <div className="text-xs text-ink-slate">
                Sent {stored?.created_at ? new Date(stored.created_at).toLocaleString() : "—"} · status{" "}
                <strong>{stored ? emailStatusMeta(stored).label : "—"}</strong>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Request-docs email modal ─────────────────────────────────────────
   Branded preview + direct send. Mirrors the UF audit EmailDraftModal:
   rendered/plain preview tabs, copy-formatted (HTML+plain ClipboardItem),
   and a Send button that delivers through Resend via
   /api/clients/[id]/request-docs-email (which also mirrors the message
   into the client thread for the trail). */

function buildRequestDocsEmail(clientName: string, items: string[]) {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = items
    .map(
      (t, i) => `
      <tr>
        <td style="border:1px solid #E5E7EB;padding:9px 10px;text-align:center;color:#1A9B8F;font-weight:700;width:36px;background:#ffffff;">${i + 1}</td>
        <td style="border:1px solid #E5E7EB;padding:9px 12px;color:#33414E;background:#ffffff;">${esc(t)}</td>
      </tr>`
    )
    .join("");
  const html = `
<div style="background:#F4F5F7;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E5E7EB;">
    <div style="background:#0F1F2E;padding:22px 28px;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;">Ironbooks</div>
      <div style="color:#8CD3CC;font-size:12px;margin-top:2px;">Advancing Financial Literacy In The Trades</div>
    </div>
    <div style="padding:28px;">
      <h2 style="margin:0 0 6px;color:#0F1F2E;font-size:18px;">We need a few things to finish your books</h2>
      <p style="color:#33414E;font-size:14px;line-height:1.55;margin:0 0 16px;">
        Hi! We're deep-cleaning the books for <strong>${esc(clientName)}</strong> right now,
        and we need ${items.length === 1 ? "one thing" : `${items.length} things`} from you to finish the job:
      </p>
      <table style="border-collapse:collapse;margin:0 0 20px;width:100%;">
        <tr>
          <th style="border:1px solid #E5E7EB;background:#F8FAFA;padding:9px 10px;text-align:center;color:#0F1F2E;font-size:12px;width:36px;">#</th>
          <th style="border:1px solid #E5E7EB;background:#F8FAFA;padding:9px 12px;text-align:left;color:#0F1F2E;font-size:12px;">WHAT WE NEED</th>
        </tr>${rows}
      </table>
      <div style="background:#F8FAFA;border:1px solid #E5E7EB;border-left:3px solid #1A9B8F;border-radius:8px;padding:14px 16px;margin:0 0 20px;color:#33414E;font-size:13px;line-height:1.55;">
        <strong>The easiest way:</strong> just reply to this email with the files attached —
        PDF, CSV, Excel, or photos all work. For the questions, type your answer right in the reply.
      </div>
      <p style="color:#33414E;font-size:14px;margin:0;">
        Thanks!<br/>Your Ironbooks bookkeeping team
      </p>
    </div>
  </div>
  <div style="max-width:620px;margin:12px auto 0;text-align:center;color:#9AA3AD;font-size:11px;">
    Sent by your Ironbooks bookkeeping team for ${esc(clientName)}.
  </div>
</div>`;
  const text = [
    `Hi!`,
    ``,
    `We're deep-cleaning the books for ${clientName} right now, and we need ${items.length === 1 ? "one thing" : `${items.length} things`} from you to finish the job:`,
    ``,
    ...items.map((t, i) => `${i + 1}. ${t}`),
    ``,
    `The easiest way: just reply to this email with the files attached (PDF, CSV, Excel, or photos all work). For the questions, type your answer right in the reply.`,
    ``,
    `Thanks!`,
    `Your Ironbooks bookkeeping team`,
  ].join("\n");
  return { html, text };
}

function RequestDocsEmailModal({
  clientLinkId,
  clientName,
  items,
  onClose,
}: {
  clientLinkId: string;
  clientName: string;
  items: string[];
  onClose: () => void;
}) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(
    `We need ${items.length === 1 ? "one thing" : `${items.length} things`} to finish cleaning up your books`
  );
  const [preview, setPreview] = useState<"rendered" | "plain">("rendered");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [copiedFormatted, setCopiedFormatted] = useState(false);

  const { html, text } = useMemo(() => buildRequestDocsEmail(clientName, items), [clientName, items]);

  // Prefill To with the client's portal-user emails when they exist.
  useEffect(() => {
    fetch(`/api/clients/${clientLinkId}/request-docs-email`)
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.emails) && d.emails.length > 0) {
          setTo(d.emails.join(", "));
        }
      })
      .catch(() => {});
  }, [clientLinkId]);

  const recipients = to
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);

  async function sendEmail() {
    if (recipients.length === 0 || sending) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/request-docs-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: recipients, subject, html, text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Send failed");
      setSentTo(data.recipients);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  async function copyFormatted() {
    setError("");
    try {
      if (typeof ClipboardItem === "undefined") {
        await navigator.clipboard.writeText(text);
      } else {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
      }
      setCopiedFormatted(true);
      setTimeout(() => setCopiedFormatted(false), 2000);
    } catch {
      setError("Clipboard blocked — use the Plain text tab and copy manually.");
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
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full my-8 flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Mail size={18} className="text-teal" />
              <h3 className="text-lg font-bold text-navy">Document request — {clientName}</h3>
            </div>
            <p className="text-xs text-ink-slate mt-1">
              {items.length} item{items.length === 1 ? "" : "s"} · sends from Ironbooks support
              via Resend, replies go to the monitored inbox
            </p>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy">
            <X size={18} />
          </button>
        </div>

        {sentTo !== null ? (
          <div className="px-6 py-10 text-center space-y-2">
            <CheckCircle2 size={28} className="mx-auto text-emerald-500" />
            <div className="text-sm font-semibold text-navy">
              Email sent to {sentTo} recipient{sentTo === 1 ? "" : "s"}
            </div>
            <p className="text-xs text-ink-slate max-w-sm mx-auto">
              A copy is recorded in the client&apos;s message thread so the whole team can see the
              request went out.
            </p>
            <button
              onClick={onClose}
              className="mt-2 inline-flex items-center gap-2 bg-navy text-white text-sm font-semibold px-5 py-2 rounded-lg"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* To + Subject */}
            <div className="px-6 pt-4 space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-xs font-semibold text-ink-slate uppercase tracking-wider w-16 flex-shrink-0">To</span>
                <input
                  type="text"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="client@example.com (comma-separate multiple)"
                  className="flex-1 px-3 py-1.5 rounded-lg border border-gray-200 text-navy text-sm focus:border-teal focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-xs font-semibold text-ink-slate uppercase tracking-wider w-16 flex-shrink-0">Subject</span>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  maxLength={200}
                  className="flex-1 px-3 py-1.5 rounded-lg border border-gray-200 text-navy font-medium text-sm focus:border-teal focus:outline-none"
                />
              </div>
            </div>

            {/* Preview tabs */}
            <div className="px-6 pt-4 flex items-center gap-1 border-b border-gray-100">
              {(["rendered", "plain"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPreview(p)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-t ${
                    preview === p
                      ? "bg-gray-50 text-navy border-b-2 border-teal"
                      : "text-ink-slate hover:text-navy"
                  }`}
                >
                  {p === "rendered" ? "Rendered preview" : "Plain text"}
                </button>
              ))}
            </div>

            {/* Preview body */}
            <div className="flex-1 overflow-y-auto bg-gray-50 px-6 py-4 max-h-[50vh]">
              {preview === "rendered" ? (
                <div
                  className="rounded border border-gray-200 overflow-hidden"
                  // Our own template — safe for dangerouslySetInnerHTML.
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap bg-white border border-gray-200 rounded-lg p-4 text-navy">
                  {text}
                </pre>
              )}
            </div>

            {/* Footer actions */}
            <div className="px-6 py-4 border-t border-gray-100 flex items-center gap-2 flex-wrap">
              <button
                onClick={sendEmail}
                disabled={recipients.length === 0 || sending || !subject.trim()}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2 rounded-lg disabled:opacity-40"
              >
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                Send email{recipients.length > 1 ? ` (${recipients.length})` : ""}
              </button>
              <button
                onClick={copyFormatted}
                className="inline-flex items-center gap-2 bg-white hover:bg-gray-50 border border-gray-200 text-navy text-sm font-semibold px-4 py-2 rounded-lg"
              >
                {copiedFormatted ? <CheckCircle2 size={14} className="text-emerald-600" /> : <Copy size={14} />}
                {copiedFormatted ? "Copied" : "Copy formatted"}
              </button>
              {recipients.length === 0 && (
                <span className="text-xs text-amber-700">
                  Add the client&apos;s email address to send.
                </span>
              )}
              {error && <span className="text-xs text-red-700">{error}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Statement analysis (multi-PDF) ───────────────────────────────────
   Upload every account's statement PDF at once. Claude reads each one,
   matches it to a QBO balance-sheet account, and the QBO-vs-statement
   gap becomes a proposed reconciling entry on the review screen — so the
   bookkeeper approves recommendations instead of hand-keying balances. */

interface StmtResult {
  filename: string;
  matched_account_name: string | null;
  qbo_account_id: string | null;
  qbo_balance: number | null;
  statement_balance: number | null;
  gap: number | null;
  statement_end_date: string | null;
  confidence: "high" | "medium" | "low" | "none";
  status: "reconciled" | "gap_found" | "unmatched" | "no_balance";
  note: string | null;
}

function fmtAmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const v = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `($${v})` : `$${v}`;
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function StatementAnalysisPanel({ runId, onApplied }: { runId: string; onApplied: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [hover, setHover] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [results, setResults] = useState<StmtResult[] | null>(null);
  const [error, setError] = useState("");

  function addFiles(list: FileList | File[] | null) {
    const pdfs = Array.from(list || []).filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (pdfs.length === 0) return;
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...pdfs.filter((f) => !names.has(f.name))];
    });
  }

  async function analyze() {
    if (files.length === 0 || analyzing) return;
    setAnalyzing(true);
    setError("");
    setResults(null);
    try {
      const statements = await Promise.all(
        files.map(async (f) => ({ filename: f.name, base64: await fileToBase64(f) }))
      );
      const res = await fetch(`/api/cleanup/${runId}/analyze-statements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statements }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      setResults(data.results || []);
      if (data.recon_rows_written > 0) onApplied(); // refresh proposed entries
    } catch (e: any) {
      setError(e?.message || "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  const gapsFound = (results || []).filter((r) => r.status === "gap_found").length;
  const reconciled = (results || []).filter((r) => r.status === "reconciled").length;
  const unresolved = (results || []).filter((r) => r.status === "unmatched" || r.status === "no_balance").length;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      <h3 className="font-bold text-navy mb-1 flex items-center gap-2">
        <FileText size={14} /> Analyze statement PDFs (recommended)
      </h3>
      <p className="text-xs text-ink-light mb-3">
        Drop in the bank, credit-card, and loan statement PDFs — multiple at once. SNAP reads each
        one, matches it to the right QuickBooks account, and turns any difference vs the QBO balance
        into a proposed reconciling entry you just review and approve.
      </p>

      <div
        onDragOver={(e) => { e.preventDefault(); setHover(true); }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => { e.preventDefault(); setHover(false); addFiles(e.dataTransfer.files); }}
        className={`rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
          hover ? "border-teal bg-teal/5" : "border-gray-200"
        }`}
      >
        <input
          id={`stmt-input-${runId}`}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <label htmlFor={`stmt-input-${runId}`} className="cursor-pointer text-sm text-ink-slate">
          <Upload size={16} className="inline mr-1 text-teal" />
          Drop statement PDFs here or <span className="text-teal font-semibold underline">browse</span> (multiple OK)
        </label>
      </div>

      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <span key={f.name} className="inline-flex items-center gap-1 text-[11px] bg-slate-100 text-navy px-2 py-1 rounded-full">
              <FileText size={10} /> {f.name}
              {!analyzing && (
                <button
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  className="text-ink-light hover:text-red-600"
                  aria-label="Remove"
                >
                  <X size={10} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="mt-2 p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">{error}</div>
      )}

      <button
        onClick={analyze}
        disabled={files.length === 0 || analyzing}
        className="mt-3 text-xs font-bold px-3 py-1.5 rounded-lg bg-teal text-white disabled:opacity-50 inline-flex items-center gap-1.5"
      >
        {analyzing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
        {analyzing ? "Reading statements…" : `Analyze ${files.length || ""} statement${files.length === 1 ? "" : "s"}`}
      </button>

      {results && (
        <div className="mt-4 space-y-2">
          <div className="text-xs text-ink-slate">
            {reconciled > 0 && <span className="text-emerald-700 font-semibold">{reconciled} already match</span>}
            {reconciled > 0 && (gapsFound > 0 || unresolved > 0) && " · "}
            {gapsFound > 0 && <span className="text-amber-700 font-semibold">{gapsFound} gap{gapsFound === 1 ? "" : "s"} → proposed entries</span>}
            {gapsFound > 0 && unresolved > 0 && " · "}
            {unresolved > 0 && <span className="text-red-700 font-semibold">{unresolved} need attention</span>}
          </div>
          <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50">
            {results.map((r, i) => (
              <div key={i} className="px-3 py-2 flex items-center gap-3 text-xs">
                <span className="flex-shrink-0">
                  {r.status === "reconciled" && <CheckCircle2 size={13} className="text-emerald-600" />}
                  {r.status === "gap_found" && <AlertCircle size={13} className="text-amber-600" />}
                  {(r.status === "unmatched" || r.status === "no_balance") && <XCircle size={13} className="text-red-500" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-navy truncate">
                    {r.matched_account_name || r.filename}
                    {r.confidence === "low" && <span className="ml-1 text-amber-600 font-normal">(low-confidence match — verify)</span>}
                  </div>
                  <div className="text-ink-light truncate">
                    {r.status === "reconciled" && `Matches QBO at ${fmtAmt(r.statement_balance)}${r.statement_end_date ? ` as of ${r.statement_end_date}` : ""}`}
                    {r.status === "gap_found" && `QBO ${fmtAmt(r.qbo_balance)} vs statement ${fmtAmt(r.statement_balance)} → entry for ${fmtAmt(r.gap)}`}
                    {r.status === "unmatched" && (r.note || "Couldn't match to a QBO account")}
                    {r.status === "no_balance" && (r.note || "Couldn't read an ending balance")}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {gapsFound > 0 && (
            <p className="text-[11px] text-ink-light">
              Reconciling entries are now in the bank-recon module — run/open it on the Modules step to review &amp; approve.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── P&L-only promote card (always-on) ────────────────────────────────
   Standalone version of the Need-from-client promote: review last
   month's statements, attest the P&L is ready, then move the client to
   production on P&L-only service (portal BS stays hidden, Production
   board tracks them as Waiting on Client) — without first sending a doc
   request. Collapsed by default so it doesn't crowd the run page. */

function PLOnlyPromoteCard({
  clientLinkId,
  clientName,
}: {
  clientLinkId: string;
  clientName: string;
}) {
  const [open, setOpen] = useState(false);
  const [stmts, setStmts] = useState<Statements | null>(null);
  const [stmtsPeriod, setStmtsPeriod] = useState("");
  const [loadingStmts, setLoadingStmts] = useState(false);
  const [attested, setAttested] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState(false);
  const [error, setError] = useState("");
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escalateNote, setEscalateNote] = useState("");
  const [escalating, setEscalating] = useState(false);
  const [escalated, setEscalated] = useState(false);

  async function escalate() {
    if (!escalateNote.trim() || escalating) return;
    setEscalating(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/escalate-statements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: escalateNote.trim(), context: "BS cleanup — P&L review" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't escalate");
      setEscalated(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setEscalating(false);
    }
  }

  async function loadStatements() {
    setLoadingStmts(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/monthly-rec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "statements" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't load statements");
      setStmts(data.run?.statements || null);
      setStmtsPeriod(data.run?.period || "");
      if (!data.run?.statements) setError("QBO returned no statements for last month.");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingStmts(false);
    }
  }

  async function promote() {
    setPromoting(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/production`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "promote_pl_only" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to promote");
      setPromoted(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPromoting(false);
    }
  }

  if (promoted) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 flex items-center gap-2">
        <CheckCircle2 size={16} />
        {clientName} moved to Production on P&amp;L-only service. Their portal balance sheet stays
        hidden until you finish the cleanup and flip BS back on from the Production board.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border-2 border-navy/15 bg-white overflow-hidden shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-9 h-9 rounded-full bg-navy/10 flex items-center justify-center flex-shrink-0">
            <ArrowRight size={16} className="text-navy" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-bold text-navy">
              P&amp;L done? Send {clientName} to Production
            </div>
            <div className="text-xs text-ink-light mt-0.5">
              Ship monthly P&amp;L service now; the balance sheet keeps waiting on client docs.
            </div>
          </div>
        </div>
        <span className="text-xs font-bold text-white bg-navy px-3 py-1.5 rounded-lg flex-shrink-0">
          {open ? "Close" : "Review & send →"}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-sky-200 pt-3">
          <p className="text-xs text-ink-slate">
            Review last month&apos;s statements, attest the P&amp;L is right, and move {clientName} to
            production on P&amp;L-only service. Their portal balance sheet is greyed out and the
            Production board tracks them as &quot;Waiting on Client&quot; until you finish the cleanup
            and turn BS back on.
          </p>

          {error && (
            <div className="p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">{error}</div>
          )}

          {stmts ? (
            <>
              <StatementsReview statements={stmts} monthLabel={stmtsPeriod ? periodLabel(stmtsPeriod) : "Last month"} clientLinkId={clientLinkId} period={stmtsPeriod || undefined} />
              <label className="flex items-start gap-2 text-sm cursor-pointer p-3 rounded-lg border border-teal/30 bg-white">
                <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-0.5 accent-teal" />
                <span className="text-navy">
                  I reviewed these statements. The <strong>P&amp;L is accurate and ready</strong> for the
                  client; the balance sheet is still in cleanup and stays off their portal.
                </span>
              </label>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  disabled={!attested || promoting}
                  onClick={promote}
                  className="inline-flex items-center gap-2 bg-navy hover:bg-navy/90 text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-40"
                >
                  {promoting ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                  Mark P&amp;L complete &amp; send to Production
                </button>
                {!escalated && (
                  <button
                    type="button"
                    onClick={() => setEscalateOpen((o) => !o)}
                    className="inline-flex items-center gap-2 bg-white hover:bg-red-50 border border-red-200 text-red-700 text-sm font-semibold px-4 py-2 rounded-lg"
                  >
                    <AlertCircle size={14} />
                    These are wrong — escalate to manager
                  </button>
                )}
              </div>

              {/* Escalation note → manager's Today queue */}
              {escalated ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 flex items-center gap-2">
                  <CheckCircle2 size={15} /> Escalated to your manager — it&apos;s on their Today
                  queue with your note. They&apos;ll take it from here.
                </div>
              ) : escalateOpen ? (
                <div className="rounded-lg border border-red-200 bg-red-50/60 p-3 space-y-2">
                  <div className="text-xs font-semibold text-red-800">
                    What looks wrong? (sent to your manager)
                  </div>
                  <textarea
                    value={escalateNote}
                    onChange={(e) => setEscalateNote(e.target.value)}
                    rows={3}
                    maxLength={2000}
                    placeholder="e.g. Revenue looks understated — I think the March Stripe deposits didn't get categorized to income."
                    className="w-full border border-red-200 rounded-lg px-3 py-2 text-sm focus:border-red-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={escalate}
                    disabled={!escalateNote.trim() || escalating}
                    className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-40"
                  >
                    {escalating ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    Send to manager
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              onClick={loadStatements}
              disabled={loadingStmts}
              className="inline-flex items-center gap-2 bg-white hover:bg-gray-50 border border-gray-200 text-navy text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-40"
            >
              {loadingStmts ? <Loader2 size={14} className="animate-spin" /> : <FileSearch size={14} />}
              {loadingStmts ? "Pulling from QuickBooks…" : "Load last month's statements to review"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
