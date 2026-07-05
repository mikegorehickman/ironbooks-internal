"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, ArrowRight, Loader2, Calendar, Flag, Download } from "lucide-react";

interface ProposedRule {
  vendorPattern: string;
  vendorDisplay: string;
  targetAccountId: string;
  targetAccountName: string;
  txCount: number;
  totalAmount: number;
  /**
   * True when the AI / bookkeeper picked a target during reclass.
   * False when this vendor appeared in the job but no target was ever
   * chosen — the row renders with an empty "Pick target..." dropdown
   * and is NOT auto-selected. Bookkeeper opts in by ticking + picking.
   */
  hasTarget: boolean;
  /**
   * True when bank_rules already has a `pushed_to_qbo=true` row for this
   * vendor (from a prior .xls export). Row renders with an "Already in
   * QBO" badge and is default-unchecked. Re-ticking is safe — the upsert
   * + push guards prevent QBO duplicates.
   */
  alreadyInQbo: boolean;
}

interface AvailableAccount {
  id: string;
  name: string;
  type: string;
  /** "master" = curated master COA account (shown first); "other" = any
   *  other live QBO account (safety net so nothing is unselectable). */
  group?: "master" | "other";
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
  // Default selection: every vendor that has an AI-picked target AND is
  // not already in QBO. Vendors without a target appear unchecked
  // (opt-in via tick + pick); vendors already in QBO appear unchecked
  // (opt-in to recreate, which is safe via upsert + push-skip guards).
  const [selected, setSelected] = useState<Set<string>>(
    new Set(
      proposedRules
        .filter((r) => r.hasTarget && !r.alreadyInQbo)
        .map((r) => r.vendorPattern)
    )
  );
  // Per-vendor account override map. Defaults to the AI-picked target;
  // empty for vendors with no target (bookkeeper picks via the dropdown).
  const [overrides, setOverrides] = useState<Map<string, { id: string; name: string }>>(
    () => {
      const initial = new Map<string, { id: string; name: string }>();
      for (const r of proposedRules) {
        if (r.targetAccountId) {
          initial.set(r.vendorPattern, { id: r.targetAccountId, name: r.targetAccountName });
        }
      }
      return initial;
    }
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<number | null>(null);
  // QBO push outcome — populated after a real create (not a skip). Drives
  // the "X of Y pushed to QBO" copy on the success screen and surfaces any
  // per-rule push errors so the bookkeeper isn't blind to a silent partial.
  const [pushOutcome, setPushOutcome] = useState<{
    pushed: number;
    failed: number;
    errors: string[];
  } | null>(null);

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
        `Wrap up ${clientName}'s cleanup?\n\n` +
          `This opens the statement sign-off. Next, on the Cleanup board you'll:\n` +
          `• Review the P&L / Balance Sheet for the period\n` +
          `• Attest, then approve & send the statements to the client — which closes the period.\n\n` +
          `(No Stripe deposits in this window, so the Stripe recon step is skipped.)`
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
      // complete-cleanup OPENS a statement sign-off (kind='cleanup'); it does
      // NOT close the period on its own — that requires the attest+send step.
      // Land the bookkeeper on the Cleanup board where the sign-off card lets
      // them review → attest → approve & send, which closes the period and
      // emails the client their statements. (Previously this redirected to the
      // client LIST with no feedback, so the button looked like it did nothing.)
      router.push(data?.already_complete ? "/clients" : "/cleanup");
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
    // Picking a target IS opting the vendor in — auto-select the row so the
    // bookkeeper doesn't also have to tick it first. (The dropdown used to
    // be disabled until the row was ticked, which read as "can't select
    // any account.")
    setSelected((prev) => {
      if (prev.has(vendorPattern)) return prev;
      const next = new Set(prev);
      next.add(vendorPattern);
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
      // Only send vendors where the bookkeeper has either:
      //   - the AI's original target still in the overrides map, OR
      //   - manually picked a target via the dropdown
      // Selected-but-no-target vendors are silently dropped here with a
      // visible warning above the table — we never POST a rule without
      // a destination account.
      const overridesPayload: Record<string, { id: string; name: string }> = {};
      const selectedVendorsPayload: string[] = [];
      const droppedNoTarget: string[] = [];
      for (const vendorPattern of selected) {
        const o = overrides.get(vendorPattern);
        if (o && o.id && o.name) {
          overridesPayload[vendorPattern] = o;
          selectedVendorsPayload.push(vendorPattern);
        } else {
          droppedNoTarget.push(vendorPattern);
        }
      }
      if (droppedNoTarget.length > 0) {
        console.warn(
          `[bank-rules] Dropping ${droppedNoTarget.length} selected vendors with no target picked: ${droppedNoTarget.join(", ")}`
        );
      }
      if (selectedVendorsPayload.length === 0) {
        throw new Error(
          "Every selected vendor needs a target account. Pick one from the dropdown next to each ticked row."
        );
      }

      const res = await fetch("/api/rules/from-reclass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reclass_job_id: reclassJobId,
          client_link_id: clientLinkId,
          selected_vendors: selectedVendorsPayload,
          overrides: overridesPayload,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create bank rules");
      setCreated(data.created);
      // The endpoint pushes to QBO inline now. Capture the outcome so the
      // success screen tells the truth — anything else and we repeat the
      // LT Woodworks confusion where rules were "created" but never landed.
      setPushOutcome({
        pushed: typeof data.pushed === "number" ? data.pushed : 0,
        failed: typeof data.push_failed === "number" ? data.push_failed : 0,
        errors: Array.isArray(data.push_errors) ? data.push_errors : [],
      });
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
            <Link
              href={`/balance-sheet/${clientLinkId}/cleanup`}
              className="w-full inline-flex items-center justify-center gap-2 bg-navy hover:bg-navy/90 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            >
              Continue to Balance Sheet
              <ArrowRight size={14} />
            </Link>
            <button
              type="button"
              onClick={handleMarkCleanupComplete}
              className="w-full inline-flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            >
              <Flag size={16} />
              Finish cleanup — review &amp; send statements
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
            href={`/balance-sheet/${clientLinkId}`}
            className="inline-flex items-center gap-2 bg-white hover:bg-gray-50 border border-gray-200 text-navy text-sm font-semibold px-5 py-2.5 rounded-lg"
          >
            Skip Stripe Recon — move to Balance Sheet
            <ArrowRight size={14} />
          </Link>
        </div>
        <div>
          <Link
            href="/today"
            className="text-sm text-ink-slate underline hover:text-navy"
          >
            Back to Today
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
    const pushed = pushOutcome?.pushed ?? 0;
    const pushFailed = pushOutcome?.failed ?? 0;
    const pushErrors = pushOutcome?.errors ?? [];
    const allPushed = !skipped && pushFailed === 0 && pushed === created;
    const somePushed = !skipped && pushed > 0 && pushFailed > 0;
    const nonePushed = !skipped && pushed === 0 && pushFailed > 0;

    // Pick icon/colour based on the QBO push outcome, not just the local
    // upsert. A row that exists in Supabase but not in QBO is half-done —
    // the bookkeeper needs to see that distinction.
    const iconCfg = skipped
      ? { bg: "bg-gray-100", color: "text-ink-slate" }
      : nonePushed
      ? { bg: "bg-red-100", color: "text-red-600" }
      : somePushed
      ? { bg: "bg-amber-100", color: "text-amber-600" }
      : { bg: "bg-emerald-100", color: "text-emerald-600" };

    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center space-y-4">
        <div className="flex justify-center">
          <div className={`w-16 h-16 rounded-full flex items-center justify-center ${iconCfg.bg}`}>
            <CheckCircle2 className={iconCfg.color} size={32} />
          </div>
        </div>
        <h2 className="text-2xl font-bold text-navy">
          {skipped
            ? "Bank rules step skipped"
            : `${created} bank rule${created === 1 ? "" : "s"} active in SNAP`}
        </h2>
        <p className="text-ink-slate text-sm max-w-md mx-auto">
          {skipped
            ? "No rules created from this reclass — moving on to the next step."
            : "SNAP's daily-recon engine applies these rules to new transactions and posts the categorization to QBO automatically. (QBO's public API doesn't support creating bank rules — see the download below to add them to QBO's native Rules tab too.)"}
        </p>

        {pushErrors.length > 0 && (
          <div className="max-w-md mx-auto bg-red-50 border border-red-200 rounded-lg p-3 text-left">
            <div className="text-xs font-bold text-red-800 mb-1">
              Push errors ({pushErrors.length})
            </div>
            <ul className="text-[11px] text-red-700 space-y-0.5 max-h-32 overflow-auto">
              {pushErrors.slice(0, 10).map((msg, i) => (
                <li key={i} className="leading-snug">• {msg}</li>
              ))}
              {pushErrors.length > 10 && (
                <li className="italic text-red-600">
                  …{pushErrors.length - 10} more
                </li>
              )}
            </ul>
          </div>
        )}

        {/* QBO import file — the manual-upload workaround for QBO's
            unsupported /bankrule API. Downloads an .xls that Lisa drops
            into QBO via Banking → Rules → ⋮ → Import Rules. SNAP's
            daily-recon engine keeps applying these rules in parallel,
            so this is additive — bookkeeper gets QBO-native rules AND
            the SNAP backstop. */}
        {!skipped && created > 0 && (
          <div className="max-w-md mx-auto pt-2">
            <a
              href={`/api/rules/export-qbo/${clientLinkId}`}
              download
              className="inline-flex items-center gap-2 text-sm font-semibold text-teal hover:text-teal-dark border border-teal/30 hover:border-teal bg-teal-lighter/50 hover:bg-teal-lighter px-4 py-2 rounded-lg transition-colors"
            >
              <Download size={16} />
              Download .xls for QBO import
            </a>
            <p className="text-[11px] text-ink-slate mt-2 leading-snug">
              Upload this in QuickBooks under <strong>Banking → Rules → ⋮ → Import Rules</strong>{" "}
              to add them natively in QBO. SNAP will keep applying them automatically either way.
            </p>
          </div>
        )}

        <NextStepFooter />
      </div>
    );
  }

  const allChecked = selected.size === proposedRules.length;
  const someChecked = selected.size > 0 && selected.size < proposedRules.length;

  // How many selected rows actually have a target → those are the ones
  // that will get submitted. The remainder need a target picked first.
  const readyCount = Array.from(selected).filter((vp) => {
    const t = overrides.get(vp);
    return !!(t && t.id);
  }).length;
  const needsTargetCount = selected.size - readyCount;

  // Counts for the header summary
  const totalVendors = proposedRules.length;
  const alreadyInQboCount = proposedRules.filter((r) => r.alreadyInQbo).length;
  const needsTargetTotal = proposedRules.filter((r) => !r.hasTarget && !r.alreadyInQbo).length;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <div className="mb-1">
          <h2 className="text-xl font-bold text-navy">
            {totalVendors} vendor{totalVendors === 1 ? "" : "s"} from this reclass
          </h2>
          <p className="text-sm text-ink-slate mt-1 leading-relaxed">
            Select vendors from this reclass and save their categorizations as rules —
            future transactions will auto-categorize using these patterns. Vendors with
            a confident AI target are pre-ticked.
            {needsTargetTotal > 0 && (
              <>
                {" "}
                <span className="font-semibold text-amber-700">
                  {needsTargetTotal} need{needsTargetTotal === 1 ? "s" : ""} a target
                </span>{" "}
                — tick the row and pick a target if you want a rule for them.
              </>
            )}
            {alreadyInQboCount > 0 && (
              <>
                {" "}
                <span className="font-semibold text-ink-slate">
                  {alreadyInQboCount} already in QBO
                </span>{" "}
                from a prior export — unchecked by default. Re-tick any you want to
                update; the existing QBO rule will be refreshed on next .xls export.
              </>
            )}
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
              const currentTargetId = overrides.get(rule.vendorPattern)?.id || rule.targetAccountId || "";
              // Selected-but-no-target = needs bookkeeper to pick before
              // submit will accept this row. We highlight it amber so it
              // can't be missed.
              const needsTarget = isSelected && !currentTargetId;
              return (
                <tr
                  key={rule.vendorPattern}
                  onClick={() => toggleOne(rule.vendorPattern)}
                  className={`border-b border-gray-50 last:border-0 cursor-pointer transition-colors ${
                    needsTarget
                      ? "bg-amber-50/60 hover:bg-amber-50"
                      : isSelected
                      ? "bg-white hover:bg-teal-lighter/30"
                      : "bg-gray-50/60 opacity-50 hover:opacity-70"
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
                    <div className="font-medium text-navy flex items-center gap-1.5 flex-wrap">
                      {rule.vendorDisplay}
                      {!rule.hasTarget && (
                        <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                          Needs target
                        </span>
                      )}
                      {rule.alreadyInQbo && (
                        <span
                          className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-ink-slate border border-gray-200"
                          title="A bank rule for this vendor was already exported to QBO. Re-ticking will update the existing rule and re-include it in the next .xls export."
                        >
                          Already in QBO
                        </span>
                      )}
                    </div>
                    {rule.vendorPattern !== rule.vendorDisplay && (
                      <div className="text-xs text-ink-slate font-mono">{rule.vendorPattern}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {availableAccounts.length > 0 ? (
                      <select
                        value={currentTargetId}
                        onChange={(e) => setOverride(rule.vendorPattern, e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className={`text-xs font-semibold rounded-md border px-2 py-1 outline-none focus:ring-2 focus:ring-teal/40 cursor-pointer ${
                          needsTarget
                            ? "bg-white text-amber-800 border-amber-300"
                            : currentTargetId
                            ? "bg-teal-lighter text-teal border-teal/30"
                            : "bg-white text-navy border-gray-300"
                        }`}
                      >
                        {/* Placeholder for no-target rows so the bookkeeper
                            sees a clear "Pick target" prompt. */}
                        {!currentTargetId && (
                          <option value="">— Pick target… —</option>
                        )}
                        {/* If the AI-picked target isn't in the live list,
                            still render it so the row doesn't blank out. */}
                        {rule.targetAccountId &&
                          !availableAccounts.find((a) => a.id === rule.targetAccountId) && (
                            <option value={rule.targetAccountId}>
                              {rule.targetAccountName}
                            </option>
                          )}
                        {/* Curated master COA accounts first… */}
                        {availableAccounts.some((a) => a.group !== "other") && (
                          <optgroup label="Master COA">
                            {availableAccounts
                              .filter((a) => a.group !== "other")
                              .map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                          </optgroup>
                        )}
                        {/* …then every other live QBO account as a safety net. */}
                        {availableAccounts.some((a) => a.group === "other") && (
                          <optgroup label="Other QBO accounts">
                            {availableAccounts
                              .filter((a) => a.group === "other")
                              .map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                          </optgroup>
                        )}
                      </select>
                    ) : rule.targetAccountName ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-teal-lighter text-teal text-xs font-semibold">
                        {rule.targetAccountName}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold">
                        No target — QBO not reachable
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
          {readyCount} ready
          {needsTargetCount > 0 && (
            <span className="text-amber-700 font-semibold">
              {" "}
              · {needsTargetCount} need target
            </span>
          )}
          <span className="text-ink-light"> · {proposedRules.length} total</span>
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
          disabled={readyCount === 0 || submitting}
          title={
            needsTargetCount > 0
              ? `${needsTargetCount} selected vendor${needsTargetCount === 1 ? "" : "s"} need a target picked. They'll be dropped from this batch — click anyway to create the ${readyCount} ready rule${readyCount === 1 ? "" : "s"}.`
              : undefined
          }
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-6 py-2.5 rounded-lg shadow-md transition-colors"
        >
          {submitting ? (
            <>
              <Loader2 className="animate-spin" size={16} /> Creating...
            </>
          ) : (
            <>
              Create {readyCount} Bank Rule{readyCount !== 1 ? "s" : ""} <ArrowRight size={16} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
