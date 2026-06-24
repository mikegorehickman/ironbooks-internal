"use client";

import { useEffect, useState } from "react";
import {
  Loader2, CheckCircle2, Circle, FileText, Mail, Send, ArrowRight, ArrowLeft, AlertCircle,
} from "lucide-react";
import { BalanceSheetLanding } from "./landing-client";
import { PLByMonthView } from "../../clients/[id]/pl-by-month-view";
import { MarkCleanupCompleteButton } from "../../stripe-recon/[id]/review/mark-complete-button";

type SubStep = "statements_needed" | "request" | "pl_attest" | "submit";
const SUBSTEPS: { key: SubStep; label: string }[] = [
  { key: "statements_needed", label: "Statements needed" },
  { key: "request", label: "Request" },
  { key: "pl_attest", label: "Review & attest P&L" },
  { key: "submit", label: "Submit for review" },
];

interface BSAccount {
  qbo_account_id: string;
  name: string;
  kind: "bank" | "credit_card" | "loan";
  last4: string | null;
  current_balance: number;
}
type AcctStatus = "needed" | "requested" | "received";

const KIND_LABEL: Record<string, string> = {
  bank: "Bank statement",
  credit_card: "Credit card statement",
  loan: "Loan statement",
};

function labelFor(a: BSAccount): string {
  return `${KIND_LABEL[a.kind] || "Statement"} — ${a.name}${a.last4 ? ` ****${a.last4}` : ""}`;
}

