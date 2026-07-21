"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Loader2, AlertCircle, Calendar, CreditCard, ArrowRight,
} from "lucide-react";

interface ClientLink {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  stripe_connection_status?: string | null;
  /** When non-null the client's main cleanup cycle has been closed
   *  out. Still selectable for Stripe-recon (a legitimate delta op),
   *  but annotated in the dropdown so it's clear. */
  cleanup_completed_at?: string | null;
  /** Failsafe metadata captured at OAuth-callback time (and on demand
   *  later). When `stripe_has_payouts === false` we warn the
   *  bookkeeper before they run a doomed recon — most often this
   *  means the client connected the wrong Stripe account
   *  (e.g. created a fresh one instead of logging into the existing
   *  one that's been receiving payments). */
  stripe_has_payouts?: boolean | null;
  stripe_last_payout_at?: string | null;
  stripe_payouts_checked_at?: string | null;
}

interface DateRangePreset {
  id: string;
  label: string;
  start: string;
  end: string;
}

export function NewStripeReconForm({
  clientLinks,
  initialClientId = null,
}: {
  clientLinks: ClientLink[];
  /** Server-resolved ?client= preselect. Seeding state from a prop makes
   *  the reclass/stepper handoff work on first paint instead of relying
   *  on the useSearchParams effect below (kept as fallback). */
  initialClientId?: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [clientLinkId, setClientLinkId] = useState<string>(initialClientId || "");
  const [reclassJobId, setReclassJobId] = useState<string | null>(null);
  const [extendingFromJobId, setExtendingFromJobId] = useState<string | null>(null);
  // Set when the user came in via the "Upgrade to Stripe API" banner on
  // a prior qbo_invoice_match recon's review page. Drives the upgrade
  // banner near the top of the form and pre-selects method=stripe_api.
  const [upgradeFromJobId, setUpgradeFromJobId] = useState<string | null>(null);

  const [datePresetId, setDatePresetId] = useState<string>("fy");
  const [datePresets, setDatePresets] = useState<DateRangePreset[]>([]);
  const [fiscalYearStartMonthName, setFiscalYearStartMonthName] = useState<string>("");
  const [loadingPresets, setLoadingPresets] = useState(false);
  const [presetsError, setPresetsError] = useState<string>("");

  const [dateRangeStart, setDateRangeStart] = useState<string>("");
  const [dateRangeEnd, setDateRangeEnd] = useState<string>("");
  // When the user lands here via the "extend" flow from a 0-deposit recon,
  // we honor start/end from the URL and skip the auto-preset overwrite that
  // would otherwise clobber them when datePresets finish loading.
  const [prefilledFromUrl, setPrefilledFromUrl] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>("");
  // For the "recheck Stripe health" inline action. Holds the most
  // recently-rechecked values (overrides selectedClient.stripe_*) so a
  // post-recheck UI update doesn't require a full page reload.
  const [healthOverride, setHealthOverride] = useState<{
    has_payouts: boolean | null;
    last_payout_at: string | null;
    checked_at: string | null;
  } | null>(null);
  const [rechecking, setRechecking] = useState(false);
  // "Client doesn't use Stripe" skip — calls the (previously UI-orphaned)
  // stripe-not-required endpoint so bookkeepers stop fighting the step
  // during onboarding when a client simply has no Stripe.
  const [skipReason, setSkipReason] = useState("");
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [skipError, setSkipError] = useState("");
  // When the API responds 409 with an existing_job_id, we hold it here so
  // the form can swap its generic error block for an actionable conflict
  // panel that links directly to the in-flight job.
  const [conflict, setConflict] = useState<{
    jobId: string;
    status: string;
  } | null>(null);

  const selectedClient = clientLinks.find((c) => c.id === clientLinkId);
  const isStripeConnected =
    selectedClient?.stripe_connection_status === "connected";

  async function markNotRequired() {
    if (!selectedClient) return;
    setSkipping(true);
    setSkipError("");
    try {
      const res = await fetch(`/api/clients/${selectedClient.id}/stripe-not-required`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: skipReason.trim() || "Marked from Stripe recon setup — client doesn't use Stripe" }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      router.push("/cleanup");
    } catch (e: any) {
      setSkipError(e?.message || "Failed to mark");
      setSkipping(false);
    }
  }

  // Effective health values — fresh recheck wins over the page-load
  // snapshot. Allows the inline "Re-check" button to update the warning
  // without a full reload.
  const effectiveHasPayouts =
    healthOverride !== null
      ? healthOverride.has_payouts
      : selectedClient?.stripe_has_payouts ?? null;
  const effectiveLastPayoutAt =
    healthOverride !== null
      ? healthOverride.last_payout_at
      : selectedClient?.stripe_last_payout_at ?? null;
  const effectiveCheckedAt =
    healthOverride !== null
      ? healthOverride.checked_at
      : selectedClient?.stripe_payouts_checked_at ?? null;

  async function recheckHealth() {
    if (!clientLinkId) return;
    setRechecking(true);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/stripe-recheck`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setHealthOverride({
        has_payouts: data.stripe_has_payouts ?? null,
        last_payout_at: data.stripe_last_payout_at ?? null,
        checked_at: data.stripe_payouts_checked_at ?? null,
      });
    } catch (e: any) {
      // Inline failure — just log; the warning panel is informational.
      console.warn("[stripe-recheck]", e?.message);
    } finally {
      setRechecking(false);
    }
  }

  // Reset the override whenever the selected client changes so we don't
  // leak one client's recheck result onto another.
  useEffect(() => {
    setHealthOverride(null);
  }, [clientLinkId]);

  // Default to Stripe API when connected, QBO matching otherwise. The user
  // can override on the form.
  const [method, setMethod] = useState<"stripe_api" | "qbo_invoice_match">(
    "qbo_invoice_match"
  );
  useEffect(() => {
    setMethod(isStripeConnected ? "stripe_api" : "qbo_invoice_match");
  }, [isStripeConnected]);

  // Auto-init from query string (handoff from reclass, the "extend"
  // CTA on a 0-deposit recon, or the "Upgrade to Stripe API" CTA on a
  // prior qbo-match recon).
  useEffect(() => {
    const cId = searchParams.get("client");
    const rId = searchParams.get("reclass_job_id");
    const sd = searchParams.get("start");
    const ed = searchParams.get("end");
    const ef = searchParams.get("extending_from");
    const uf = searchParams.get("upgrade_from");
    const m = searchParams.get("method");
    if (cId && clientLinks.some((c) => c.id === cId)) setClientLinkId(cId);
    if (rId) setReclassJobId(rId);
    if (ef) setExtendingFromJobId(ef);
    if (uf) setUpgradeFromJobId(uf);
    // Prefill start/end if provided. We mark prefilledFromUrl so the
    // "auto-default to FY preset when datePresets load" effect skips its
    // overwrite for this run.
    if (sd && ed) {
      setDateRangeStart(sd);
      setDateRangeEnd(ed);
      setPrefilledFromUrl(true);
    }
    // Force method=stripe_api when arriving via the upgrade flow.
    // (Otherwise the default-on-client-select effect would flip it
    // based on stripe_connection_status, which is also correct, but
    // explicit is better here.)
    if (m === "stripe_api") {
      setMethod("stripe_api");
    }
  }, [searchParams, clientLinks]);

  // Pre-check the same-client concurrency guard when a client is picked.
  // Catches the 409 case BEFORE submit so the form can disable itself and
  // show the conflict panel proactively — eliminates the "Failed to load
  // resource: 409" console errors that fire on the submit path.
  //
  // Two safeguards to avoid the upgrade-loop bug:
  //   - cache: 'no-store' so a freshly-acknowledged prior job isn't seen
  //     as still-active from a stale cached response.
  //   - exclude_job_id=upgradeFromJobId when we arrived via the upgrade
  //     CTA, so even if DB replication lag means the prior job still
  //     reads as in_review for a beat, this endpoint ignores it.
  useEffect(() => {
    if (!clientLinkId) {
      setConflict(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ client_link_id: clientLinkId });
    if (upgradeFromJobId) params.set("exclude_job_id", upgradeFromJobId);
    fetch(`/api/stripe-recon/active?${params.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.active) {
          setConflict({ jobId: data.active.id, status: data.active.status });
        } else {
          setConflict(null);
        }
      })
      .catch(() => {
        // Pre-check is best-effort; server-side guard still catches it.
      });
    return () => {
      cancelled = true;
    };
  }, [clientLinkId, upgradeFromJobId]);

  // Load fiscal year + presets when client is selected
  useEffect(() => {
    if (!clientLinkId) return;
    setLoadingPresets(true);
    setPresetsError("");
    fetch(`/api/clients/${clientLinkId}/company-info`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || "Failed to load company info");
        return r.json();
      })
      .then((data) => {
        setDatePresets(data.date_range_presets);
        setFiscalYearStartMonthName(data.company.fiscal_year_start_month_name);
        // Only auto-apply the FY preset if we didn't get start/end from the
        // URL — otherwise we'd clobber the bookkeeper's "extend back" choice
        // the moment company-info finishes loading.
        if (!prefilledFromUrl) {
          const def = data.date_range_presets.find((p: DateRangePreset) => p.id === "fy")
                   || data.date_range_presets[0];
          if (def) {
            setDatePresetId(def.id);
            setDateRangeStart(def.start);
            setDateRangeEnd(def.end);
          }
        } else {
          // Mark as "custom" so the preset-switch effect below doesn't
          // overwrite the URL dates either.
          setDatePresetId("__custom__");
        }
      })
      .catch((e) => setPresetsError(e.message))
      .finally(() => setLoadingPresets(false));
  }, [clientLinkId]);

  useEffect(() => {
    const p = datePresets.find((p) => p.id === datePresetId);
    if (p) { setDateRangeStart(p.start); setDateRangeEnd(p.end); }
  }, [datePresetId, datePresets]);

  // Disable submit if the pre-check (or a prior 409) has identified an
  // active recon on this client. Belt-and-suspenders: the server guard
  // still rejects the submit if someone bypasses this, so safety isn't
  // dependent on the UI.
  const canSubmit =
    !!clientLinkId &&
    !!dateRangeStart &&
    !!dateRangeEnd &&
    !submitting &&
    !conflict;

  async function handleSubmit() {
    if (!canSubmit || !selectedClient) return;
    setSubmitting(true);
    setSubmitError("");
    setConflict(null);

    try {
      const res = await fetch("/api/stripe-recon/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          reclass_job_id: reclassJobId || undefined,
          date_range_start: dateRangeStart,
          date_range_end: dateRangeEnd,
          jurisdiction: selectedClient.jurisdiction,
          state_province: selectedClient.state_province || "",
          method,
          // upgrade_from: tells the discover concurrency guard to ignore
          // the just-acknowledged prior job, in case its row hasn't fully
          // propagated to the read replica yet.
          upgrade_from: upgradeFromJobId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 409 carries the existing job's id/status — render the actionable
        // conflict panel instead of dumping the prose into the error block.
        if (res.status === 409 && data.existing_job_id) {
          setConflict({
            jobId: data.existing_job_id,
            status: data.existing_status || "in_review",
          });
          setSubmitting(false);
          return;
        }
        throw new Error(data.error || "Failed to start job");
      }
      router.push(`/stripe-recon/${data.job_id}/review`);
    } catch (e: any) {
      setSubmitError(e.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
        <div className="flex items-center gap-3">
          <CreditCard className="text-teal" size={24} />
          <h2 className="text-lg font-bold text-navy">Stripe AR Reconciliation</h2>
        </div>

        <p className="text-sm text-ink-slate">
          Pull Stripe deposits in a date range. AI matches each deposit to the customer
          invoices that make it up, calculates the Stripe processing fee
          {" "}(and sales tax on the fee for Canadian clients), and writes it back as
          labeled line items.
        </p>

        {reclassJobId && (
          <div className="p-3 rounded-lg bg-teal-lighter border border-teal/30 text-xs text-navy">
            ↪ Continuing from a transaction reclassification job.
          </div>
        )}

        {extendingFromJobId && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
            ↪ Extending the search window — the previous recon found 0 Stripe
            deposits. Date range below is pre-filled to look one year further
            back.
          </div>
        )}

        {upgradeFromJobId && (
          <div className="p-3 rounded-lg bg-teal-light border border-teal-border text-xs text-teal-dark">
            ↪ <strong>Upgrading to the Stripe API path.</strong> The previous
            recon used the QBO-AI matcher. Running this will replace the
            AI-matched <code className="font-mono">[Ironbooks]</code> lines on
            each deposit with deterministic charges/fees/customers pulled
            directly from Stripe.{" "}
            {selectedClient?.cleanup_completed_at
              ? "This client's main cleanup is marked complete — re-running the recon is fine; their completion status isn't affected."
              : ""}
          </div>
        )}

        {/* FAILSAFE: warn when the connected Stripe account has no payout
            history. Most common cause is the client connected the wrong
            Stripe account at OAuth time (created a new one instead of
            logging into the existing one). Without this guard a bookkeeper
            would only find out by running a doomed recon — the James
            Painting LLC incident. */}
        {selectedClient?.stripe_connection_status === "connected" &&
          effectiveHasPayouts === false && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-900 space-y-2">
              <div className="font-bold">
                ⚠ The connected Stripe account has no payout history
              </div>
              <div className="leading-relaxed">
                {selectedClient.client_name}&apos;s connected Stripe account
                shows <strong>zero payouts</strong> in its entire history. If
                you expect Stripe deposits to exist (QBO has them, or the
                client says so), the wrong Stripe account is likely connected
                — they may have created a fresh account on the Connect link
                instead of logging into the existing one that&apos;s been
                receiving payments.
              </div>
              <div className="leading-relaxed">
                <strong>Fix:</strong> open the{" "}
                <strong>Stripe Connect Link</strong> button in the sidebar,
                Disconnect this client, then send a fresh link with explicit
                instructions to log into the right Stripe account. Re-run the
                recon after they reconnect.
              </div>
              <div className="flex items-center justify-between gap-2">
                {effectiveCheckedAt && (
                  <span className="text-[10px] text-red-700/70">
                    Last checked {new Date(effectiveCheckedAt).toLocaleString()}
                  </span>
                )}
                <button
                  type="button"
                  onClick={recheckHealth}
                  disabled={rechecking}
                  className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 px-3 py-1.5 rounded-md disabled:opacity-60"
                >
                  {rechecking ? "Re-checking…" : "Re-check now"}
                </button>
              </div>
            </div>
          )}

        {/* "Doesn't use Stripe" skip — the legitimate exit from this step.
            Bookkeeper feedback: with no visible skip, onboarding bookkeepers
            were overriding through the flow every time a client simply had
            no Stripe. Marks stripe_not_required (audit-logged, reversible
            from the client profile) and returns to the cleanup board. */}
        {selectedClient && !isStripeConnected && (
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-ink-slate space-y-2">
            {!skipOpen ? (
              <div className="flex items-center justify-between gap-3">
                <span>
                  <strong className="text-navy">{selectedClient.client_name}</strong> doesn&apos;t take payments
                  through Stripe? You can skip this step for good.
                </span>
                <button
                  type="button"
                  onClick={() => setSkipOpen(true)}
                  className="shrink-0 text-xs font-semibold text-teal hover:underline"
                >
                  Skip — client doesn&apos;t use Stripe
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="font-semibold text-navy">
                  Mark {selectedClient.client_name} as not using Stripe
                </div>
                <p>
                  This hides every Stripe prompt for this client (invites, recon steps, reminders) and marks
                  step 4 as skipped on the board. It&apos;s audit-logged and reversible from the client profile
                  if they start taking Stripe payments later.
                </p>
                <input
                  value={skipReason}
                  onChange={(e) => setSkipReason(e.target.value)}
                  placeholder="Optional note, e.g. 'client only takes cheques + e-transfer'"
                  className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-teal"
                />
                {skipError && <p className="text-red-600">{skipError}</p>}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={markNotRequired}
                    disabled={skipping}
                    className="inline-flex items-center gap-1.5 rounded-md bg-teal text-white px-3 py-1.5 text-xs font-semibold hover:bg-teal/90 disabled:opacity-50"
                  >
                    {skipping ? <Loader2 size={12} className="animate-spin" /> : null}
                    Confirm — no Stripe for this client
                  </button>
                  <button
                    type="button"
                    onClick={() => setSkipOpen(false)}
                    className="text-xs text-ink-light hover:text-ink-slate"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Inverse: the account has payouts. Quiet green badge so the
            bookkeeper has a positive signal that the right account is
            connected — especially helpful for clients with similar names
            or for clients who've reconnected. */}
        {selectedClient?.stripe_connection_status === "connected" &&
          effectiveHasPayouts === true && (
            <div className="p-2 rounded-lg bg-green-50 border border-green-200 text-[11px] text-green-900">
              ✓ Stripe account looks healthy
              {effectiveLastPayoutAt && (
                <>
                  {" · Last payout "}
                  <strong>{effectiveLastPayoutAt.slice(0, 10)}</strong>
                </>
              )}
            </div>
          )}

        {/* Never-checked case: legacy connections from before the
            health-check migration. Surface a small prompt so the
            bookkeeper can populate it on demand. */}
        {selectedClient?.stripe_connection_status === "connected" &&
          effectiveHasPayouts === null && (
            <div className="p-2 rounded-lg bg-gray-50 border border-gray-200 text-[11px] text-ink-slate flex items-center justify-between">
              <span>
                Stripe health not yet checked for this client (legacy connection).
              </span>
              <button
                type="button"
                onClick={recheckHealth}
                disabled={rechecking}
                className="font-semibold text-teal hover:text-teal-dark disabled:opacity-60"
              >
                {rechecking ? "Checking…" : "Check now"}
              </button>
            </div>
          )}

        {/* Client */}
        <div>
          <label className="block text-sm font-semibold text-navy mb-2">Client</label>
          <select
            value={clientLinkId}
            onChange={(e) => setClientLinkId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
          >
            <option value="">Select a client...</option>
            {clientLinks.map((c) => (
              <option key={c.id} value={c.id}>
                {c.client_name} ({c.jurisdiction}{c.state_province ? ` · ${c.state_province}` : ""}){c.stripe_connection_status === "connected" ? " · Stripe connected" : ""}{c.cleanup_completed_at ? " · Cleanup complete" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Matching method — only meaningful once a client is selected */}
        {clientLinkId && (
          <div>
            <label className="block text-sm font-semibold text-navy mb-2">
              Matching method
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!isStripeConnected}
                onClick={() => setMethod("stripe_api")}
                className={`px-3 py-3 rounded-lg border-2 text-left transition-colors ${
                  !isStripeConnected
                    ? "bg-gray-50 border-gray-200 cursor-not-allowed opacity-60"
                    : method === "stripe_api"
                    ? "bg-teal-light border-teal text-teal-dark"
                    : "bg-white border-gray-200 hover:border-gray-300 text-navy"
                }`}
              >
                <div className="font-semibold text-sm mb-1">
                  Stripe API {isStripeConnected ? "(deterministic)" : "(not connected)"}
                </div>
                <div className="text-[11px] leading-relaxed text-ink-slate">
                  {isStripeConnected
                    ? "Pull exact charges + fees from Stripe directly. No AI guessing — instant, accurate."
                    : "Send the client a Connect link from the sidebar to enable this method."}
                </div>
              </button>
              <button
                type="button"
                onClick={() => setMethod("qbo_invoice_match")}
                className={`px-3 py-3 rounded-lg border-2 text-left transition-colors ${
                  method === "qbo_invoice_match"
                    ? "bg-teal-lighter border-teal text-teal"
                    : "bg-white border-gray-200 hover:border-gray-300 text-navy"
                }`}
              >
                <div className="font-semibold text-sm mb-1">QBO invoice match (AI)</div>
                <div className="text-[11px] leading-relaxed text-ink-slate">
                  Match deposits to QBO invoices using AI. Falls back to a manual picker for any deposits the AI can't resolve.
                </div>
              </button>
            </div>
          </div>
        )}

        {clientLinkId && (
          <>
            {loadingPresets && (
              <div className="flex items-center gap-2 text-sm text-ink-slate">
                <Loader2 className="animate-spin" size={16} />
                Loading fiscal year from QuickBooks...
              </div>
            )}
            {presetsError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 text-red-800 rounded-lg text-sm">
                <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                {presetsError}
              </div>
            )}

            {datePresets.length > 0 && (
              <div>
                <label className="flex items-center gap-1.5 text-sm font-semibold text-navy mb-2">
                  <Calendar size={14} /> Date Range
                </label>
                <div className="text-xs text-ink-slate mb-2">
                  Fiscal year starts in <span className="font-semibold">{fiscalYearStartMonthName}</span> (pulled from QBO)
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {datePresets.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setDatePresetId(p.id)}
                      className={`px-3 py-2.5 rounded-lg border-2 text-xs font-semibold text-left transition-colors ${
                        datePresetId === p.id
                          ? "bg-teal-lighter border-teal text-teal"
                          : "bg-white border-gray-200 hover:border-gray-300 text-navy"
                      }`}
                    >
                      <div>{p.label}</div>
                      <div className="text-[10px] text-ink-light mt-0.5 font-normal">
                        {p.start} → {p.end}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Actionable conflict panel for the 409 same-client guard. The
            previous behavior dumped the prose error into the red block
            and made the bookkeeper hunt down the job by ID. Now the
            existing job is one click away. */}
        {conflict && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm space-y-3">
            <div className="flex items-start gap-2">
              <AlertCircle size={16} className="text-amber-700 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-bold text-amber-900">
                  A Stripe reconciliation is already in progress for{" "}
                  {selectedClient?.client_name || "this client"}.
                </div>
                <div className="text-xs text-amber-900 mt-1">
                  Status: <span className="font-semibold">{conflict.status}</span>.
                  Finish or close out the existing run before starting a new
                  one — same-client parallel runs cause deposit-snapshot
                  races.
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() =>
                  router.push(`/stripe-recon/${conflict.jobId}/review`)
                }
                className="inline-flex items-center gap-1.5 bg-amber-700 hover:bg-amber-800 text-white text-xs font-semibold px-3 py-1.5 rounded-md"
              >
                <ArrowRight size={13} />
                Open the existing recon
              </button>
              <button
                type="button"
                onClick={() => setConflict(null)}
                className="text-xs font-semibold text-amber-900 hover:text-amber-950 px-2 py-1.5"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {submitError && (
          <div className="flex items-start gap-2 p-3 bg-red-50 text-red-800 rounded-lg text-sm">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            {submitError}
          </div>
        )}

        {clientLinkId && (
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full bg-teal hover:bg-teal-dark text-white font-semibold px-6 py-3 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {submitting ? <Loader2 className="animate-spin" size={18} /> : <ArrowRight size={18} />}
            {submitting ? "Starting discovery..." : "Find Stripe deposits & match"}
          </button>
        )}
      </div>
    </div>
  );
}
