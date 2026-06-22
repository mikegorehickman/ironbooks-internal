"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle, Clock, Mail, Phone, Sparkles, X, Copy, Loader2,
  TrendingUp, AlertTriangle, EyeOff, Undo2, ChevronDown, ChevronRight,
} from "lucide-react";
import { AskAboutButton } from "../ask-about";

interface AgingSummary {
  totalAmount: number;
  totalCount: number;
  buckets: {
    current: { total: number; count: number };
    "1-30": { total: number; count: number };
    "31-60": { total: number; count: number };
    "61-90": { total: number; count: number };
    "90+": { total: number; count: number };
  };
}

interface CustomerCard {
  customer_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  last_payment_date: string | null;
  last_payment_amount: number | null;
  current_total: number;
  overdue_total: number;
  total: number;
  oldest_days: number;
  invoices: { num: string; doc_id: string; date: string; due_date: string | null; amount: number; days_overdue: number }[];
}

export interface DismissedInvoice {
  qbo_invoice_id: string;
  doc_number: string | null;
  customer_name: string | null;
  amount: number | null;
}

export function WhosPayingClient({
  aging,
  dso,
  paymentsInWindowCount,
  customers,
  topCustomerShare,
  dismissed = [],
}: {
  aging: AgingSummary;
  dso: number | null;
  paymentsInWindowCount: number;
  customers: CustomerCard[];
  topCustomerShare: number;
  dismissed?: DismissedInvoice[];
}) {
  const router = useRouter();
  const [followupCustomer, setFollowupCustomer] = useState<CustomerCard | null>(null);
  const [busyInvoice, setBusyInvoice] = useState<string | null>(null);

  // Dismiss / restore persist server-side (portal_ar_dismissals) — every
  // number on this page recomputes without the dismissed invoices on the
  // refresh, and they stay hidden on future logins until restored.
  async function dismissInvoice(
    inv: { doc_id: string; num: string; amount: number },
    customerName: string
  ) {
    if (
      !confirm(
        `Dismiss invoice ${inv.num} ($${inv.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) from your A/R?\n\nUse this when it isn't actually owed (duplicate, already paid, not yours). Your bookkeeper is notified and will clear it in QuickBooks properly. You can restore it anytime from the "Dismissed" list at the bottom of this page.`
      )
    )
      return;
    setBusyInvoice(inv.doc_id);
    try {
      const res = await fetch("/api/portal/ar-dismissals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qbo_invoice_id: inv.doc_id,
          doc_number: inv.num,
          customer_name: customerName,
          amount: inv.amount,
        }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusyInvoice(null);
    }
  }

  async function restoreInvoice(qboInvoiceId: string) {
    setBusyInvoice(qboInvoiceId);
    try {
      const res = await fetch("/api/portal/ar-dismissals", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qbo_invoice_id: qboInvoiceId }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusyInvoice(null);
    }
  }

  const overdueTotal =
    aging.buckets["1-30"].total + aging.buckets["31-60"].total +
    aging.buckets["61-90"].total + aging.buckets["90+"].total;
  const overdueCount =
    aging.buckets["1-30"].count + aging.buckets["31-60"].count +
    aging.buckets["61-90"].count + aging.buckets["90+"].count;
  const overduePct = aging.totalAmount > 0 ? Math.round((overdueTotal / aging.totalAmount) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* ── Gradient hero ───────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy to-teal-dark px-6 py-6 text-white">
        <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full bg-teal/20 blur-2xl" />
        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-xs text-white/60 uppercase tracking-wider font-semibold">Outstanding invoices</div>
            <h1 className="text-3xl font-bold mt-1">Who owes you money</h1>
            <div className="text-sm text-white/70 mt-1">
              Across {customers.length} customer{customers.length === 1 ? "" : "s"}
            </div>
          </div>
          <div className="flex-shrink-0 bg-white/10 backdrop-blur rounded-xl px-5 py-3 border border-white/15">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-white/60">Total owed to you</div>
            <div className="text-3xl font-bold mt-0.5 text-white">{fmtMoney(aging.totalAmount)}</div>
            {overdueTotal > 0 && (
              <div className="text-xs text-amber-200 mt-0.5">{fmtMoney(overdueTotal)} past due</div>
            )}
          </div>
        </div>
      </div>

      {/* Health metrics row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricTile
          label="Days to collect (DSO)"
          value={dso != null ? `${dso}d` : "—"}
          hint={
            dso == null
              ? "Need recent paid invoices to compute"
              : dso < 21 ? "Healthy — under 3 weeks"
              : dso < 35 ? "Reasonable"
              : dso < 60 ? "Slow — worth nudging customers"
              : "Concerning — many customers paying late"
          }
          tone={dso == null ? "slate" : dso < 21 ? "emerald" : dso < 35 ? "teal" : dso < 60 ? "amber" : "red"}
          tooltip={`Weighted average days between invoice date and payment date over the last 180 days, across ${paymentsInWindowCount} paid invoices.`}
        />
        <MetricTile
          label="Overdue total"
          value={fmtMoney(overdueTotal)}
          hint={overdueCount > 0 ? `${overdueCount} invoice${overdueCount === 1 ? "" : "s"} · ${overduePct}% of A/R` : "Everything current"}
          tone={overduePct === 0 ? "emerald" : overduePct < 20 ? "amber" : "red"}
          tooltip="Total of every invoice past its due date."
        />
        <MetricTile
          label="Biggest customer share"
          value={topCustomerShare > 0 ? `${topCustomerShare}%` : "—"}
          hint={
            customers.length === 0 ? "No open A/R" :
            topCustomerShare >= 50 ? `${customers[0].name} = collection risk`
            : topCustomerShare >= 30 ? "Some concentration"
            : "Diversified — healthy"
          }
          tone={topCustomerShare >= 50 ? "red" : topCustomerShare >= 30 ? "amber" : "emerald"}
          tooltip="Largest customer's outstanding balance as % of total A/R. High concentration means one customer not paying could hurt cash flow."
        />
        <MetricTile
          label="Customers with balance"
          value={`${customers.length}`}
          hint={customers.length === 0 ? "Nothing outstanding" : "Open invoices"}
          tone="teal"
        />
      </div>

      {/* Heads-up row */}
      {overdueTotal > 0 && (
        <div className="bg-teal/5 border border-teal/30 rounded-xl p-4 text-sm text-navy/80 leading-relaxed">
          <strong className="text-teal-dark">Heads up:</strong> {fmtMoney(overdueTotal)} of this is past
          due. The top of the list is sorted by urgency. Click <strong>Draft follow-up</strong> on any
          customer to generate a polite reminder email you can copy into your email tool.
        </div>
      )}

      {/* Aging bucket row */}
      <div className="grid grid-cols-4 gap-3">
        <Bucket label="Current" amount={fmtMoney(aging.buckets.current.total)} count={aging.buckets.current.count} color="emerald" />
        <Bucket label="1–30 days late" amount={fmtMoney(aging.buckets["1-30"].total)} count={aging.buckets["1-30"].count} color="amber" />
        <Bucket label="31–60 days" amount={fmtMoney(aging.buckets["31-60"].total)} count={aging.buckets["31-60"].count} color="orange" />
        <Bucket label="60+ days" amount={fmtMoney(aging.buckets["61-90"].total + aging.buckets["90+"].total)} count={aging.buckets["61-90"].count + aging.buckets["90+"].count} color="red" />
      </div>

      {/* Customer cards */}
      <div className="space-y-3">
        {customers.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-ink-slate">
            No open invoices — all customers are paid up.
          </div>
        ) : (
          customers.slice(0, 30).map((c) => (
            <CustomerCardView
              key={c.customer_id || c.name}
              c={c}
              onDraftFollowup={() => setFollowupCustomer(c)}
              onDismissInvoice={(inv) => dismissInvoice(inv, c.name)}
              busyInvoice={busyInvoice}
            />
          ))
        )}
        {customers.length > 30 && (
          <div className="text-center text-sm text-ink-slate py-3">
            + {customers.length - 30} more customers — ask your bookkeeper for a full export
          </div>
        )}
      </div>

      {dismissed.length > 0 && (
        <DismissedSection
          dismissed={dismissed}
          busyInvoice={busyInvoice}
          onRestore={restoreInvoice}
        />
      )}

      {followupCustomer && (
        <FollowupModal customer={followupCustomer} onClose={() => setFollowupCustomer(null)} />
      )}
    </div>
  );
}

