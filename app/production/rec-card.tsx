"use client";

/**
 * Shared per-client monthly close card + statement review flow.
 * Used by /production (board) and /cleanup (sign-off column).
 * Extracted verbatim from app/monthly-rec/monthly-rec-client.tsx.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, AlertTriangle, ArrowUpRight, CheckCircle2, ChevronDown, ChevronRight,
  FileText, Loader2, PlayCircle, RotateCcw, Send, Sparkles, XCircle,
} from "lucide-react";
import { playSound } from "@/lib/sounds";
import { VerificationPanel, vFixLink } from "./verification-panel";

type CheckStatus = "pass" | "warn" | "fail";

interface Check {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: "reclass" | "uf_audit" | "ar" | "profile" | "connections";
}

interface StatementLine {
  label: string;
  amount: number;
  group: string;
  depth: number;
}

interface CashFlowSection {
  title: string;
  total: number;
  items: { label: string; amount: number }[];
}

export interface Statements {
  pl: {
    totalIncome: number;
    totalExpenses: number;
    netIncome: number;
    /** COGS + Gross Profit are present on the snapshot (fetchStatementsPreview)
     *  — declared here so the sectioned P&L view can render the waterfall. */
    cogs?: number;
    grossProfit?: number;
    lineItems: { label: string; amount: number; group: string }[];
  };
  bs: {
    lines: StatementLine[];
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
  } | null;
  cfs?: {
    operating: CashFlowSection;
    investing: CashFlowSection;
    financing: CashFlowSection;
    netCashChange: number;
    cashAtStart: number;
    cashAtEnd: number;
  } | null;
}

interface SpotCheck {
  verdict: "looks_good" | "needs_review";
  summary: string;
  findings: { severity: "info" | "warn" | "flag"; area: string; note: string }[];
  error?: string;
}

interface Run {
  status: "open" | "pending_review" | "complete";
  has_concerns: boolean;
  concerns: string | null;
  checks: { checks: Check[]; overall: CheckStatus } | null;
  checks_ran_at: string | null;
  completed_at: string | null;
  statements?: Statements | null;
  sent_to_client_at?: string | null;
  email_delivery?: { sent: boolean; reason?: string } | null;
  kind?: "production_me" | "cleanup";
  period?: string;
  ai_spot_check?: SpotCheck | null;
  submitted_at?: string | null;
  submitted_by?: string | null;
  // Production board state (migration 65)
  board_status?: "not_started" | "in_progress" | "stuck" | "waiting_client";
  waiting_reasons?: string[];
  status_note?: string | null;
  // Books Reliability (migration 104)
  verification?: any | null;
  verification_score?: number | null;
  verification_ran_at?: string | null;
  verification_override?: { by: string; at: string; reason: string; score_at_override: number } | null;
  // TEMPORARY manager-review gate (migration 113) — remove alongside the
  // gate in app/api/clients/[id]/monthly-rec/route.ts when no longer needed.
  manager_reviewed_at?: string | null;
  manager_review_override?: { by: string; at: string; reason: string } | null;
  // Draft-with-a-question sends (migration 131) — month stays open.
  draft_sends?: Array<{ at: string; by: string; by_name?: string | null; question: string; email_sent?: boolean }> | null;
}

export interface ProdClient {
  id: string;
  client_name: string;
  urgent?: boolean;
  urgent_note?: string | null;
  /** Contact first + last name — shown under the business name on cards. */
  contact_name?: string | null;
  paused: boolean;
  bs_enabled?: boolean;
  assigned_bookkeeper_id?: string | null;
  run: Run | null;
}

export interface Bookkeeper {
  id: string;
  full_name: string;
}

export interface EligibleClient {
  id: string;
  client_name: string;
  cleanup_completed_at: string;
}


export function shiftPeriod(period: string, delta: number): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ─── PER-CLIENT CARD ─────────────────────────────────────────────────────

