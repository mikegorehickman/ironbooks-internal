"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowUpRight, CalendarCheck, CheckCircle2, ChevronDown,
  ChevronLeft, ChevronRight, FileText, Loader2, PlayCircle, RotateCcw,
  Send, Sparkles, XCircle,
} from "lucide-react";
import { playSound } from "@/lib/sounds";

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

interface Statements {
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
  };
}

interface Run {
  status: "open" | "complete";
  has_concerns: boolean;
  concerns: string | null;
  checks: { checks: Check[]; overall: CheckStatus } | null;
  checks_ran_at: string | null;
  completed_at: string | null;
  statements?: Statements | null;
  sent_to_client_at?: string | null;
  email_delivery?: { sent: boolean; reason?: string } | null;
}

interface ProdClient {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  paused: boolean;
  last_synced_at: string | null;
  run: Run | null;
}

interface EligibleClient {
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
      return { href: "/reclass/new", label: "Open Reclassify" };
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

function shiftPeriod(period: string, delta: number): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function MonthlyRecClient() {
  const [period, setPeriod] = useState<string>("");
  const [production, setProduction] = useState<ProdClient[]>([]);
  const [eligible, setEligible] = useState<EligibleClient[]>([]);
  const [isSenior, setIsSenior] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load(p?: string) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/monthly-rec${p ? `?period=${p}` : ""}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setPeriod(body.period);
      setProduction(body.production || []);
      setEligible(body.eligible || []);
      setIsSenior(!!body.is_senior);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const doneCount = production.filter((c) => c.run?.status === "complete").length;

  return (
    <div className="space-y-5">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>
      )}

      {/* Period switcher + progress */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex items-center gap-3 flex-wrap">
        <div className="p-2 rounded-lg bg-teal-light">
          <CalendarCheck size={18} className="text-teal" />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => load(shiftPeriod(period, -1))}
            disabled={!period || loading}
            className="p-1.5 rounded hover:bg-gray-100 text-ink-slate disabled:opacity-40"
            aria-label="Previous month"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="font-bold text-navy min-w-[140px] text-center">
            {period ? periodLabel(period) : "…"}
          </span>
          <button
            onClick={() => load(shiftPeriod(period, 1))}
            disabled={!period || loading}
            className="p-1.5 rounded hover:bg-gray-100 text-ink-slate disabled:opacity-40"
            aria-label="Next month"
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <div className="flex-1" />
        {production.length > 0 && (
          <span className="text-sm text-ink-slate">
            <strong className="text-navy">{doneCount}</strong> of{" "}
            <strong className="text-navy">{production.length}</strong> complete
          </span>
        )}
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center">
          <Loader2 className="animate-spin text-teal mx-auto" size={28} />
        </div>
      ) : (
        <>
          {/* Production roster */}
          {production.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center">
              <Sparkles size={28} className="mx-auto text-teal mb-2" />
              <h3 className="font-bold text-navy">No clients in production yet</h3>
              <p className="text-sm text-ink-slate mt-1 max-w-md mx-auto">
                Once a client&apos;s balance sheet is clean, promote them to
                production from their client profile — they&apos;ll show up here
                for the fast monthly routine.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {production.map((c) => (
                <ClientRecCard key={c.id} client={c} period={period} onChanged={() => load(period)} />
              ))}
            </div>
          )}

          {/* Ready to promote */}
          {eligible.length > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
              <h3 className="text-sm font-bold text-navy mb-1">
                Ready for production ({eligible.length})
              </h3>
              <p className="text-xs text-ink-slate mb-3">
                Cleanup complete, not yet promoted. {isSenior
                  ? "Promote them and they join the monthly routine."
                  : "Ask an admin or lead to promote them from the client profile."}
              </p>
              <ul className="divide-y divide-slate-200/70">
                {eligible.map((c) => (
                  <EligibleRow key={c.id} client={c} isSenior={isSenior} onPromoted={() => load(period)} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── PER-CLIENT CARD ─────────────────────────────────────────────────────

function ClientRecCard({
  client,
  period,
  onChanged,
}: {
  client: ProdClient;
  period: string;
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
    } catch (e: any) {
      setError(e?.message || "Couldn't load statements");
    } finally {
      setLoadingStatements(false);
    }
  }

  async function sendToClient() {
    setCompleting(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${client.id}/monthly-rec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", period, attested: true, concerns }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
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
            <span className="font-bold text-navy">{client.client_name}</span>
            {client.paused && (
              <span className="text-[10px] font-bold bg-gray-100 text-ink-slate px-1.5 py-0.5 rounded">
                RECON PAUSED
              </span>
            )}
            {isComplete ? (
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
        {!isComplete && (
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

          {/* ── THE CLOSE GATE ──
              Step 1: review the actual financial statements.
              Step 2: attest. Step 3: send → email + portal notification +
              period closed. No shortcut to "complete". */}
          {!isComplete && !reviewing && (
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

          {!isComplete && reviewing && run?.statements && (
            <div className="space-y-4">
              <StatementsReview statements={run.statements} monthLabel={periodLabel(period)} />

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
                  Profit &amp; Loss and Balance Sheet above, and they are accurate
                  and ready to share with the client.
                </span>
              </label>

              <button
                onClick={sendToClient}
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
                Emails the client, posts a notification in their portal, and closes {periodLabel(period)}.
              </p>
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

function StatementsReview({
  statements,
  monthLabel,
}: {
  statements: Statements;
  monthLabel: string;
}) {
  const { pl, bs } = statements;
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

      {/* Balance Sheet */}
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

function EligibleRow({
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
