"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Landmark, CreditCard, FileSpreadsheet, Loader2, ArrowRight,
  RefreshCw, AlertCircle, Sparkles, Wallet,
} from "lucide-react";

interface BSAccount {
  qbo_account_id: string;
  name: string;
  account_type: string;
  account_subtype: string | null;
  kind: "bank" | "credit_card" | "loan";
  last4: string | null;
  current_balance: number;
  currency: string | null;
}

interface AccountsResponse {
  client_name: string;
  counts: { bank: number; credit_card: number; loan: number };
  accounts: {
    bank: BSAccount[];
    credit_card: BSAccount[];
    loan: BSAccount[];
  };
}

/**
 * Balance Sheet landing page client. Three sections:
 *
 *   1. UF → A/R matcher (single big button at the top — highest-leverage
 *      automated step). Clicking it kicks off /api/balance-sheet/uf-ar-discover
 *      and routes to the review page.
 *
 *   2. Account reconciliation picker — banks / credit cards / loans
 *      grouped, each row showing the last-4 digits where QBO has them.
 *      Clicking a row routes to the per-account form (next iteration).
 *
 *   3. Refresh button — re-pulls the QBO COA in case the bookkeeper
 *      just added an account.
 */
export function BalanceSheetLanding({
  clientLinkId,
  clientName,
}: {
  clientLinkId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [runningUFAR, setRunningUFAR] = useState(false);

  async function loadAccounts() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/bs-accounts`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e: any) {
      setError(e.message || "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientLinkId]);

  async function runUFAR() {
    setRunningUFAR(true);
    setError("");
    try {
      const res = await fetch("/api/balance-sheet/uf-ar-discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId }),
      });
      const json = await res.json();
      if (!res.ok) {
        // Concurrency 409 — already running. Route to the existing job.
        if (json.existing_job_id) {
          router.push(`/balance-sheet/uf-ar/${json.existing_job_id}/review`);
          return;
        }
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      router.push(`/balance-sheet/uf-ar/${json.job_id}/review`);
    } catch (e: any) {
      setError(e.message || "Could not start UF→A/R match");
      setRunningUFAR(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Section 1: UF → A/R matcher ── */}
      <div className="rounded-2xl bg-gradient-to-br from-teal-lighter to-white border border-teal/30 p-6">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-xl bg-teal-light flex-shrink-0">
            <Wallet size={22} className="text-teal" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-bold text-navy">
              Match Undeposited Funds to Accounts Receivable
            </h2>
            <p className="text-sm text-ink-slate mt-1 leading-relaxed">
              We&apos;ll scan every payment sitting in Undeposited Funds for{" "}
              <strong>{clientName}</strong>, then cross-reference against open
              A/R invoices. Memo references like &quot;INV-1234&quot; get matched
              exactly; customer+amount matches surface as high-confidence
              suggestions; the rest become recommendations the bookkeeper
              picks from a candidate list.
            </p>
            {error && (
              <div className="mt-3 p-2.5 rounded-md bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2">
                <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
            <button
              onClick={runUFAR}
              disabled={runningUFAR}
              className="mt-4 inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            >
              {runningUFAR ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Sparkles size={16} />
              )}
              {runningUFAR ? "Starting…" : "Scan UF and match to A/R"}
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Section 2: Account reconciliation ── */}
      <div className="rounded-2xl bg-white border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-navy">
              Reconcile accounts
            </h2>
            <p className="text-xs text-ink-slate mt-0.5">
              Click an account to enter its statement ending balance + date.
              We&apos;ll compare to the QBO ledger and surface the gap.
            </p>
          </div>
          <button
            onClick={loadAccounts}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-60"
            title="Re-pull the COA from QBO"
          >
            {loading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            Refresh
          </button>
        </div>

        {loading && !data && (
          <div className="px-5 py-8 text-center text-sm text-ink-slate">
            <Loader2 size={18} className="inline animate-spin mr-2 text-teal" />
            Fetching accounts from QuickBooks…
          </div>
        )}

        {data && (
          <div className="divide-y divide-gray-100">
            <AccountGroup
              clientLinkId={clientLinkId}
              icon={Landmark}
              iconColor="#2D7A75"
              label="Bank accounts"
              accounts={data.accounts.bank}
              emptyText="No bank accounts on this client's QBO."
            />
            <AccountGroup
              clientLinkId={clientLinkId}
              icon={CreditCard}
              iconColor="#7C3AED"
              label="Credit cards"
              accounts={data.accounts.credit_card}
              emptyText="No credit-card accounts."
            />
            <AccountGroup
              clientLinkId={clientLinkId}
              icon={FileSpreadsheet}
              iconColor="#F59E0B"
              label="Loans"
              accounts={data.accounts.loan}
              emptyText="No loan or long-term-liability accounts."
            />
          </div>
        )}
      </div>
    </div>
  );
}

function AccountGroup({
  clientLinkId,
  icon: Icon,
  iconColor,
  label,
  accounts,
  emptyText,
}: {
  clientLinkId: string;
  icon: any;
  iconColor: string;
  label: string;
  accounts: BSAccount[];
  emptyText: string;
}) {
  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
  return (
    <div>
      <div className="px-5 py-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink-slate bg-gray-50">
        <Icon size={13} style={{ color: iconColor }} />
        {label}
        <span className="text-[10px] font-semibold opacity-70">
          {accounts.length} account{accounts.length === 1 ? "" : "s"}
        </span>
      </div>
      {accounts.length === 0 ? (
        <div className="px-5 py-3 text-xs text-ink-light">{emptyText}</div>
      ) : (
        accounts.map((a) => (
          <a
            key={a.qbo_account_id}
            href={`/balance-sheet/${clientLinkId}/${a.qbo_account_id}`}
            className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors"
          >
            <Icon size={16} style={{ color: iconColor }} className="flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm text-navy truncate">
                {a.name}
                {a.last4 && (
                  <span className="ml-2 font-mono text-xs text-ink-slate">
                    •••{a.last4}
                  </span>
                )}
              </div>
              <div className="text-xs text-ink-light truncate">
                {a.account_subtype || a.account_type}
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="text-sm font-mono font-semibold text-navy">
                {fmt.format(a.current_balance)}
              </div>
              <div className="text-[10px] text-ink-light uppercase tracking-wider">
                QBO balance
              </div>
            </div>
            <ArrowRight size={14} className="text-ink-light flex-shrink-0" />
          </a>
        ))
      )}
    </div>
  );
}
