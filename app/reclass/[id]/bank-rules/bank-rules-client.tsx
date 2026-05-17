"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, ArrowRight, Loader2 } from "lucide-react";

interface ProposedRule {
  vendorPattern: string;
  vendorDisplay: string;
  targetAccountId: string;
  targetAccountName: string;
  txCount: number;
  totalAmount: number;
}

interface AvailableAccount {
  id: string;
  name: string;
  type: string;
}

interface Props {
  reclassJobId: string;
  clientLinkId: string;
  clientName: string;
  proposedRules: ProposedRule[];
  availableAccounts: AvailableAccount[];
}

export function BankRulesFromReclassClient({
  reclassJobId,
  clientLinkId,
  clientName,
  proposedRules,
  availableAccounts,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(proposedRules.map((r) => r.vendorPattern))
  );
  // Per-vendor account override map. Defaults to the AI-picked target;
  // the bookkeeper can re-route a rule to any P&L account from the dropdown.
  const [overrides, setOverrides] = useState<Map<string, { id: string; name: string }>>(
    () => {
      const initial = new Map<string, { id: string; name: string }>();
      for (const r of proposedRules) {
        initial.set(r.vendorPattern, { id: r.targetAccountId, name: r.targetAccountName });
      }
      return initial;
    }
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<number | null>(null);

  function setOverride(vendorPattern: string, accountId: string) {
    const account = availableAccounts.find((a) => a.id === accountId);
    if (!account) return;
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(vendorPattern, { id: account.id, name: account.name });
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    if (checked) {
      setSelected(new Set(proposedRules.map((r) => r.vendorPattern)));
    } else {
      setSelected(new Set());
    }
  }

  function toggleOne(vendorPattern: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(vendorPattern)) {
        next.delete(vendorPattern);
      } else {
        next.add(vendorPattern);
      }
      return next;
    });
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError("");
    try {
      // Send only the overrides for SELECTED vendors. The API will use
      // these to set target_account_name, falling back to the AI pick if
      // a vendor isn't in the map (shouldn't happen, but safe).
      const overridesPayload: Record<string, { id: string; name: string }> = {};
      for (const vendorPattern of selected) {
        const o = overrides.get(vendorPattern);
        if (o) overridesPayload[vendorPattern] = o;
      }

      const res = await fetch("/api/rules/from-reclass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reclass_job_id: reclassJobId,
          client_link_id: clientLinkId,
          selected_vendors: Array.from(selected),
          overrides: overridesPayload,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create bank rules");
      setCreated(data.created);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (proposedRules.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center space-y-4">
        <p className="text-ink-slate text-sm">
          No vendor→account mappings to create rules from — the job had no approved transactions,
          or all vendors were already saved as bank rules.
        </p>
        <Link
          href={`/stripe-recon/new?client=${clientLinkId}`}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white font-semibold px-6 py-2.5 rounded-lg"
        >
          Continue to Stripe Recon <ArrowRight size={16} />
        </Link>
        <div>
          <Link href="/dashboard" className="text-sm text-ink-slate underline hover:text-navy">
            Skip — back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (created !== null) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center space-y-4">
        <div className="flex justify-center">
          <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center">
            <CheckCircle2 className="text-emerald-600" size={32} />
          </div>
        </div>
        <h2 className="text-2xl font-bold text-navy">{created} bank rules created</h2>
        <p className="text-ink-slate text-sm max-w-sm mx-auto">
          Future transactions matching these vendors will auto-categorize in QBO.
        </p>
        <Link
          href={`/stripe-recon/new?client=${clientLinkId}`}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white font-semibold px-6 py-2.5 rounded-lg"
        >
          Continue to Stripe Recon <ArrowRight size={16} />
        </Link>
        <div>
          <Link href="/dashboard" className="text-sm text-ink-slate underline hover:text-navy">
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  const allChecked = selected.size === proposedRules.length;
  const someChecked = selected.size > 0 && selected.size < proposedRules.length;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <div className="mb-1">
          <h2 className="text-xl font-bold text-navy">
            {proposedRules.length} vendors → {proposedRules.length} bank rules
          </h2>
          <p className="text-sm text-ink-slate mt-1">
            Deselect any rules you don't want to create, then click the button below.
          </p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="w-10 px-4 py-3 text-left">
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked;
                  }}
                  onChange={(e) => toggleAll(e.target.checked)}
                  className="rounded border-gray-300 text-teal focus:ring-teal"
                />
              </th>
              <th className="px-4 py-3 text-left font-semibold text-navy">Vendor</th>
              <th className="px-4 py-3 text-left font-semibold text-navy">Account</th>
              <th className="px-4 py-3 text-right font-semibold text-navy">Transactions</th>
              <th className="px-4 py-3 text-right font-semibold text-navy">Total</th>
            </tr>
          </thead>
          <tbody>
            {proposedRules.map((rule) => {
              const isSelected = selected.has(rule.vendorPattern);
              return (
                <tr
                  key={rule.vendorPattern}
                  onClick={() => toggleOne(rule.vendorPattern)}
                  className={`border-b border-gray-50 last:border-0 cursor-pointer transition-colors ${
                    isSelected ? "bg-white hover:bg-teal-lighter/30" : "bg-gray-50/60 opacity-50 hover:opacity-70"
                  }`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(rule.vendorPattern)}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded border-gray-300 text-teal focus:ring-teal"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-navy">{rule.vendorDisplay}</div>
                    {rule.vendorPattern !== rule.vendorDisplay && (
                      <div className="text-xs text-ink-slate font-mono">{rule.vendorPattern}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {availableAccounts.length > 0 ? (
                      <select
                        value={overrides.get(rule.vendorPattern)?.id || rule.targetAccountId}
                        onChange={(e) => setOverride(rule.vendorPattern, e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        disabled={!isSelected}
                        className={`text-xs font-semibold rounded-md border px-2 py-1 outline-none focus:ring-2 focus:ring-teal/40 ${
                          isSelected
                            ? "bg-teal-lighter text-teal border-teal/30 cursor-pointer"
                            : "bg-gray-100 text-ink-slate border-gray-200 cursor-not-allowed"
                        }`}
                      >
                        {/* If the AI-picked target isn't in the live P&L list,
                            still render it so the row doesn't blank out. */}
                        {!availableAccounts.find((a) => a.id === rule.targetAccountId) && (
                          <option value={rule.targetAccountId}>
                            {rule.targetAccountName}
                          </option>
                        )}
                        {availableAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-teal-lighter text-teal text-xs font-semibold">
                        {rule.targetAccountName}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-ink-slate">{rule.txCount}</td>
                  <td className="px-4 py-3 text-right text-ink-slate font-mono">
                    ${Math.abs(rule.totalAmount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-800 rounded-lg text-sm">{error}</div>
      )}

      <div className="flex items-center justify-end gap-4">
        <span className="text-sm text-ink-slate">
          {selected.size} of {proposedRules.length} selected
        </span>
        <button
          onClick={handleSubmit}
          disabled={selected.size === 0 || submitting}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-6 py-2.5 rounded-lg shadow-md transition-colors"
        >
          {submitting ? (
            <>
              <Loader2 className="animate-spin" size={16} /> Creating...
            </>
          ) : (
            <>
              Create {selected.size} Bank Rule{selected.size !== 1 ? "s" : ""} <ArrowRight size={16} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
