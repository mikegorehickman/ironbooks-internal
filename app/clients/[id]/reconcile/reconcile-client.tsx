"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowRight, CheckCircle2, ClipboardCopy, ExternalLink, Landmark, Loader2,
  Lightbulb, Lock, RotateCcw, Sparkles, TriangleAlert, X,
} from "lucide-react";

/**
 * Reconcile workspace — mimics QBO's reconcile screen, prepped by SNAP:
 * setup (account + statement → prefilled balance/date) → worksheet with
 * auto-checked matches + live difference math → Finish → the exact QBO steps.
 */

type Account = { id: string; name: string; kind: string; balance: number };
type Stmt = {
  id: string; display_name: string; matched_qbo_account_id: string | null;
  matched_account_name: string | null; ending_balance: number | null;
  statement_end_date: string | null; reconciled_session_id: string | null;
};
type SessionRow = {
  id: string; qbo_account_id: string; qbo_account_name: string; status: string;
  ending_balance: number; statement_end_date: string; difference: number | null;
  cleared_count: number; finished_at: string | null; created_at: string;
};
type Txn = {
  id: string; origin: "qbo" | "statement_only"; qbo_txn_id: string | null;
  txn_type: string | null; txn_date: string | null; doc_num: string | null;
  payee: string | null; memo: string | null; amount: number; checked: boolean;
  match_source: string | null; matched_line_date: string | null; matched_line_desc: string | null;
};
type Math_ = {
  beginning: number; clearedIn: number; clearedOut: number; clearedBalance: number;
  ending: number; difference: number; checkedCount: number;
};
type Instructions = {
  reconcile_url: string; account_name: string; ending_balance: number; ending_date: string;
  mode: string; steps: string[];
  uncheck: Array<{ date: string | null; payee: string | null; amount: number; type: string | null }>;
  add_first: Array<{ date: string | null; description: string | null; amount: number }>;
};
type Detail = { session: any; txns: Txn[]; math: Math_; instructions: Instructions };

