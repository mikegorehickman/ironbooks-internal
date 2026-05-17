"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  Lock,
  Play,
  ArrowRight,
  Info,
  HelpCircle,
  Search,
  ChevronDown,
  Flag,
  Mail,
  Send,
  X,
} from "lucide-react";

interface ReclassJob {
  id: string;
  workflow: string;
  source_account_name: string;
  target_account_name: string | null;
  date_range_start: string;
  date_range_end: string;
  reason: string;
  attested: boolean;
  force_reconciled: boolean;
  transactions_pulled: number;
  transactions_in_scope: number;
  transactions_auto_approve: number;
  transactions_needs_review: number;
  transactions_flagged: number;
  transactions_skipped_reconciled: number;
  transactions_skipped_closed: number;
  unique_vendors_count: number;
  warnings: any;
  client_name: string;
}

interface Reclassification {
  id: string;
  qbo_transaction_id: string;
  qbo_transaction_type: string;
  line_id: string | null;
  vendor_name: string | null;
  transaction_date: string | null;
  transaction_amount: number | null;
  description: string | null;
  from_account_name: string | null;
  to_account_id: string | null;
  to_account_name: string | null;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  decision: string;
  skip_reason: string | null;
  is_reconciled: boolean;
  is_bank_fed: boolean;
  is_manual_entry: boolean;
  bookkeeper_override: boolean;
  bookkeeper_override_target_id: string | null;
  bookkeeper_override_target_name: string | null;
}

type Tab = "auto" | "review" | "flagged" | "ask_client" | "skipped";

interface MasterAccount {
  account_name: string;
  parent_account_name: string | null;
  is_parent: boolean;
  section: string | null;
  sort_order: number | null;
}