export function ClientRecCard({
  client,
  period,
  isSenior,
  onChanged,
}: {
  client: ProdClient;
  period: string;
  isSenior: boolean;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [concerns, setConcerns] = useState(client.run?.concerns || "");
  const [localRun, setLocalRun] = useState<Run | null>(client.run);
  const [error, setError] = useState("");
  // The close gate: statements must be loaded + reviewed, then attested,
  // before "Send to client" unlocks.
  const [loadingStatements, setLoadingStatements] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [attested, setAttested] = useState(false);
  const [sendWarning, setSendWarning] = useState<string | null>(null);
  // Red-flag approval gate: the server 409s the send with the open flags
  // (duplicate expenses/revenue, COGS band, net-margin band); each must be
  // approved with a reason or fixed + re-verified before sending.
  const [redFlags, setRedFlags] = useState<any[] | null>(null);
  // Draft-with-a-question path — sends DRAFT numbers, month stays open.
  const [draftQuestion, setDraftQuestion] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);

  useEffect(() => {
    setLocalRun(client.run);
    setConcerns(client.run?.concerns || "");
  }, [client.run]);

  const run = localRun;
  const checks = run?.checks?.checks || [];
  const overall = run?.checks?.overall;
  const isComplete = run?.status === "complete";
  const isPending = run?.status === "pending_review";
  // TEMPORARY manager-review gate — informational only (server always
  // re-checks); cleanup sign-off is a different queue and is never gated.
  const needsManagerReview =
    !isComplete &&
    run?.kind !== "cleanup" &&
    !run?.manager_reviewed_at &&
    !run?.manager_review_override;
  const isCleanupKind = run?.kind === "cleanup";
  const [spotChecking, setSpotChecking] = useState(false);

  async function act(body: Record<string, unknown>) {
    const res = await fetch(`/api/clients/${client.id}/monthly-rec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, period }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.run as Run;
  }

  async function runChecks() {
    setRunning(true);
    setError("");
    try {
      const r = await act({ action: "run" });
      setLocalRun(r);
      setExpanded(true);
      playSound("scan_complete");
    } catch (e: any) {
      setError(e?.message || "Check run failed");
    } finally {
      setRunning(false);
    }
  }

  async function loadStatements() {
    setLoadingStatements(true);
    setError("");
    try {
      const r = await act({ action: "statements" });
      setLocalRun(r);
      setReviewing(true);
      setAttested(false);
      // Fire the AI spot check in the background — advisory second opinion
      // alongside the human review, never blocking it.
      setSpotChecking(true);
      act({ action: "spot_check" })
        .then((r2) => setLocalRun(r2))
        .catch(() => {})
        .finally(() => setSpotChecking(false));
    } catch (e: any) {
      setError(e?.message || "Couldn't load statements");
    } finally {
      setLoadingStatements(false);
    }
  }

  async function submitForReview() {
    setCompleting(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${client.id}/monthly-rec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit", period, attested: true, concerns }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      playSound("scan_complete");
      onChanged();
    } catch (e: any) {
      setError(e?.message || "Couldn't submit");
    } finally {
      setCompleting(false);
    }
  }

  async function sendToClient(overrideReason?: string, managerOverrideReason?: string) {
    setCompleting(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${client.id}/monthly-rec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send",
          period,
          attested: true,
          concerns,
          ...(overrideReason ? { override_reason: overrideReason } : {}),
          ...(managerOverrideReason ? { manager_override_reason: managerOverrideReason } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        // Red-flag approval gate: the flags render inline with per-flag
        // Approve buttons — no override prompt, each needs its own reason.
        if (res.status === 409 && json.requires_red_flag_approval) {
          setRedFlags(json.red_flags || []);
          throw new Error(json.error || "Red flags need manual approval before this month can be sent.");
        }
        // Books Reliability gate: score below the bar — a senior can override
        // with a written reason (recorded on the run + audited).
        if (res.status === 409 && json.requires_override) {
          const reason = window.prompt(
            `${json.error}\n\nTo send anyway, enter an override reason (recorded with your name):`
          );
          if (reason && reason.trim()) {
            setCompleting(false);
            return sendToClient(reason.trim(), managerOverrideReason);
          }
          throw new Error("Send cancelled — fix the findings and re-verify, or provide an override reason.");
        }
        // TEMPORARY manager-review gate — Kedma hasn't reviewed this run yet.
        // Any senior can still push it through with a written reason.
        if (res.status === 409 && json.requires_manager_review) {
          const reason = window.prompt(
            `${json.error}\n\nTo send anyway, enter an override reason (recorded with your name):`
          );
          if (reason && reason.trim()) {
            setCompleting(false);
            return sendToClient(overrideReason, reason.trim());
          }
          throw new Error("Send cancelled — ask Kedma to review, or provide an override reason.");
        }
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      if (json.email_delivery && !json.email_delivery.sent) {
        setSendWarning(
          json.email_delivery.reason === "no_portal_user" || json.email_delivery.reason === "no_active_email"
            ? "Month closed — but this client has no portal login, so no email went out. Their portal notification is waiting whenever they get access."
            : "Month closed and portal updated — but the email notification failed to send."
        );
      }
      setRedFlags(null);
      playSound("client_graduated");
      onChanged();
    } catch (e: any) {
      setError(e?.message || "Couldn't send");
    } finally {
      setCompleting(false);
    }
  }

  // Approve ONE red flag = dismiss-with-reason (recorded who/why). The server
  // recomputes the score instantly; when the list empties, send again.
  async function approveRedFlag(flag: any) {
    const reason = window.prompt(
      `APPROVE this red flag? The statements go to the client as-is — recorded with your name.\n\n${flag.check_label}: ${flag.message}\n\nReason (required):`
    );
    if (!reason || !reason.trim()) return;
    setError("");
    try {
      const r = await act({
        action: "dismiss_finding",
        fingerprint: flag.fingerprint,
        check_key: flag.check_key,
        reason: reason.trim(),
      });
      setLocalRun(r);
      setRedFlags((prev) => (prev || []).filter((f) => f.fingerprint !== flag.fingerprint));
    } catch (e: any) {
      setError(e?.message || "Couldn't approve the flag");
    }
  }

  // The "not sure yet" path: DRAFT numbers + a question to the client
  // (portal message + email). The month stays open.
  async function sendDraft() {
    if (!draftQuestion.trim()) return;
    setDraftBusy(true);
    setError("");
    setDraftNotice(null);
    try {
      const res = await fetch(`/api/clients/${client.id}/monthly-rec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send_draft", period, question: draftQuestion.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (json.run) setLocalRun(json.run);
      setDraftQuestion("");
      setDraftNotice(
        (json.email_delivery?.sent
          ? "Draft sent — portal message + email are out. The month stays open; close it after the client replies."
          : "Draft posted to the client's portal, but no email went out (no portal login on file?). The month stays open.") +
          (json.draft_record_error ? ` ${json.draft_record_error}` : "")
      );
      playSound("scan_complete");
    } catch (e: any) {
      setError(e?.message || "Couldn't send the draft");
    } finally {
      setDraftBusy(false);
    }
  }

  async function reopen() {
    setCompleting(true);
    setError("");
    try {
      await act({ action: "reopen" });
      onChanged();
    } catch (e: any) {
      setError(e?.message || "Couldn't reopen");
    } finally {
      setCompleting(false);
    }
  }

  return (
    <div
      className={`bg-white rounded-2xl border overflow-hidden ${
        isComplete
          ? run?.has_concerns
            ? "border-amber-300"
            : "border-emerald-200"
          : "border-gray-100"
      }`}
    >
      {/* Header row */}
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
            <span className="font-bold text-navy">{client.client_name}</span>
            {client.urgent && (
              <span
                title={client.urgent_note || "Urgent — books ASAP"}
                className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-600 text-white"
              >
                URGENT
              </span>
            )}
            {isCleanupKind && (
              <span className="text-[10px] font-bold bg-violet-100 text-violet-800 px-1.5 py-0.5 rounded">
                CLEANUP SIGN-OFF
              </span>
            )}
            {client.paused && (
              <span className="text-[10px] font-bold bg-gray-100 text-ink-slate px-1.5 py-0.5 rounded">
                RECON PAUSED
              </span>
            )}
            {isPending && (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold bg-purple-100 text-purple-800 px-2 py-0.5 rounded">
                Awaiting senior approval
              </span>
            )}
            {!isPending && isComplete ? (
              <span
                className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded ${
                  run?.has_concerns
                    ? "bg-amber-100 text-amber-800"
                    : "bg-emerald-100 text-emerald-700"
                }`}
              >
                <CheckCircle2 size={10} />
                {run?.has_concerns ? "Done — concerns noted" : "Done"}
              </span>
            ) : run?.checks_ran_at ? (
              <OverallBadge overall={overall} />
            ) : (
              <span className="text-[11px] font-semibold bg-gray-100 text-ink-slate px-2 py-0.5 rounded">
                Not started
              </span>
            )}
          </div>
        </div>
        {!isComplete && !isPending && (
          <button
            onClick={runChecks}
            disabled={running}
            className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-3 py-2 rounded-lg disabled:opacity-50 flex-shrink-0"
          >
            {running ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <PlayCircle size={12} />
            )}
            {run?.checks_ran_at ? "Re-run checks" : "Run checks"}
          </button>
        )}
        {isPending && isSenior && !reviewing && (
          <button
            onClick={() => {
              setExpanded(true);
              loadStatements();
            }}
            disabled={loadingStatements}
            className="inline-flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold px-3 py-2 rounded-lg disabled:opacity-50 flex-shrink-0"
          >
            {loadingStatements ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <FileText size={12} />
            )}
            Review &amp; approve
          </button>
        )}
        {isPending && (
          <button
            onClick={reopen}
            disabled={completing}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-slate hover:text-navy px-2 py-1.5 disabled:opacity-50 flex-shrink-0"
            title={isSenior ? "Send back to the bookkeeper" : "Withdraw and keep working"}
          >
            <RotateCcw size={11} />
            {isSenior ? "Send back to bookkeeper" : "Withdraw"}
          </button>
        )}
        {isComplete && (
          <button
            onClick={reopen}
            disabled={completing}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-slate hover:text-navy px-2 py-1.5 disabled:opacity-50 flex-shrink-0"
            title="Reopen this month"
          >
            <RotateCcw size={11} />
            Reopen
          </button>
        )}
      </div>

      {error && (
        <div className="mx-4 mb-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{error}</div>
      )}

      {/* Expanded: checklist + concerns + complete */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-4 space-y-4 bg-gray-50/40">
          {checks.length === 0 ? (
            <p className="text-sm text-ink-slate">
              No checks run yet for this month — hit <strong>Run checks</strong> to
              pull last month&apos;s state from QuickBooks (takes ~10 seconds).
            </p>
          ) : (
            <ul className="space-y-2">
              {checks.map((c) => {
                const link = vFixLink(c.fix, client.id);
                return (
                  <li
                    key={c.key}
                    className="flex items-start gap-2.5 bg-white border border-gray-100 rounded-xl px-3 py-2.5"
                  >
                    <StatusIcon status={c.status} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-navy">{c.label}</div>
                      <div className="text-xs text-ink-slate mt-0.5">{c.detail}</div>
                    </div>
                    {link && c.status !== "pass" && (
                      <Link
                        href={link.href}
                        className="inline-flex items-center gap-1 text-[11px] font-bold text-teal hover:underline flex-shrink-0 mt-1"
                      >
                        {link.label}
                        <ArrowUpRight size={11} />
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* ── BOOKS RELIABILITY ── verify → work findings → score gates the send. */}
          <VerificationPanel
            clientId={client.id}
            period={period}
            verification={(run as any)?.verification || null}
            verificationRanAt={(run as any)?.verification_ran_at || null}
            checksRanAt={run?.checks_ran_at || null}
            isSenior={isSenior}
            locked={isComplete || isPending}
            onRun={(r) => setLocalRun(r)}
          />

          {/* ── THE CLOSE GATE ──
              Step 1: review the actual financial statements.
              Step 2: attest. Step 3: send → email + portal notification +
              period closed. No shortcut to "complete". */}
          {!isComplete && !isPending && !reviewing && (
            <button
              onClick={loadStatements}
              disabled={loadingStatements || !run?.checks_ran_at}
              title={!run?.checks_ran_at ? "Run the checks first" : undefined}
              className="inline-flex items-center gap-2 bg-navy hover:bg-ink-light text-white text-sm font-bold px-4 py-2 rounded-lg disabled:opacity-50"
            >
              {loadingStatements ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <FileText size={13} />
              )}
              Review financial statements
            </button>
          )}

          {isPending && !isSenior && (
            <p className="text-sm text-ink-slate">
              Submitted for senior review
              {run?.submitted_at ? ` ${new Date(run.submitted_at).toLocaleString()}` : ""} —
              a lead/admin will review the statements and send them to the client.
              {run?.concerns && (
                <span className="block mt-1 text-xs text-amber-800">Concerns noted: {run.concerns}</span>
              )}
            </p>
          )}

          {!isComplete && reviewing && run?.statements && (
            <div className="space-y-4">
              <StatementsReview statements={run.statements} monthLabel={periodLabel(period)} />

              <SpotCheckPanel spot={run.ai_spot_check || null} loading={spotChecking} />

              <div>
                <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider">
                  Concerns (optional)
                </label>
                <textarea
                  value={concerns}
                  onChange={(e) => setConcerns(e.target.value)}
                  rows={2}
                  maxLength={4000}
                  placeholder="Anything off this month? e.g. recurring vendor uncategorized, client says revenue looks low…"
                  className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:border-teal/50 focus:outline-none"
                />
              </div>

              {/* Draft-with-a-question — the "not sure yet" path. Sends the
                  client DRAFT numbers + your question; the month stays open. */}
              {(run?.draft_sends?.length || 0) > 0 && (
                <div className="text-[11px] font-semibold text-sky-800 bg-sky-50 border border-sky-200 rounded-lg px-3 py-1.5">
                  DRAFT sent {new Date(run!.draft_sends![run!.draft_sends!.length - 1].at).toLocaleDateString()}
                  {run!.draft_sends![run!.draft_sends!.length - 1].by_name
                    ? ` by ${run!.draft_sends![run!.draft_sends!.length - 1].by_name}`
                    : ""}{" "}
                  — waiting on the client&apos;s answer. Send the final statements once it&apos;s resolved.
                </div>
              )}
              <div className="bg-sky-50/60 border border-sky-200 rounded-xl px-3 py-3 space-y-2">
                <div className="text-xs font-bold text-navy flex items-center gap-1.5">
                  <AlertCircle size={13} className="text-sky-600" />
                  Not sure about something? Send a DRAFT with a question instead
                </div>
                <textarea
                  value={draftQuestion}
                  onChange={(e) => setDraftQuestion(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder="e.g. We see two Lowe's charges for $2,226 on May 8 and 9 — were both real purchases?"
                  className="w-full px-3 py-2 text-sm border border-sky-200 rounded-lg bg-white focus:border-sky-400 focus:outline-none"
                />
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={sendDraft}
                    disabled={draftBusy || !draftQuestion.trim()}
                    className="inline-flex items-center gap-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg disabled:opacity-50"
                  >
                    {draftBusy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                    Send DRAFT + question
                  </button>
                  <span className="text-[11px] text-ink-light">
                    Portal + email, numbers marked DRAFT. Does <strong>not</strong> close the month.
                  </span>
                </div>
                {draftNotice && (
                  <div className="text-[11px] text-sky-900 bg-white border border-sky-200 rounded-lg px-2.5 py-1.5">
                    {draftNotice}
                  </div>
                )}
              </div>

              <label className="flex items-start gap-2.5 cursor-pointer bg-white border border-gray-200 rounded-xl px-3 py-3">
                <input
                  type="checkbox"
                  checked={attested}
                  onChange={(e) => setAttested(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-2 border-gray-300 text-teal focus:ring-teal"
                />
                <span className="text-xs text-navy leading-relaxed">
                  I have reviewed {client.client_name}&apos;s {periodLabel(period)}{" "}
                  {run?.statements?.bs
                    ? "Profit & Loss, Balance Sheet, and Cash Flow Statement"
                    : "Profit & Loss (P&L-only service)"}{" "}
                  above (including the AI spot check), and they are accurate and
                  ready to share with the client.
                </span>
              </label>

              {/* Red-flag approval gate — the server refuses the send while
                  any of these are open. Approve = dismiss with a reason. */}
              {redFlags && redFlags.length > 0 && (
                <div className="bg-red-50 border-2 border-red-300 rounded-xl px-3 py-3 space-y-2">
                  <div className="text-xs font-bold text-red-900 flex items-center gap-1.5">
                    <AlertTriangle size={13} />
                    {redFlags.length} red flag{redFlags.length === 1 ? "" : "s"} need manual approval before this month goes out
                  </div>
                  <ul className="space-y-2">
                    {redFlags.map((f) => {
                      const link = vFixLink(f.fix, client.id);
                      return (
                        <li key={f.fingerprint} className="bg-white border border-red-200 rounded-lg px-2.5 py-2">
                          <div className="text-[11px] font-bold text-red-800 uppercase tracking-wide">{f.check_label}</div>
                          <p className="text-xs text-navy mt-0.5">{f.message}</p>
                          <div className="flex items-center gap-2.5 mt-1.5">
                            <button
                              onClick={() => approveRedFlag(f)}
                              className="text-[11px] font-bold text-red-700 border border-red-300 rounded-lg px-2 py-1 hover:bg-red-100"
                            >
                              Approve with reason…
                            </button>
                            {link && (
                              <Link
                                href={link.href}
                                className="text-[11px] font-semibold text-teal-dark hover:underline inline-flex items-center gap-0.5"
                              >
                                {link.label} <ArrowUpRight size={10} />
                              </Link>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="text-[11px] text-red-800">
                    Fix it in QuickBooks and re-verify, or approve each flag with a reason (recorded with your name) — then send again.
                  </p>
                </div>
              )}
              {redFlags && redFlags.length === 0 && (
                <div className="text-[11px] font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5">
                  All red flags approved — click send again.
                </div>
              )}

              {isSenior ? (
                <>
                  {needsManagerReview && (
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
                      <AlertCircle size={12} />
                      Awaiting Kedma&apos;s review this month — she can send it herself, or you can send with a written override.
                    </div>
                  )}
                  <button
                    onClick={() => sendToClient()}
                    disabled={completing || !attested}
                    title={!attested ? "Tick the attestation first" : undefined}
                    className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold px-4 py-2 rounded-lg disabled:opacity-50"
                  >
                    {completing ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Send size={13} />
                    )}
                    Approve &amp; send to client
                  </button>
                  <p className="text-[11px] text-ink-light -mt-2">
                    Emails the client, posts a notification in their portal, and closes {periodLabel(period)}
                    {isCleanupKind ? " — and marks the cleanup complete" : ""}.
                  </p>
                </>
              ) : (
                <>
                  <button
                    onClick={submitForReview}
                    disabled={completing || !attested}
                    title={!attested ? "Tick the attestation first" : undefined}
                    className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold px-4 py-2 rounded-lg disabled:opacity-50"
                  >
                    {completing ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Send size={13} />
                    )}
                    Submit for senior review
                  </button>
                  <p className="text-[11px] text-ink-light -mt-2">
                    Goes to a lead/admin&apos;s Today queue — they review the same
                    statements and approve the send to the client.
                  </p>
                </>
              )}
            </div>
          )}

          {sendWarning && (
            <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-900">{sendWarning}</div>
          )}

          {isComplete && (
            <div className="space-y-2">
              <div className="text-xs text-emerald-800 font-semibold flex items-center gap-1.5">
                <Send size={11} />
                Sent to client{run?.sent_to_client_at ? ` · ${new Date(run.sent_to_client_at).toLocaleString()}` : ""}
              </div>
              {run?.email_delivery && !run.email_delivery.sent && (
                <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
                  No email went out ({run.email_delivery.reason === "no_portal_user" ? "client has no portal login" : "send failed"}) — the portal notification is there, but consider reaching them another way.
                </div>
              )}
              {run?.concerns && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
                  <strong className="block mb-0.5">Concerns noted:</strong>
                  {run.concerns}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── STATEMENTS REVIEW ───────────────────────────────────────────────────
// What the client will see — reviewed in full before the attestation.

const money = (n: number) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
};

/** amount as a % of total income (the client-facing P&L column). */
function pctOfIncome(n: number, income: number): string {
  if (!(income > 0)) return "—";
  return `${((n / income) * 100).toFixed(1)}%`;
}

/**
 * Client-format Profit & Loss: Income → COGS → Gross Profit → Operating
 * Expenses → Net, with each account under its section, a % of income column,
 * subtotals, and KPI flags on Gross Profit / Net when margins fall outside the
 * healthy band (same bands as the month-end red-flag gate: COGS 20–65% of
 * revenue, net margin 10–35%). Drives both the month-end review and the
 * cleanup wizard so the bookkeeper sees exactly what the client will.
 */
function PLStatementView({ pl, monthLabel }: { pl: Statements["pl"]; monthLabel: string }) {
  const income = Number(pl.totalIncome) || 0;
  const cogs = Number(pl.cogs) || 0;
  const grossProfit = pl.grossProfit != null ? Number(pl.grossProfit) : income - cogs;
  const opex = Number(pl.totalExpenses) || 0;
  const net = Number(pl.netIncome) || 0;

  const g = (li: { group?: string }) => String(li.group || "");
  const hasCogsSection = /cogs|cost of goods/i;
  const otherIncomeLines = pl.lineItems.filter((li) => /other\s*income/i.test(g(li)));
  const otherExpenseLines = pl.lineItems.filter((li) => /other\s*expense/i.test(g(li)));
  const incomeLines = pl.lineItems.filter(
    (li) => /income/i.test(g(li)) && !/other/i.test(g(li)) && !hasCogsSection.test(g(li))
  );
  const cogsLines = pl.lineItems.filter((li) => hasCogsSection.test(g(li)));
  const opexLines = pl.lineItems.filter(
    (li) => /expense/i.test(g(li)) && !/other/i.test(g(li)) && !hasCogsSection.test(g(li))
  );

  // KPI bands — identical to lib/books-verification cogs_ratio / net_margin.
  const cogsPct = income > 0 ? (cogs / income) * 100 : 0;
  const netPct = income > 0 ? (net / income) * 100 : 0;
  const gmPct = income > 0 ? (grossProfit / income) * 100 : 0;
  const showCogs = cogs > 0.005 || cogsLines.length > 0;
  const gpFlag = income > 0 && showCogs && (cogsPct < 20 || cogsPct > 65);
  const npFlag = income > 0 && (netPct < 10 || netPct > 35);

  type PlRow = {
    kind: "section" | "line" | "subtotal" | "band";
    label: string;
    amount?: number;
    pct?: string;
    flag?: boolean;
    tone?: "navy" | "emerald" | "red";
  };
  const rows: PlRow[] = [];
  const pushLines = (lines: { label: string; amount: number }[]) =>
    lines.forEach((li) => rows.push({ kind: "line", label: li.label, amount: li.amount, pct: pctOfIncome(li.amount, income) }));

  rows.push({ kind: "section", label: "Income" });
  pushLines(incomeLines);
  rows.push({ kind: "subtotal", label: "Total Income", amount: income, pct: income > 0 ? "100.0%" : "—" });
  if (showCogs) {
    rows.push({ kind: "section", label: "Cost of Goods Sold" });
    pushLines(cogsLines);
    rows.push({ kind: "subtotal", label: "Total COGS", amount: cogs, pct: pctOfIncome(cogs, income) });
    rows.push({ kind: "band", label: "Gross Profit", amount: grossProfit, pct: pctOfIncome(grossProfit, income), flag: gpFlag, tone: "navy" });
  }
  rows.push({ kind: "section", label: "Operating Expenses" });
  pushLines(opexLines);
  rows.push({ kind: "subtotal", label: "Total Operating Expenses", amount: opex, pct: pctOfIncome(opex, income) });
  if (otherIncomeLines.length) {
    rows.push({ kind: "section", label: "Other Income" });
    pushLines(otherIncomeLines);
  }
  if (otherExpenseLines.length) {
    rows.push({ kind: "section", label: "Other Expense" });
    pushLines(otherExpenseLines);
  }
  rows.push({ kind: "band", label: `Net ${net >= 0 ? "Profit" : "Loss"}`, amount: net, pct: pctOfIncome(net, income), flag: npFlag, tone: net >= 0 ? "emerald" : "red" });

  const toneText = (t?: string) => (t === "emerald" ? "text-emerald-700" : t === "red" ? "text-red-700" : "text-navy");

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 bg-navy text-white text-sm font-bold">Profit &amp; Loss — {monthLabel}</div>

      {(gpFlag || npFlag) && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1 font-bold"><AlertTriangle size={13} className="text-amber-600" /> KPI check</span>
          {gpFlag && (
            <span>Gross margin <strong>{gmPct.toFixed(0)}%</strong> — outside the healthy 35–80% band (COGS {cogsPct.toFixed(0)}%).</span>
          )}
          {npFlag && (
            <span>Net margin <strong>{netPct.toFixed(0)}%</strong> — outside the healthy 10–35% band.</span>
          )}
        </div>
      )}

      <div className="max-h-96 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-ink-light border-b border-gray-100 bg-gray-50/50">
              <th className="px-4 py-1.5 text-left font-semibold">Account</th>
              <th className="px-4 py-1.5 text-right font-semibold">Amount</th>
              <th className="px-4 py-1.5 text-right font-semibold whitespace-nowrap">% of income</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              if (r.kind === "section") {
                return (
                  <tr key={i} className="bg-gray-50/70">
                    <td colSpan={3} className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-ink-slate">
                      {r.label}
                    </td>
                  </tr>
                );
              }
              if (r.kind === "line") {
                return (
                  <tr key={i} className="border-t border-gray-50">
                    <td className="px-4 py-1 text-ink-slate pl-7">{r.label}</td>
                    <td className="px-4 py-1 text-right font-mono text-navy whitespace-nowrap">${money(r.amount || 0)}</td>
                    <td className="px-4 py-1 text-right font-mono text-ink-light whitespace-nowrap">{r.pct}</td>
                  </tr>
                );
              }
              if (r.kind === "subtotal") {
                return (
                  <tr key={i} className="border-t border-gray-100 bg-gray-50/30">
                    <td className="px-4 py-1 font-semibold text-navy">{r.label}</td>
                    <td className="px-4 py-1 text-right font-mono font-semibold text-navy whitespace-nowrap">${money(r.amount || 0)}</td>
                    <td className="px-4 py-1 text-right font-mono text-ink-slate whitespace-nowrap">{r.pct}</td>
                  </tr>
                );
              }
              // band (Gross Profit / Net)
              return (
                <tr key={i} className={`border-t-2 ${r.flag ? "border-amber-300 bg-amber-50/60" : "border-gray-200 bg-gray-50/60"}`}>
                  <td className={`px-4 py-1.5 font-bold ${toneText(r.tone)}`}>
                    {r.label}
                    {r.flag && <span className="ml-1.5 text-[9px] font-bold uppercase text-amber-700 bg-amber-100 px-1 py-0.5 rounded">out of KPI</span>}
                  </td>
                  <td className={`px-4 py-1.5 text-right font-mono font-bold whitespace-nowrap ${toneText(r.tone)}`}>${money(r.amount || 0)}</td>
                  <td className={`px-4 py-1.5 text-right font-mono font-semibold whitespace-nowrap ${r.flag ? "text-amber-700" : "text-ink-slate"}`}>{r.pct}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Client-format Balance Sheet: Assets / Liabilities / Equity as sections with
 * their accounts indented beneath, bold subtotals, the section totals, and a
 * balance check (Assets must equal Liabilities + Equity). Mirrors the P&L
 * view so the bookkeeper reviews the same statement the client receives.
 */
function BSStatementView({
  bs,
  monthLabel,
}: {
  bs: NonNullable<Statements["bs"]>;
  monthLabel: string;
}) {
  const liabPlusEquity = (Number(bs.totalLiabilities) || 0) + (Number(bs.totalEquity) || 0);
  const diff = (Number(bs.totalAssets) || 0) - liabPlusEquity;
  const balanced = Math.abs(diff) <= 1; // $1 rounding tolerance
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 bg-navy text-white text-sm font-bold">
        Balance Sheet — as of end of {monthLabel}
      </div>
      {!balanced && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900 flex items-center gap-1.5">
          <AlertTriangle size={13} className="text-amber-600" />
          <span>
            Out of balance by <strong>${money(diff)}</strong> — Assets don&apos;t equal Liabilities + Equity. Finish the BS cleanup before sending.
          </span>
        </div>
      )}
      <div className="max-h-96 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-ink-light border-b border-gray-100 bg-gray-50/50">
              <th className="px-4 py-1.5 text-left font-semibold">Account</th>
              <th className="px-4 py-1.5 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody>
            {bs.lines.map((l, i) => {
              const isTotal = /^total/i.test(l.label);
              return (
                <tr key={i} className={`border-t border-gray-50 ${isTotal ? "bg-gray-50/40" : ""}`}>
                  <td
                    className={`px-4 py-1 ${isTotal ? "font-semibold text-navy" : "text-ink-slate"}`}
                    style={{ paddingLeft: `${16 + Math.min(l.depth, 4) * 14}px` }}
                  >
                    {l.label}
                  </td>
                  <td className={`px-4 py-1 text-right font-mono whitespace-nowrap ${isTotal ? "font-semibold text-navy" : "text-navy"}`}>
                    ${money(l.amount)}
                  </td>
                </tr>
              );
            })}
            {/* Totals footer — the client-statement bottom line. */}
            <tr className="border-t-2 border-gray-200 bg-gray-50/60">
              <td className="px-4 py-1.5 font-bold text-navy">Total Assets</td>
              <td className="px-4 py-1.5 text-right font-mono font-bold text-navy whitespace-nowrap">${money(bs.totalAssets)}</td>
            </tr>
            <tr className={`border-t ${balanced ? "border-gray-100" : "border-amber-200 bg-amber-50/60"}`}>
              <td className="px-4 py-1.5 font-bold text-navy">Total Liabilities &amp; Equity</td>
              <td className="px-4 py-1.5 text-right font-mono font-bold text-navy whitespace-nowrap">${money(liabPlusEquity)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function StatementsReview({
  statements,
  monthLabel,
}: {
  statements: Statements;
  monthLabel: string;
}) {
  const { pl, bs, cfs } = statements;
  return (
    <div className="space-y-3">
      {/* P&L — client-facing statement format: categories → accounts, % of
          income, waterfall totals, and GP/NP KPI flags. */}
      <PLStatementView pl={pl} monthLabel={monthLabel} />

      {!bs && (
        <div className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-ink-slate">
          <strong className="text-navy">P&L-only service</strong> — this client's
          Balance Sheet toggle is off while their BS cleanup finishes. Only the
          Profit &amp; Loss is reviewed and sent.
        </div>
      )}

      {/* Balance Sheet — same client-statement format as the P&L. */}
      {bs && <BSStatementView bs={bs} monthLabel={monthLabel} />}

      {/* Cash Flow Statement */}
      {cfs && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 bg-navy text-white text-sm font-bold">
            Cash Flow — {monthLabel}
          </div>
          <div className="grid grid-cols-4 divide-x divide-gray-100 text-center border-b border-gray-100">
            <div className="py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-ink-slate font-semibold">Operating</div>
              <div className="font-mono font-bold text-navy">${money(cfs.operating?.total || 0)}</div>
            </div>
            <div className="py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-ink-slate font-semibold">Investing</div>
              <div className="font-mono font-bold text-navy">${money(cfs.investing?.total || 0)}</div>
            </div>
            <div className="py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-ink-slate font-semibold">Financing</div>
              <div className="font-mono font-bold text-navy">${money(cfs.financing?.total || 0)}</div>
            </div>
            <div className="py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-ink-slate font-semibold">Net change</div>
              <div className={`font-mono font-bold ${cfs.netCashChange >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                ${money(cfs.netCashChange)}
              </div>
            </div>
          </div>
          <div className="px-4 py-2 text-xs text-ink-slate flex items-center justify-between">
            <span>Cash at start: <span className="font-mono text-navy">${money(cfs.cashAtStart)}</span></span>
            <span>Cash at end: <span className="font-mono font-semibold text-navy">${money(cfs.cashAtEnd)}</span></span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── AI SPOT CHECK PANEL ─────────────────────────────────────────────────

function SpotCheckPanel({ spot, loading }: { spot: SpotCheck | null; loading: boolean }) {
  if (loading && !spot) {
    return (
      <div className="bg-violet-50 border border-violet-200 rounded-xl px-4 py-3 flex items-center gap-2.5 text-sm text-violet-900">
        <Loader2 size={14} className="animate-spin text-violet-600" />
        AI is spot-checking these statements against painting-industry standards…
      </div>
    );
  }
  if (!spot) return null;
  const ok = spot.verdict === "looks_good";
  return (
    <div
      className={`rounded-xl border overflow-hidden ${
        ok ? "border-emerald-200" : "border-amber-300"
      }`}
    >
      <div
        className={`px-4 py-2.5 flex items-center gap-2 text-sm font-bold ${
          ok ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"
        }`}
      >
        <Sparkles size={14} className={ok ? "text-emerald-600" : "text-amber-600"} />
        AI spot check: {ok ? "looks good" : "review the items below"}
        {loading && <Loader2 size={12} className="animate-spin ml-1 opacity-60" />}
      </div>
      <div className="px-4 py-3 bg-white space-y-2">
        {spot.summary && <p className="text-xs text-ink-slate">{spot.summary}</p>}
        {spot.findings.length > 0 && (
          <ul className="space-y-1.5">
            {spot.findings.map((f, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                {f.severity === "flag" ? (
                  <XCircle size={13} className="text-red-600 flex-shrink-0 mt-0.5" />
                ) : f.severity === "warn" ? (
                  <AlertTriangle size={13} className="text-amber-500 flex-shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle2 size={13} className="text-slate-400 flex-shrink-0 mt-0.5" />
                )}
                <span className="text-ink-slate">
                  <strong className="text-navy">{f.area}:</strong> {f.note}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[10px] text-ink-light">
          Advisory only — your review is the one that counts.
          {spot.error ? ` (AI check degraded: ${spot.error})` : ""}
        </p>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "pass") return <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />;
  if (status === "warn") return <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />;
  return <XCircle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />;
}

function OverallBadge({ overall }: { overall?: CheckStatus }) {
  if (overall === "pass")
    return (
      <span className="text-[11px] font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded">
        All checks pass — ready to complete
      </span>
    );
  if (overall === "warn")
    return (
      <span className="text-[11px] font-bold bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
        Minor items to review
      </span>
    );
  return (
    <span className="text-[11px] font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded">
      Needs attention
    </span>
  );
}

// ─── ELIGIBLE (READY TO PROMOTE) ────────────────────────────────────────

export function EligibleRow({
  client,
  isSenior,
  onPromoted,
}: {
  client: EligibleClient;
  isSenior: boolean;
  onPromoted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function promote() {
    if (
      !confirm(
        `Promote ${client.client_name} to production?\n\nTheir books are maintained going forward: daily recon runs nightly and they join the Monthly Rec routine.`
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${client.id}/production`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enable" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      playSound("client_graduated");
      onPromoted();
    } catch (e: any) {
      setError(e?.message || "Promote failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="py-2 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <span className="text-sm font-semibold text-navy">{client.client_name}</span>
        <span className="text-xs text-ink-slate ml-2">
          cleanup done {new Date(client.cleanup_completed_at).toLocaleDateString()}
        </span>
        {error && <span className="text-xs text-red-700 ml-2">{error}</span>}
      </div>
      {isSenior ? (
        <button
          onClick={promote}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-white bg-navy hover:bg-ink-light px-3 py-1.5 rounded-lg disabled:opacity-50 flex-shrink-0"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
          Promote to production
        </button>
      ) : (
        <Link
          href={`/clients/${client.id}`}
          className="text-xs font-semibold text-teal hover:underline flex-shrink-0"
        >
          View profile
        </Link>
      )}
    </li>
  );
}