// ─── DISMISSED INVOICES ──────────────────────────────────────────────────

function DismissedSection({
  dismissed,
  busyInvoice,
  onRestore,
}: {
  dismissed: DismissedInvoice[];
  busyInvoice: string | null;
  onRestore: (qboInvoiceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-5 py-3 flex items-center gap-2 text-left text-sm font-semibold text-ink-slate hover:bg-slate-100"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <EyeOff size={13} />
        Dismissed — not actually owed ({dismissed.length})
      </button>
      {open && (
        <div className="px-5 pb-4 space-y-1">
          <p className="text-[11px] text-ink-light mb-2">
            These stay hidden from your totals until your bookkeeper clears them
            in QuickBooks. Restore one if you dismissed it by mistake.
          </p>
          {dismissed.map((d) => (
            <div
              key={d.qbo_invoice_id}
              className="flex items-center justify-between text-xs text-ink-slate py-1 border-t border-slate-200/60 first:border-0"
            >
              <span>
                {d.doc_number ? `#${d.doc_number}` : d.qbo_invoice_id}
                {d.customer_name && <span className="text-ink-light"> · {d.customer_name}</span>}
                {d.amount != null && (
                  <span className="font-mono ml-2">{fmtMoney(d.amount)}</span>
                )}
              </span>
              <button
                onClick={() => onRestore(d.qbo_invoice_id)}
                disabled={busyInvoice !== null}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-dark hover:underline disabled:opacity-50"
              >
                {busyInvoice === d.qbo_invoice_id ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <Undo2 size={10} />
                )}
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── METRIC TILE ─────────────────────────────────────────────────────────

function MetricTile({
  label, value, hint, tone, tooltip,
}: { label: string; value: string; hint: string; tone: "emerald" | "teal" | "amber" | "red" | "slate"; tooltip?: string }) {
  const colors = {
    emerald: "border-emerald-200 bg-emerald-50",
    teal: "border-teal/30 bg-teal/5",
    amber: "border-amber-200 bg-amber-50",
    red: "border-red-200 bg-red-50",
    slate: "border-slate-200 bg-slate-50",
  }[tone];
  const valueColor = {
    emerald: "text-emerald-700",
    teal: "text-teal-dark",
    amber: "text-amber-700",
    red: "text-red-700",
    slate: "text-ink-slate",
  }[tone];
  return (
    <div className={`p-3 rounded-xl border ${colors}`} title={tooltip}>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-slate">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${valueColor}`}>{value}</div>
      <div className="text-[11px] text-ink-slate mt-0.5">{hint}</div>
    </div>
  );
}

function Bucket({ label, amount, count, color }: { label: string; amount: string; count: number; color: string }) {
  const colors: Record<string, string> = {
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    orange: "bg-orange-50 border-orange-200 text-orange-900",
    red: "bg-red-50 border-red-200 text-red-900",
  };
  return (
    <div className={`p-3 rounded-xl border ${colors[color]}`}>
      <div className="text-[10px] uppercase tracking-wider font-semibold opacity-80">{label}</div>
      <div className="text-lg font-bold mt-1">{amount}</div>
      <div className="text-[11px] opacity-70">{count} invoice{count === 1 ? "" : "s"}</div>
    </div>
  );
}

// ─── CUSTOMER CARD ───────────────────────────────────────────────────────

function CustomerCardView({
  c,
  onDraftFollowup,
  onDismissInvoice,
  busyInvoice,
}: {
  c: CustomerCard;
  onDraftFollowup: () => void;
  onDismissInvoice: (inv: { doc_id: string; num: string; amount: number }) => void;
  busyInvoice: string | null;
}) {
  const urgent = c.oldest_days > 30;
  return (
    <div className={`bg-white border rounded-2xl p-5 ${urgent ? "border-red-300" : "border-slate-200"}`}>
      <div className="flex items-start justify-between mb-3 gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-navy">{c.name}</h3>
            {urgent && (
              <span className="text-[10px] font-bold bg-red-100 text-red-800 px-1.5 py-0.5 rounded">
                <AlertCircle size={9} className="inline mr-0.5" />
                URGENT
              </span>
            )}
          </div>
          {/* Contact row */}
          {(c.email || c.phone) && (
            <div className="flex items-center gap-3 mt-1 text-xs text-ink-slate flex-wrap">
              {c.email && (
                <a
                  href={`mailto:${c.email}`}
                  className="inline-flex items-center gap-1 hover:text-teal-dark hover:underline"
                >
                  <Mail size={11} />
                  {c.email}
                </a>
              )}
              {c.phone && (
                <a
                  href={`tel:${c.phone}`}
                  className="inline-flex items-center gap-1 hover:text-teal-dark hover:underline"
                >
                  <Phone size={11} />
                  {c.phone}
                </a>
              )}
            </div>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-xl font-bold text-navy">{fmtMoney(c.total)}</div>
          <div className="text-xs text-ink-slate">
            <Clock size={10} className="inline mr-0.5" />
            Oldest: {c.oldest_days}d
          </div>
        </div>
      </div>

      {/* Current vs overdue split */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <SplitTile
          label="Current (not yet due)"
          value={fmtMoney(c.current_total)}
          tone="emerald"
          empty={c.current_total === 0}
        />
        <SplitTile
          label="Past due"
          value={fmtMoney(c.overdue_total)}
          tone={c.overdue_total > 0 ? (c.oldest_days > 60 ? "red" : "amber") : "slate"}
          empty={c.overdue_total === 0}
        />
      </div>

      {/* Last payment info */}
      {c.last_payment_date && (
        <div className="text-xs text-ink-slate mb-3 flex items-center gap-1.5">
          <TrendingUp size={11} />
          Last paid you {fmtRelativeDays(c.last_payment_date)}
          {c.last_payment_amount != null && (
            <span className="text-ink-light"> · {fmtMoney(c.last_payment_amount)}</span>
          )}
        </div>
      )}
      {!c.last_payment_date && c.oldest_days > 0 && (
        <div className="text-xs text-amber-700 mb-3 flex items-center gap-1.5">
          <AlertTriangle size={11} />
          No payments from this customer in the last 180 days
        </div>
      )}

      {/* Invoices */}
      <div className="space-y-1 mb-3">
        {c.invoices.slice(0, 5).map((inv, i) => (
          <div key={i} className="flex items-center justify-between text-xs text-ink-slate py-0.5 group">
            <span>
              {inv.num} · {inv.date}
              {inv.due_date && <span className="text-ink-light"> · due {inv.due_date}</span>}
            </span>
            <span className="font-mono flex items-center gap-1">
              {fmtMoney(inv.amount)}
              {inv.days_overdue > 0 && (
                <span className="text-red-700 font-semibold ml-2">({inv.days_overdue}d late)</span>
              )}
              <button
                onClick={() => onDismissInvoice(inv)}
                disabled={busyInvoice !== null}
                title="Not actually owed? Dismiss it — your bookkeeper is notified and it stays hidden from your A/R"
                className="ml-2 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-md border border-slate-200 text-ink-slate hover:text-red-700 hover:border-red-300 hover:bg-red-50 transition-all disabled:opacity-40"
              >
                {busyInvoice === inv.doc_id ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <>
                    <EyeOff size={11} /> Dismiss
                  </>
                )}
              </button>
            </span>
          </div>
        ))}
        {c.invoices.length > 5 && (
          <div className="text-[11px] text-ink-light italic">+ {c.invoices.length - 5} more invoices</div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onDraftFollowup}
          disabled={!urgent && c.overdue_total === 0}
          className={`px-3 py-1.5 rounded text-xs font-semibold inline-flex items-center gap-1.5 ${
            urgent || c.overdue_total > 0
              ? "bg-teal text-white hover:bg-teal-dark"
              : "bg-slate-100 text-ink-light cursor-not-allowed"
          }`}
          title={urgent || c.overdue_total > 0 ? "Draft a polite reminder email with AI" : "Nothing overdue — no follow-up needed"}
        >
          <Sparkles size={11} />
          Draft follow-up email
        </button>
        {c.email && (
          <a
            href={`mailto:${c.email}`}
            className="px-3 py-1.5 border border-slate-300 rounded text-xs font-semibold text-ink-slate hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <Mail size={11} />
            Email directly
          </a>
        )}
        <AskAboutButton
          kind="ar_customer"
          label={c.name}
          amount={c.total}
          period={`${c.invoices.length} open invoice${c.invoices.length === 1 ? "" : "s"} · oldest ${c.oldest_days}d`}
          context={{
            customer_id: c.customer_id,
            total_owed: c.total,
            current_total: c.current_total,
            overdue_total: c.overdue_total,
            oldest_days_overdue: c.oldest_days,
            invoice_count: c.invoices.length,
            invoices: c.invoices.slice(0, 10).map((i) => ({
              num: i.num,
              amount: i.amount,
              date: i.date,
              due_date: i.due_date,
              days_overdue: i.days_overdue,
            })),
          }}
          subtitle="We'll double-check this customer's invoices and reply by email."
          variant="chip"
        />
      </div>
    </div>
  );
}

function SplitTile({ label, value, tone, empty }: { label: string; value: string; tone: "emerald" | "amber" | "red" | "slate"; empty: boolean }) {
  const colors = empty
    ? "bg-slate-50 border-slate-100 text-ink-light"
    : tone === "emerald" ? "bg-emerald-50 border-emerald-200 text-emerald-900"
    : tone === "amber" ? "bg-amber-50 border-amber-200 text-amber-900"
    : tone === "red" ? "bg-red-50 border-red-200 text-red-900"
    : "bg-slate-50 border-slate-200 text-ink-slate";
  return (
    <div className={`px-3 py-2 rounded-lg border ${colors}`}>
      <div className="text-[10px] uppercase tracking-wider font-semibold opacity-80">{label}</div>
      <div className={`text-sm font-bold mt-0.5 ${empty ? "" : ""}`}>{value}</div>
    </div>
  );
}

// ─── FOLLOWUP EMAIL MODAL ────────────────────────────────────────────────

function FollowupModal({ customer, onClose }: { customer: CustomerCard; onClose: () => void }) {
  const [tone, setTone] = useState<"friendly" | "firm" | "final">("friendly");
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/draft-followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_name: customer.name,
          total_owed: customer.total,
          oldest_days_overdue: customer.oldest_days,
          invoices: customer.invoices
            .filter((i) => i.days_overdue > 0)
            .map((i) => ({
              num: i.num,
              amount: i.amount,
              days_overdue: i.days_overdue,
            })),
          last_payment_date: customer.last_payment_date,
          tone,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setDraft({ subject: body.subject, body: body.body });
    } catch (e: any) {
      setError(e?.message || "Couldn't draft the email");
    } finally {
      setLoading(false);
    }
  }

  async function copyAll() {
    if (!draft) return;
    const text = `Subject: ${draft.subject}\n\n${draft.body}`;
    await navigator.clipboard.writeText(text);
    setCopyStatus("Copied subject + body");
    setTimeout(() => setCopyStatus(""), 2000);
  }
  async function copyBody() {
    if (!draft) return;
    await navigator.clipboard.writeText(draft.body);
    setCopyStatus("Copied body");
    setTimeout(() => setCopyStatus(""), 2000);
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl max-w-2xl w-full shadow-xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="font-bold text-navy">Draft follow-up email</h3>
            <div className="text-xs text-ink-slate truncate">
              To: <strong>{customer.name}</strong>
              {customer.email && <> · {customer.email}</>}
              {" · "}{fmtMoney(customer.overdue_total || customer.total)} overdue
            </div>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy">
            <X size={20} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          <div>
            <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider">Tone</label>
            <div className="mt-2 flex gap-2 flex-wrap">
              {(["friendly", "firm", "final"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTone(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                    tone === t
                      ? "bg-teal text-white border-teal"
                      : "bg-white text-ink-slate border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  {t === "friendly" && "🌱 Friendly nudge"}
                  {t === "firm" && "📌 Firm but polite"}
                  {t === "final" && "⚠️ Final reminder"}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-ink-light mt-1.5">
              {tone === "friendly" && "Casual, assumes the late payment is an oversight. Use for first follow-up."}
              {tone === "firm" && "Direct, asks for a specific commitment by a specific date."}
              {tone === "final" && "Last-chance tone. Use sparingly, only after multiple unanswered nudges."}
            </div>
          </div>

          {!draft && !loading && (
            <button
              onClick={generate}
              className="w-full px-4 py-2 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark inline-flex items-center justify-center gap-2"
            >
              <Sparkles size={14} />
              Generate the email
            </button>
          )}

          {loading && (
            <div className="text-center py-6 text-ink-slate text-sm">
              <Loader2 size={20} className="animate-spin mx-auto mb-2 text-teal-dark" />
              Drafting your follow-up…
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800 flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <div>{error}</div>
            </div>
          )}

          {draft && (
            <>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs">
                  <span className="text-ink-slate font-semibold">Subject:</span>{" "}
                  <span className="text-navy">{draft.subject}</span>
                </div>
                <div className="p-3 text-sm text-navy whitespace-pre-wrap leading-relaxed">
                  {draft.body}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={copyAll}
                  className="px-3 py-1.5 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark inline-flex items-center gap-1.5"
                >
                  <Copy size={12} />
                  Copy subject + body
                </button>
                <button
                  onClick={copyBody}
                  className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-semibold text-ink-slate hover:bg-slate-50 inline-flex items-center gap-1.5"
                >
                  <Copy size={12} />
                  Copy body only
                </button>
                <button
                  onClick={generate}
                  className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-semibold text-ink-slate hover:bg-slate-50 inline-flex items-center gap-1.5"
                >
                  <Sparkles size={12} />
                  Re-draft
                </button>
                {copyStatus && (
                  <span className="text-xs text-emerald-700 font-semibold">{copyStatus}</span>
                )}
              </div>
              <div className="text-[11px] text-ink-light">
                Review it before sending — the AI doesn't know your full history with this customer.
                Paste it into Gmail, Outlook, or whatever you use.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── HELPERS ─────────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return sign + abs.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtRelativeDays(iso: string): string {
  const d = new Date(iso);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} week${diffDays >= 14 ? "s" : ""} ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} month${diffDays >= 60 ? "s" : ""} ago`;
  return iso;
}