export function ReclassReview({
  job,
  rows: initialRows,
  userRole,
  masterAccounts = [],
  clientLinkId,
}: {
  job: ReclassJob;
  rows: Reclassification[];
  userRole: string;
  masterAccounts?: MasterAccount[];
  clientLinkId?: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [activeTab, setActiveTab] = useState<Tab>(
    initialRows.some((r) => r.decision === "needs_review") ? "review" : "auto"
  );
  const [attested, setAttested] = useState(job.attested);
  const [forceReconciled, setForceReconciled] = useState(job.force_reconciled);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");
  const [emailModalOpen, setEmailModalOpen] = useState(false);

  const isAdmin = userRole === "admin";
  const isLeadOrAdmin = userRole === "admin" || userRole === "lead";

  // Partition rows by tab
  const partitioned = useMemo(() => {
    const auto: Reclassification[] = [];
    const review: Reclassification[] = [];
    const flagged: Reclassification[] = [];
    const ask: Reclassification[] = [];
    const skipped: Reclassification[] = [];
    for (const r of rows) {
      if (r.decision === "auto_approve" || r.decision === "approved") auto.push(r);
      else if (r.decision === "needs_review") review.push(r);
      else if (r.decision === "flagged") flagged.push(r);
      else if (r.decision === "ask_client") ask.push(r);
      else if (r.decision === "skip" || r.decision === "rejected") skipped.push(r);
    }
    return { auto, review, flagged, ask, skipped };
  }, [rows]);

  const totalApproved = partitioned.auto.length;
  const stillNeedsAction = partitioned.review.length + partitioned.flagged.length;

  // Mutation helpers
  async function updateDecision(rowId: string, newDecision: string) {
    setRows((prev) =>
      prev.map((r) => (r.id === rowId ? { ...r, decision: newDecision } : r))
    );
    await fetch(`/api/reclass/decisions/${rowId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: newDecision }),
    });
  }

  /**
   * Normalize a vendor name so all transactions from "SHERWIN-WILLIAMS #4521"
   * and "Sherwin Williams Co" cluster together for propagation.
   */
  function normalizeVendorName(raw: string | null | undefined): string {
    return (raw || "")
      .toUpperCase()
      .replace(/^(interac\s+(purchase|retail|debit)\s*[\-:]?\s*)/i, "")
      .replace(/^(pos\s+(purchase|debit)\s*[\-:]?\s*)/i, "")
      .replace(/\bstore\s*#?\s*\d+\b/gi, "")
      .replace(/#\d+/g, "")
      .replace(/[^A-Z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Set the target account for a row + promote to "approved".
   *
   * Propagation: if other unresolved rows (needs_review / flagged / ask_client)
   * share the same normalized vendor name, they get the same target — saves the
   * bookkeeper from picking the same account 20 times for the same vendor.
   *
   * Also fires a bank-rule upsert so future runs skip categorization for this
   * vendor. Skipped for ask_client (peer payments are unique).
   */
  async function setTarget(rowId: string, targetAccountName: string) {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;

    // Find all sibling rows with the same normalized vendor that are still
    // unresolved (needs_review / flagged / ask_client). Auto-approve them too.
    const normalized = normalizeVendorName(row.vendor_name);
    const unresolvedStates = new Set(["needs_review", "flagged", "ask_client"]);
    const propagateIds = new Set<string>([rowId]);
    if (normalized) {
      for (const r of rows) {
        if (r.id === rowId) continue;
        if (!unresolvedStates.has(r.decision)) continue;
        if (normalizeVendorName(r.vendor_name) === normalized) {
          propagateIds.add(r.id);
        }
      }
    }

    // Optimistic local update for all affected rows
    setRows((prev) =>
      prev.map((r) =>
        propagateIds.has(r.id)
          ? {
              ...r,
              bookkeeper_override: true,
              bookkeeper_override_target_name: targetAccountName,
              to_account_name: targetAccountName,
              decision: "approved",
            }
          : r
      )
    );

    // Persist each row update
    await Promise.all(
      Array.from(propagateIds).map((id) =>
        fetch(`/api/reclass/decisions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision: "approved",
            bookkeeper_override_target_name: targetAccountName,
          }),
        })
      )
    );

    // Save as bank rule once for this vendor — covers all current AND future
    // transactions. Skipped for ask_client / unknown-vendor rows.
    if (
      clientLinkId &&
      row.decision !== "ask_client" &&
      row.vendor_name &&
      row.vendor_name.toLowerCase() !== "unknown vendor"
    ) {
      fetch(`/api/bank-rules/upsert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          vendor_pattern: row.vendor_name,
          target_account_name: targetAccountName,
        }),
      }).catch((e) => console.warn("Bank rule upsert failed:", e));
    }
  }

  async function bulkApprove(rowIds: string[]) {
    setRows((prev) =>
      prev.map((r) => (rowIds.includes(r.id) ? { ...r, decision: "approved" } : r))
    );
    await Promise.all(
      rowIds.map((id) =>
        fetch(`/api/reclass/decisions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "approved" }),
        })
      )
    );
  }

  async function toggleAttestation() {
    const next = !attested;
    setAttested(next);
    await fetch(`/api/reclass/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attested: next }),
    });
  }

  async function toggleForceReconciled() {
    if (!isAdmin) return;
    const next = !forceReconciled;
    setForceReconciled(next);
    const res = await fetch(`/api/reclass/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force_reconciled: next }),
    });
    if (res.ok) router.refresh();
  }

  async function handleExecute() {
    if (!attested) {
      setError("You must attest before executing");
      return;
    }
    if (stillNeedsAction > 0) {
      const proceed = confirm(
        `${stillNeedsAction} transactions still need review or are flagged. They will NOT be executed. Continue with the ${totalApproved} approved transactions?`
      );
      if (!proceed) return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/reclass/${job.id}/execute`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Execute failed");
      router.push(`/reclass/${job.id}/execute`);
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 max-w-7xl">
      {/* Summary header */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-ink-slate mb-1">Scope</div>
            <div className="text-lg font-bold text-navy">
              {job.source_account_name}
              {job.target_account_name && (
                <>
                  <ArrowRight className="inline mx-2 text-teal" size={18} />
                  {job.target_account_name}
                </>
              )}
            </div>
            <div className="text-sm text-ink-slate mt-1">
              {job.date_range_start} → {job.date_range_end} · "{job.reason}"
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-center">
          <StatCard label="Pulled" value={job.transactions_pulled} />
          <StatCard label="In scope" value={job.transactions_in_scope} accent="navy" />
          <StatCard label="Auto-approve" value={partitioned.auto.length} accent="green" />
          <StatCard label="Need review" value={partitioned.review.length} accent="amber" />
          <StatCard label="Flagged" value={partitioned.flagged.length} accent="red" />
        </div>

        {(job.transactions_skipped_reconciled > 0 ||
          job.transactions_skipped_closed > 0) && (
          <div className="mt-4 p-3 bg-gray-50 rounded-lg text-sm text-ink-slate flex items-start gap-2">
            <Info size={16} className="flex-shrink-0 mt-0.5" />
            <div>
              Skipped: {job.transactions_skipped_reconciled} reconciled,{" "}
              {job.transactions_skipped_closed} in closed periods.
              {isAdmin && job.transactions_skipped_reconciled > 0 && (
                <>
                  {" "}
                  As admin, you can{" "}
                  <button
                    onClick={toggleForceReconciled}
                    className="underline text-teal hover:text-teal-dark"
                  >
                    {forceReconciled ? "disable" : "enable"} force_reconciled
                  </button>{" "}
                  to include reconciled transactions.
                </>
              )}
            </div>
          </div>
        )}

        {job.warnings && Array.isArray(job.warnings) && job.warnings.length > 0 && (
          <div className="mt-3 p-3 bg-amber-50 rounded-lg text-sm text-amber-800">
            <div className="font-semibold mb-1">AI warnings:</div>
            <ul className="list-disc pl-5 space-y-0.5">
              {(job.warnings as string[]).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        <TabButton
          active={activeTab === "auto"}
          onClick={() => setActiveTab("auto")}
          icon={<CheckCircle2 size={16} className="text-emerald-600" />}
          label="Auto-approve"
          count={partitioned.auto.length}
        />
        <TabButton
          active={activeTab === "review"}
          onClick={() => setActiveTab("review")}
          icon={<AlertTriangle size={16} className="text-amber-600" />}
          label="Needs review"
          count={partitioned.review.length}
        />
        <TabButton
          active={activeTab === "flagged"}
          onClick={() => setActiveTab("flagged")}
          icon={<XCircle size={16} className="text-red-600" />}
          label="Flagged"
          count={partitioned.flagged.length}
        />
        <TabButton
          active={activeTab === "ask_client"}
          onClick={() => setActiveTab("ask_client")}
          icon={<HelpCircle size={16} className="text-purple-600" />}
          label="Ask Client"
          count={partitioned.ask.length}
        />
        <TabButton
          active={activeTab === "skipped"}
          onClick={() => setActiveTab("skipped")}
          icon={<Lock size={16} className="text-ink-slate" />}
          label="Skipped"
          count={partitioned.skipped.length}
        />
      </div>

      {/* Tab content */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {activeTab === "auto" && (
          <>
            {partitioned.auto.length > 0 && (
              <div className="p-3 bg-green-50 border-b border-green-100 text-sm text-green-800">
                <CheckCircle2 size={14} className="inline mr-1" />
                Auto-approved — these will execute as shown. Use the dropdown if you want to override any.
              </div>
            )}
            <RowTable
              rows={partitioned.auto}
              showConfidence={true}
              showActions={true}
              showApproveReject={false}
              masterAccounts={masterAccounts}
              onTargetChange={setTarget}
            />
          </>
        )}

        {activeTab === "review" && (
          <>
            {partitioned.review.length > 0 && (
              <div className="p-3 bg-amber-50 border-b border-amber-100 flex items-center justify-between">
                <span className="text-sm text-amber-800">
                  AI confidence 70-91%. Pick the right account from the dropdown — selection applies to all matching-vendor transactions automatically.
                </span>
                <button
                  onClick={() => bulkApprove(partitioned.review.map((r) => r.id))}
                  className="text-sm bg-amber-600 text-white px-3 py-1.5 rounded-lg hover:bg-amber-700"
                >
                  Approve all AI picks
                </button>
              </div>
            )}
            <RowTable
              rows={partitioned.review}
              showConfidence={true}
              showActions={true}
              showApproveReject={false}
              masterAccounts={masterAccounts}
              onTargetChange={setTarget}
            />
          </>
        )}

        {activeTab === "flagged" && (
          <>
            {partitioned.flagged.length > 0 && (
              <div className="p-3 bg-red-50 border-b border-red-100 text-sm text-red-800">
                AI couldn't confidently match these. Pick the right account from the dropdown — selection auto-applies to all matching-vendor transactions.
              </div>
            )}
            <RowTable
              rows={partitioned.flagged}
              showConfidence={true}
              showActions={true}
              showApproveReject={false}
              masterAccounts={masterAccounts}
              onTargetChange={setTarget}
            />
          </>
        )}

        {activeTab === "ask_client" && (
          <>
            {partitioned.ask.length > 0 && (
              <div className="p-3 bg-purple-50 border-b border-purple-100 flex items-center justify-between gap-3">
                <span className="text-sm text-purple-800">
                  <HelpCircle size={14} className="inline mr-1" />
                  E-transfers / Venmo / Zelle — confirm with the client what each was for, then pick
                  the right account from the dropdown.
                </span>
                <button
                  onClick={() => setEmailModalOpen(true)}
                  className="inline-flex items-center gap-1.5 text-sm bg-purple-600 text-white px-3 py-1.5 rounded-lg hover:bg-purple-700 flex-shrink-0"
                >
                  <Mail size={14} />
                  Draft Email to Client ({partitioned.ask.length})
                </button>
              </div>
            )}
            <RowTable
              rows={partitioned.ask}
              showConfidence={false}
              showActions={true}
              showApproveReject={false}
              masterAccounts={masterAccounts}
              onTargetChange={setTarget}
            />
          </>
        )}

        {activeTab === "skipped" && (
          <RowTable rows={partitioned.skipped} showConfidence={false} showActions={false} showSkipReason />
        )}
      </div>

      {/* Attestation + Execute */}
      <div className="bg-white rounded-2xl border-2 border-teal/20 p-6">
        <h3 className="font-bold text-navy mb-3">Attestation</h3>
        <label className="flex items-start gap-3 cursor-pointer mb-4">
          <input
            type="checkbox"
            checked={attested}
            onChange={toggleAttestation}
            className="mt-1 w-5 h-5 rounded border-2 border-gray-300 text-teal focus:ring-teal"
          />
          <div className="text-sm text-navy">
            I have reviewed the {totalApproved} approved transactions and confirm they should be
            reclassified in QBO. I understand this will modify production accounting data and that
            rollback is available but is a last resort.
          </div>
        </label>

        {error && (
          <div className="mb-3 p-3 bg-red-50 text-red-800 rounded-lg text-sm">{error}</div>
        )}

        <button
          onClick={handleExecute}
          disabled={!attested || submitting || totalApproved === 0}
          className="w-full bg-teal hover:bg-teal-dark text-white font-semibold px-6 py-3 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {submitting ? (
            <Loader2 className="animate-spin" size={18} />
          ) : (
            <Play size={18} />
          )}
          Execute {totalApproved} reclassifications in QBO
        </button>
        <p className="text-xs text-ink-slate text-center mt-2">
          Skipped, flagged, and rejected transactions will NOT be executed.
        </p>
      </div>

      {/* Email Client Modal */}
      {emailModalOpen && (
        <ClientEmailModal
          jobId={job.id}
          clientName={(job as any).client_name || "Client"}
          dateStart={job.date_range_start}
          dateEnd={job.date_range_end}
          rows={partitioned.ask}
          onClose={() => setEmailModalOpen(false)}
        />
      )}
    </div>
  );
}

// ============== Components ==============

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "navy" | "green" | "amber" | "red";
}) {
  const colors = {
    navy: "text-navy",
    green: "text-emerald-600",
    amber: "text-amber-600",
    red: "text-red-600",
  };
  return (
    <div className="p-3 bg-gray-50 rounded-lg">
      <div className={`text-2xl font-bold ${accent ? colors[accent] : "text-navy"}`}>{value}</div>
      <div className="text-xs text-ink-slate uppercase tracking-wide">{label}</div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
        active
          ? "border-teal text-navy"
          : "border-transparent text-ink-slate hover:text-navy"
      }`}
    >
      {icon}
      {label}
      <span
        className={`rounded-full px-2 py-0.5 text-xs ${
          active ? "bg-teal text-white" : "bg-gray-100 text-ink-slate"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function RowTable({
  rows,
  showConfidence,
  showActions,
  showSkipReason,
  showApproveReject = true,
  masterAccounts = [],
  onTargetChange,
  onApprove,
  onReject,
}: {
  rows: Reclassification[];
  showConfidence: boolean;
  showActions: boolean;
  showSkipReason?: boolean;
  /** Whether to render the Approve/Reject column. The Map-to-Master dropdown is
   *  still shown when showActions is true regardless. Defaults to true. */
  showApproveReject?: boolean;
  masterAccounts?: MasterAccount[];
  onTargetChange?: (rowId: string, accountName: string) => void;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
}) {
  if (rows.length === 0) {
    return <div className="p-8 text-center text-ink-slate text-sm">No transactions in this category.</div>;
  }

  const showDropdown = showActions && masterAccounts.length > 0;
  const showActionsCol = showActions && showApproveReject;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Date</th>
            <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Vendor</th>
            <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Amount</th>
            <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">→ AI Target</th>
            {showDropdown && (
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Map to Master</th>
            )}
            {showConfidence && (
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Confidence</th>
            )}
            {showSkipReason && (
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Skip reason</th>
            )}
            {showActionsCol && (
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Actions</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((r) => (
            <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-4 py-2.5 text-ink-slate align-top">{r.transaction_date}</td>
              <td className="px-4 py-2.5 align-top">
                <div className="font-medium text-navy">{r.vendor_name}</div>
                {r.description && (
                  <div className="text-xs text-ink-slate truncate max-w-xs">{r.description}</div>
                )}
                <div className="flex gap-1.5 mt-0.5">
                  {r.is_reconciled && (
                    <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded">
                      reconciled
                    </span>
                  )}
                  {r.is_bank_fed && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                      bank-fed
                    </span>
                  )}
                  {r.is_manual_entry && (
                    <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                      manual
                    </span>
                  )}
                </div>
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-navy align-top">
                ${(r.transaction_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
              <td className="px-4 py-2.5 align-top">
                <div className="text-navy">
                  {r.bookkeeper_override
                    ? r.bookkeeper_override_target_name
                    : r.to_account_name || <span className="text-ink-slate italic">no target</span>}
                </div>
                {r.ai_reasoning && (
                  <div className="text-xs text-ink-slate italic">{r.ai_reasoning}</div>
                )}
              </td>
              {showDropdown && (
                <td className="px-4 py-2.5 align-top">
                  <MasterAccountSelect
                    value={r.bookkeeper_override_target_name || r.to_account_name || ""}
                    masterAccounts={masterAccounts}
                    onChange={(name) => onTargetChange?.(r.id, name)}
                  />
                </td>
              )}
              {showConfidence && (
                <td className="px-4 py-2.5">
                  {r.ai_confidence !== null ? (
                    <ConfidenceBadge value={r.ai_confidence} />
                  ) : (
                    <span className="text-xs text-ink-slate">—</span>
                  )}
                </td>
              )}
              {showSkipReason && (
                <td className="px-4 py-2.5">
                  <span className="text-xs bg-gray-100 text-ink-slate px-1.5 py-0.5 rounded">
                    {r.skip_reason || r.decision}
                  </span>
                </td>
              )}
              {showActionsCol && (
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => onApprove?.(r.id)}
                      className="text-xs px-2 py-1 bg-emerald-100 text-emerald-700 rounded hover:bg-emerald-200"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => onReject?.(r.id)}
                      className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200"
                    >
                      Reject
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 200 && (
        <div className="p-3 bg-gray-50 text-center text-xs text-ink-slate border-t border-gray-100">
          Showing first 200 of {rows.length} rows.
        </div>
      )}
    </div>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  let cls = "bg-emerald-100 text-emerald-700";
  if (value < 0.7) cls = "bg-red-100 text-red-700";
  else if (value < 0.95) cls = "bg-amber-100 text-amber-700";
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${cls}`}>{pct}%</span>
  );
}

