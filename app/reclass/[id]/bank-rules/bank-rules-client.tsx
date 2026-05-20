"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, ArrowRight, Loader2, Calendar, Flag } from "lucide-react";

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
  /** The cleanup's date range (from the reclass job). Used to ask QBO
   *  whether there are any Stripe-tagged deposits in that window — if
   *  zero, we skip the Stripe-recon step entirely and offer a
   *  do-another-period / mark-complete choice instead. */
  cleanupRangeStart: string | null;
  cleanupRangeEnd: string | null;
}

export function BankRulesFromReclassClient({
  reclassJobId,
  clientLinkId,
  clientName,
  proposedRules,
  availableAccounts,
  cleanupRangeStart,
  cleanupRangeEnd,
}: Props) {
  const router = useRouter();
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

  // Stripe-deposits pre-check: counts QBO deposits flagged as Stripe-origin
  // in the cleanup's date range. Drives the "skip Stripe recon" shortcut
  // when zero exist. Null = not yet checked / fail-soft. We fetch lazily
  // only when the user reaches the Continue stage (created !== null OR
  // proposedRules.length === 0) so we don't burn QBO API calls on every
  // page visit.
  const [depositCheck, setDepositCheck] = useState<{
    count: number | null;
    total_amount: number | null;
    loading: boolean;
  }>({ count: null, total_amount: null, loading: false });

  // Trigger pre-check only at the "post-bank-rules" moment to keep cost low.
  const inContinueStage = created !== null || proposedRules.length === 0;
  useEffect(() => {
    if (!inContinueStage) return;
    if (!cleanupRangeStart || !cleanupRangeEnd) return;
    if (depositCheck.count !== null || depositCheck.loading) return;
    setDepositCheck((s) => ({ ...s, loading: true }));
    fetch(
      `/api/clients/${clientLinkId}/stripe-deposits-check?start=${cleanupRangeStart}&end=${cleanupRangeEnd}`
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        setDepositCheck({
          count: data?.count ?? null,
          total_amount: data?.total_amount ?? null,
          loading: false,
        });
      })
      .catch(() => setDepositCheck((s) => ({ ...s, loading: false })));
  }, [inContinueStage, clientLinkId, cleanupRangeStart, cleanupRangeEnd, depositCheck.count, depositCheck.loading]);

  async function handleMarkCleanupComplete() {
    if (
      !confirm(
        `Mark ${clientName}'s cleanup complete?\n\n` +
          `• The client moves to the Completed Accounts list.\n` +
          `• PDF report stays available; you can reopen anytime.\n` +
          `• Since there are no Stripe deposits in this window, the Stripe recon step is skipped.`
      )
    )
      return;
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/complete-cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          range_start: cleanupRangeStart || undefined,
          range_end: cleanupRangeEnd || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      router.push("/clients");
    } catch (e: any) {
      setError(e.message || "Failed to mark complete");
    }
  }

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

  // Shared "what's next" footer for both empty-state and post-create
  // panels. Renders either the standard Continue-to-Stripe-Recon CTA
  // or, when the pre-check confirmed zero Stripe deposits in the
  // cleanup's date range, a Do-another-period / Mark-cleanup-complete
  // choice screen. While the pre-check is in flight we show a small
  // loader; once it resolves we pick the right path.
  function NextStepFooter() {
    if (depositCheck.loading) {
      return (
        <div className="inline-flex items-center gap-2 text-sm text-ink-slate">
          <Loader2 size={14} className="animate-spin" />
          Checking for Stripe deposits in this client&apos;s books…
        </div>
      );
    }

    // Zero deposits + we have a date range we trust → skip recon, offer
    // the do-another-period / mark-complete choice.
    if (depositCheck.count === 0 && cleanupRangeStart && cleanupRangeEnd) {
      const startYear = Number(cleanupRangeStart.split("-")[0]);
      const previousYear =
        Number.isFinite(startYear) ? startYear - 1 : null;
      const otherPeriodHref = previousYear
        ? `/jobs/new?client=${clientLinkId}` // start a fresh cleanup on a different period
        : `/jobs/new?client=${clientLinkId}`;

      return (
        <div className="text-left max-w-md mx-auto space-y-5">
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 leading-relaxed">
            <div className="font-bold mb-1">
              No Stripe deposits in this cleanup window
            </div>
            We scanned QBO from <strong>{cleanupRangeStart}</strong> to{" "}
            <strong>{cleanupRangeEnd}</strong> and found{" "}
            <strong>zero Stripe-tagged deposits</strong>. Nothing to reconcile
            for this period — skip the Stripe recon step.
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold text-navy">What now?</div>
            <Link
              href={otherPeriodHref}
              className="w-full inline-flex items-center justify-center gap-2 bg-white hover:bg-gray-50 border border-gray-200 text-navy text-sm font-semibold px-5 py-2.5 rounded-lg"
            >
              <Calendar size={16} />
              Do another period (start a new cleanup)
              <ArrowRight size={14} />
            </Link>
            <button
              type="button"
              onClick={handleMarkCleanupComplete}
              className="w-full inline-flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            >
              <Flag size={16} />
              Mark {clientName}&apos;s cleanup complete
              <ArrowRight size={14} />
            </button>
            <Link
              href={`/stripe-recon/new?client=${clientLinkId}`}
              className="block text-xs text-ink-slate underline hover:text-navy text-center pt-1"
            >
              Or run Stripe Recon anyway on a different range
            </Link>
          </div>
          {error && (
            <div className="p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
              {error}
            </div>
          )}
        </div>
      );
    }

    // Normal path — deposits exist (or we couldn't check, fail-open).
    return (
      <>
        <Link
          href={`/stripe-recon/new?client=${clientLinkId}`}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white font-semibold px-6 py-2.5 rounded-lg"
        >
          Continue to Stripe Recon{" "}
          {depositCheck.count !== null && depositCheck.count > 0 && (
            <span className="opacity-80 text-xs">
              · {depositCheck.count} Stripe deposit
              {depositCheck.count === 1 ? "" : "s"} found
            </span>
          )}
          <ArrowRight size={16} />
        </Link>
        <div>
          <Link
            href="/dashboard"
            className="text-sm text-ink-slate underline hover:text-navy"
          >
            Back to dashboard
          </Link>
        </div>
      </>
    );
  }

  if (proposedRules.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center space-y-4">
        <p className="text-ink-slate text-sm">
          No vendor→account mappings to create rules from — the job had no approved transactions,
          or all vendors were already saved as bank rules.
        </p>
        <NextStepFooter />
      </div>
    );
  }

  if (created !== null) {
    // Branch the success copy: real-create vs skipped. created=0 fires
    // when the bookkeeper clicked "Skip without creating" — celebrating
    // "0 bank rules created" would be confusing.
    const skipped = created === 0;
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center space-y-4">
        <div className="flex justify-center">
          <div
            className={`w-16 h-16 rounded-full flex items-center justify-center ${
              skipped ? "bg-gray-100" : "bg-emerald-100"
            }`}
          >
            <CheckCircle2
              className={skipped ? "text-ink-slate" : "text-emerald-600"}
              size={32}
            />
          </div>
        </div>
        <h2 className="text-2xl font-bold text-navy">
          {skipped
            ? "Bank rules step skipped"
            : `${created} bank rule${created === 1 ? "" : "s"} created`}
        </h2>
        <p className="text-ink-slate text-sm max-w-sm mx-auto">
          {skipped
            ? "No rules created from this reclass — moving on to the next step."
            : "Future transactions matching these vendors will auto-categorize in QBO."}
        </p>
        <NextStepFooter />
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

      <div className="flex items-center justify-end gap-4 flex-wrap">
        <span className="text-sm text-ink-slate">
          {selected.size} of {proposedRules.length} selected
        </span>

        {/* Skip path — bookkeeper doesn't want to create any rules
            from this reclass. Setting created=0 hops into the
            NextStepFooter branch, which routes to Stripe Recon (or
            the do-another-period / mark-complete screen if there are
            zero Stripe deposits). Same destination as a successful
            create, just no rules persisted. */}
        <button
          type="button"
          onClick={() => setCreated(0)}
          disabled={submitting}
          className="text-sm font-semibold text-ink-slate hover:text-navy disabled:opacity-60 underline"
          title="Skip without creating rules"
        >
          {selected.size === 0
            ? "Skip — no rules to create →"
            : "Skip without creating →"}
        </button>

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
