"use client";

import { useState } from "react";
import {
  CheckCircle2, ChevronRight, CreditCard, ExternalLink, Phone,
  ArrowUpCircle, FileText, AlertTriangle, XCircle, Loader2, Star,
  Download, Calendar,
} from "lucide-react";
import type { ServiceTier, TierConfig } from "./tiers";
import { TIERS, INCLUDED_FEATURES } from "./tiers";
import type { StripeInvoice } from "@/lib/stripe-billing";

interface Props {
  clientLinkId: string;
  clientName: string;
  tier: ServiceTier | null;
  monthlyAmountDollars: number | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  billingStart: string | null;
  stripeCustomerId: string | null;
  invoices: StripeInvoice[];
  coachingCallLink: string | null;
  coaches: { coach_key: string; coach_name: string }[];
  coachingCheckoutEnabled: boolean;
  cancelRequestAt: string | null;
  cancelRequestNote: string | null;
  impersonating: boolean;
  portalReturnUrl: string;
}

const TIER_COLORS: Record<string, string> = {
  teal:   "bg-teal/10 text-teal border-teal/20",
  blue:   "bg-blue-50 text-blue-700 border-blue-200",
  violet: "bg-teal-light text-teal-dark border-teal-border",
  navy:   "bg-navy/10 text-navy border-navy/20",
};

const STATUS_COLORS: Record<string, string> = {
  active:   "bg-emerald-50 text-emerald-700 border-emerald-200",
  past_due: "bg-red-50 text-red-700 border-red-200",
  canceled: "bg-slate-50 text-slate-600 border-slate-200",
};

function fmtMoney(n: number, currency = "USD") {
  return n.toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: 0 });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function fmtMonthYear(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function BillingClient({
  clientLinkId,
  clientName,
  tier,
  monthlyAmountDollars,
  subscriptionStatus,
  currentPeriodEnd,
  billingStart,
  stripeCustomerId,
  invoices,
  coachingCallLink,
  coaches,
  coachingCheckoutEnabled,
  cancelRequestAt,
  cancelRequestNote,
  impersonating,
  portalReturnUrl,
}: Props) {
  const currentTier = tier ? TIERS.find((t) => t.key === tier) || null : null;
  const currentIdx = tier ? TIERS.findIndex((t) => t.key === tier) : -1;
  const nextTier: TierConfig | null =
    currentIdx >= 0 && currentIdx < TIERS.length - 1 ? TIERS[currentIdx + 1] : null;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Account</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Billing & Plan</h1>
        {impersonating && (
          <div className="mt-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 inline-block">
            Preview mode — payment actions disabled while impersonating
          </div>
        )}
      </div>

      <CurrentPlanCard
        tier={currentTier}
        monthlyAmountDollars={monthlyAmountDollars}
        subscriptionStatus={subscriptionStatus}
        currentPeriodEnd={currentPeriodEnd}
        billingStart={billingStart}
        hasStripe={!!stripeCustomerId}
      />

      <WhatIsIncludedCard />

      <CoachingCallCard
        coachingCallLink={coachingCallLink}
        coaches={coaches}
        checkoutEnabled={coachingCheckoutEnabled}
        impersonating={impersonating}
      />

      {nextTier && currentTier && (
        <UpgradeCard
          currentTier={currentTier}
          nextTier={nextTier}
          clientName={clientName}
          impersonating={impersonating}
        />
      )}

      <ReceiptsCard
        invoices={invoices}
        stripeCustomerId={stripeCustomerId}
        impersonating={impersonating}
        portalReturnUrl={portalReturnUrl}
      />

      <CancelRequestCard
        clientLinkId={clientLinkId}
        cancelRequestAt={cancelRequestAt}
        cancelRequestNote={cancelRequestNote}
        impersonating={impersonating}
      />
    </div>
  );
}

// ─── Current plan ─────────────────────────────────────────────────────────────