// Searchable master-account dropdown for reclass review.
function MasterAccountSelect({
  value,
  masterAccounts,
  onChange,
}: {
  value: string;
  masterAccounts: MasterAccount[];
  onChange: (val: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = masterAccounts.filter(
    (m) =>
      m.account_name.toLowerCase().includes(search.toLowerCase()) ||
      (m.parent_account_name || "").toLowerCase().includes(search.toLowerCase()) ||
      (m.section || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full max-w-[230px] flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border bg-white hover:bg-gray-50 text-left"
        style={{ borderColor: value ? "#2D7A75" : "#D1D5DB", color: value ? "#0F1F2E" : "#9CA3AF" }}
      >
        <span className="flex-1 truncate">{value || "Select account…"}</span>
        <ChevronDown size={12} className="flex-shrink-0 text-ink-light" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setOpen(false); setSearch(""); }} />
          <div className="absolute left-0 top-full mt-1 z-20 w-72 rounded-lg shadow-xl bg-white border border-gray-200 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
              <Search size={13} className="text-ink-light flex-shrink-0" />
              <input
                autoFocus
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search accounts..."
                className="flex-1 text-xs outline-none bg-transparent text-navy placeholder:text-ink-light"
              />
            </div>
            <div className="max-h-72 overflow-y-auto">
              {/* Pinned Uncategorized option */}
              {!search && (
                <button
                  onClick={() => { onChange("Uncategorized"); setOpen(false); setSearch(""); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-amber-50 transition-colors text-amber-700 border-b border-gray-100"
                >
                  <span className="flex items-center gap-1.5">
                    <Flag size={11} /> Uncategorized — flag for senior review
                  </span>
                </button>
              )}
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-xs text-center text-ink-slate">No matches</div>
              ) : (
                filtered.map((m) => (
                  <button
                    key={m.account_name}
                    onClick={() => { onChange(m.account_name); setOpen(false); setSearch(""); }}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-teal-lighter transition-colors ${
                      value === m.account_name ? "font-semibold text-teal bg-teal-lighter" : "text-navy"
                    }`}
                  >
                    <span>{m.account_name}</span>
                    {m.parent_account_name && (
                      <span className="ml-1.5 text-ink-light">· {m.parent_account_name}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─────────── Client Email Modal ───────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface TxnRow {
  date: string;
  vendor: string;
  amount: number;
}

function buildTxnRows(rows: Reclassification[]): TxnRow[] {
  return rows
    .map((r) => ({
      date: r.transaction_date || "",
      vendor: (r.vendor_name || "Unknown").trim(),
      amount: Math.abs(Number(r.transaction_amount || 0)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const fmtMoney = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function ClientEmailModal({
  jobId,
  clientName,
  dateStart,
  dateEnd,
  rows,
  onClose,
}: {
  jobId: string;
  clientName: string;
  dateStart: string;
  dateEnd: string;
  rows: Reclassification[];
  onClose: () => void;
}) {
  void jobId; // legacy prop, no longer used
  const txns = useMemo(() => buildTxnRows(rows), [rows]);
  const periodLabel = `${dateStart} → ${dateEnd}`;

  const defaultIntro = useMemo(
    () =>
      `Hi ${clientName.split(" ")[0] || "there"},\n\nWhile cleaning up your books for the period ${periodLabel}, we found ${rows.length} transaction${rows.length === 1 ? "" : "s"} we have questions about. Most look like e-transfers, Venmo, or peer payments without a clear vendor.\n\nPlease fill in the "What was this for?" column in the table below so we can categorize them correctly:`,
    [clientName, periodLabel, rows.length]
  );
  const defaultOutro = `Please reply within 48 hours so we can complete your books.\n\nKindly,\nIronbooks`;

  const [subject, setSubject] = useState<string>(
    `Quick question on ${rows.length} transaction${rows.length === 1 ? "" : "s"} — ${clientName}`
  );
  const [intro, setIntro] = useState<string>(defaultIntro);
  const [outro, setOutro] = useState<string>(defaultOutro);
  const [copied, setCopied] = useState<"subject" | "body" | null>(null);
  const [copyError, setCopyError] = useState<string>("");

  // Build the HTML the bookkeeper pastes into Double's rich-text editor.
  // Branded with the Ironbooks palette (teal + navy + slate). Most rich-text
  // editors handle <table> + inline styles well, including Double's portal.
  const html = useMemo(() => {
    const BRAND = {
      teal: "#2D7A75",
      tealDark: "#1F5D58",
      tealLight: "#E8F2F0",
      tealLighter: "#F4F9F8",
      navy: "#0F1F2E",
      slate: "#475569",
      lightSlate: "#94A3B8",
      border: "#CBD5E1",
      white: "#FFFFFF",
    };
    const introHtml = intro
      .split("\n\n")
      .map((p) => `<p style="margin:0 0 12px 0;color:${BRAND.navy};line-height:1.55;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
    const outroHtml = outro
      .split("\n\n")
      .map((p) => `<p style="margin:0 0 12px 0;color:${BRAND.navy};line-height:1.55;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
    const tableRows = txns
      .map(
        (t, i) => {
          const bg = i % 2 === 0 ? BRAND.white : BRAND.tealLighter;
          return `
        <tr style="background:${bg};">
          <td style="border:1px solid ${BRAND.border};padding:8px 12px;color:${BRAND.slate};font-variant-numeric:tabular-nums;">${escapeHtml(t.date)}</td>
          <td style="border:1px solid ${BRAND.border};padding:8px 12px;color:${BRAND.navy};font-weight:500;">${escapeHtml(t.vendor)}</td>
          <td style="border:1px solid ${BRAND.border};padding:8px 12px;text-align:right;color:${BRAND.navy};font-weight:600;font-variant-numeric:tabular-nums;">$${fmtMoney(t.amount)}</td>
          <td style="border:1px solid ${BRAND.border};padding:8px 12px;background:${BRAND.white};">&nbsp;</td>
        </tr>`;
        }
      )
      .join("");

    return `<div style="font-family:'Figtree','Helvetica Neue',Helvetica,Arial,sans-serif;color:${BRAND.navy};max-width:720px;margin:0 auto;background:${BRAND.white};">
  <!-- Brand header bar -->
  <div style="background:${BRAND.navy};color:${BRAND.white};padding:18px 22px;border-radius:10px 10px 0 0;display:flex;align-items:center;">
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="background:${BRAND.teal};color:${BRAND.white};font-weight:700;font-size:16px;width:38px;height:38px;text-align:center;border-radius:8px;font-family:'Figtree','Helvetica Neue',sans-serif;">IB</td>
        <td style="padding-left:12px;color:${BRAND.white};">
          <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;line-height:1.1;">Ironbooks</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.6);margin-top:2px;letter-spacing:0.06em;text-transform:uppercase;">Bookkeeping &middot; Cleanup</div>
        </td>
      </tr>
    </table>
  </div>

  <!-- Body -->
  <div style="border:1px solid ${BRAND.border};border-top:none;padding:24px 22px;border-radius:0 0 10px 10px;background:${BRAND.white};">
    ${introHtml}

    <!-- Branded transaction table -->
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid ${BRAND.border};font-family:'Figtree','Helvetica Neue',sans-serif;font-size:13px;margin:8px 0 18px 0;">
      <thead>
        <tr style="background:${BRAND.teal};">
          <th style="border:1px solid ${BRAND.tealDark};padding:10px 12px;text-align:left;color:${BRAND.white};font-weight:600;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;">Date</th>
          <th style="border:1px solid ${BRAND.tealDark};padding:10px 12px;text-align:left;color:${BRAND.white};font-weight:600;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;">Sender / Vendor</th>
          <th style="border:1px solid ${BRAND.tealDark};padding:10px 12px;text-align:right;color:${BRAND.white};font-weight:600;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;">Amount</th>
          <th style="border:1px solid ${BRAND.tealDark};padding:10px 12px;text-align:left;color:${BRAND.white};font-weight:600;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;">What was this for?</th>
        </tr>
      </thead>
      <tbody>${tableRows}
      </tbody>
    </table>

    ${outroHtml}

    <!-- Branded signature divider -->
    <div style="border-top:2px solid ${BRAND.teal};margin:24px 0 12px 0;width:60px;"></div>
    <div style="color:${BRAND.lightSlate};font-size:11px;line-height:1.5;">
      This message was prepared with <span style="color:${BRAND.teal};font-weight:600;">Ironbooks</span> as part of your bookkeeping cleanup. Reply directly to this email with your answers in the table above.
    </div>
  </div>
</div>`;
  }, [intro, outro, txns]);

  // Plain-text fallback for paste destinations that don't take HTML
  const plainText = useMemo(() => {
    const widths = { date: 12, vendor: 28, amount: 12, note: 28 };
    const pad = (s: string, n: number) => s.length >= n ? s : s + " ".repeat(n - s.length);
    const padR = (s: string, n: number) => s.length >= n ? s : " ".repeat(n - s.length) + s;
    const header =
      pad("Date", widths.date) + " | " +
      pad("Sender", widths.vendor) + " | " +
      padR("Amount", widths.amount) + " | What was this for?";
    const sep = "-".repeat(header.length);
    const lines = txns.map((t) =>
      pad(t.date, widths.date) + " | " +
      pad((t.vendor || "").slice(0, widths.vendor), widths.vendor) + " | " +
      padR("$" + fmtMoney(t.amount), widths.amount) + " | "
    );
    return `${intro}\n\n${header}\n${sep}\n${lines.join("\n")}\n\n${outro}`;
  }, [intro, outro, txns]);

  async function copySubject() {
    try {
      await navigator.clipboard.writeText(subject);
      setCopied("subject");
      setCopyError("");
      setTimeout(() => setCopied(null), 2000);
    } catch (err: any) {
      setCopyError(err?.message || "Could not access clipboard");
    }
  }

  async function copyBody() {
    setCopyError("");
    // Body only — most email tools have a separate Subject field; pasting the subject
    // inside the body would be noise. Keep the "Copy subject" button for that field.
    try {
      if (typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plainText], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(plainText);
      }
      setCopied("body");
      setTimeout(() => setCopied(null), 2500);
    } catch (err: any) {
      try {
        await navigator.clipboard.writeText(plainText);
        setCopied("body");
        setTimeout(() => setCopied(null), 2500);
      } catch (err2: any) {
        setCopyError(err2?.message || "Could not access clipboard");
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-navy flex items-center gap-2">
              <Mail size={18} className="text-purple-600" />
              Email to {clientName}
            </h3>
            <p className="text-xs text-ink-slate mt-1">
              {rows.length} transaction{rows.length === 1 ? "" : "s"}. Edit the message, then copy & paste into the Double client portal to send.
            </p>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy">
            <X size={20} />
          </button>
        </div>

        {/* Instructions strip */}
        <div className="px-6 py-3 bg-purple-50 border-b border-purple-100 text-xs text-purple-900">
          <strong>How to send:</strong> Click "Copy Email" → open the Double client portal for {clientName} → paste into a new email → send. The table will render as a proper HTML table so the client can fill in the right column directly in their reply.
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
          {/* Subject */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold uppercase tracking-wider text-ink-slate">
                Subject
              </label>
              <button
                onClick={copySubject}
                className="inline-flex items-center gap-1 text-xs font-semibold text-purple-700 hover:text-purple-900"
              >
                {copied === "subject" ? <CheckCircle2 size={12} /> : <Send size={12} />}
                {copied === "subject" ? "Copied" : "Copy subject"}
              </button>
            </div>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
            />
          </div>

          {/* Intro */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
              Intro
            </label>
            <textarea
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy leading-relaxed"
            />
          </div>

          {/* Branded table preview — matches what the client will see */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
              Transaction Table Preview ({txns.length} rows)
            </label>
            <div className="rounded-lg border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto max-h-72">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr style={{ background: "#2D7A75" }}>
                      <th className="text-left px-3 py-2 text-white font-semibold uppercase tracking-wider text-[10px]">Date</th>
                      <th className="text-left px-3 py-2 text-white font-semibold uppercase tracking-wider text-[10px]">Sender / Vendor</th>
                      <th className="text-right px-3 py-2 text-white font-semibold uppercase tracking-wider text-[10px]">Amount</th>
                      <th className="text-left px-3 py-2 text-white font-semibold uppercase tracking-wider text-[10px]">What was this for?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {txns.map((t, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? "#FFFFFF" : "#F4F9F8" }}>
                        <td className="px-3 py-1.5 text-ink-slate border border-gray-200">{t.date}</td>
                        <td className="px-3 py-1.5 text-navy border border-gray-200 font-medium">{t.vendor}</td>
                        <td className="px-3 py-1.5 text-right font-semibold text-navy border border-gray-200">${fmtMoney(t.amount)}</td>
                        <td className="px-3 py-1.5 text-ink-light italic border border-gray-200">(client fills in)</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="text-[11px] text-ink-light mt-1.5">
              When copied, the email gets a branded Ironbooks header bar, this teal-styled table, and a brand-line footer.
            </p>
          </div>

          {/* Outro */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
              Closing
            </label>
            <textarea
              value={outro}
              onChange={(e) => setOutro(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy leading-relaxed"
            />
          </div>

          {copyError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              {copyError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between gap-3">
          <button
            onClick={onClose}
            className="text-sm font-semibold text-ink-slate hover:text-navy"
          >
            Close
          </button>
          <div className="flex items-center gap-2">
            {copied === "body" && (
              <span className="text-xs text-green-700 font-semibold flex items-center gap-1">
                <CheckCircle2 size={12} /> Copied — paste into Double now
              </span>
            )}
            <button
              onClick={copyBody}
              className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            >
              {copied === "body" ? <CheckCircle2 size={14} /> : <Send size={14} />}
              {copied === "body" ? "Copied! Paste into Double" : "Copy Email Body + Table"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
