"use client";

/**
 * Shared per-client monthly close card + statement review flow.
 * Used by /production (board) and /cleanup (sign-off column).
 * Extracted verbatim from app/monthly-rec/monthly-rec-client.tsx.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowUpRight, CheckCircle2, ChevronDown, ChevronRight,
  FileText, Loader2, PlayCircle, RotateCcw, Send, Sparkles, XCircle,
} from "lucide-react";
import { playSound } from "@/lib/sounds";
import { VerificationPanel } from "./verification-panel";

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
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

export interface CashFlowSection {
  title: string;
  total: number;
  items: { label: string; amount: number }[];
}

export interface Statements {
  pl: {
    totalIncome: number;
    totalExpenses: number;
    netIncome: number;
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

export interface SpotCheck {
  verdict: "looks_good" | "needs_review";
  summary: string;
  findings: { severity: "info" | "warn" | "flag"; area: string; note: string }[];
  error?: string;
}

export interface Run {
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
}

export interface ProdClient {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  paused: boolean;
  last_synced_at: string | null;
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
  jurisdiction: string;
  state_province: string | null;
  cleanup_completed_at: string;
}

/** Deep link into the right fix tool for a failed check. */
function fixLink(fix: Check["fix"], clientId: string): { href: string; label: string } | null {
  switch (fix) {
    case "reclass":
      // ?client= preselects this client in the reclass form — no picker hunt
      return { href: `/reclass/new?client=${clientId}`, label: "Open Reclassify" };
    case "uf_audit":
      return { href: `/balance-sheet/${clientId}/uf-audit`, label: "Open UF Audit" };
    case "ar":
      return { href: `/clients/${clientId}`, label: "Open client profile" };
    case "profile":
      return { href: `/clients/${clientId}`, label: "Open client profile" };
    case "connections":
      return { href: "/fleet/qbo-health", label: "QBO Connections" };
    default:
      return null;
  }
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

  useEffect(() => {
    setLocalRun(client.run);
    setConcerns(client.run?.concerns || "");
  }, [client.run]);

  const run = localRun;
  const checks = run?.checks?.checks || [];
  const overall = run?.checks?.overall;
  const isComplete = run?.status === "complete";
  const isPending = run?.status === "pending_review";
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

  async function sendToClient(overrideReason?: string) {
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
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        // Books Reliability gate: score below the bar — a senior can override
        // with a written reason (recorded on the run + audited).
        if (res.status === 409 && json.requires_override) {
          const reason = window.prompt(
            `${json.error}\n\nTo send anyway, enter an override reason (recorded with your name):`
          );
          if (reason && reason.trim()) {
            setCompleting(false);
            return sendToClient(reason.trim());
          }
          throw new Error("Send cancelled — fix the findings and re-verify, or provide an override reason.");
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
      playSound("client_graduated");
      onChanged();
    } catch (e: any) {
      setError(e?.message || "Couldn't send");
    } finally {
      setCompleting(false);
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
            <Link
              href={`/clients/${client.id}`}
              className="font-bold text-navy hover:text-teal hover:underline"
              title="Open client profile"
            >
              {client.client_name}
            </Link>
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
                const link = c.fix ? fixLink(c.fix, client.id) : null;
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

              {isSenior ? (
                <>
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
      {/* P&L */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 bg-navy text-white text-sm font-bold">
          Profit &amp; Loss — {monthLabel}
        </div>
        <div className="grid grid-cols-3 divide-x divide-gray-100 text-center border-b border-gray-100">
          <div className="py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-ink-slate font-semibold">Income</div>
            <div className="font-mono font-bold text-navy">${money(pl.totalIncome)}</div>
          </div>
          <div className="py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-ink-slate font-semibold">Expenses</div>
            <div className="font-mono font-bold text-navy">${money(pl.totalExpenses)}</div>
          </div>
          <div className="py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-ink-slate font-semibold">
              Net {pl.netIncome >= 0 ? "profit" : "loss"}
            </div>
            <div className={`font-mono font-bold ${pl.netIncome >= 0 ? "text-emerald-700" : "text-red-700"}`}>
              ${money(pl.netIncome)}
            </div>
          </div>
        </div>
        <div className="max-h-56 overflow-y-auto">
          <table className="w-full text-xs">
            <tbody>
              {pl.lineItems.map((li, i) => (
                <tr key={i} className="border-t border-gray-50">
                  <td className="px-4 py-1 text-ink-slate">
                    <span className="text-ink-light">{li.group ? `${li.group} · ` : ""}</span>
                    {li.label}
                  </td>
                  <td className="px-4 py-1 text-right font-mono text-navy whitespace-nowrap">${money(li.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {!bs && (
        <div className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-ink-slate">
          <strong className="text-navy">P&L-only service</strong> — this client's
          Balance Sheet toggle is off while their BS cleanup finishes. Only the
          Profit &amp; Loss is reviewed and sent.
        </div>
      )}

      {/* Balance Sheet */}
      {bs && (
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 bg-navy text-white text-sm font-bold">
          Balance Sheet — as of end of {monthLabel}
        </div>
        <div className="grid grid-cols-3 divide-x divide-gray-100 text-center border-b border-gray-100">
          <div className="py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-ink-slate font-semibold">Assets</div>
            <div className="font-mono font-bold text-navy">${money(bs.totalAssets)}</div>
          </div>
          <div className="py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-ink-slate font-semibold">Liabilities</div>
            <div className="font-mono font-bold text-navy">${money(bs.totalLiabilities)}</div>
          </div>
          <div className="py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-ink-slate font-semibold">Equity</div>
            <div className="font-mono font-bold text-navy">${money(bs.totalEquity)}</div>
          </div>
        </div>
        <div className="max-h-56 overflow-y-auto">
          <table className="w-full text-xs">
            <tbody>
              {bs.lines.map((l, i) => (
                <tr key={i} className="border-t border-gray-50">
                  <td
                    className={`px-4 py-1 ${/^total/i.test(l.label) ? "font-semibold text-navy" : "text-ink-slate"}`}
                    style={{ paddingLeft: `${16 + Math.min(l.depth, 4) * 12}px` }}
                  >
                    {l.label}
                  </td>
                  <td className="px-4 py-1 text-right font-mono text-navy whitespace-nowrap">${money(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      )}

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