const fmt = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ReconcileClient({ clientLinkId }: { clientLinkId: string }) {
  const searchParams = useSearchParams();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [statements, setStatements] = useState<Stmt[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  const refreshList = useCallback(async () => {
    const res = await fetch(`/api/clients/${clientLinkId}/recon`);
    if (res.ok) {
      const j = await res.json();
      setAccounts(j.accounts || []);
      setStatements(j.statements || []);
      setSessions(j.sessions || []);
    }
    setLoading(false);
  }, [clientLinkId]);

  useEffect(() => { refreshList(); }, [refreshList]);

  async function openSession(id: string) {
    setError("");
    const res = await fetch(`/api/recon/${id}`);
    const j = await res.json();
    if (!res.ok) { setError(j.error || "Couldn't load session"); return; }
    setDetail(j);
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-ink-slate"><Loader2 size={15} className="animate-spin" /> Loading accounts &amp; statements…</div>;
  }

  if (detail) {
    return (
      <Worksheet
        detail={detail}
        onUpdate={setDetail}
        onBack={() => { setDetail(null); refreshList(); }}
        onError={setError}
        error={error}
      />
    );
  }

  return (
    <SetupView
      clientLinkId={clientLinkId}
      accounts={accounts}
      statements={statements}
      sessions={sessions}
      preselectStatement={searchParams?.get("statement") || null}
      onOpen={openSession}
      error={error}
      setError={setError}
    />
  );
}

function SetupView({
  clientLinkId, accounts, statements, sessions, preselectStatement, onOpen, error, setError,
}: {
  clientLinkId: string; accounts: Account[]; statements: Stmt[]; sessions: SessionRow[];
  preselectStatement: string | null; onOpen: (id: string) => void; error: string; setError: (e: string) => void;
}) {
  const pre = statements.find((s) => s.id === preselectStatement) || null;
  const [accountId, setAccountId] = useState(pre?.matched_qbo_account_id || "");
  const [statementId, setStatementId] = useState(pre?.id || "");
  const [manualBalance, setManualBalance] = useState("");
  const [manualDate, setManualDate] = useState("");
  const [creating, setCreating] = useState(false);

  const accountStatements = statements.filter(
    (s) => !accountId || s.matched_qbo_account_id === accountId
  );
  const chosenStmt = statements.find((s) => s.id === statementId) || null;

  async function create() {
    if (!accountId || creating) return;
    setCreating(true);
    setError("");
    try {
      const body: any = { account_id: accountId };
      if (statementId) body.statement_id = statementId;
      else {
        body.ending_balance = Number(manualBalance);
        body.statement_end_date = manualDate;
      }
      const res = await fetch(`/api/clients/${clientLinkId}/recon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onOpen(j.session_id);
    } catch (e: any) {
      setError(e?.message || "Couldn't start the reconciliation");
    } finally {
      setCreating(false);
    }
  }

  const canCreate = !!accountId && (!!statementId || (!!manualBalance && !!manualDate));

  return (
    <div className="grid lg:grid-cols-[1fr_1fr] gap-6 max-w-5xl">
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <h3 className="font-bold text-navy mb-1 flex items-center gap-2"><Landmark size={15} className="text-teal" /> Start a reconciliation</h3>
        <p className="text-xs text-ink-light mb-4">
          Pick the account, then the statement — SNAP fills the ending balance and date from the
          statement, matches it against QuickBooks, and preps the worksheet.
        </p>

        <label className="block text-xs font-semibold text-navy mb-1">Account</label>
        <select
          value={accountId}
          onChange={(e) => { setAccountId(e.target.value); setStatementId(""); }}
          className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-3 bg-white text-navy"
        >
          <option value="">Choose a bank / credit-card account…</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name} · QBO balance {fmt(a.balance)}</option>
          ))}
        </select>

        <label className="block text-xs font-semibold text-navy mb-1">Statement</label>
        <select
          value={statementId}
          onChange={(e) => setStatementId(e.target.value)}
          disabled={!accountId}
          className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-1 bg-white text-navy disabled:opacity-50"
        >
          <option value="">{accountStatements.length ? "Choose an uploaded statement…" : "No processed statements for this account"}</option>
          {accountStatements.map((s) => (
            <option key={s.id} value={s.id}>
              {s.display_name} · ends {s.statement_end_date || "?"} · {s.ending_balance != null ? fmt(Number(s.ending_balance)) : "?"}
              {s.reconciled_session_id ? " · reconciled ✓" : ""}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-ink-light mb-3">
          Missing? Ask the client from the BS-cleanup &ldquo;Need from client&rdquo; card, or upload it on their profile.
        </p>

        {!statementId && (
          <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3 mb-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-light mb-2">No statement? Enter it manually</div>
            <div className="flex gap-2">
              <input
                type="number" step="0.01" value={manualBalance} onChange={(e) => setManualBalance(e.target.value)}
                placeholder="Ending balance" className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2"
              />
              <input
                type="date" value={manualDate} onChange={(e) => setManualDate(e.target.value)}
                className="text-sm border border-gray-200 rounded-lg px-3 py-2"
              />
            </div>
          </div>
        )}

        {chosenStmt && (
          <div className="rounded-lg bg-teal-lighter border border-teal-light px-3 py-2 mb-3 text-xs text-navy">
            Will prefill: ending balance <strong>{chosenStmt.ending_balance != null ? fmt(Number(chosenStmt.ending_balance)) : "?"}</strong>,
            end date <strong>{chosenStmt.statement_end_date || "?"}</strong> — extracted from the statement.
          </div>
        )}

        {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</div>}

        <button
          onClick={create}
          disabled={!canCreate || creating}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-40 text-white text-sm font-bold px-4 py-2.5 rounded-lg"
        >
          {creating ? <><Loader2 size={14} className="animate-spin" /> Matching against QuickBooks…</> : <>Start reconciling <ArrowRight size={14} /></>}
        </button>
        {creating && <p className="text-[11px] text-ink-light mt-2">Reading the statement + pulling the QBO ledger — usually 15–30 seconds.</p>}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <h3 className="font-bold text-navy mb-3">Sessions</h3>
        {sessions.length === 0 ? (
          <p className="text-sm text-ink-light">None yet — start the first one on the left.</p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => onOpen(s.id)}
                  className="w-full text-left rounded-lg border border-gray-200 hover:border-teal px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-navy flex-1 truncate">{s.qbo_account_name}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      s.status === "finished" ? "bg-emerald-100 text-emerald-700" : s.status === "abandoned" ? "bg-gray-100 text-gray-500" : "bg-amber-100 text-amber-700"
                    }`}>{s.status === "in_progress" ? "in progress" : s.status}</span>
                  </div>
                  <div className="text-xs text-ink-slate mt-0.5">
                    ends {s.statement_end_date} · ending {fmt(Number(s.ending_balance))}
                    {s.status !== "finished" && s.difference != null && Math.abs(Number(s.difference)) > 0.005 && (
                      <span className="text-amber-700"> · off by {fmt(Number(s.difference))}</span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Worksheet({
  detail, onUpdate, onBack, onError, error,
}: {
  detail: Detail; onUpdate: (d: Detail) => void; onBack: () => void; onError: (e: string) => void; error: string;
}) {
  const { session, txns, math, instructions } = detail;
  const finished = session.status === "finished";
  const [busy, setBusy] = useState(false);
  const qboTxns = txns.filter((t) => t.origin === "qbo");
  const stmtOnly = txns.filter((t) => t.origin === "statement_only");
  const balanced = Math.abs(math.difference) <= 0.005;

  // Smart hint: one unchecked txn exactly equals the difference.
  const hint = useMemo(() => {
    if (balanced) return null;
    const cands = qboTxns.filter((t) => !t.checked && Math.abs(t.amount - math.difference) <= 0.01);
    if (cands.length === 1) return { txn: cands[0], action: "check" as const };
    const over = qboTxns.filter((t) => t.checked && Math.abs(-t.amount - math.difference) <= 0.01);
    if (over.length === 1) return { txn: over[0], action: "uncheck" as const };
    return null;
  }, [qboTxns, math.difference, balanced]);

  async function patch(body: any) {
    setBusy(true);
    onError("");
    try {
      const res = await fetch(`/api/recon/${session.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onUpdate(j);
    } catch (e: any) {
      onError(e?.message || "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function act(action: string, force = false) {
    setBusy(true);
    onError("");
    try {
      const res = await fetch(`/api/recon/${session.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, force }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      if (action === "abandon") { onBack(); return; }
      onUpdate(j);
    } catch (e: any) {
      onError(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  function toggle(t: Txn) {
    if (finished) return;
    patch({ txn_ids: [t.id], checked: !t.checked });
  }

  const setAll = (checked: boolean) =>
    patch({ txn_ids: qboTxns.filter((t) => t.checked !== checked).map((t) => t.id), checked });

  return (
    <div className="max-w-5xl space-y-4">
      <button onClick={onBack} className="text-xs text-ink-slate hover:text-navy underline">← All sessions</button>

      {/* Math header — QBO-style */}
      <div className={`rounded-2xl border-2 p-5 ${balanced ? "border-emerald-300 bg-emerald-50/60" : "border-amber-300 bg-amber-50/50"}`}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="font-bold text-navy">{session.qbo_account_name}</h2>
            <p className="text-xs text-ink-slate">
              {session.statement_start_date} → {session.statement_end_date}
              {session.beginning_source === "prior_session" && " · beginning carried from last reconciliation"}
              {finished && <span className="text-emerald-700 font-semibold"> · finished</span>}
            </p>
          </div>
          <div className="flex items-center gap-5 text-sm">
            <Stat label="Beginning" value={fmt(math.beginning)} />
            <span className="text-ink-light">+</span>
            <Stat label={session.account_kind === "credit_card" ? "Charges" : "Deposits"} value={fmt(math.clearedIn)} />
            <span className="text-ink-light">−</span>
            <Stat label={session.account_kind === "credit_card" ? "Payments" : "Withdrawals"} value={fmt(Math.abs(math.clearedOut))} />
            <span className="text-ink-light">vs</span>
            <Stat label="Statement ending" value={fmt(math.ending)} />
            <div className={`rounded-xl px-4 py-2 text-center ${balanced ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}`}>
              <div className="text-[10px] font-bold uppercase tracking-wider opacity-80">Difference</div>
              <div className="text-lg font-bold tabular-nums">{fmt(math.difference)}</div>
            </div>
          </div>
        </div>

        {hint && !finished && (
          <div className="mt-3 flex items-center gap-2 text-xs bg-white border border-amber-200 rounded-lg px-3 py-2">
            <Lightbulb size={13} className="text-amber-600 flex-shrink-0" />
            <span className="text-navy">
              This one transaction equals the difference exactly:
              <strong> {hint.txn.payee || hint.txn.txn_type} · {fmt(hint.txn.amount)} · {hint.txn.txn_date}</strong> —
              {hint.action === "check" ? " it likely cleared. " : " it likely didn't clear. "}
            </span>
            <button onClick={() => toggle(hint.txn)} disabled={busy}
              className="ml-auto text-xs font-bold text-teal border border-teal/30 hover:bg-teal/5 rounded-md px-2 py-1 flex-shrink-0">
              {hint.action === "check" ? "Check it" : "Uncheck it"}
            </button>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          {!finished ? (
            <>
              <button
                onClick={() => act("finish", !balanced)}
                disabled={busy}
                className={`inline-flex items-center gap-2 text-sm font-bold px-4 py-2 rounded-lg text-white ${balanced ? "bg-emerald-600 hover:bg-emerald-700" : "bg-gray-400 hover:bg-gray-500"}`}
                title={balanced ? "Record the reconciliation + get the QBO steps" : "Not balanced — finishing records it as-is"}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {balanced ? "Finish — get QBO steps" : "Finish anyway (not balanced)"}
              </button>
              <button onClick={() => act("abandon")} disabled={busy} className="text-xs text-ink-slate hover:text-red-700 underline">
                Abandon
              </button>
            </>
          ) : (
            <button onClick={() => act("reopen")} disabled={busy}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate border border-gray-300 rounded-lg px-3 py-1.5 hover:border-teal">
              <RotateCcw size={12} /> Reopen
            </button>
          )}
          {error && <span className="text-xs text-red-700">{error}</span>}
        </div>
      </div>

      {/* QBO instructions — the whole point: minimal clicks in QBO. */}
      <QboSteps instructions={instructions} highlight={finished || balanced} />

      {stmtOnly.length > 0 && (
        <div className="rounded-2xl border border-red-200 bg-red-50/60 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-red-800 mb-2">
            <TriangleAlert size={14} /> On the statement but missing from QuickBooks ({stmtOnly.length})
          </div>
          <p className="text-xs text-red-800/80 mb-2">QBO can&apos;t balance until these are recorded. Add them in QBO (or via a reclass), then re-create this session to re-match.</p>
          <ul className="text-xs text-navy space-y-1">
            {stmtOnly.map((t) => (
              <li key={t.id} className="flex gap-3"><span className="tabular-nums text-ink-slate">{t.txn_date || "?"}</span><span className="flex-1 truncate">{t.matched_line_desc || "(no description)"}</span><span className="font-mono">{fmt(t.amount)}</span></li>
            ))}
          </ul>
        </div>
      )}

      {/* Worksheet */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
          <span className="text-xs font-bold text-navy uppercase tracking-wider">QuickBooks transactions ({qboTxns.length})</span>
          <span className="text-[11px] text-ink-light">{math.checkedCount} checked · auto-matched rows marked</span>
          {!finished && (
            <span className="ml-auto flex gap-2">
              <button onClick={() => setAll(true)} disabled={busy} className="text-[11px] font-semibold text-teal hover:underline">Check all</button>
              <button onClick={() => setAll(false)} disabled={busy} className="text-[11px] font-semibold text-ink-slate hover:underline">Uncheck all</button>
            </span>
          )}
          {finished && <Lock size={12} className="ml-auto text-ink-light" />}
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-ink-light border-b border-gray-100">
              <th className="w-10"></th>
              <th className="text-left px-2 py-2 font-bold">Date</th>
              <th className="text-left px-2 py-2 font-bold">Type</th>
              <th className="text-left px-2 py-2 font-bold">Payee / memo</th>
              <th className="text-left px-2 py-2 font-bold">Match</th>
              <th className="text-right px-4 py-2 font-bold">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {qboTxns.map((t) => (
              <tr key={t.id} className={`${t.checked ? "bg-teal-lighter/30" : ""} ${finished ? "" : "cursor-pointer hover:bg-gray-50"}`} onClick={() => toggle(t)}>
                <td className="pl-4 py-2"><input type="checkbox" readOnly checked={t.checked} disabled={finished} className="accent-teal h-3.5 w-3.5" /></td>
                <td className="px-2 py-2 tabular-nums text-navy whitespace-nowrap">{t.txn_date || "—"}</td>
                <td className="px-2 py-2 text-ink-slate whitespace-nowrap">{t.txn_type}{t.doc_num ? ` #${t.doc_num}` : ""}</td>
                <td className="px-2 py-2 text-navy truncate max-w-[240px]">{t.payee || t.memo || "—"}</td>
                <td className="px-2 py-2">
                  {t.match_source === "auto_statement" ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-teal-dark bg-teal-light rounded px-1.5 py-0.5"><Sparkles size={9} /> statement</span>
                  ) : t.checked ? (
                    <span className="text-[10px] text-ink-light">manual</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] text-amber-700"><X size={9} /> no match</span>
                  )}
                </td>
                <td className={`px-4 py-2 text-right font-mono whitespace-nowrap ${t.amount < 0 ? "text-red-700" : "text-navy"}`}>{fmt(t.amount)}</td>
              </tr>
            ))}
            {qboTxns.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-sm text-ink-light">No QuickBooks transactions found in this window.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light">{label}</div>
      <div className="font-bold text-navy tabular-nums">{value}</div>
    </div>
  );
}

function QboSteps({ instructions, highlight }: { instructions: Instructions; highlight: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };
  return (
    <div className={`rounded-2xl border p-4 ${highlight ? "border-teal bg-teal-lighter/40" : "border-gray-200 bg-white"}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-bold text-navy">Finish in QuickBooks — {instructions.mode === "select_all" ? "3 actions" : "4 actions"}</span>
        <a href={instructions.reconcile_url} target="_blank" rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 text-xs font-bold bg-navy hover:bg-navy/90 text-white rounded-lg px-3 py-1.5">
          Open QBO reconcile <ExternalLink size={11} />
        </a>
      </div>
      <ol className="space-y-1.5 text-sm text-navy list-decimal ml-5">
        {instructions.steps.map((s, i) => <li key={i} className="leading-relaxed">{s}</li>)}
      </ol>
      <div className="flex items-center gap-2 mt-3">
        <button onClick={() => copy("bal", instructions.ending_balance.toFixed(2))}
          className="inline-flex items-center gap-1.5 text-xs font-semibold border border-gray-300 rounded-lg px-2.5 py-1.5 hover:border-teal text-navy">
          <ClipboardCopy size={11} /> {copied === "bal" ? "Copied!" : `Copy balance ${instructions.ending_balance.toFixed(2)}`}
        </button>
        <button onClick={() => copy("date", instructions.ending_date)}
          className="inline-flex items-center gap-1.5 text-xs font-semibold border border-gray-300 rounded-lg px-2.5 py-1.5 hover:border-teal text-navy">
          <ClipboardCopy size={11} /> {copied === "date" ? "Copied!" : `Copy date ${instructions.ending_date}`}
        </button>
      </div>
      {instructions.uncheck.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-light mb-1">Uncheck these in QBO ({instructions.uncheck.length})</div>
          <ul className="text-xs text-navy space-y-0.5">
            {instructions.uncheck.map((u, i) => (
              <li key={i} className="flex gap-3"><span className="tabular-nums text-ink-slate">{u.date || "?"}</span><span className="flex-1 truncate">{u.payee || u.type || ""}</span><span className="font-mono">{fmt(u.amount)}</span></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
