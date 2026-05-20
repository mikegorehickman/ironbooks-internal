"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Loader2, ArrowLeft, AlertCircle, CheckCircle2, Landmark, CreditCard, FileSpreadsheet,
} from "lucide-react";

interface BSAccount {
  qbo_account_id: string;
  name: string;
  account_type: string;
  account_subtype: string | null;
  kind: "bank" | "credit_card" | "loan";
  last4: string | null;
  current_balance: number;
}

/**
 * Per-account reconciliation entry form. Captures statement ending
 * balance + date and POSTs a bank_recon_jobs row. The gap-analysis
 * stage layers in next; for now the bookkeeper just records the
 * inputs.
 */
export function AccountReconForm({
  clientLinkId,
  clientName,
  accountId,
}: {
  clientLinkId: string;
  clientName: string;
  accountId: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<BSAccount | null>(null);
  const [error, setError] = useState<string>("");
  const [endingBalance, setEndingBalance] = useState<string>("");
  const [asOfDate, setAsOfDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [notes, setNotes] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<{ gap: number; job_id: string } | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/clients/${clientLinkId}/bs-accounts`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) {
          setError(json.error);
          setLoading(false);
          return;
        }
        const all = [
          ...(json.accounts.bank || []),
          ...(json.accounts.credit_card || []),
          ...(json.accounts.loan || []),
        ];
        const hit = all.find((a: BSAccount) => a.qbo_account_id === accountId);
        if (!hit) {
          setError("Account not found in QBO — it may have been deactivated.");
        } else {
          setAccount(hit);
        }
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message || "Could not load account");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [clientLinkId, accountId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!account) return;
    const amount = Number(endingBalance);
    if (Number.isNaN(amount)) {
      setError("Enter a valid ending balance");
      return;
    }
    if (!asOfDate) {
      setError("Pick the statement as-of date");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/balance-sheet/bank-recon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          qbo_account_id: account.qbo_account_id,
          statement_ending_balance: amount,
          statement_as_of_date: asOfDate,
          notes: notes || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setSuccess({ gap: json.gap_amount, job_id: json.job_id });
    } catch (err: any) {
      setError(err.message || "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  const KindIcon =
    account?.kind === "bank"
      ? Landmark
      : account?.kind === "credit_card"
      ? CreditCard
      : FileSpreadsheet;

  if (loading) {
    return (
      <div className="text-center text-sm text-ink-slate py-8">
        <Loader2 size={18} className="inline animate-spin mr-2 text-teal" />
        Loading account…
      </div>
    );
  }

  if (error && !account) {
    return (
      <div className="space-y-3">
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
        <Link
          href={`/balance-sheet/${clientLinkId}`}
          className="inline-flex items-center gap-1.5 text-sm text-ink-slate hover:text-navy"
        >
          <ArrowLeft size={14} /> Back to accounts
        </Link>
      </div>
    );
  }

  if (!account) return null;

  if (success) {
    const absGap = Math.abs(success.gap);
    const isMatch = absGap < 0.01;
    return (
      <div className="space-y-4">
        <div
          className={`p-5 rounded-2xl border ${
            isMatch
              ? "bg-green-50 border-green-200"
              : "bg-amber-50 border-amber-200"
          }`}
        >
          <div className="flex items-start gap-3">
            <CheckCircle2
              size={24}
              className={isMatch ? "text-green-700" : "text-amber-700"}
            />
            <div>
              <h2 className="text-base font-bold text-navy">
                {isMatch
                  ? `${account.name} reconciles cleanly`
                  : `${account.name} has a $${absGap.toFixed(2)} gap`}
              </h2>
              <p className="text-sm mt-1 text-ink-slate leading-relaxed">
                {isMatch
                  ? `Statement and QBO ledger agree as of ${asOfDate}. No further action needed — the next reconciliation can pick up from this date.`
                  : `Statement says $${Number(endingBalance).toFixed(2)} as of ${asOfDate}; QBO ledger shows the difference. The gap-analysis screen (coming in a follow-up) will surface missing or duplicate transactions. For now this run is recorded.`}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/balance-sheet/${clientLinkId}`}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-slate hover:text-navy"
          >
            <ArrowLeft size={14} /> Back to accounts
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Link
        href={`/balance-sheet/${clientLinkId}`}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy"
      >
        <ArrowLeft size={12} /> Back to accounts
      </Link>

      {/* Account summary */}
      <div className="rounded-2xl bg-white border border-gray-200 p-5 flex items-center gap-4">
        <div className="p-2.5 rounded-lg bg-gray-100">
          <KindIcon size={20} className="text-navy" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-base text-navy">
            {account.name}
            {account.last4 && (
              <span className="ml-2 font-mono text-sm text-ink-slate">
                •••{account.last4}
              </span>
            )}
          </div>
          <div className="text-xs text-ink-light">
            {account.account_subtype || account.account_type}
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-mono font-semibold text-navy">
            $
            {Math.abs(account.current_balance).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
            {account.current_balance < 0 && " (cr)"}
          </div>
          <div className="text-[10px] text-ink-light uppercase tracking-wider">
            QBO ledger now
          </div>
        </div>
      </div>

      {/* Form */}
      <div className="rounded-2xl bg-white border border-gray-200 p-5 space-y-4">
        <div>
          <label className="block text-sm font-semibold text-navy mb-1.5">
            Statement ending balance
          </label>
          <input
            type="number"
            step="0.01"
            value={endingBalance}
            onChange={(e) => setEndingBalance(e.target.value)}
            placeholder="14233.18"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm font-mono text-navy"
            required
          />
          <p className="text-[11px] text-ink-light mt-1">
            Enter the ending balance from the {account.kind === "loan" ? "lender" : account.kind === "credit_card" ? "credit card" : "bank"} statement. Negative for amounts owed if it's a liability balance shown as a positive on the statement.
          </p>
        </div>
        <div>
          <label className="block text-sm font-semibold text-navy mb-1.5">
            Statement as-of date
          </label>
          <input
            type="date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-navy mb-1.5">
            Notes (optional)
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. statement period 4/1 – 4/30"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
          />
        </div>

        {error && (
          <div className="p-2.5 rounded-md bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
        >
          {submitting ? (
            <Loader2 size={16} className="animate-spin" />
          ) : null}
          {submitting ? "Saving…" : "Save reconciliation"}
        </button>
      </div>

      <p className="text-[11px] text-ink-light text-center">
        Saves the statement values for {clientName}. Gap analysis (find
        missing / duplicate transactions in QBO) is coming next.
      </p>
    </form>
  );
}
