"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Loader2, AlertCircle, Sparkles, GitMerge, ChevronRight, Layers,
  Calendar, DollarSign,
} from "lucide-react";

interface ClientLink {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  qbo_realm_id: string;
  double_client_id: string | null;
  double_client_name: string | null;
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

  const [workflow, setWorkflow] = useState<Workflow>(null);
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
        const def = data.date_range_presets.find((p: DateRangePreset) => p.id === "fy")
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

  async function handleSubmit() {
    if (!canSubmit || !selectedClient) return;
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
      if (!res.ok) throw new Error(data.error || "Failed to start job");
      router.push(`/reclass/${data.job_id}/review`);
    } catch (e: any) {
      setSubmitError(e.message);
      setSubmitting(false);
    }
  }

  // ─────────── STEP 1: Workflow picker ───────────
  if (!workflow) {
    return (
      <div className="space-y-4">
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
        ← Change workflow
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

        {workflow === "full_categorization" && clientLinkId && (
          <>
            {loadingPresets && (
              <div className="flex items-center gap-2 text-sm text-ink-slate">
                <Loader2 className="animate-spin" size={16} />
                Loading fiscal year from QuickBooks...
              </div>
            )}
            {presetsError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 text-red-800 rounded-lg text-sm">
                <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                {presetsError}
              </div>
            )}

            {datePresets.length > 0 && (
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
                Source account {workflow === "scrub" ? "(the dumping ground to scrub)" : "(the account to move FROM)"}
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
                <label className="block text-sm font-semibold text-navy mb-2">Target account (the account to move TO)</label>
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
          <div className="flex items-start gap-2 p-3 bg-red-50 text-red-800 rounded-lg text-sm">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            {submitError}
          </div>
        )}

        {clientLinkId && (
          <>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full bg-teal hover:bg-teal-dark text-white font-semibold px-6 py-3 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="animate-spin" size={18} />}
              {submitting ? "Starting discovery..." : "Start Discovery"}
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
