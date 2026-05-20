"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, ArrowRight, RefreshCw, AlertCircle, Sparkles, Wallet,
  CheckCircle2, Save, FileText, Landmark, CreditCard, FileSpreadsheet,
  HomeIcon,
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

type Category =
  | "personal"
  | "business_checking"
  | "business_savings"
  | "loan_cc";

interface RowState {
  category: Category | "";
  ending_balance: string;
  as_of_date: string;
  notes: string;
}

interface Suggestion {
  qbo_account_id: string;
  status: "matched" | "gap" | "no_balance";
  gap: number;
  summary: string;
  reasoning: string;
  je_lines: Array<{
    side: "debit" | "credit";
    account_hint: string;
    amount: number;
    description: string;
  }>;
}

const CATEGORY_LABELS: Record<Category, string> = {
  personal: "Personal",
  business_checking: "Business Checking",
  business_savings: "Business Savings",
  loan_cc: "Loan / Credit Card",
};

const CATEGORY_ICON: Record<Category, any> = {
  personal: HomeIcon,
  business_checking: Landmark,
  business_savings: Wallet,
  loan_cc: CreditCard,
};

/**
 * Inline single-page form for Balance Sheet reconciliation. Every
 * bank / CC / loan account on the client's QBO COA renders as one row.
 * Bookkeeper picks a category (Personal / Business Checking / Business
 * Savings / Loan-CC), enters the statement ending balance + as-of
 * date, and clicks Save All at the bottom — we compute the gap per
 * row and surface adjusting-JE suggestions inline. No per-account
 * page navigation.
 *
 * Categories are sticky (saved on client_account_categories) so the
 * next BS cleanup session pre-fills.
 */
