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
  RefreshCw,
  SkipForward,
} from "lucide-react";
import { PayrollDoubleCard } from "@/components/PayrollDoubleCard";

interface ReclassJob {
  id: string;
  status: string;
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
  bank_account_name?: string | null;
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
  // Client's answer from the portal Categorize page (migration 67)
  client_response_account?: string | null;
  client_response_note?: string | null;
  client_responded_at?: string | null;
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

  // Capture the ORIGINAL decision per row at mount-time. Tab partitioning uses
  // this snapshot — so a row that started in "Needs Review" stays visible there
  // even after the bookkeeper approves it (it gets a "✓ Moved" badge instead of
  // vanishing). The Auto-Approved tab still surfaces it via the current decision,
  // so the row appears in BOTH places: confirmation in the original tab + active
  // execution row in auto-approved.
  const [originalDecisions] = useState(
    () => new Map(initialRows.map((r) => [r.id, r.decision]))
  );
  // Source-account filter (JP workflow: clear one bank/card at a time).
  const [accountFilter, setAccountFilter] = useState<string>("");
  const [activeTab, setActiveTab] = useState<Tab>(
    initialRows.some((r) => r.decision === "needs_review") ? "review" : "auto"
  );
  const [attested, setAttested] = useState(job.attested);
  const [forceReconciled, setForceReconciled] = useState(job.force_reconciled);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [reExecuting, setReExecuting] = useState(false);
  const [reExecuteError, setReExecuteError] = useState("");

  const isAdmin = userRole === "admin";
  const isLeadOrAdmin = userRole === "admin" || userRole === "lead";

