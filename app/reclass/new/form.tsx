"use client";

import { useEffect, useState } from "react";
import { RedoWarning } from "@/components/RedoWarning";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Loader2, AlertCircle, Sparkles, GitMerge, ChevronRight, Layers,
  Calendar, DollarSign, Scale,
} from "lucide-react";

interface ClientLink {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  qbo_realm_id: string;
  double_client_id: string | null;
  double_client_name: string | null;
  // From migration 32 — drives the PY-aware date range banner/default.
  // Both fields are present-but-defaults when the migration hasn't shipped yet.
  py_taxes_filed?: boolean;
  py_taxes_filed_through_year?: number | null;
}

interface QboAccount {
  id: string;
  name: string;
  fullyQualifiedName: string;
  accountType: string;
  accountSubType: string;
  currentBalance: number;
  classification: string;
}

interface DateRangePreset {
  id: string;
  label: string;
  start: string;
  end: string;
}

type Workflow = "consolidation" | "scrub" | "full_categorization" | null;

export function NewReclassForm({ clientLinks }: { clientLinks: ClientLink[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Default straight into Full AI Categorization — for almost every client the
  // reclass job is just "match the transactions, then review & approve". The
  // mode picker (consolidation / scrub / advanced bypass) is one click away via
  // the "Other reclass options" link on the setup screen.
  const [workflow, setWorkflow] = useState<Workflow>("full_categorization");
  // Picker tab — splits the workflow chooser between the day-to-day
  // reclass options ("standard") and bypass routes that skip reclass
  // entirely ("advanced", currently just Balance Sheet only).
  const [pickerTab, setPickerTab] = useState<"standard" | "advanced">("standard");
  // Inline client picker for the Advanced → Balance Sheet only path,
  // which navigates straight to /balance-sheet/[id] without creating a
  // reclass job.
  const [bsOnlyClientId, setBsOnlyClientId] = useState<string>("");
  const [clientLinkId, setClientLinkId] = useState<string>("");
  const [accounts, setAccounts] = useState<QboAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [accountsError, setAccountsError] = useState<string>("");

  const [sourceAccountId, setSourceAccountId] = useState<string>("");
  const [targetAccountId, setTargetAccountId] = useState<string>("");
  const [dateRangeStart, setDateRangeStart] = useState<string>("");
  const [dateRangeEnd, setDateRangeEnd] = useState<string>("");
  const [reason, setReason] = useState<string>("");

  // full_categorization-specific
  const [datePresetId, setDatePresetId] = useState<string>("fy");
  const [datePresets, setDatePresets] = useState<DateRangePreset[]>([]);
  const [fiscalYearStartMonthName, setFiscalYearStartMonthName] = useState<string>("");
  const [loadingPresets, setLoadingPresets] = useState(false);
  const [presetsError, setPresetsError] = useState<string>("");
  const [threshold, setThreshold] = useState<number>(500);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>("");
  const [blockingJobId, setBlockingJobId] = useState<string>("");
  const [cancelling, setCancelling] = useState(false);
  const [redoAllowed, setRedoAllowed] = useState(true);

  const selectedClient = clientLinks.find((c) => c.id === clientLinkId);
  const sourceAccount = accounts.find((a) => a.id === sourceAccountId);
  const targetAccount = accounts.find((a) => a.id === targetAccountId);

  // Auto-init from query string (handoff from COA)
  useEffect(() => {
    const cId = searchParams.get("client");
    const wf = searchParams.get("workflow") as Workflow | null;
    if (wf && ["consolidation", "scrub", "full_categorization"].includes(wf)) {
      setWorkflow(wf);
    }
    if (cId && clientLinks.some((c) => c.id === cId)) {
      setClientLinkId(cId);
    }
  }, [searchParams, clientLinks]);

  // Default date range to current year (for consolidation/scrub)
  useEffect(() => {
    if (workflow !== "full_categorization") {
      const now = new Date();
      const yearStart = `${now.getUTCFullYear()}-01-01`;
      const today = now.toISOString().split("T")[0];
      setDateRangeStart(yearStart);
      setDateRangeEnd(today);
    }
  }, [workflow]);

  // Load accounts when client changes (consolidation + scrub)
  useEffect(() => {
    if (!clientLinkId || workflow === "full_categorization") {
      setAccounts([]);
      return;
    }
    setLoadingAccounts(true);
    setAccountsError("");
    setSourceAccountId("");
    setTargetAccountId("");
    fetch(`/api/clients/${clientLinkId}/qbo-accounts`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || "Failed to load accounts");
        return r.json();
      })
      .then((data) => setAccounts(data.accounts || []))
      .catch((e) => setAccountsError(e.message))
      .finally(() => setLoadingAccounts(false));
  }, [clientLinkId, workflow]);

  // Load fiscal year + presets for full_categorization
  useEffect(() => {
    if (!clientLinkId || workflow !== "full_categorization") return;
    setLoadingPresets(true);
    setPresetsError("");
    fetch(`/api/clients/${clientLinkId}/company-info`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || "Failed to load company info");
        return r.json();
      })
      .then((data) => {
        setDatePresets(data.date_range_presets);
        setFiscalYearStartMonthName(data.company.fiscal_year_start_month_name);

        // Smart Q1 default: if "This Fiscal Year" is <90 days long (e.g., we
        // just started a new FY), default to "This FY + Last FY" so the
        // bookkeeper has enough transactions to build solid bank rules.
        // Otherwise default to "This Fiscal Year".
        const fyPreset = data.date_range_presets.find((p: DateRangePreset) => p.id === "fy");
        const fyPlus1Preset = data.date_range_presets.find((p: DateRangePreset) => p.id === "fy_plus_1");
        let chosenId = "fy";
        if (fyPreset) {
          const fyStart = new Date(fyPreset.start);
          const fyEnd = new Date(fyPreset.end);
          const fyDays = Math.round((fyEnd.getTime() - fyStart.getTime()) / 86_400_000);
          if (fyDays < 90 && fyPlus1Preset) {
            chosenId = "fy_plus_1";
          }
        }
        const def = data.date_range_presets.find((p: DateRangePreset) => p.id === chosenId)
                 || data.date_range_presets[0];
        if (def) {
          setDatePresetId(def.id);
          setDateRangeStart(def.start);
          setDateRangeEnd(def.end);
        }
      })
      .catch((e) => setPresetsError(e.message))
      .finally(() => setLoadingPresets(false));
  }, [clientLinkId, workflow]);

  useEffect(() => {
    const p = datePresets.find((p) => p.id === datePresetId);
    if (p) {
      setDateRangeStart(p.start);
      setDateRangeEnd(p.end);
    }
  }, [datePresetId, datePresets]);

  // ── PY-taxes-aware date clamp ────────────────────────────────────────
  // When the selected client has filed taxes through year Y, the reclass
  // job should start no earlier than (Y+1)-01-01. Clamps automatically
  // any time the client changes or the date range is set (preset or
  // default). The banner below the picker explains it to the bookkeeper.
  const pyFiledThroughYear =
    selectedClient?.py_taxes_filed && selectedClient.py_taxes_filed_through_year
      ? selectedClient.py_taxes_filed_through_year
      : null;
  const unfiledStartDate = pyFiledThroughYear ? `${pyFiledThroughYear + 1}-01-01` : null;
  const dateRangeCrossesFiledBoundary =
    !!(unfiledStartDate && dateRangeStart && dateRangeStart < unfiledStartDate);

  useEffect(() => {
    if (!unfiledStartDate || !dateRangeStart) return;
    if (dateRangeStart < unfiledStartDate) {
      setDateRangeStart(unfiledStartDate);
    }
  }, [unfiledStartDate, dateRangeStart]);

  const daysDiff =
    dateRangeStart && dateRangeEnd
      ? Math.round(
          (new Date(dateRangeEnd).getTime() - new Date(dateRangeStart).getTime()) / 86400000
        )
      : 0;
  const dateRangeOverLimit = workflow !== "full_categorization" && daysDiff > 366;

  // Reason is auto-generated server-side for full_categorization (no bookkeeper input needed).
  // Required for consolidation / scrub since those are bespoke decisions.
  const reasonOk =
    workflow === "full_categorization" ? true : reason.trim().length >= 5;

  const canSubmit =
    workflow &&
    clientLinkId &&
    (workflow === "full_categorization" ? true : sourceAccountId) &&
    (workflow !== "consolidation" || targetAccountId) &&
    (workflow === "full_categorization" || sourceAccountId !== targetAccountId) &&
    dateRangeStart &&
    dateRangeEnd &&
    !dateRangeOverLimit &&
    reasonOk &&
    (workflow !== "full_categorization" || threshold > 0) &&
    !submitting;

  // Pre-flight warning state. When the QBO TX-count probe says the client
  // has 0 reclass-eligible transactions in the date range, we show a yellow
  // panel explaining the For Review queue + Ask My Accountant pattern.
  // Bookkeeper clicks "Run anyway" to bypass; that flips `preflightDismissed`
  // so the next submit skips the check.
  const [preflightChecking, setPreflightChecking] = useState(false);
  const [preflightWarning, setPreflightWarning] = useState<{
    supported: number;
    unsupported: number;
    topUnsupported: Array<{ type: string; count: number }>;
  } | null>(null);
  const [preflightDismissed, setPreflightDismissed] = useState(false);

  async function handleSubmit() {
    if (!canSubmit || !selectedClient) return;

    // Pre-flight: only on full_categorization (the workflow that scans
    // all expense types). For consolidation/scrub the bookkeeper already
    // picked a specific source account, so we trust their intent.
    // Skip if already dismissed (user clicked "Run anyway") to avoid a loop.
    if (workflow === "full_categorization" && !preflightDismissed && !preflightWarning) {
      setPreflightChecking(true);
      setSubmitError("");
      try {
        const url = `/api/clients/${clientLinkId}/qbo-tx-counts?start=${dateRangeStart}&end=${dateRangeEnd}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const supported = data?.summary?.currently_supported_total ?? 0;
          const unsupported = data?.summary?.currently_unsupported_total ?? 0;
          if (supported === 0) {
            // Surface the warning panel; user can dismiss + retry.
            const topUnsupported = (data?.counts || [])
              .filter((c: any) => !c.supported_by_reclass && (c.count || 0) > 0)
              .sort((a: any, b: any) => (b.count || 0) - (a.count || 0))
              .slice(0, 4)
              .map((c: any) => ({ type: c.type, count: c.count }));
            setPreflightWarning({ supported, unsupported, topUnsupported });
            setPreflightChecking(false);
            return;
          }
        }
        // Pre-flight failed or returned non-empty → fall through and submit.
      } catch {
        // Probe failures shouldn't block discovery — fail open and submit.
      } finally {
        setPreflightChecking(false);
      }
    }

    setSubmitting(true);
    setSubmitError("");

    try {
      const body: any = {
        client_link_id: clientLinkId,
        workflow,
        date_range_start: dateRangeStart,
        date_range_end: dateRangeEnd,
        jurisdiction: selectedClient.jurisdiction,
        state_province: selectedClient.state_province || "",
        // Reason: auto-generated server-side for full_categorization
        reason: workflow === "full_categorization" ? "" : reason.trim(),
      };

      if (workflow === "full_categorization") {
        body.source_account_id = null;
        body.source_account_name = null;
        body.auto_approve_threshold = threshold;
      } else {
        body.source_account_id = sourceAccountId;
        body.source_account_name = sourceAccount?.name;
        body.target_account_id = targetAccountId || undefined;
        body.target_account_name = targetAccount?.name || undefined;
      }

      const res = await fetch("/api/reclass/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.existing_job_id) {
          setBlockingJobId(data.existing_job_id);
        }
        throw new Error(data.error || "Failed to start job");
      }
      router.push(`/reclass/${data.job_id}/review`);
    } catch (e: any) {
      setSubmitError(e.message);
      setSubmitting(false);
    }
  }

  async function cancelBlockingJob() {
    if (!blockingJobId) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/reclass/${blockingJobId}/cancel`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Cancel failed");
      }
      setBlockingJobId("");
      setSubmitError("");
      // Auto-retry
      await handleSubmit();
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setCancelling(false);
    }
  }

  // ─────────── STEP 1: Workflow picker ───────────
  if (!workflow) {
    return (
      <div className="space-y-4">
        {/* Standard / Advanced tabs. Standard = day-to-day reclass workflows.
            Advanced = bypass routes that skip reclass entirely (e.g.
            Balance-Sheet-only for clients where P&L work is already done
            or was completed manually). */}
        <div className="inline-flex items-center gap-1 bg-gray-100 p-1 rounded-xl">
          <button
            onClick={() => setPickerTab("standard")}
            className={`px-4 py-1.5 text-sm font-semibold rounded-lg transition-all ${
              pickerTab === "standard"
                ? "bg-white text-navy shadow-sm"
                : "text-ink-slate hover:text-navy"
            }`}
          >
            Standard
          </button>
          <button
            onClick={() => setPickerTab("advanced")}
            className={`px-4 py-1.5 text-sm font-semibold rounded-lg transition-all ${
              pickerTab === "advanced"
                ? "bg-white text-navy shadow-sm"
                : "text-ink-slate hover:text-navy"
            }`}
          >
            Advanced
          </button>
        </div>

        {pickerTab === "advanced" ? (
          <div className="space-y-4">
            <p className="text-ink-slate">
              Bypass routes for clients where the standard reclass pipeline
              doesn&apos;t apply. Pick a client and jump straight to the work.
            </p>

            {/* Balance Sheet only — skip COA + reclass entirely and go
                directly to /balance-sheet/[id]. For clients whose P&L is
                already clean or was reconciled manually and only the
                balance sheet remains. */}
            <div className="w-full flex items-start gap-4 p-6 bg-white rounded-2xl border-2 border-teal text-left shadow-sm">
              <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-teal flex items-center justify-center">
                <Scale className="text-white" size={24} />
              </div>
              <div className="flex-1">
                <div className="font-bold text-navy mb-1">Balance Sheet only</div>
                <div className="text-sm text-ink-slate mb-3">
                  Skip COA cleanup and reclass — go straight to the BS
                  Cleanup workflow (account picker, statement balances,
                  JE suggestions, gap analyzer). Use when the P&L side is
                  already clean or was finished outside the app.
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={bsOnlyClientId}
                    onChange={(e) => setBsOnlyClientId(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none text-sm"
                  >
                    <option value="">Select a client...</option>
                    {clientLinks.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.client_name}
                        {c.state_province ? ` (${c.jurisdiction} · ${c.state_province})` : ` (${c.jurisdiction})`}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      if (bsOnlyClientId) {
                        router.push(`/balance-sheet/${bsOnlyClientId}`);
                      }
                    }}
                    disabled={!bsOnlyClientId}
                    className="px-4 py-2 rounded-lg bg-teal hover:bg-teal-dark text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                  >
                    Open →
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
        <p className="text-ink-slate">Choose what kind of reclassification you want to run.</p>

        <button
          onClick={() => setWorkflow("full_categorization")}
          className="w-full flex items-start gap-4 p-6 bg-white rounded-2xl border-2 border-teal hover:border-teal-dark text-left transition-colors shadow-sm"
        >
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-teal flex items-center justify-center">
            <Layers className="text-white" size={24} />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <div className="font-bold text-navy">Full AI Categorization</div>
              <span className="text-[10px] bg-teal text-white px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide">Recommended</span>
            </div>
            <div className="text-sm text-ink-slate">
              Pull all transactions in a date range and let AI map each one to the correct account
              in the new COA. Auto-approves below your threshold, flags higher-value transactions
              for review. Best run right after a COA cleanup.
            </div>
          </div>
          <ChevronRight className="text-ink-slate self-center" size={20} />
        </button>

        <button
          onClick={() => setWorkflow("consolidation")}
          className="w-full flex items-start gap-4 p-6 bg-white rounded-2xl border-2 border-gray-100 hover:border-teal text-left transition-colors"
        >
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-teal-lighter flex items-center justify-center">
            <GitMerge className="text-teal" size={24} />
          </div>
          <div className="flex-1">
            <div className="font-bold text-navy mb-1">Account Consolidation</div>
            <div className="text-sm text-ink-slate">
              Move all transactions from one account into another. Use when you want to merge
              "Supplies" into "Job Supplies" or eliminate a duplicate account.
            </div>
          </div>
          <ChevronRight className="text-ink-slate self-center" size={20} />
        </button>

        <button
          onClick={() => setWorkflow("scrub")}
          className="w-full flex items-start gap-4 p-6 bg-white rounded-2xl border-2 border-gray-100 hover:border-teal text-left transition-colors"
        >
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-teal-lighter flex items-center justify-center">
            <Sparkles className="text-teal" size={24} />
          </div>
          <div className="flex-1">
            <div className="font-bold text-navy mb-1">AI Scrub (single account)</div>
            <div className="text-sm text-ink-slate">
              Pick one dumping-ground account (Uncategorized, Ask My Accountant) and AI suggests
              the correct target per transaction.
            </div>
          </div>
          <ChevronRight className="text-ink-slate self-center" size={20} />
        </button>
          </>
        )}
      </div>
    );
  }

  // ─────────── STEP 2: setup form ───────────
  return (
    <div className="space-y-6">
      <button
        onClick={() => { setWorkflow(null); setClientLinkId(""); }}
        className="text-sm text-ink-slate hover:text-navy"
      >
        Other reclass options (consolidate · scrub · advanced) →
      </button>

      <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
        <div className="flex items-center gap-3">
          {workflow === "consolidation" && (<><GitMerge className="text-teal" size={24} /><h2 className="text-lg font-bold text-navy">Account Consolidation</h2></>)}
          {workflow === "scrub" && (<><Sparkles className="text-teal" size={24} /><h2 className="text-lg font-bold text-navy">AI Scrub</h2></>)}
          {workflow === "full_categorization" && (<><Layers className="text-teal" size={24} /><h2 className="text-lg font-bold text-navy">Full AI Categorization</h2></>)}
        </div>

        <div>
          <label className="block text-sm font-semibold text-navy mb-2">Client</label>
          <select
            value={clientLinkId}
            onChange={(e) => setClientLinkId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
          >
            <option value="">Select a client...</option>
            {clientLinks.map((c) => (
              <option key={c.id} value={c.id}>
                {c.client_name} ({c.jurisdiction}{c.state_province ? ` · ${c.state_province}` : ""})
              </option>
            ))}
          </select>
        </div>

        {/* PY-taxes banner — surfaces the unfiled-year boundary so the
            bookkeeper knows what dates this reclass should cover. The
            date range above is auto-clamped to (year+1)-01-01 when
            taxes are filed. */}
        {selectedClient && pyFiledThroughYear && (
          <div className="flex items-start gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm">
            <Calendar size={16} className="text-emerald-700 flex-shrink-0 mt-0.5" />
            <div className="text-emerald-900">
              <strong>Taxes filed through {pyFiledThroughYear}</strong>
              <span className="text-emerald-700">
                {" "}· this reclass will start no earlier than {unfiledStartDate} to keep filed books untouched.
              </span>
            </div>
          </div>
        )}
        {selectedClient && !pyFiledThroughYear && selectedClient.py_taxes_filed === false && (
          <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
            <AlertCircle size={16} className="text-amber-700 flex-shrink-0 mt-0.5" />
            <div className="text-amber-900 flex-1">
              <strong>PY taxes flagged as not yet filed.</strong>
              <span className="text-amber-800">
                {" "}Reclass will touch any year. If a prior year IS actually filed, update the client&apos;s PY-taxes setting on the client card before continuing.
              </span>
            </div>
          </div>
        )}

        {workflow === "full_categorization" && clientLinkId && (
          <>
            {loadingPresets && (
              <div className="flex items-center gap-2 text-sm text-ink-slate">
                <Loader2 className="animate-spin" size={16} />
                Loading fiscal year from QuickBooks...
              </div>
            )}
            {presetsError && (
              <div className="flex items-start gap-2 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">
                <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                Could not load fiscal year from QBO — enter dates manually.
              </div>
            )}

            {presetsError && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-semibold text-navy mb-2">Date range start</label>
                  <input
                    type="date"
                    value={dateRangeStart}
                    onChange={(e) => setDateRangeStart(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-navy mb-2">Date range end</label>
                  <input
                    type="date"
                    value={dateRangeEnd}
                    onChange={(e) => setDateRangeEnd(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
                  />
                </div>
              </div>
            )}

            {!presetsError && datePresets.length > 0 && (
              <>
                <div>
                  <label className="flex items-center gap-1.5 text-sm font-semibold text-navy mb-2">
                    <Calendar size={14} /> Date Range
                  </label>
                  <div className="text-xs text-ink-slate mb-2">
                    Fiscal year starts in <span className="font-semibold">{fiscalYearStartMonthName}</span> (pulled from QBO)
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {datePresets.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setDatePresetId(p.id)}
                        className={`px-3 py-2.5 rounded-lg border-2 text-xs font-semibold text-left transition-colors ${
                          datePresetId === p.id
                            ? "bg-teal-lighter border-teal text-teal"
                            : "bg-white border-gray-200 hover:border-gray-300 text-navy"
                        }`}
                      >
                        <div>{p.label}</div>
                        <div className="text-[10px] text-ink-light mt-0.5 font-normal">
                          {p.start} → {p.end}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="flex items-center gap-1.5 text-sm font-semibold text-navy mb-2">
                    <DollarSign size={14} /> Auto-approve Threshold
                  </label>
                  <div className="text-xs text-ink-slate mb-2">
                    Transactions under this amount with high AI confidence are auto-approved.
                    Higher amounts always require bookkeeper review.
                  </div>
                  <div className="relative max-w-xs">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-slate text-sm">$</span>
                    <input
                      type="number"
                      min={1}
                      step={50}
                      value={threshold}
                      onChange={(e) => setThreshold(parseInt(e.target.value, 10) || 0)}
                      className="w-full pl-7 pr-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm"
                    />
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {workflow !== "full_categorization" && clientLinkId && loadingAccounts && (
          <div className="flex items-center gap-2 text-sm text-ink-slate">
            <Loader2 className="animate-spin" size={16} />
            Loading chart of accounts from QBO...
          </div>
        )}
        {workflow !== "full_categorization" && accountsError && (
          <div className="flex items-start gap-2 p-3 bg-red-50 text-red-800 rounded-lg text-sm">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            {accountsError}
          </div>
        )}

        {workflow !== "full_categorization" && accounts.length > 0 && (
          <>
            <div>
              <label className="block text-sm font-semibold text-navy mb-2">
                Source account — Categorize FROM {workflow === "scrub" ? "(all uncategorized expenses)" : ""}
              </label>
              <select
                value={sourceAccountId}
                onChange={(e) => setSourceAccountId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
              >
                <option value="">Select source account...</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.fullyQualifiedName} ({a.accountType})</option>
                ))}
              </select>
            </div>

            {workflow === "consolidation" && (
              <div>
                <label className="block text-sm font-semibold text-navy mb-2">Target account — Categorize TO</label>
                <select
                  value={targetAccountId}
                  onChange={(e) => setTargetAccountId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
                >
                  <option value="">Select target account...</option>
                  {accounts.filter((a) => a.id !== sourceAccountId).map((a) => (
                    <option key={a.id} value={a.id}>{a.fullyQualifiedName} ({a.accountType})</option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-semibold text-navy mb-2">Date range start</label>
                <input
                  type="date"
                  value={dateRangeStart}
                  onChange={(e) => setDateRangeStart(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-navy mb-2">Date range end</label>
                <input
                  type="date"
                  value={dateRangeEnd}
                  onChange={(e) => setDateRangeEnd(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
                />
              </div>
            </div>
            {dateRangeOverLimit && (
              <div className="flex items-start gap-2 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">
                <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                Date range exceeds 1 year ({daysDiff} days). Run multiple jobs.
              </div>
            )}
          </>
        )}

        {clientLinkId && workflow !== "full_categorization" && (
          <div>
            <label className="block text-sm font-semibold text-navy mb-2">Reason (appears in QBO memo + audit log)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Post-COA categorization for Q4 cleanup"
              maxLength={200}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
            />
            <div className="mt-1 text-xs text-ink-slate">Min 5 chars.</div>
          </div>
        )}

        {submitError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm">
            <div className="flex items-start gap-2 text-red-800">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
            {blockingJobId && (
              <button
                onClick={cancelBlockingJob}
                disabled={cancelling}
                className="mt-3 flex items-center gap-2 px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs font-bold disabled:opacity-60 transition-colors"
              >
                {cancelling && <Loader2 size={12} className="animate-spin" />}
                {cancelling ? "Cancelling…" : "Cancel stuck job & retry"}
              </button>
            )}
          </div>
        )}

        {/* Pre-flight warning: QBO has no reclass-eligible transactions in
            the date range. Almost always means the items are stuck in
            Banking → For Review and need to be Added to a holding account
            in QBO first. Bookkeeper can bypass with "Run anyway" if they
            know what they're doing. */}
        {preflightWarning && (
          <div className="p-4 bg-amber-50 border border-amber-300 rounded-lg space-y-2">
            <div className="flex items-start gap-2">
              <AlertCircle size={18} className="flex-shrink-0 mt-0.5 text-amber-700" />
              <div className="flex-1">
                <div className="font-bold text-amber-900 text-sm">
                  No reclass-eligible transactions found in QBO
                </div>
                <p className="text-xs text-amber-800 mt-1">
                  QBO returned <strong>0 Bills / Purchases / Expenses</strong> for{" "}
                  <strong>{selectedClient?.client_name}</strong> in this date range.
                  {preflightWarning.unsupported > 0 && (
                    <>
                      {" "}It does have{" "}
                      <strong>{preflightWarning.unsupported}</strong> transactions in
                      types reclass doesn't currently scan
                      {preflightWarning.topUnsupported.length > 0 && (
                        <> ({preflightWarning.topUnsupported.map((t) => `${t.count} ${t.type}`).join(", ")})</>
                      )}.
                    </>
                  )}
                </p>
                <div className="mt-3 text-xs text-amber-900 bg-white/60 rounded p-2 border border-amber-200">
                  <div className="font-semibold mb-1">Most likely cause:</div>
                  <p className="leading-snug">
                    Bank-fed transactions are sitting in QBO&apos;s{" "}
                    <strong>Banking → For Review</strong> tab and haven&apos;t been Added
                    yet. The QBO API can&apos;t see those — SNAP only works on
                    transactions that are already posted in QBO.
                  </p>
                  <div className="font-semibold mt-2 mb-1">Fix:</div>
                  <ol className="list-decimal ml-4 space-y-0.5">
                    <li>In QBO: <strong>Banking → For Review</strong></li>
                    <li>Select all → bulk-categorize to <strong>&quot;Ask My Accountant&quot;</strong></li>
                    <li>Come back to SNAP and re-run reclass</li>
                  </ol>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => {
                  setPreflightDismissed(true);
                  setPreflightWarning(null);
                  // Re-trigger submit now that the bypass flag is set
                  handleSubmit();
                }}
                className="text-xs font-semibold bg-amber-700 hover:bg-amber-800 text-white px-3 py-1.5 rounded-md"
              >
                Run anyway
              </button>
              <button
                onClick={() => setPreflightWarning(null)}
                className="text-xs font-semibold text-amber-900 hover:text-amber-950 px-3 py-1.5"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {clientLinkId && (
          <>
            <RedoWarning clientId={clientLinkId} kind="reclass" onAllowChange={setRedoAllowed} />
            <button
              onClick={handleSubmit}
              disabled={!canSubmit || preflightChecking || !!preflightWarning || !redoAllowed}
              className="w-full bg-teal hover:bg-teal-dark text-white font-semibold px-6 py-3 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {(submitting || preflightChecking) && <Loader2 className="animate-spin" size={18} />}
              {preflightChecking
                ? "Checking QBO transaction counts…"
                : submitting
                ? "Starting discovery..."
                : "Start Discovery"}
            </button>
            <p className="text-xs text-ink-slate text-center">
              Discovery will pull transactions, run AI classification, and prepare a review queue.
              You'll review before anything is changed in QBO.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
