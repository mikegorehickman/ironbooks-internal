import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchOpenBills, ageBills, summarizeBanks } from "@/lib/portal-data";
import { fetchAllAccounts } from "@/lib/qbo";
import { PortalErrorState } from "../error-state";
import { AskAboutButton } from "../ask-about";
import { Calendar, Sparkles, MessageSquare } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * "What you owe" — live A/P aging + a cash-flow comfort check, facelifted to
 * match the portal visual system (gradient hero, teal insight card) and wired
 * with an "Ask Ironbooks about this" affordance on every vendor.
 *
 * The cash-flow line at the top compares cash on hand to upcoming bills.
 * If the ratio is tight, the language nudges the user to look closer.
 */
export default async function WhatsDuePage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const [bills, accounts] = await Promise.all([
    fetchOpenBills(ctx.qboRealmId, ctx.accessToken).catch(() => []),
    fetchAllAccounts(ctx.qboRealmId, ctx.accessToken).catch(() => []),
  ]);

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
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy to-teal-dark px-6 py-6 text-white">
        <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full bg-amber-300/15 blur-2xl" />
        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-xs text-white/60 uppercase tracking-wider font-semibold">Bills & obligations</div>
            <h1 className="text-3xl font-bold mt-1">What you owe</h1>
            <div className="text-sm text-white/70 mt-1">
              {fmtMoney(dueSoonTotal)} due in the next 30 days
            </div>
          </div>
          <div className="flex-shrink-0 bg-white/10 backdrop-blur rounded-xl px-5 py-3 border border-white/15">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-white/60">Total owed to vendors</div>
            <div className="text-3xl font-bold mt-0.5 text-white">{fmtMoney(aging.totalAmount)}</div>
            <div className="text-xs text-white/70 mt-0.5">
              {vendors.length} vendor{vendors.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>
      </div>

      {bills.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-ink-slate">
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
                <Sparkles size={18} className={cashHealthy ? "text-emerald-700" : "text-amber-700"} />
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-xs font-bold uppercase tracking-wider ${cashHealthy ? "text-emerald-700" : "text-amber-700"}`}>
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

          {dueSoon.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <h3 className="font-bold text-navy mb-3">Due in the next 30 days</h3>
              <div className="space-y-2">
                {dueSoon.slice(0, 15).map((b) => {
                  const due = new Date(b.due_date!);
                  const daysAway = Math.max(0, Math.floor((due.getTime() - now.getTime()) / 86_400_000));
                  const urgent = daysAway <= 7;
                  return (
                    <BillRow
                      key={b.qbo_bill_id}
                      payee={b.vendor_name || "Unknown vendor"}
                      vendorId={b.vendor_id}
                      docNumber={b.doc_number}
                      dueIso={b.due_date!}
                      due={formatDate(b.due_date!)}
                      daysAway={daysAway}
                      balance={b.balance}
                      urgent={urgent}
                    />
                  );
                })}
                {dueSoon.length > 15 && (
                  <div className="text-xs text-ink-light italic pt-2">+ {dueSoon.length - 15} more</div>
                )}
              </div>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-2xl p-5">
            <h3 className="font-bold text-navy mb-3">All outstanding bills by vendor</h3>
            <div className="divide-y divide-slate-100">
              {vendors.slice(0, 20).map((v, i) => (
                <div key={i} className="flex items-center justify-between gap-2 py-1.5 group">
                  <div className="text-sm min-w-0">
                    <div className="font-semibold text-navy truncate">{v.name}</div>
                    <div className="text-xs text-ink-slate">
                      {v.bills} bill{v.bills === 1 ? "" : "s"} · oldest {v.oldestDays}d
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="font-bold text-navy">{fmtMoney(v.total)}</div>
                    <AskAboutButton
                      kind="ap_vendor"
                      label={v.name}
                      amount={v.total}
                      period={`${v.bills} open bill${v.bills === 1 ? "" : "s"} · oldest ${v.oldestDays}d`}
                      context={{
                        vendor_id: v.vendor_id,
                        total_owed: v.total,
                        bill_count: v.bills,
                        oldest_days: v.oldestDays,
                      }}
                      subtitle="We'll double-check what you owe this vendor and reply by email."
                      variant="icon"
                    />
                  </div>
                </div>
              ))}
              {vendors.length > 20 && (
                <div className="text-xs text-ink-light italic pt-2">+ {vendors.length - 20} more vendors</div>
              )}
            </div>
          </div>
        </>
      )}
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
  payee, vendorId, docNumber, dueIso, due, daysAway, balance, urgent,
}: {
  payee: string;
  vendorId: string | null;
  docNumber: string | null;
  dueIso: string;
  due: string;
  daysAway: number;
  balance: number;
  urgent?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-2 p-3 rounded-lg ${urgent ? "bg-red-50 border border-red-200" : "bg-slate-50 border border-slate-100"}`}>
      <div className="flex items-center gap-3 min-w-0">
        <Calendar size={14} className={urgent ? "text-red-700 flex-shrink-0" : "text-ink-slate flex-shrink-0"} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-navy truncate">{payee}</span>
            {urgent && <span className="text-[9px] font-bold bg-red-100 text-red-800 px-1 rounded flex-shrink-0">URGENT</span>}
          </div>
          <div className="text-xs text-ink-slate">{due} · {daysAway} day{daysAway === 1 ? "" : "s"} away</div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="text-lg font-bold text-navy">{fmtMoney(balance)}</div>
        <AskAboutButton
          kind="ap_vendor"
          label={payee}
          amount={balance}
          period={`Due ${due} · ${daysAway} day${daysAway === 1 ? "" : "s"} away`}
          context={{
            vendor_id: vendorId,
            doc_number: docNumber,
            due_date: dueIso,
            days_until_due: daysAway,
          }}
          subtitle="We'll double-check this bill and reply by email."
          variant="icon"
        />
      </div>
    </div>
  );
}