function CurrentPlanCard({
  tier,
  monthlyAmountDollars,
  subscriptionStatus,
  currentPeriodEnd,
  billingStart,
  hasStripe,
}: {
  tier: TierConfig | null;
  monthlyAmountDollars: number | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  billingStart: string | null;
  hasStripe: boolean;
}) {
  if (!tier) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-3">
          <Star size={16} className="text-ink-slate" />
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Your plan</h2>
        </div>
        <p className="text-sm text-ink-slate">
          {hasStripe
            ? "We couldn't retrieve your subscription details right now. Try refreshing, or reach out to "
            : "Your plan details haven't been set up yet. Reach out to "}
          <a href="mailto:admin@ironbooks.com" className="text-teal underline underline-offset-2">
            admin@ironbooks.com
          </a>
          {hasStripe ? "." : " to confirm your tier."}
        </p>
      </div>
    );
  }

  const colorClass = TIER_COLORS[tier.color] || TIER_COLORS.navy;
  const statusLabel = subscriptionStatus === "active" ? "Active"
    : subscriptionStatus === "past_due" ? "Past due"
    : subscriptionStatus === "canceled" ? "Canceled"
    : null;
  const statusColor = STATUS_COLORS[subscriptionStatus ?? ""] || STATUS_COLORS.canceled;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Star size={16} className="text-ink-slate" />
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Your plan</h2>
        </div>
        <div className="flex items-center gap-2">
          {statusLabel && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${statusColor}`}>
              {statusLabel}
            </span>
          )}
          <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${colorClass}`}>
            {tier.name}
          </span>
        </div>
      </div>

      <div className="px-6 py-5 space-y-4">
        <div className="flex items-end gap-2">
          {monthlyAmountDollars !== null ? (
            <>
              <span className="text-3xl font-black text-navy">{fmtMoney(monthlyAmountDollars)}</span>
              <span className="text-sm text-ink-slate mb-1">/month · 12-month commitment</span>
            </>
          ) : tier.monthlyFee !== null ? (
            <>
              <span className="text-3xl font-black text-navy">{fmtMoney(tier.monthlyFee)}</span>
              <span className="text-sm text-ink-slate mb-1">/month · 12-month commitment</span>
            </>
          ) : (
            <span className="text-2xl font-black text-navy">Custom pricing</span>
          )}
        </div>

        <p className="text-sm text-ink-slate">{tier.tagline}</p>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-ink-light font-semibold">Revenue cap</dt>
            <dd className="font-semibold text-navy mt-0.5">{tier.revenueCap}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-ink-light font-semibold">Onboarding call</dt>
            <dd className="font-semibold text-navy mt-0.5">{tier.onboardingCall}</dd>
          </div>
          {billingStart && (
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-ink-light font-semibold">Member since</dt>
              <dd className="font-semibold text-navy mt-0.5">{fmtDate(billingStart)}</dd>
            </div>
          )}
          {currentPeriodEnd && subscriptionStatus === "active" && (
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-ink-light font-semibold">Next billing date</dt>
              <dd className="font-semibold text-navy mt-0.5">{fmtDate(currentPeriodEnd)}</dd>
            </div>
          )}
        </dl>

        {subscriptionStatus === "past_due" && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
            <span>
              Your subscription is past due. Please update your payment method to keep your account active.
              Email{" "}
              <a href="mailto:admin@ironbooks.com" className="underline">admin@ironbooks.com</a>{" "}
              if you need help.
            </span>
          </div>
        )}

        {tier.key === "insight" && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-800">
            <strong>Tier 1 participation reminder:</strong> To keep Insight pricing available, promote
            Ironbooks once per quarter via email or social media using our templates. Send a link or
            screenshot to{" "}
            <a href="mailto:admin@ironbooks.com" className="underline">admin@ironbooks.com</a>.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── What's included ──────────────────────────────────────────────────────────

function WhatIsIncludedCard() {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <CheckCircle2 size={16} className="text-ink-slate" />
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">What's included</h2>
      </div>
      <ul className="px-6 py-5 space-y-2">
        {INCLUDED_FEATURES.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-navy">
            <CheckCircle2 size={14} className="text-teal flex-shrink-0 mt-0.5" />
            {f}
          </li>
        ))}
      </ul>
      <div className="px-6 pb-5 text-xs text-ink-slate">
        All tiers include a 12-month commitment. Questions about your scope?{" "}
        <a href="mailto:admin@ironbooks.com" className="text-teal underline underline-offset-2">Email us</a>.
      </div>
    </div>
  );
}

