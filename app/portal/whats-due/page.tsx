import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchOpenBills, ageBills, summarizeBanks } from "@/lib/portal-data";
import { fetchAllAccounts } from "@/lib/qbo";
import { createServiceSupabase } from "@/lib/supabase";
import { PortalErrorState } from "../error-state";
import { DismissBillButton, DismissedBillsSection, type DismissibleBill } from "./whats-due-actions";
import { Calendar, Sparkles, MessageSquare } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * "What you owe" — live A/P aging + a cash-flow comfort check.
 *
 * Each bill can be DISMISSED ("not actually owed") — persisted server-side
 * (portal_ap_dismissals), filtered out everywhere, and mirrored to the
 * bookkeeper. (Bills used to have an "Ask" button that routed into the
 * transaction-Ask flow, which didn't fit — a bill isn't a transaction.)
 */
export default async function WhatsDuePage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const service = createServiceSupabase();
  const [billsRaw, accounts, dismissalRows] = await Promise.all([
    fetchOpenBills(ctx.qboRealmId, ctx.accessToken).catch(() => []),
    fetchAllAccounts(ctx.qboRealmId, ctx.accessToken).catch(() => []),
    (service as any)
      .from("portal_ap_dismissals")
      .select("qbo_bill_id, vendor_name, doc_number, amount")
      .eq("client_link_id", ctx.clientLinkId)
      .then((r: any) => r.data || [])
      .catch(() => []),
  ]);

  // Filter client-dismissed bills out everywhere — every total recomputes
  // without them, just like the A/R "Who owes you" page.
  const dismissedIds = new Set<string>((dismissalRows as any[]).map((d) => d.qbo_bill_id));
  const bills = billsRaw.filter((b) => !dismissedIds.has(b.qbo_bill_id));
  const dismissedBills: DismissibleBill[] = (dismissalRows as any[]).map((d) => ({
    qbo_bill_id: d.qbo_bill_id,
    vendor_name: d.vendor_name,
    doc_number: d.doc_number,
    amount: typeof d.amount === "number" ? d.amount : 0,
  }));

  const aging = ageBills(bills);
  const banks = summarizeBanks(accounts);

  // 30-day due window for the cash-flow check
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86_400_000);
  const dueSoon = bills
    .filter((b) => {
      if (!b.due_date) return false;
      const due = new Date(b.due_date);
      return due >= now && due <= in30;
    })
    .sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1));
  const dueSoonTotal = dueSoon.reduce((s, b) => s + b.balance, 0);

  // Itemized "bills to review" = overdue + due in the next 30 days, each
  // individually dismissible.
  const reviewBills = bills
    .filter((b) => b.due_date)
    .filter((b) => new Date(b.due_date!) <= in30)
    .sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1));

  // Vendor aggregation
  const byVendor = new Map<
    string,
    { name: string; vendor_id: string | null; total: number; bills: number; oldestDays: number }
  >();
  for (const b of bills) {
    const key = b.vendor_id || `__name:${b.vendor_name || "(no vendor)"}`;
    if (!byVendor.has(key)) {
      byVendor.set(key, {
        name: b.vendor_name || "(no vendor)",
        vendor_id: b.vendor_id,
        total: 0,
        bills: 0,
        oldestDays: 0,
      });
    }
    const g = byVendor.get(key)!;
    const txnDate = new Date(b.txn_date);
    const daysOld = Math.floor((now.getTime() - txnDate.getTime()) / 86_400_000);
    g.total += b.balance;
    g.bills++;
    g.oldestDays = Math.max(g.oldestDays, daysOld);
  }
  const vendors = Array.from(byVendor.values()).sort((a, b) => b.total - a.total);

  const cashRatio = banks.totalCashOnHand > 0 ? dueSoonTotal / banks.totalCashOnHand : 0;
  const cashHealthy = cashRatio < 0.5;

  return (
    <div className="space-y-6">
      {/* ── Gradient hero ───────────────────────────────────────────── */}
      <header className="flex items-end justify-between gap-5 flex-wrap">
        <div className="min-w-0">
          <div className="font-brand text-[11px] uppercase tracking-[0.14em] text-teal-dark">Bills &amp; obligations</div>
          <h1 className="font-brand text-3xl font-semibold text-navy leading-none mt-1.5">What you owe vendors</h1>
          <div className="text-sm text-ink-slate mt-2">
            {fmtMoney(dueSoonTotal)} due in the next 30 days
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="font-brand text-[10px] uppercase tracking-[0.1em] text-ink-light">Total owed to vendors</div>
          <div className="text-[26px] font-bold text-navy tabular-nums leading-none mt-1">{fmtMoney(aging.totalAmount)}</div>
          <div className="text-xs text-ink-slate mt-1">
            {vendors.length} vendor{vendors.length === 1 ? "" : "s"}
          </div>
        </div>
      </header>

      {bills.length === 0 ? (
        <div className="bg-white border border-cardline rounded-2xl p-8 text-center text-sm text-ink-slate">
          No outstanding bills — you're all caught up.
        </div>
      ) : (
        <>
          {/* Cash-flow check insight card */}
          <div className={`relative overflow-hidden rounded-2xl border-2 p-5 ${
            cashHealthy
              ? "border-emerald-300 bg-gradient-to-br from-emerald-50 via-white to-white"
              : "border-amber-300 bg-gradient-to-br from-amber-50 via-white to-white"
          }`}>
            <div className="flex items-start gap-3">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                cashHealthy ? "bg-emerald-100" : "bg-amber-100"
              }`}>
                <Sparkles size={18} className={cashHealthy ? "text-emerald-700" : "text-gold-deep"} />
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-xs font-bold uppercase tracking-wider ${cashHealthy ? "text-emerald-700" : "text-gold-deep"}`}>
                  Cash flow check
                </div>
                <p className="text-sm text-navy/85 leading-relaxed mt-1">
                  You have <strong>{fmtMoney(banks.totalCashOnHand)}</strong> in the bank and{" "}
                  <strong>{fmtMoney(dueSoonTotal)}</strong> in bills due in the next 30 days.{" "}
                  {cashHealthy
                    ? "You're in good shape — plenty of room for payroll and operating expenses."
                    : "Tighter than ideal — keep an eye on this and prioritize the urgent bills."}
                </p>
                <div className="mt-3 flex items-center gap-3 flex-wrap">
                  <a
                    href="/portal/ask-ai"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-dark hover:underline"
                  >
                    <MessageSquare size={12} /> Ask the AI about your bills
                  </a>
                </div>
              </div>
            </div>
          </div>

          {reviewBills.length > 0 && (
            <div className="bg-white border border-cardline rounded-2xl p-5">
              <h3 className="font-bold text-navy">Bills to review</h3>
              <p className="text-xs text-ink-slate mb-3">
                Overdue and due in the next 30 days — dismiss any that aren't actually owed.
              </p>
              <div className="space-y-2">
                {reviewBills.slice(0, 20).map((b) => {
                  const due = new Date(b.due_date!);
                  const daysAway = Math.floor((due.getTime() - now.getTime()) / 86_400_000);
                  const urgent = daysAway <= 7;
                  return (
                    <BillRow
                      key={b.qbo_bill_id}
                      billId={b.qbo_bill_id}
                      payee={b.vendor_name || "Unknown vendor"}
                      docNumber={b.doc_number}
                      due={formatDate(b.due_date!)}
                      daysAway={daysAway}
                      balance={b.balance}
                      urgent={urgent}
                    />
                  );
                })}
                {reviewBills.length > 20 && (
                  <div className="text-xs text-ink-light italic pt-2">+ {reviewBills.length - 20} more</div>
                )}
              </div>
            </div>
          )}

          <div className="bg-white border border-cardline rounded-2xl p-5">
            <h3 className="font-bold text-navy mb-3">All outstanding bills by vendor</h3>
            <div className="divide-y divide-slate-100">
              {vendors.slice(0, 20).map((v, i) => (
                <div key={i} className="flex items-center justify-between gap-2 py-1.5">
                  <div className="text-sm min-w-0">
                    <div className="font-semibold text-navy truncate">{v.name}</div>
                    <div className="text-xs text-ink-slate">
                      {v.bills} bill{v.bills === 1 ? "" : "s"} · oldest {v.oldestDays}d
                    </div>
                  </div>
                  <div className="font-bold text-navy flex-shrink-0">{fmtMoney(v.total)}</div>
                </div>
              ))}
              {vendors.length > 20 && (
                <div className="text-xs text-ink-light italic pt-2">+ {vendors.length - 20} more vendors</div>
              )}
            </div>
          </div>
        </>
      )}

      <DismissedBillsSection dismissed={dismissedBills} />
    </div>
  );
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return sign + abs.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function BillRow({
  billId, payee, docNumber, due, daysAway, balance, urgent,
}: {
  billId: string;
  payee: string;
  docNumber: string | null;
  due: string;
  daysAway: number;
  balance: number;
  urgent?: boolean;
}) {
  const overdue = daysAway < 0;
  const timing = overdue
    ? `${due} · ${Math.abs(daysAway)} day${Math.abs(daysAway) === 1 ? "" : "s"} overdue`
    : `${due} · ${daysAway} day${daysAway === 1 ? "" : "s"} away`;
  return (
    <div className={`flex items-center justify-between gap-2 p-3 rounded-lg ${urgent ? "bg-rust-tint border border-rust-border" : "bg-canvas border border-hairline"}`}>
      <div className="flex items-center gap-3 min-w-0">
        <Calendar size={14} className={urgent ? "text-rust flex-shrink-0" : "text-ink-slate flex-shrink-0"} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-navy truncate">{payee}</span>
            {overdue ? (
              <span className="text-[9px] font-bold bg-red-100 text-rust px-1 rounded flex-shrink-0">OVERDUE</span>
            ) : urgent ? (
              <span className="text-[9px] font-bold bg-amber-100 text-gold-deep px-1 rounded flex-shrink-0">DUE SOON</span>
            ) : null}
          </div>
          <div className="text-xs text-ink-slate">{timing}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="text-lg font-bold text-navy">{fmtMoney(balance)}</div>
        <DismissBillButton bill={{ qbo_bill_id: billId, vendor_name: payee, doc_number: docNumber, amount: balance }} />
      </div>
    </div>
  );
}