  // Partition rows by tab. The rules:
  //
  // - Auto-Approved: any row whose CURRENT decision is auto_approve/approved.
  // - Skipped:       any row whose CURRENT decision is skip/rejected.
  // - Needs Review:  rows currently in needs_review, PLUS rows whose ORIGINAL
  //                  decision was needs_review and are now approved (shown
  //                  with a "Moved to Auto-Approved" badge so the bookkeeper
  //                  doesn't get disoriented by rows vanishing on approve).
  // - Flagged:       same rule, for flagged origin.
  // - Ask Client:    ONLY rows whose CURRENT decision is ask_client. Moving
  //                  to/from ask_client is a deliberate workflow gesture —
  //                  rows should leave the tab the moment the bookkeeper
  //                  picks a category (which flips them to approved) or
  //                  reclassifies them. This keeps the email template clean.
  const partitioned = useMemo(() => {
    const source = accountFilter
      ? rows.filter((r) => (r.bank_account_name || "") === accountFilter)
      : rows;
    const auto: Reclassification[] = [];
    const review: Reclassification[] = [];
    const flagged: Reclassification[] = [];
    const ask: Reclassification[] = [];
    const skipped: Reclassification[] = [];

    for (const r of source) {
      const isApprovedNow = r.decision === "auto_approve" || r.decision === "approved";
      if (isApprovedNow) auto.push(r);
      if (r.decision === "skip" || r.decision === "rejected") skipped.push(r);

      const orig = originalDecisions.get(r.id) || r.decision;

      // Needs Review: current OR (originally + now approved for the badge)
      if (r.decision === "needs_review") {
        review.push(r);
      } else if (orig === "needs_review" && isApprovedNow) {
        review.push(r);
      }

      // Flagged: current OR (originally + now approved)
      if (r.decision === "flagged") {
        flagged.push(r);
      } else if (orig === "flagged" && isApprovedNow) {
        flagged.push(r);
      }

      // Ask Client: ONLY current decision. No badge persistence — rows leave
      // immediately when the bookkeeper picks a category or moves them.
      if (r.decision === "ask_client") {
        ask.push(r);
      }
    }

    return { auto, review, flagged, ask, skipped };
  }, [rows, originalDecisions, accountFilter]);

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
   * Set the target account for a row + promote to "approved".
   *
   * Propagation: when the bookkeeper picks an account for one row, the same
   * target is applied to all OTHER unresolved rows (needs_review / flagged /
   * ask_client) whose "effective sender" matches. The effective sender uses
   * vendor_name when meaningful, otherwise extracts from description — so a
   * batch of 15 "Unknown vendor" rows with "Josh Smith" in the description
   * cluster together and all get updated when the bookkeeper picks one.
   *
   * Also fires a bank-rule upsert so future runs skip categorization for this
   * vendor. Skipped for ask_client (peer payments are too unique to memoize).
   */
  async function setTarget(rowId: string, targetAccountName: string) {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;

    // Extract the effective sender (digs into description when vendor_name is
    // generic), then normalize for dedup matching.
    const effectiveSender = extractSender(row.vendor_name, row.description, (row as any).original_memo);
    const normalized = normalizeSender(effectiveSender);

    // "Uncategorized" is the explicit ESCALATION choice — the bookkeeper is
    // saying "I can't place this, a senior needs to look." It becomes a
    // human-flagged row (decision=flagged + bookkeeper_override=true) — NOT an
    // approved reclass to a meaningless target, and never a bank rule.
    const isEscalation = targetAccountName === "Uncategorized";

    // Vendor cascade: apply this choice to every other row with the same sender
    // (matched by vendor, regardless of amount). For a normal category we only
    // touch UNRESOLVED rows so we don't stomp a category already set. For an
    // escalation we touch ALL of that vendor's rows — including ones already
    // auto-approved — because if one transaction from a vendor needs senior
    // eyes, every transaction from that vendor does too.
    const matchStates = isEscalation
      ? new Set(["needs_review", "flagged", "ask_client", "auto_approve", "approved"])
      : new Set(["needs_review", "flagged", "ask_client"]);
    const propagateIds = new Set<string>([rowId]);
    if (normalized) {
      for (const r of rows) {
        if (r.id === rowId) continue;
        if (!matchStates.has(r.decision)) continue;
        const rSender = extractSender(r.vendor_name, r.description, (r as any).original_memo);
        if (normalizeSender(rSender) === normalized) {
          propagateIds.add(r.id);
        }
      }
    }

    const newDecision = isEscalation ? "flagged" : "approved";

    // Optimistic local update for all affected rows
    setRows((prev) =>
      prev.map((r) =>
        propagateIds.has(r.id)
          ? {
              ...r,
              bookkeeper_override: true,
              bookkeeper_override_target_name: targetAccountName,
              to_account_name: targetAccountName,
              decision: newDecision,
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
            decision: newDecision,
            bookkeeper_override_target_name: targetAccountName,
          }),
        })
      )
    );

    // Save as bank rule once for this vendor — covers all current AND future
    // transactions. Skipped for ask_client / unknown-vendor / escalated rows.
    if (
      !isEscalation &&
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
    // Only approve rows that actually have a target account. Approving a
    // row with no destination causes the executor to skip it — better to
    // surface that up-front so the bookkeeper sees the missing assignment
    // before executing.
    const eligible: string[] = [];
    const blocked: string[] = [];
    for (const id of rowIds) {
      const row = rows.find((r) => r.id === id);
      if (!row) continue;
      // A row has a target if any of: explicit override ID, override name (resolved
      // at execute time), AI-assigned ID, or AI-assigned name.
      const hasTarget =
        !!row.bookkeeper_override_target_id ||
        !!(row.bookkeeper_override_target_name && row.bookkeeper_override_target_name !== "") ||
        (!!row.to_account_id && row.to_account_id !== "") ||
        !!(row.to_account_name && row.to_account_name !== "");
      if (hasTarget) eligible.push(id);
      else blocked.push(id);
    }

    if (blocked.length > 0) {
      alert(
        `${blocked.length} row${blocked.length === 1 ? "" : "s"} still need${
          blocked.length === 1 ? "s" : ""
        } a target account assigned before approval. Use the dropdown to set one, then approve.`
      );
    }
    if (eligible.length === 0) return;

    setRows((prev) =>
      prev.map((r) => (eligible.includes(r.id) ? { ...r, decision: "approved" } : r))
    );
    await Promise.all(
      eligible.map((id) =>
        fetch(`/api/reclass/decisions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "approved" }),
        })
      )
    );
  }

  // Move a row (or set of rows) to the Ask Client bucket — used from
  // Needs Review / Flagged when the bookkeeper realizes only the client
  // can answer this one.
  //
  // When called from a per-row button (single ID), we propagate by sender
  // so all matching unresolved transactions move at once — same logic as
  // setTarget. The bulk-button case (multiple IDs) is used as-is.
  async function moveToAskClient(rowIds: string[]) {
    if (rowIds.length === 0) return;

    // Build the full propagation set
    const unresolvedStates = new Set(["needs_review", "flagged", "ask_client"]);
    const propagateIds = new Set<string>(rowIds);

    // Only auto-propagate when the caller invoked with a single seed row.
    // For bulk moves the bookkeeper already selected what they want.
    if (rowIds.length === 1) {
      const seedId = rowIds[0];
      const seedRow = rows.find((r) => r.id === seedId);
      if (seedRow) {
        const seedSender = extractSender(
          seedRow.vendor_name,
          seedRow.description,
          (seedRow as any).original_memo
        );
        const seedNorm = normalizeSender(seedSender);
        if (seedNorm) {
          for (const r of rows) {
            if (r.id === seedId) continue;
            if (!unresolvedStates.has(r.decision)) continue;
            const rSender = extractSender(
              r.vendor_name,
              r.description,
              (r as any).original_memo
            );
            if (normalizeSender(rSender) === seedNorm) {
              propagateIds.add(r.id);
            }
          }
        }
      }
    }

    const ids = Array.from(propagateIds);
    setRows((prev) =>
      prev.map((r) => (propagateIds.has(r.id) ? { ...r, decision: "ask_client" } : r))
    );
    await Promise.all(
      ids.map((id) =>
        fetch(`/api/reclass/decisions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "ask_client" }),
        })
      )
    );
  }

  // Bring a skipped row back into the active workflow when the bookkeeper
  // catches a miscategorization. Setting a target account flips it to
  // "approved" status with pending status so it executes on the next run.
  async function unskipRow(rowId: string, accountName: string) {
    // First set the target name (this writes bookkeeper_override_*)
    await setTarget(rowId, accountName);
    // Then flip the decision back to approved so it ships at execute time
    setRows((prev) =>
      prev.map((r) =>
        r.id === rowId ? { ...r, decision: "approved", status: "pending" } : r
      )
    );
    await fetch(`/api/reclass/decisions/${rowId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", status: "pending" }),
    });
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

  async function handleReExecute() {
    setReExecuting(true);
    setReExecuteError("");
    try {
      const res = await fetch(`/api/reclass/${job.id}/re-execute`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Re-execute failed");
      router.push(`/reclass/${job.id}/execute`);
    } catch (e: any) {
      setReExecuteError(e.message);
      setReExecuting(false);
    }
  }

  // Count approved rows still pending execution (bounced from a prior run)
  const pendingApprovedCount = rows.filter(
    (r) => (r.decision === "approved" || r.decision === "auto_approve") && (r as any).status === "pending"
  ).length;

  // "Skip — already done" escape hatch. For inherited clients where reclass
  // was completed by a prior bookkeeper or done manually in QBO. Marks the
  // job complete without touching QBO and advances to Step 3 (Bank Rules).
  const [skippingAlreadyDone, setSkippingAlreadyDone] = useState(false);
  async function handleSkipAlreadyDone() {
    if (
      !confirm(
        `Skip reclass for "${(job as any).client_name || "this client"}"?\n\n` +
        `Use this only if reclass was ALREADY done for this period (e.g. by ` +
        `a previous bookkeeper or manually in QBO). This will mark Step 2 ` +
        `complete without modifying any transactions, and advance to Step 3 ` +
        `(Bank Rules).\n\nThis is logged for audit.`
      )
    ) {
      return;
    }
    setSkippingAlreadyDone(true);
    setError("");
    try {
      const res = await fetch(`/api/reclass/${job.id}/skip-already-done`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Skip failed");
      // Bank-rules step is the next stop in the workflow.
      router.push(`/reclass/${job.id}/bank-rules`);
    } catch (e: any) {
      setError(e.message);
      setSkippingAlreadyDone(false);
    }
  }

  return (
    <div className="space-y-6 max-w-7xl">
      {/* Payroll double-count check + resolve, in the cleanup flow (Mike:
          bookkeepers fix it here, per client). No-op until "Check now". */}
      {clientLinkId && (
        <PayrollDoubleCard clientLinkId={clientLinkId} clientName={(job as any).client_name || "Client"} />
      )}
      {/* Summary header */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <div className="flex items-start justify-between mb-4 gap-4">
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
          {/* Skip — already done. Escape hatch for inherited clients where
              reclass was completed by a prior bookkeeper or done manually
              in QBO. Marks Step 2 complete without touching transactions
              and advances to Step 3 (Bank Rules). Only shown when the job
              isn't already complete — there's nothing to skip past at that
              point. Confirmation dialog inside handleSkipAlreadyDone. */}
          {job.status !== "complete" && (
            <button
              onClick={handleSkipAlreadyDone}
              disabled={skippingAlreadyDone}
              className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy border border-gray-200 hover:border-gray-300 bg-white px-3 py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Mark reclass complete without executing — use if this period was already reclassed (in QBO or by a prior bookkeeper)"
            >
              {skippingAlreadyDone ? (
                <Loader2 className="animate-spin" size={14} />
              ) : (
                <SkipForward size={14} />
              )}
              Skip — already done
            </button>
          )}
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

      {/* Source-account filter — work one bank/card at a time (JP workflow). */}
      {(() => {
        const accounts = [...new Set(rows.map((r) => r.bank_account_name).filter(Boolean))] as string[];
        if (accounts.length < 2 && !accountFilter) return null;
        return (
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-ink-slate">Account:</span>
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm bg-white"
            >
              <option value="">All accounts</option>
              {accounts.sort().map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            {accountFilter && (
              <span className="text-xs bg-teal/10 text-teal-dark font-semibold px-2 py-1 rounded-lg">
                Working in: {accountFilter}
              </span>
            )}
          </div>
        );
      })()}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        <TabButton
          active={activeTab === "auto"}
          onClick={() => setActiveTab("auto")}
          icon={<span className="w-2 h-2 rounded-full bg-emerald-600" />}
          label="Auto-approve"
          count={partitioned.auto.length}
        />
        <TabButton
          active={activeTab === "review"}
          onClick={() => setActiveTab("review")}
          icon={<span className="w-2 h-2 rounded-full bg-amber-600" />}
          label="Needs review"
          count={partitioned.review.length}
        />
        <TabButton
          active={activeTab === "flagged"}
          onClick={() => setActiveTab("flagged")}
          icon={<span className="w-2 h-2 rounded-full bg-red-600" />}
          label="Flagged"
          count={partitioned.flagged.length}
        />
        <TabButton
          active={activeTab === "ask_client"}
          onClick={() => setActiveTab("ask_client")}
          icon={<span className="w-2 h-2 rounded-full bg-navy" />}
          label="Ask Client"
          count={partitioned.ask.length}
        />
        <TabButton
          active={activeTab === "skipped"}
          onClick={() => setActiveTab("skipped")}
          icon={<span className="w-2 h-2 rounded-full bg-ink-slate" />}
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
              <div className="p-3 bg-amber-50 border-b border-amber-100 flex items-center justify-between gap-3">
                <span className="text-sm text-amber-800">
                  AI confidence 70-91%. Pick the right account from the dropdown — selection applies to all matching-vendor transactions automatically.
                </span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => moveToAskClient(partitioned.review.map((r) => r.id))}
                    className="text-sm bg-navy text-white px-3 py-1.5 rounded-lg hover:bg-navy-deep"
                    title="Move all rows to Ask Client so the client can clarify"
                  >
                    Move all to Ask Client
                  </button>
                  <button
                    onClick={() => bulkApprove(partitioned.review.map((r) => r.id))}
                    className="text-sm bg-amber-600 text-white px-3 py-1.5 rounded-lg hover:bg-amber-700"
                  >
                    Approve all AI picks
                  </button>
                </div>
              </div>
            )}
            <RowTable
              rows={partitioned.review}
              showConfidence={true}
              showActions={true}
              showApproveReject={false}
              masterAccounts={masterAccounts}
              onTargetChange={setTarget}
              onMoveToAskClient={(id) => moveToAskClient([id])}
            />
          </>
        )}

        {activeTab === "flagged" && (
          <>
            {partitioned.flagged.length > 0 && (
              <div className="p-3 bg-red-50 border-b border-red-100 flex items-center justify-between gap-3">
                <span className="text-sm text-red-800">
                  AI couldn't confidently match these. Pick the right account from the dropdown — selection auto-applies to all matching-vendor transactions.
                </span>
                <button
                  onClick={() => moveToAskClient(partitioned.flagged.map((r) => r.id))}
                  className="text-sm bg-navy text-white px-3 py-1.5 rounded-lg hover:bg-navy-deep flex-shrink-0"
                  title="Move all rows to Ask Client so the client can clarify"
                >
                  Move all to Ask Client
                </button>
              </div>
            )}
            <RowTable
              rows={partitioned.flagged}
              showConfidence={true}
              showActions={true}
              showApproveReject={false}
              masterAccounts={masterAccounts}
              onTargetChange={setTarget}
              onMoveToAskClient={(id) => moveToAskClient([id])}
            />
          </>
        )}

        {activeTab === "ask_client" && (
          <>
            {partitioned.ask.length > 0 && (
              <div className="p-3 bg-teal-light border-b border-teal-border flex items-center justify-between gap-3">
                <span className="text-sm text-teal-dark">
                  <HelpCircle size={14} className="inline mr-1" />
                  Rows here will be sent to the client for clarification when you execute — one portal
                  message + one email listing all {partitioned.ask.length} transaction
                  {partitioned.ask.length === 1 ? "" : "s"}. If you know the category for any row, pick
                  it from the dropdown to remove it from the email batch.
                </span>
                <button
                  onClick={() => setEmailModalOpen(true)}
                  className="inline-flex items-center gap-1.5 text-sm bg-navy text-white px-3 py-1.5 rounded-lg hover:bg-navy-deep flex-shrink-0"
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
              onApproveChoice={(id) => bulkApprove([id])}
            />
          </>
        )}

        {activeTab === "skipped" && (
          <>
            {partitioned.skipped.length > 0 && (
              <div className="p-3 bg-gray-50 border-b border-gray-100 text-sm text-ink-slate">
                Skipped rows aren't executed by default. If you spot a miscategorization,
                pick a target account from the dropdown — that brings the row back into
                the queue as "approved" for the next execute.
              </div>
            )}
            <RowTable
              rows={partitioned.skipped}
              showConfidence={false}
              showActions={true}
              showApproveReject={false}
              showSkipReason
              masterAccounts={masterAccounts}
              onTargetChange={unskipRow}
            />
          </>
        )}
      </div>

      {/* Attestation + Execute */}
      <div className="bg-white rounded-2xl border-2 border-teal/20 p-6">
        <h3 className="font-bold text-navy mb-3">Review &amp; Execute</h3>
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

        {job.status === "complete" && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
            <span aria-hidden>✓</span>
            Already executed — these reclassifications were posted to QBO. Running again won&apos;t re-post.
          </div>
        )}
        <button
          onClick={handleExecute}
          disabled={!attested || submitting || job.status === "complete"}
          className="w-full bg-teal hover:bg-teal-dark text-white font-semibold px-6 py-3 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {submitting ? (
            <Loader2 className="animate-spin" size={18} />
          ) : (
            <Play size={18} />
          )}
          {job.status === "complete"
            ? "Already executed"
            : totalApproved === 0
            ? "Continue to next step"
            : `Execute ${totalApproved} reclassifications in QBO`}
        </button>
        <p className="text-xs text-ink-slate text-center mt-2">
          Skipped, flagged, and rejected transactions will NOT be executed.
        </p>
      </div>

      {/* Re-execute card — only shown when the job already ran and rows are still pending */}
      {job.status === "complete" && pendingApprovedCount > 0 && (
        <div className="bg-white rounded-2xl border-2 border-amber-200 p-6">
          <div className="flex items-start gap-3 mb-4">
            <RefreshCw size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-bold text-navy">
                {pendingApprovedCount} row{pendingApprovedCount === 1 ? "" : "s"} ready to re-execute
              </h3>
              <p className="text-sm text-ink-slate mt-1">
                These rows have a target account assigned but weren't executed in the first run.
                Click below to push them to QBO now.
              </p>
            </div>
          </div>
          {reExecuteError && (
            <div className="mb-3 p-3 bg-red-50 text-red-800 rounded-lg text-sm">{reExecuteError}</div>
          )}
          <button
            onClick={handleReExecute}
            disabled={reExecuting}
            className="w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold px-6 py-3 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {reExecuting ? (
              <Loader2 className="animate-spin" size={18} />
            ) : (
              <RefreshCw size={18} />
            )}
            {reExecuting ? "Starting…" : `Execute ${pendingApprovedCount} pending row${pendingApprovedCount === 1 ? "" : "s"} in QBO`}
          </button>
        </div>
      )}

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
  onMoveToAskClient,
  onApproveChoice,
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
  /** If provided, renders an "Ask Client" button per row so a single
   *  needs_review / flagged item can be punted to the client. */
  onMoveToAskClient?: (id: string) => void;
  /** If provided, renders an "Approve choice" button per row that promotes
   *  the row to approved using whatever target is currently set (AI's pick or
   *  bookkeeper override). Used on the Ask Client tab so the bookkeeper can
   *  one-click confirm a row without the email-to-client step. */
  onApproveChoice?: (id: string) => void;
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
            <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Account</th>
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
            {onMoveToAskClient && (
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Ask Client?</th>
            )}
            {onApproveChoice && (
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Approve</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((r) => {
            // A row that's been moved out of this tab (i.e., now approved) gets
            // a "Moved to Auto-Approved" visual confirmation instead of vanishing.
            const isMovedOut =
              r.decision === "approved" || r.decision === "auto_approve";
            return (
            <tr key={r.id} className={`border-b border-gray-100 ${isMovedOut ? "bg-green-50/40" : "hover:bg-gray-50"}`}>
              <td className="px-4 py-2.5 text-ink-slate align-top">{r.transaction_date}</td>
              <td className="px-4 py-2.5 align-top">
                <div className={`font-medium ${isMovedOut ? "text-ink-slate line-through" : "text-navy"}`}>
                  {r.vendor_name}
                </div>
                {r.description && (
                  <div className="text-xs text-ink-slate truncate max-w-xs">{r.description}</div>
                )}
                <div className="flex gap-1.5 mt-0.5 flex-wrap">
                  {isMovedOut && (
                    <span className="text-[10px] font-bold bg-green-600 text-white px-1.5 py-0.5 rounded inline-flex items-center gap-0.5">
                      <CheckCircle2 size={10} /> Moved to Auto-Approved
                    </span>
                  )}
                  {r.client_responded_at && (
                    <span
                      className="text-xs bg-teal/15 text-teal-dark font-semibold px-1.5 py-0.5 rounded"
                      title={r.client_response_note || undefined}
                    >
                      Client: {r.client_response_account || "see note"}
                      {r.client_response_note ? ` — "${r.client_response_note.slice(0, 80)}${r.client_response_note.length > 80 ? "…" : ""}"` : ""}
                    </span>
                  )}
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
              <td className="px-4 py-2.5 text-ink-slate align-top text-xs whitespace-nowrap">
                {r.bank_account_name || "—"}
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
                  <span
                    title={r.skip_reason || r.decision || ""}
                    className="text-xs bg-gray-100 text-ink-slate px-1.5 py-0.5 rounded"
                  >
                    {friendlySkipReason(r.skip_reason, r.decision)}
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
              {onMoveToAskClient && (
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => onMoveToAskClient(r.id)}
                    className="text-xs px-2 py-1 bg-teal-light text-teal-dark rounded hover:bg-teal-light inline-flex items-center gap-1"
                    title="Move this row to the Ask Client bucket"
                  >
                    <HelpCircle size={11} />
                    Ask Client
                  </button>
                </td>
              )}
              {onApproveChoice && (
                <td className="px-4 py-2.5 text-right">
                  {(() => {
                    const hasTarget =
                      !!r.bookkeeper_override_target_id ||
                      !!(r.bookkeeper_override_target_name && r.bookkeeper_override_target_name !== "") ||
                      (!!r.to_account_id && r.to_account_id !== "") ||
                      !!(r.to_account_name && r.to_account_name !== "");
                    if (!hasTarget) {
                      return (
                        <span className="text-[11px] text-ink-slate italic" title="Pick a target from the Map to Master dropdown first">
                          set target first
                        </span>
                      );
                    }
                    return (
                      <button
                        onClick={() => onApproveChoice(r.id)}
                        className="text-xs px-2 py-1 bg-emerald-100 text-emerald-700 rounded hover:bg-emerald-200 inline-flex items-center gap-1"
                        title="Approve this row's target and move to Auto-Approved (skips the email-to-client step)"
                      >
                        <CheckCircle2 size={11} />
                        Approve
                      </button>
                    );
                  })()}
                </td>
              )}
            </tr>
            );
          })}
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

// Convert raw skip-reason enum values into something the bookkeeper can read at a glance.
function friendlySkipReason(reason: string | null, decision: string | null): string {
  switch (reason) {
    case "already_correct":
      return "Already in target account";
    case "reconciled":
      return "Reconciled — locked";
    case "closed_period_qbo":
      return "QBO closed period";
    case "closed_period_double":
      return "Double end-close locked";
    case "balance_sheet_account":
      return "Balance sheet line — skipped";
    case "unsupported_type":
      return "Unsupported transaction type";
    case "user_excluded":
      return "Excluded by bookkeeper";
    case "manual_entry":
      return "Manual entry — skipped";
    default:
      return reason || decision || "Skipped";
  }
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

  // Tokenized, punctuation-insensitive match — a plain phrase-substring match
  // (the old behavior) required the WHOLE typed string to appear verbatim, so
  // typing "owner draw" found nothing against an account literally named
  // "Owner's Draw" (the apostrophe breaks contiguity). Split the query into
  // words, strip punctuation from both sides, and require every word to
  // appear somewhere across name/parent/section — order- and
  // punctuation-independent.
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const searchTokens = normalize(search).split(/\s+/).filter(Boolean);
  const filtered = masterAccounts.filter((m) => {
    if (searchTokens.length === 0) return true;
    const haystack = normalize(`${m.account_name} ${m.parent_account_name || ""} ${m.section || ""}`);
    return searchTokens.every((t) => haystack.includes(t));
  });

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

/**
 * Extract the real sender from a transaction.
 *
 * QBO often surfaces e-transfers with vendor_name = "Unknown vendor" while the
 * actual sender name lives in the description/memo (e.g., "Interac e-Transfer
 * from Josh Smith for July rent"). This helper digs the real name out so we
 * can group by it.
 *
 * Returns the cleanest human-readable name we can find, falling back to
 * "Unknown" only when truly nothing identifiable exists.
 */
function extractSender(
  vendorName: string | null | undefined,
  description: string | null | undefined,
  privateNote?: string | null
): string {
  const isMeaningfulVendor = (v: string) => {
    const lower = v.toLowerCase().trim();
    if (!lower) return false;
    if (lower === "unknown vendor" || lower === "unknown" || lower === "n/a") return false;
    // Generic peer-payment / transfer labels — these tell the client
    // nothing on their own. Dig into the description for the real party.
    if (/^(venmo|zelle|paypal|cash\s*app)(\s+(payment|transfer|deposit))?$/i.test(lower)) return false;
    if (/^(online\s+transfer|wire\s+transfer|ach\s+transfer|funds?\s+transfer|internal\s+transfer)$/i.test(lower)) return false;
    if (/^(transfer|deposit|withdrawal|payment)$/i.test(lower)) return false;
    return true;
  };

  const v = (vendorName || "").trim();
  if (isMeaningfulVendor(v)) return v;

  // Fall back to description, then private note. If neither yields useful
  // detail, keep the (generic) vendor name so the row isn't an empty "Unknown".
  const source = (description || privateNote || "").trim();
  if (!source) return v || "Unknown";

  let cleaned = source
    // Strip Interac/POS bank-feed prefixes
    .replace(/^(interac\s+(purchase|retail|debit)\s*[\-:]?\s*)/i, "")
    .replace(/^(pos\s+(purchase|debit)\s*[\-:]?\s*)/i, "")
    // Strip e-transfer noise words at the start of the descriptor
    .replace(/^(interac\s+)?e[\s\-]?transfer\s*(from\s+|to\s+)?/i, "")
    .replace(/^(emt|e[\s\-]?tfr)\s+(from\s+|to\s+)?/i, "")
    // Strip peer-payment prefixes — keep the recipient/payer name that follows
    .replace(/^(venmo|zelle|paypal|cash\s*app)\s*\*?\s*/i, "")
    .replace(/^(online\s+transfer|wire\s+transfer|ach\s+transfer|funds?\s+transfer|money\s+transfer|prairie\s+transfer)\s+(to|from|authorized\s+on\s+\S+)?\s*/i, "")
    .replace(/^(received\s+from|sent\s+to|from|to)\s+/i, "")
    // Strip trailing reference numbers and memo qualifiers ("for X")
    .replace(/\s+(ref|reference|confirmation|memo)[\s:#]*[A-Z0-9]+.*$/i, "")
    .replace(/\s+for\s+(deposit|payment|services?|invoice|job|reno|cleanup|rent|materials?).*$/i, "")
    .replace(/\s+#?\d{4,}\b.*$/, "")
    // Strip trailing card masks like "SXXXXXXXX1269204 CARD"
    .replace(/\s+S[X*]+\d+\s*CARD\s*$/i, "")
    // Strip trailing city/state tags ("Oakland CA", "POST FALLS ID")
    .replace(/\s+[A-Z][A-Z\s]+\s+[A-Z]{2}\s*$/, "")
    .trim();

  if (!cleaned) return "Unknown";
  // Collapse double spaces
  cleaned = cleaned.replace(/\s+/g, " ");
  return cleaned;
}

/**
 * Normalize an extracted sender name for grouping/dedup. Removes punctuation
 * and case differences so "Josh Smith", "JOSH SMITH", "josh-smith" all match.
 */
function normalizeSender(name: string): string {
  return (name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface SenderGroup {
  sender: string;             // display name (e.g. "Josh Smith")
  normalized: string;         // dedup key
  count: number;
  total: number;
  firstDate: string;
  lastDate: string;
  /** Distinct memo/description snippets seen for this sender. Up to 5,
   *  truncated for readability. Crucial context for Venmo/Zelle/E-transfer
   *  rows where the sender alone tells the client nothing. */
  memos: string[];
}

/**
 * Cleaned-up memo: strip the same leading prefixes extractSender removes
 * so we don't echo "Interac e-Transfer from Josh Smith for X" — we show
 * just "for X". Truncated to ~80 chars.
 */
function cleanMemo(raw: string | null | undefined): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  let cleaned = s
    .replace(/^(interac\s+(purchase|retail|debit)\s*[\-:]?\s*)/i, "")
    .replace(/^(pos\s+(purchase|debit)\s*[\-:]?\s*)/i, "")
    .replace(/^(interac\s+)?e[\s\-]?transfer\s*(from\s+|to\s+)?[A-Za-z .'-]+?(\s+for\s+)?/i, "$3")
    .replace(/^(emt|e[\s\-]?tfr)\s+(from\s+|to\s+)?[A-Za-z .'-]+?(\s+for\s+)?/i, "$3")
    .replace(/^(venmo|zelle|cash\s*app|paypal)\s*\*?\s*[A-Za-z .'-]+?(\s+for\s+)?/i, "$2")
    .replace(/\s+ref(erence)?[\s:#]*[A-Z0-9]+.*$/i, "")
    .replace(/\s+#?\d{6,}\b.*$/, "")
    .trim();
  if (cleaned.length > 80) cleaned = cleaned.slice(0, 77) + "…";
  return cleaned;
}

/**
 * Group ask-client rows by extracted sender (digs into description when
 * vendor_name is "Unknown vendor"). Returns one row per unique recipient
 * with transaction count + total + up to 5 distinct memo snippets so
 * Venmo/Zelle rows aren't context-free in the client email.
 */
function buildSenderGroups(rows: Reclassification[]): SenderGroup[] {
  const map = new Map<string, SenderGroup>();
  for (const r of rows) {
    const sender = extractSender(r.vendor_name, r.description, (r as any).original_memo);
    const norm = normalizeSender(sender);
    if (!norm) continue;
    const amount = Math.abs(Number(r.transaction_amount || 0));
    const date = r.transaction_date || "";
    if (!map.has(norm)) {
      map.set(norm, {
        sender,
        normalized: norm,
        count: 0,
        total: 0,
        firstDate: date,
        lastDate: date,
        memos: [],
      });
    }
    const g = map.get(norm)!;
    g.count++;
    g.total += amount;
    if (date && (!g.firstDate || date < g.firstDate)) g.firstDate = date;
    if (date && (!g.lastDate || date > g.lastDate)) g.lastDate = date;
    // Collect up to 5 distinct memo snippets
    const memo = cleanMemo(r.description || (r as any).original_memo);
    if (memo && g.memos.length < 5 && !g.memos.includes(memo)) {
      g.memos.push(memo);
    }
  }
  // Sort by total descending (biggest mysteries first)
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
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
  const groups = useMemo(() => buildSenderGroups(rows), [rows]);
  const periodLabel = `${dateStart} → ${dateEnd}`;

  const defaultIntro = useMemo(
    () =>
      `Hi ${clientName.split(" ")[0] || "there"},\n\nWhile cleaning up your books for the period ${periodLabel}, we found ${rows.length} transaction${rows.length === 1 ? "" : "s"} from ${groups.length} sender${groups.length === 1 ? "" : "s"} that we have questions about. These look like e-transfers, Venmo, or peer payments without a clear category.\n\nPlease fill in the "What were these for?" column in the table below — one answer per sender is fine (e.g., "rent payments" or "materials reimbursement"):`,
    [clientName, periodLabel, rows.length, groups.length]
  );
  const defaultOutro = `Please reply within 48 hours so we can complete your books.\n\nKindly,\nIronbooks`;

  const [subject, setSubject] = useState<string>(
    `Quick question on ${rows.length} transaction${rows.length === 1 ? "" : "s"} — ${clientName}`
  );
  const [intro, setIntro] = useState<string>(defaultIntro);
  const [outro, setOutro] = useState<string>(defaultOutro);
  const [copied, setCopied] = useState<"subject" | "body" | null>(null);
  const [copyError, setCopyError] = useState<string>("");
  // Direct-send state (Send Email button → Resend, no Double copy-paste)
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<
    { ok: true; recipients: string[]; messageId?: string | null } | { ok: false; message: string } | null
  >(null);

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
    const tableRows = groups
      .map(
        (g, i) => {
          const bg = i % 2 === 0 ? BRAND.white : BRAND.tealLighter;
          const dateLabel = g.firstDate === g.lastDate
            ? g.firstDate
            : `${g.firstDate} → ${g.lastDate}`;
          const memosHtml = g.memos.length > 0
            ? g.memos
                .map((m) => `<div style="color:${BRAND.slate};font-size:11px;line-height:1.45;">• ${escapeHtml(m)}</div>`)
                .join("")
            : `<div style="color:${BRAND.lightSlate};font-size:11px;font-style:italic;">No memo on bank record</div>`;
          return `
        <tr style="background:${bg};">
          <td style="border:1px solid ${BRAND.border};padding:8px 12px;color:${BRAND.navy};font-weight:600;vertical-align:top;">${escapeHtml(g.sender)}</td>
          <td style="border:1px solid ${BRAND.border};padding:8px 12px;text-align:center;color:${BRAND.slate};font-variant-numeric:tabular-nums;vertical-align:top;">${g.count}</td>
          <td style="border:1px solid ${BRAND.border};padding:8px 12px;text-align:right;color:${BRAND.navy};font-weight:600;font-variant-numeric:tabular-nums;vertical-align:top;">$${fmtMoney(g.total)}</td>
          <td style="border:1px solid ${BRAND.border};padding:8px 12px;color:${BRAND.slate};font-size:11px;font-variant-numeric:tabular-nums;vertical-align:top;">${escapeHtml(dateLabel)}</td>
          <td style="border:1px solid ${BRAND.border};padding:8px 12px;vertical-align:top;">${memosHtml}</td>
          <td style="border:1px solid ${BRAND.border};padding:8px 12px;background:${BRAND.white};vertical-align:top;">&nbsp;</td>
        </tr>`;
        }
      )
      .join("");

    return `<div style="font-family:'Figtree','Helvetica Neue',Helvetica,Arial,sans-serif;color:${BRAND.navy};max-width:720px;margin:0 auto;background:${BRAND.white};">
  <!-- Brand header bar -->
  <div style="background:${BRAND.navy};color:${BRAND.white};padding:18px 22px;border-radius:10px 10px 0 0;">
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="vertical-align:middle;width:54px;padding-right:14px;">
          <img src="https://internal.ironbooks.com/logo.png" alt="SNAP" width="44" height="44" style="display:block;width:44px;height:auto;" />
        </td>
        <td style="vertical-align:middle;color:${BRAND.white};">
          <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;line-height:1.1;color:${BRAND.white};">Ironbooks</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-top:3px;letter-spacing:0.06em;text-transform:uppercase;">Bookkeeping &middot; Cleanup</div>
        </td>
      </tr>
    </table>
  </div>

  <!-- Body -->
  <div style="border:1px solid ${BRAND.border};border-top:none;padding:24px 22px;border-radius:0 0 10px 10px;background:${BRAND.white};">
    ${introHtml}

    <!-- Branded sender-grouped table — one row per unique sender -->
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid ${BRAND.border};font-family:'Figtree','Helvetica Neue',sans-serif;font-size:13px;margin:8px 0 18px 0;">
      <thead>
        <tr style="background:${BRAND.teal};">
          <th style="border:1px solid ${BRAND.tealDark};padding:10px 12px;text-align:left;color:${BRAND.white};font-weight:600;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;">Sender</th>
          <th style="border:1px solid ${BRAND.tealDark};padding:10px 12px;text-align:center;color:${BRAND.white};font-weight:600;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;"># Txns</th>
          <th style="border:1px solid ${BRAND.tealDark};padding:10px 12px;text-align:right;color:${BRAND.white};font-weight:600;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;">Total</th>
          <th style="border:1px solid ${BRAND.tealDark};padding:10px 12px;text-align:left;color:${BRAND.white};font-weight:600;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;">Date Range</th>
          <th style="border:1px solid ${BRAND.tealDark};padding:10px 12px;text-align:left;color:${BRAND.white};font-weight:600;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;">Bank Memo / Notes</th>
          <th style="border:1px solid ${BRAND.tealDark};padding:10px 12px;text-align:left;color:${BRAND.white};font-weight:600;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;">What were these for?</th>
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
  }, [intro, outro, groups]);

  // Plain-text fallback for paste destinations that don't take HTML
  const plainText = useMemo(() => {
    const lines = groups.map((g) => {
      const dateLabel = g.firstDate === g.lastDate ? g.firstDate : `${g.firstDate} → ${g.lastDate}`;
      const memoBlock = g.memos.length > 0
        ? g.memos.map((m) => `      • ${m}`).join("\n")
        : "      (no memo on bank record)";
      return [
        `▸ ${g.sender}`,
        `    ${g.count} txn${g.count === 1 ? "" : "s"} · $${fmtMoney(g.total)} · ${dateLabel}`,
        `    Bank memo / notes:`,
        memoBlock,
        `    What were these for? __________________________`,
      ].join("\n");
    });
    return `${intro}\n\n${lines.join("\n\n")}\n\n${outro}`;
  }, [intro, outro, groups]);

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

  // Send the branded email straight to the client via Resend — no Double
  // copy-paste. The server resolves the recipient (portal users, else the
  // QBO business email); if none exists it returns a clear error and the
  // bookkeeper falls back to Copy.
  async function sendEmail() {
    if (sending) return;
    setSending(true);
    setSendResult(null);
    setCopyError("");
    try {
      const res = await fetch(`/api/reclass/${jobId}/email-questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, html, text: plainText }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't send the email");
      setSendResult({ ok: true, recipients: json.recipients || [], messageId: json.message_id || null });
    } catch (err: any) {
      setSendResult({ ok: false, message: err?.message || "Couldn't send the email" });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-navy flex items-center gap-2">
              <Mail size={18} className="text-teal-dark" />
              Email to {clientName}
            </h3>
            <p className="text-xs text-ink-slate mt-1">
              {rows.length} transaction{rows.length === 1 ? "" : "s"}. Edit the message, then send it directly — or copy & paste into Double.
            </p>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy">
            <X size={20} />
          </button>
        </div>

        {/* Instructions strip */}
        <div className="px-6 py-3 bg-teal-light border-b border-teal-border text-xs text-teal-dark">
          <strong>Send Email</strong> delivers this straight to {clientName} via Resend and logs it to their email history — the client fills in the right column and replies to you. <span className="text-teal-dark">(Or use “Copy for Double” to paste it elsewhere.)</span>
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
                className="inline-flex items-center gap-1 text-xs font-semibold text-teal-dark hover:text-teal-dark"
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

          {/* Branded table preview — one row per unique sender */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
              Sender Table Preview ({groups.length} unique sender{groups.length === 1 ? "" : "s"} · {rows.length} total transaction{rows.length === 1 ? "" : "s"})
            </label>
            <div className="rounded-lg border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto max-h-72">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr style={{ background: "#2D7A75" }}>
                      <th className="text-left px-3 py-2 text-white font-semibold uppercase tracking-wider text-[10px]">Sender</th>
                      <th className="text-center px-3 py-2 text-white font-semibold uppercase tracking-wider text-[10px]"># Txns</th>
                      <th className="text-right px-3 py-2 text-white font-semibold uppercase tracking-wider text-[10px]">Total</th>
                      <th className="text-left px-3 py-2 text-white font-semibold uppercase tracking-wider text-[10px]">Date Range</th>
                      <th className="text-left px-3 py-2 text-white font-semibold uppercase tracking-wider text-[10px]">Bank Memo / Notes</th>
                      <th className="text-left px-3 py-2 text-white font-semibold uppercase tracking-wider text-[10px]">What were these for?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g, i) => {
                      const dateLabel = g.firstDate === g.lastDate
                        ? g.firstDate
                        : `${g.firstDate} → ${g.lastDate}`;
                      return (
                        <tr key={i} style={{ background: i % 2 === 0 ? "#FFFFFF" : "#F4F9F8" }}>
                          <td className="px-3 py-1.5 text-navy border border-gray-200 font-semibold align-top">{g.sender}</td>
                          <td className="px-3 py-1.5 text-center text-ink-slate border border-gray-200 align-top">{g.count}</td>
                          <td className="px-3 py-1.5 text-right font-semibold text-navy border border-gray-200 align-top">${fmtMoney(g.total)}</td>
                          <td className="px-3 py-1.5 text-ink-slate border border-gray-200 text-[10px] align-top">{dateLabel}</td>
                          <td className="px-3 py-1.5 border border-gray-200 align-top">
                            {g.memos.length > 0 ? (
                              <div className="space-y-0.5">
                                {g.memos.map((m, idx) => (
                                  <div key={idx} className="text-ink-slate text-[10px] leading-tight">• {m}</div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-ink-light italic text-[10px]">No memo on bank record</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-ink-light italic border border-gray-200 align-top">(client fills in)</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="text-[11px] text-ink-light mt-1.5">
              Sender extracted from vendor name or transaction description (catches e-transfer / Venmo / Zelle recipient names). Bank Memo column surfaces what each payment was for so the client has context per sender.
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

          {/* Direct-send result */}
          {sendResult?.ok && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800 flex items-start gap-2">
              <CheckCircle2 size={15} className="mt-0.5 flex-shrink-0" />
              <span>
                <strong>Sent via Resend</strong> to{" "}
                <strong>{sendResult.recipients.join(", ")}</strong>. The client can
                fill in the table and reply directly to you.
                <span className="block text-xs text-green-700 mt-0.5">
                  Logged to this client&apos;s email history
                  {sendResult.messageId ? ` · Resend id ${sendResult.messageId.slice(0, 12)}…` : ""}.
                </span>
              </span>
            </div>
          )}
          {sendResult && !sendResult.ok && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-start gap-2">
              <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
              <span>{sendResult.message}</span>
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
              className="inline-flex items-center gap-2 bg-white border border-teal-border hover:bg-teal-light text-teal-dark text-sm font-semibold px-4 py-2.5 rounded-lg"
            >
              {copied === "body" ? <CheckCircle2 size={14} /> : <Send size={14} />}
              {copied === "body" ? "Copied!" : "Copy for Double"}
            </button>
            <button
              onClick={sendEmail}
              disabled={sending || (sendResult?.ok ?? false)}
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-60"
            >
              {sending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : sendResult?.ok ? (
                <CheckCircle2 size={14} />
              ) : (
                <Mail size={14} />
              )}
              {sending ? "Sending…" : sendResult?.ok ? "Sent" : "Send Email"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