export function BalanceSheetStage({
  clientLinkId,
  clientName,
  plAttestedAt: initialAttestedAt,
  statementsRequestedAt,
  defaultRangeStart,
  defaultRangeEnd,
}: {
  clientLinkId: string;
  clientName: string;
  plAttestedAt: string | null;
  statementsRequestedAt: string | null;
  defaultRangeStart: string | null;
  defaultRangeEnd: string | null;
}) {
  const [subStep, setSubStep] = useState<SubStep>("statements_needed");

  const [accounts, setAccounts] = useState<BSAccount[] | null>(null);
  const [statusByAcct, setStatusByAcct] = useState<Record<string, AcctStatus>>({});
  const [loadingAccts, setLoadingAccts] = useState(true);
  const [acctError, setAcctError] = useState<string>("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<
    { kind: "sent"; to: string[] } | { kind: "no_address" } | { kind: "error"; msg: string } | null
  >(null);
  const [overrideEmail, setOverrideEmail] = useState("");

  const [attestedAt, setAttestedAt] = useState<string | null>(initialAttestedAt);
  const [attestChecked, setAttestChecked] = useState(false);
  const [attestNotes, setAttestNotes] = useState("");
  const [attesting, setAttesting] = useState(false);

  // Load BS accounts + cross-reference requested / received status.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingAccts(true);
      setAcctError("");
      try {
        const [acctRes, reqRes, stmtRes] = await Promise.all([
          fetch(`/api/clients/${clientLinkId}/bs-accounts`).then((r) => r.json()),
          fetch(`/api/clients/${clientLinkId}/statement-requests`).then((r) => r.json()).catch(() => ({})),
          fetch(`/api/clients/${clientLinkId}/statements`).then((r) => r.json()).catch(() => ({})),
        ]);
        if (cancelled) return;
        if (acctRes?.error) {
          setAcctError(acctRes.error);
          setAccounts([]);
          return;
        }
        const all: BSAccount[] = [
          ...(acctRes?.accounts?.bank || []),
          ...(acctRes?.accounts?.credit_card || []),
          ...(acctRes?.accounts?.loan || []),
        ];
        const openReq = new Set(
          ((reqRes?.requests as any[]) || [])
            .filter((r) => r.status === "open" && r.qbo_account_id)
            .map((r) => String(r.qbo_account_id))
        );
        const received = new Set(
          (((stmtRes?.statements || stmtRes?.rows) as any[]) || [])
            .filter((s) => (s.status === "processed" || s.status === "matched") && (s.matched_qbo_account_id || s.qbo_account_id))
            .map((s) => String(s.matched_qbo_account_id || s.qbo_account_id))
        );
        const status: Record<string, AcctStatus> = {};
        for (const a of all) {
          status[a.qbo_account_id] = received.has(a.qbo_account_id)
            ? "received"
            : openReq.has(a.qbo_account_id)
            ? "requested"
            : "needed";
        }
        setAccounts(all);
        setStatusByAcct(status);
        // Pre-select everything still "needed" for the request step.
        setSelected(new Set(all.filter((a) => status[a.qbo_account_id] === "needed").map((a) => a.qbo_account_id)));
      } catch (e: any) {
        if (!cancelled) { setAcctError(e?.message || "Could not load accounts"); setAccounts([]); }
      } finally {
        if (!cancelled) setLoadingAccts(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clientLinkId]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function sendStatementRequest() {
    if (!accounts) return;
    const chosen = accounts.filter((a) => selected.has(a.qbo_account_id));
    if (chosen.length === 0) return;
    setSending(true);
    setSendResult(null);
    try {
      // 1. Create the open statement_requests rows (client sees them in the portal).
      await fetch(`/api/clients/${clientLinkId}/statement-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: chosen.map((a) => ({
            label: labelFor(a),
            account_name: a.name,
            account_kind: a.kind,
            qbo_account_id: a.qbo_account_id,
          })),
        }),
      });
      // 2. Email the client the branded request.
      const res = await fetch(`/api/clients/${clientLinkId}/request-statements-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          labels: chosen.map(labelFor),
          client_name: clientName,
          override_email: overrideEmail.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok && !data.no_address) throw new Error(data.error || "Could not send");
      if (data.no_address) setSendResult({ kind: "no_address" });
      else if (data.sent) {
        setSendResult({ kind: "sent", to: data.addresses || [] });
        setOverrideEmail("");
        // Flip chosen accounts to "requested" locally.
        setStatusByAcct((prev) => {
          const next = { ...prev };
          for (const a of chosen) next[a.qbo_account_id] = "requested";
          return next;
        });
      } else setSendResult({ kind: "error", msg: data.error || "Email could not be sent" });
    } catch (e: any) {
      setSendResult({ kind: "error", msg: e.message });
    } finally {
      setSending(false);
    }
  }

  async function attestPL() {
    setAttesting(true);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/attest-pl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attested: true, notes: attestNotes.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not attest");
      setAttestedAt(data.attested_at || new Date().toISOString());
      setSubStep("submit");
    } catch (e: any) {
      alert(e.message);
    } finally {
      setAttesting(false);
    }
  }

  const stepIndex = SUBSTEPS.findIndex((s) => s.key === subStep);
  const neededCount = accounts ? accounts.filter((a) => statusByAcct[a.qbo_account_id] === "needed").length : 0;

  return (
    <div className="space-y-6">
      {/* Sub-stepper */}
      <div className="flex items-center gap-2">
        {SUBSTEPS.map((s, i) => {
          const done = i < stepIndex || (s.key === "pl_attest" && !!attestedAt);
          const active = s.key === subStep;
          return (
            <button
              key={s.key}
              onClick={() => setSubStep(s.key)}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-full border transition-colors ${
                active
                  ? "border-teal bg-teal-lighter text-teal-dark"
                  : done
                  ? "border-green-200 bg-green-50 text-green-700"
                  : "border-gray-200 text-ink-slate hover:border-gray-300"
              }`}
            >
              {done ? <CheckCircle2 size={13} /> : <Circle size={13} />}
              <span className="text-[10px] opacity-70">{i + 1}</span>
              {s.label}
            </button>
          );
        })}
      </div>

      {/* (a) Statements needed + the reconciliation worksection */}
      {subStep === "statements_needed" && (
        <div className="space-y-5">
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center gap-2 mb-1">
              <FileText size={16} className="text-teal" />
              <h3 className="text-sm font-bold text-navy">Statements we need to verify ending balances</h3>
            </div>
            <p className="text-xs text-ink-slate mb-3">
              Every bank, credit card, and loan account needs a statement to confirm its ending balance
              before we sign off. Anything marked <strong>Needed</strong> gets requested in the next step.
            </p>
            {loadingAccts ? (
              <div className="flex items-center gap-2 text-sm text-ink-slate"><Loader2 className="animate-spin" size={15} /> Loading accounts from QuickBooks…</div>
            ) : acctError ? (
              <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"><AlertCircle size={15} className="mt-0.5" />{acctError}</div>
            ) : accounts && accounts.length === 0 ? (
              <div className="text-sm text-ink-slate">No bank, credit card, or loan accounts on this client&apos;s books — nothing to request. You can review the P&amp;L and submit.</div>
            ) : (
              <div className="space-y-1.5">
                {accounts!.map((a) => {
                  const st = statusByAcct[a.qbo_account_id];
                  return (
                    <div key={a.qbo_account_id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-navy truncate">{labelFor(a)}</div>
                        <div className="text-[11px] text-ink-light">Balance {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(a.current_balance)}</div>
                      </div>
                      <span className={`flex-shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${
                        st === "received" ? "bg-green-50 text-green-700" : st === "requested" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"
                      }`}>{st}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <button onClick={() => setSubStep("request")} className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg">
                {neededCount > 0 ? `Request ${neededCount} statement${neededCount === 1 ? "" : "s"}` : "Next"} <ArrowRight size={15} />
              </button>
            </div>
          </div>

          {/* The actual reconciliation work (existing landing) sits here. */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-light mb-2">Reconcile accounts</h3>
            <BalanceSheetLanding clientLinkId={clientLinkId} clientName={clientName} />
          </div>
        </div>
      )}

      {/* (b) Request statements */}
      {subStep === "request" && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Mail size={16} className="text-teal" />
            <h3 className="text-sm font-bold text-navy">Request statements from {clientName}</h3>
          </div>
          {statementsRequestedAt && (
            <div className="text-[12px] text-ink-slate">Last requested {new Date(statementsRequestedAt).toLocaleDateString()}.</div>
          )}
          {!accounts || accounts.length === 0 ? (
            <p className="text-sm text-ink-slate">No statement accounts to request — continue to the P&amp;L review.</p>
          ) : (
            <>
              <p className="text-xs text-ink-slate">Select the statements to request. We&apos;ll email {clientName} a branded upload link and they&apos;ll appear in their portal.</p>
              <div className="space-y-1.5">
                {accounts.map((a) => (
                  <label key={a.qbo_account_id} className="flex items-center gap-2.5 rounded-lg border border-gray-100 px-3 py-2 cursor-pointer hover:bg-teal-lighter/30">
                    <input
                      type="checkbox"
                      checked={selected.has(a.qbo_account_id)}
                      onChange={() => toggle(a.qbo_account_id)}
                      className="w-4 h-4 rounded border-gray-300"
                    />
                    <span className="text-sm text-navy flex-1">{labelFor(a)}</span>
                    {statusByAcct[a.qbo_account_id] === "received" && <span className="text-[11px] text-green-700 font-semibold">received</span>}
                  </label>
                ))}
              </div>

              {sendResult?.kind === "sent" && (
                <div className="rounded-lg bg-green-50 border border-green-200 p-2.5 text-[12px] text-green-800">✓ Request emailed to {sendResult.to.join(", ")}.</div>
              )}
              {sendResult?.kind === "error" && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-2.5 text-[12px] text-red-800">{sendResult.msg}</div>
              )}
              {sendResult?.kind === "no_address" && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 space-y-2">
                  <div className="text-[12px] font-semibold text-amber-900">No email on file for this client</div>
                  <p className="text-[11px] text-amber-800">Enter the client&apos;s email — we&apos;ll send the request and save it to their profile.</p>
                  <div className="flex gap-2">
                    <input type="email" value={overrideEmail} onChange={(e) => setOverrideEmail(e.target.value)} placeholder="owner@client.com" className="flex-1 px-3 py-2 rounded-lg border border-amber-300 text-sm text-navy outline-none focus:border-amber-500" />
                    <button onClick={sendStatementRequest} disabled={sending || !overrideEmail.trim()} className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-[13px] font-semibold px-3 py-2 rounded-lg whitespace-nowrap">Save &amp; send</button>
                  </div>
                </div>
              )}

              {!sendResult?.no_address && (
                <button onClick={sendStatementRequest} disabled={sending || selected.size === 0} className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2.5 rounded-lg">
                  {sending ? <Loader2 className="animate-spin" size={15} /> : <Send size={15} />}
                  {sending ? "Sending…" : `Email request (${selected.size})`}
                </button>
              )}
            </>
          )}
          <div className="flex items-center justify-between pt-2">
            <button onClick={() => setSubStep("statements_needed")} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink-slate hover:text-navy"><ArrowLeft size={14} /> Back</button>
            <button onClick={() => setSubStep("pl_attest")} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-teal hover:text-teal-dark">Next: Review P&amp;L <ArrowRight size={14} /></button>
          </div>
        </div>
      )}

      {/* (c) Review & attest P&L */}
      {subStep === "pl_attest" && (
        <div className="space-y-4">
          <PLByMonthView clientLinkId={clientLinkId} />
          <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
            {attestedAt ? (
              <div className="flex items-center gap-2 text-sm text-green-700 font-semibold"><CheckCircle2 size={16} /> P&amp;L attested {new Date(attestedAt).toLocaleString()}.</div>
            ) : (
              <>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input type="checkbox" checked={attestChecked} onChange={(e) => setAttestChecked(e.target.checked)} className="w-4 h-4 mt-0.5 rounded border-gray-300" />
                  <span className="text-sm text-navy">I have reviewed the P&amp;L{defaultRangeStart && defaultRangeEnd ? ` for ${defaultRangeStart} → ${defaultRangeEnd}` : ""} and confirm it is accurate.</span>
                </label>
                <textarea value={attestNotes} onChange={(e) => setAttestNotes(e.target.value)} placeholder="Notes (optional)" rows={2} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-teal" />
                <button onClick={attestPL} disabled={!attestChecked || attesting} className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2.5 rounded-lg">
                  {attesting ? <Loader2 className="animate-spin" size={15} /> : <CheckCircle2 size={15} />} Attest &amp; continue
                </button>
              </>
            )}
            <div className="flex items-center justify-between pt-1">
              <button onClick={() => setSubStep("request")} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink-slate hover:text-navy"><ArrowLeft size={14} /> Back</button>
              {attestedAt && (
                <button onClick={() => setSubStep("submit")} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-teal hover:text-teal-dark">Next: Submit <ArrowRight size={14} /></button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* (d) Submit for senior review */}
      {subStep === "submit" && (
        <div className="space-y-3 max-w-2xl">
          <MarkCleanupCompleteButton
            clientLinkId={clientLinkId}
            clientName={clientName}
            defaultRangeStart={defaultRangeStart}
            defaultRangeEnd={defaultRangeEnd}
            disabled={!attestedAt}
            disabledHint={!attestedAt ? "Attest the P&L first (step 3)." : undefined}
          />
          <button onClick={() => setSubStep("pl_attest")} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink-slate hover:text-navy"><ArrowLeft size={14} /> Back to P&amp;L</button>
        </div>
      )}
    </div>
  );
}