export function BalanceSheetLanding({
  clientLinkId,
  clientName,
}: {
  clientLinkId: string;
  clientName: string;
}) {
  const router = useRouter();

  const [accounts, setAccounts] = useState<BSAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<{ recons: number; cats: number } | null>(null);
  const [runningUFAR, setRunningUFAR] = useState(false);

  async function loadAccounts() {
    setLoading(true);
    setError("");
    try {
      const [accRes, prefillRes] = await Promise.all([
        fetch(`/api/clients/${clientLinkId}/bs-accounts`).then((r) => r.json()),
        fetch(
          `/api/balance-sheet/bank-recon-batch?client_link_id=${clientLinkId}`
        ).then((r) => r.json()),
      ]);

      if (accRes.error) throw new Error(accRes.error);
      const allAccts: BSAccount[] = [
        ...(accRes.accounts.bank || []),
        ...(accRes.accounts.credit_card || []),
        ...(accRes.accounts.loan || []),
      ];
      setAccounts(allAccts);

      // Pre-fill rows from prior input (categories + most-recent recon)
      const initial: Record<string, RowState> = {};
      for (const a of allAccts) {
        const prior = prefillRes?.prefill?.[a.qbo_account_id];
        initial[a.qbo_account_id] = {
          category: prior?.category || "",
          ending_balance: prior?.statement_ending_balance?.toString() ?? "",
          as_of_date: prior?.statement_as_of_date ?? "",
          notes: prior?.notes ?? "",
        };
      }
      setRows(initial);
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

  function updateRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    // Clear any prior save success since the input changed
    setSaveSuccess(null);
  }

  async function saveAll() {
    setSaving(true);
    setError("");
    setSaveSuccess(null);
    try {
      const entries = accounts
        .map((a) => {
          const r = rows[a.qbo_account_id];
          if (!r) return null;
          const hasBalance =
            r.ending_balance !== "" && r.ending_balance != null;
          const hasDate = !!r.as_of_date;
          if (!r.category && !hasBalance && !hasDate) return null;
          return {
            qbo_account_id: a.qbo_account_id,
            category: r.category || null,
            statement_ending_balance: hasBalance ? Number(r.ending_balance) : null,
            statement_as_of_date: hasDate ? r.as_of_date : null,
            notes: r.notes || null,
          };
        })
        .filter(Boolean);

      const res = await fetch("/api/balance-sheet/bank-recon-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId, entries }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);

      // Index suggestions by qbo_account_id for inline render
      const map: Record<string, Suggestion> = {};
      for (const s of json.suggestions || []) {
        map[s.qbo_account_id] = s;
      }
      setSuggestions(map);
      setSaveSuccess({
        recons: json.saved_recons || 0,
        cats: json.saved_categories || 0,
      });
    } catch (e: any) {
      setError(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

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

  // Order accounts so banks come first, then CCs, then loans.
  const orderedAccounts = useMemo(() => {
    const order: Record<string, number> = { bank: 0, credit_card: 1, loan: 2 };
    return [...accounts].sort((a, b) => {
      const k = order[a.kind] - order[b.kind];
      if (k !== 0) return k;
      return a.name.localeCompare(b.name);
    });
  }, [accounts]);

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(n);

  return (
    <div className="space-y-6">
      {/* UF → A/R top action */}
      <div className="rounded-2xl bg-gradient-to-br from-teal-lighter to-white border border-teal/30 p-5">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-teal-light flex-shrink-0">
            <Wallet size={18} className="text-teal" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-navy">
              Match Undeposited Funds to A/R
            </h2>
            <p className="text-xs text-ink-slate mt-1 leading-relaxed">
              Scan every UF payment and cross-reference against open A/R
              invoices. Memo refs like INV-1234 → exact match; customer +
              amount → high-confidence suggestion; rest → manual picker.
            </p>
          </div>
          <button
            onClick={runUFAR}
            disabled={runningUFAR}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-xs font-semibold px-4 py-2 rounded-lg flex-shrink-0"
          >
            {runningUFAR ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {runningUFAR ? "Starting…" : "Scan UF → A/R"}
            <ArrowRight size={12} />
          </button>
        </div>
      </div>

      {/* Account reconciliation form — the main event */}
      <div className="rounded-2xl bg-white border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-navy">
              Reconcile accounts for {clientName}
            </h2>
            <p className="text-xs text-ink-slate mt-1 leading-relaxed">
              For each account: pick the category, enter the statement
              ending balance + as-of date, and hit Save All. We compute the
              gap vs QBO and propose adjusting journal entries inline.
              Categories are sticky across cleanup sessions.
            </p>
          </div>
          <button
            onClick={loadAccounts}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-60 flex-shrink-0"
            title="Re-pull from QBO"
          >
            {loading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            Refresh
          </button>
        </div>

        {error && (
          <div className="m-4 p-2.5 rounded-md bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {saveSuccess && (
          <div className="m-4 p-2.5 rounded-md bg-green-50 border border-green-200 text-xs text-green-900 flex items-start gap-2">
            <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" />
            <span>
              Saved {saveSuccess.recons} reconciliation entr
              {saveSuccess.recons === 1 ? "y" : "ies"} +{" "}
              {saveSuccess.cats} categor
              {saveSuccess.cats === 1 ? "y" : "ies"}. JE suggestions appear
              inline below.
            </span>
          </div>
        )}

        {loading && accounts.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-ink-slate">
            <Loader2 size={18} className="inline animate-spin mr-2 text-teal" />
            Fetching accounts from QuickBooks…
          </div>
        )}

        {orderedAccounts.length > 0 && (
          <>
            {/* Header row */}
            <div className="px-5 py-2.5 bg-gray-50 border-b border-gray-100 text-[10px] font-bold uppercase tracking-wider text-ink-slate grid items-center gap-3"
                 style={{ gridTemplateColumns: "minmax(180px,2fr) minmax(140px,1.4fr) 110px 130px 100px 32px" }}>
              <div>Account</div>
              <div>Category</div>
              <div>QBO balance</div>
              <div>Statement ending balance</div>
              <div>As-of date</div>
              <div></div>
            </div>

            <div className="divide-y divide-gray-100">
              {orderedAccounts.map((a) => {
                const r = rows[a.qbo_account_id] || {
                  category: "",
                  ending_balance: "",
                  as_of_date: "",
                  notes: "",
                };
                const sug = suggestions[a.qbo_account_id];
                return (
                  <div key={a.qbo_account_id}>
                    <div className="px-5 py-3 grid items-center gap-3"
                         style={{ gridTemplateColumns: "minmax(180px,2fr) minmax(140px,1.4fr) 110px 130px 100px 32px" }}>
                      {/* Account name + last4 */}
                      <div className="min-w-0">
                        <div className="font-semibold text-sm text-navy truncate">
                          {a.name}
                          {a.last4 && (
                            <span className="ml-1.5 font-mono text-xs text-ink-slate">
                              •••{a.last4}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-ink-light truncate">
                          {a.account_subtype || a.account_type}
                        </div>
                      </div>

                      {/* Category */}
                      <select
                        value={r.category}
                        onChange={(e) =>
                          updateRow(a.qbo_account_id, {
                            category: e.target.value as Category,
                          })
                        }
                        className="px-2 py-1.5 rounded border border-gray-200 focus:border-teal outline-none text-xs text-navy bg-white"
                      >
                        <option value="">— Pick —</option>
                        <option value="business_checking">
                          Business Checking
                        </option>
                        <option value="business_savings">
                          Business Savings
                        </option>
                        <option value="loan_cc">Loan / CC</option>
                        <option value="personal">Personal</option>
                      </select>

                      {/* QBO balance */}
                      <div className="text-xs font-mono text-ink-slate text-right">
                        {fmt(a.current_balance)}
                      </div>

                      {/* Statement ending balance */}
                      <input
                        type="number"
                        step="0.01"
                        value={r.ending_balance}
                        onChange={(e) =>
                          updateRow(a.qbo_account_id, {
                            ending_balance: e.target.value,
                          })
                        }
                        placeholder="0.00"
                        className="px-2 py-1.5 rounded border border-gray-200 focus:border-teal outline-none text-xs font-mono text-navy text-right"
                      />

                      {/* As-of date */}
                      <input
                        type="date"
                        value={r.as_of_date}
                        onChange={(e) =>
                          updateRow(a.qbo_account_id, {
                            as_of_date: e.target.value,
                          })
                        }
                        className="px-2 py-1.5 rounded border border-gray-200 focus:border-teal outline-none text-xs text-navy"
                      />

                      {/* Status indicator */}
                      <div className="flex items-center justify-center">
                        {sug && sug.status === "matched" && (
                          <CheckCircle2
                            size={16}
                            className="text-green-600"
                          />
                        )}
                        {sug && sug.status === "gap" && (
                          <AlertCircle
                            size={16}
                            className="text-amber-600"
                          />
                        )}
                      </div>
                    </div>

                    {/* JE suggestion (inline below row when saved) */}
                    {sug && sug.status !== "no_balance" && (
                      <div
                        className={`px-5 py-3 ml-12 mr-5 mb-3 rounded-lg border text-xs ${
                          sug.status === "matched"
                            ? "bg-green-50 border-green-200"
                            : "bg-amber-50 border-amber-200"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex-1">
                            <div
                              className={`font-bold text-sm ${
                                sug.status === "matched"
                                  ? "text-green-900"
                                  : "text-amber-900"
                              }`}
                            >
                              {sug.summary}
                              {sug.status === "gap" && (
                                <span className="ml-2 font-mono font-normal">
                                  {fmt(sug.gap)}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 leading-relaxed text-ink-slate">
                              {sug.reasoning}
                            </p>
                            {sug.je_lines.length > 0 && (
                              <div className="mt-3 bg-white border border-gray-200 rounded p-2">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1.5">
                                  Suggested journal entry
                                </div>
                                <table className="w-full text-[11px]">
                                  <thead>
                                    <tr className="text-ink-light">
                                      <th className="text-left font-semibold pr-3">Account</th>
                                      <th className="text-right font-semibold pr-3">DR</th>
                                      <th className="text-right font-semibold">CR</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sug.je_lines.map((line, i) => (
                                      <tr key={i} className="border-t border-gray-100">
                                        <td className="py-1 pr-3">
                                          <div className="font-semibold text-navy">
                                            {line.account_hint}
                                          </div>
                                          <div className="text-[10px] text-ink-light">
                                            {line.description}
                                          </div>
                                        </td>
                                        <td className="text-right font-mono pr-3">
                                          {line.side === "debit"
                                            ? fmt(line.amount)
                                            : ""}
                                        </td>
                                        <td className="text-right font-mono">
                                          {line.side === "credit"
                                            ? fmt(line.amount)
                                            : ""}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Save all */}
            <div className="px-5 py-4 border-t border-gray-100 bg-gray-50 flex items-center justify-between gap-3">
              <div className="text-xs text-ink-slate">
                Categories are sticky; reconciliation entries are
                history-preserving (each Save All inserts new rows).
              </div>
              <button
                onClick={saveAll}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-sm font-semibold px-5 py-2 rounded-lg"
              >
                {saving ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Save size={14} />
                )}
                {saving ? "Saving…" : "Save All & Compute Gaps"}
              </button>
            </div>
          </>
        )}

        {!loading && orderedAccounts.length === 0 && !error && (
          <div className="px-5 py-8 text-center text-sm text-ink-slate">
            No bank, credit-card, or loan accounts on this client&apos;s QBO.
          </div>
        )}
      </div>
    </div>
  );
}