// ─── Coaching call ────────────────────────────────────────────────────────────

function CoachingCallCard({
  coachingCallLink,
  coaches,
  checkoutEnabled,
  impersonating,
}: {
  coachingCallLink: string | null;
  coaches: { coach_key: string; coach_name: string }[];
  checkoutEnabled: boolean;
  impersonating: boolean;
}) {
  const useCheckout = checkoutEnabled && coaches.length > 0;
  const [coachKey, setCoachKey] = useState<string>(coaches[0]?.coach_key || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function book() {
    if (!coachKey) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/coaching-calls/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coach_key: coachKey }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || "Could not start checkout");
      window.location.href = data.url;
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <Phone size={16} className="text-ink-slate" />
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Book a coaching call</h2>
      </div>
      <div className="px-6 py-5 space-y-3">
        <div>
          <div className="text-lg font-black text-navy">
            $150 <span className="text-sm font-normal text-ink-slate">/ 30 min</span>
          </div>
          <p className="text-sm text-ink-slate mt-1">
            A focused 1:1 with your bookkeeping coach. Dig into your P&amp;L, margins, cash position —
            whatever matters most right now.
          </p>
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-xs text-ink-slate">
          <strong className="text-navy">What to expect:</strong> Your coach reviews your most recent
          month before the call. Come with 2–3 questions, leave with a clear action plan.
        </div>

        {impersonating ? (
          <div className="text-xs text-ink-slate italic">Payment actions hidden during impersonation.</div>
        ) : useCheckout ? (
          <>
            {coaches.length > 1 && (
              <div>
                <div className="text-xs font-semibold text-navy mb-1.5">Choose your coach</div>
                <div className="flex flex-wrap gap-2">
                  {coaches.map((c) => (
                    <button
                      key={c.coach_key}
                      onClick={() => setCoachKey(c.coach_key)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-semibold border-2 transition-colors ${
                        coachKey === c.coach_key
                          ? "border-teal bg-teal-lighter text-teal-dark"
                          : "border-slate-200 text-ink-slate hover:border-slate-300"
                      }`}
                    >
                      {c.coach_name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {err && <div className="text-xs text-red-600">{err}</div>}
            <button
              onClick={book}
              disabled={busy || !coachKey}
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-bold px-5 py-2.5 rounded-lg transition-colors"
            >
              {busy ? "Starting checkout…" : `Book ${coaches.find((c) => c.coach_key === coachKey)?.coach_name || ""} — $150`}
            </button>
            <p className="text-[11px] text-ink-light">Secure payment, then pick your time. Your saved card is used if we have one on file.</p>
          </>
        ) : coachingCallLink ? (
          <a
            href={coachingCallLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-5 py-2.5 rounded-lg transition-colors"
          >
            Book & pay now <ExternalLink size={13} />
          </a>
        ) : (
          <a
            href="mailto:admin@ironbooks.com?subject=Book%20a%20coaching%20call"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-5 py-2.5 rounded-lg transition-colors"
          >
            Request a session <ExternalLink size={13} />
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Upgrade ──────────────────────────────────────────────────────────────────

function UpgradeCard({
  currentTier,
  nextTier,
  clientName,
  impersonating,
}: {
  currentTier: TierConfig;
  nextTier: TierConfig;
  clientName: string;
  impersonating: boolean;
}) {
  const priceDiff =
    nextTier.monthlyFee !== null && currentTier.monthlyFee !== null
      ? nextTier.monthlyFee - currentTier.monthlyFee
      : null;

  const subject = encodeURIComponent(`Upgrade request — ${clientName} → ${nextTier.name}`);
  const body = encodeURIComponent(
    `Hi,\n\nI'd like to upgrade from ${currentTier.name} to ${nextTier.name}.\n\nPlease let me know next steps.\n\nThanks,\n${clientName}`
  );

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <ArrowUpCircle size={16} className="text-ink-slate" />
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Upgrade your plan</h2>
      </div>
      <div className="px-6 py-5 space-y-3">
        <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-bold text-navy">{nextTier.name}</div>
            <div className="text-xs text-ink-slate mt-0.5">{nextTier.tagline}</div>
            <div className="text-xs text-ink-slate mt-1">
              Revenue cap: <strong>{nextTier.revenueCap}</strong>
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            {nextTier.monthlyFee !== null ? (
              <>
                <div className="text-xl font-black text-navy">
                  {fmtMoney(nextTier.monthlyFee)}
                  <span className="text-xs font-normal text-ink-slate">/mo</span>
                </div>
                {priceDiff !== null && (
                  <div className="text-xs text-ink-slate">+{fmtMoney(priceDiff)}/mo</div>
                )}
              </>
            ) : (
              <div className="text-sm font-bold text-navy">Custom pricing</div>
            )}
          </div>
        </div>
        <p className="text-sm text-ink-slate">
          Ready to unlock more capacity? Send us a note and we'll confirm the upgrade and
          adjust your billing at the next cycle.
        </p>
        {impersonating ? (
          <div className="text-xs text-ink-slate italic">Email link hidden during impersonation.</div>
        ) : (
          <a
            href={`mailto:admin@ironbooks.com?subject=${subject}&body=${body}`}
            className="inline-flex items-center gap-2 border-2 border-navy text-navy hover:bg-navy hover:text-white text-sm font-bold px-5 py-2.5 rounded-lg transition-colors"
          >
            Request upgrade <ChevronRight size={14} />
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Receipts ─────────────────────────────────────────────────────────────────

function ReceiptsCard({
  invoices,
  stripeCustomerId,
  impersonating,
  portalReturnUrl,
}: {
  invoices: StripeInvoice[];
  stripeCustomerId: string | null;
  impersonating: boolean;
  portalReturnUrl: string;
}) {
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  async function openPortal() {
    setPortalLoading(true);
    setPortalError(null);
    try {
      const res = await fetch("/api/portal/billing/customer-portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: portalReturnUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not open billing portal");
      window.location.href = data.url;
    } catch (e: any) {
      setPortalError(e.message || "Something went wrong");
      setPortalLoading(false);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-ink-slate" />
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Receipts & invoices</h2>
        </div>
        {stripeCustomerId && !impersonating && (
          <button
            onClick={openPortal}
            disabled={portalLoading}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-navy disabled:opacity-50"
            title="Open Stripe billing portal to manage payment method"
          >
            {portalLoading ? <Loader2 size={11} className="animate-spin" /> : <CreditCard size={11} />}
            Update payment method
          </button>
        )}
      </div>

      <div className="px-6 py-5">
        {portalError && (
          <p className="text-xs text-red-600 mb-3">{portalError}</p>
        )}

        {impersonating ? (
          <p className="text-xs text-ink-slate italic">Invoice links hidden during impersonation.</p>
        ) : invoices.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-ink-slate">
              {stripeCustomerId
                ? "No paid invoices found yet."
                : "Connect your Stripe account to see invoice history here."}
            </p>
            {!stripeCustomerId && (
              <a
                href="mailto:admin@ironbooks.com?subject=Request%20for%20receipts"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-teal hover:underline"
              >
                Email us for a copy of your invoices <ExternalLink size={12} />
              </a>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {invoices.map((inv) => (
              <InvoiceRow key={inv.id} invoice={inv} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InvoiceRow({ invoice }: { invoice: StripeInvoice }) {
  const label = invoice.number
    ? invoice.number
    : fmtMonthYear(invoice.periodStart);

  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-slate-100 last:border-0">
      <div className="flex items-center gap-3 min-w-0">
        <Calendar size={13} className="text-ink-light flex-shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-navy truncate">{label}</div>
          <div className="text-xs text-ink-light">
            {fmtDate(invoice.periodStart)} – {fmtDate(invoice.periodEnd)}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="text-sm font-bold text-navy">
          {fmtMoney(invoice.amountPaid, invoice.currency)}
        </span>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
          Paid
        </span>
        {invoice.invoicePdfUrl && (
          <a
            href={invoice.invoicePdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-semibold text-ink-slate hover:text-navy"
            title="Download PDF receipt"
          >
            <Download size={12} /> PDF
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Cancel request ───────────────────────────────────────────────────────────

function CancelRequestCard({
  clientLinkId: _clientLinkId,
  cancelRequestAt,
  cancelRequestNote,
  impersonating,
}: {
  clientLinkId: string;
  cancelRequestAt: string | null;
  cancelRequestNote: string | null;
  impersonating: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(!!cancelRequestAt);
  const [submittedAt, setSubmittedAt] = useState(cancelRequestAt);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (impersonating) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/billing/cancel-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      setSubmitted(true);
      setSubmittedAt(new Date().toISOString());
      setOpen(false);
    } catch (e: any) {
      setError(e.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <XCircle size={16} className="text-ink-slate" />
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Cancel request received</h2>
        </div>
        <div className="px-6 py-5 space-y-2">
          <div className="flex items-start gap-2.5 text-sm text-emerald-700">
            <CheckCircle2 size={15} className="flex-shrink-0 mt-0.5" />
            <span>
              We received your cancellation request
              {submittedAt ? ` on ${fmtDate(submittedAt)}` : ""}.
              Your manager will be in touch within 1–2 business days.
            </span>
          </div>
          {cancelRequestNote && (
            <div className="text-xs text-ink-slate italic mt-1">Your note: "{cancelRequestNote}"</div>
          )}
          <p className="text-xs text-ink-slate pt-2">
            This does not cancel your account automatically. Your 12-month commitment continues
            until we confirm the cancellation in writing. See your agreement for full terms.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <XCircle size={16} className="text-ink-slate" />
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Cancel subscription</h2>
      </div>
      <div className="px-6 py-5 space-y-3">
        {!open ? (
          <>
            <p className="text-sm text-ink-slate">
              Need to step away? Submit a cancel request and your Ironbooks manager will reach
              out within 1–2 business days to discuss options and next steps.
            </p>
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-800 flex items-start gap-2">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              <span>
                Submitting a request does not cancel your account or stop billing. Your
                12-month commitment terms apply. We're happy to discuss your situation first.
              </span>
            </div>
            <button
              onClick={() => setOpen(true)}
              className="text-sm text-ink-slate hover:text-red-600 underline underline-offset-2"
            >
              Request cancellation
            </button>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ink-slate">
              Help us understand — what's not working? Your feedback goes directly to your manager.
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional: share what's behind this decision…"
              rows={4}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy placeholder:text-ink-light resize-none focus:outline-none focus:border-navy"
            />
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-800 flex items-start gap-2">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              <span>
                This notifies your manager. It does <strong>not</strong> cancel your account
                or stop billing.
              </span>
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex items-center gap-3">
              <button
                onClick={submit}
                disabled={loading || impersonating}
                className="inline-flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
              >
                {loading && <Loader2 size={13} className="animate-spin" />}
                Submit cancel request
              </button>
              <button
                onClick={() => { setOpen(false); setNote(""); setError(null); }}
                className="text-sm text-ink-slate hover:text-navy"
              >
                Never mind
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
