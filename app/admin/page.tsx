import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getAttentionMap } from "@/lib/client-attention-state";
import Link from "next/link";
import { AdminSearch } from "./admin-search";
import {
  Users, AlertTriangle, ArrowRight, Clock, Mail, CreditCard, RefreshCw, Repeat,
  Landmark, ReceiptText, CheckCheck, ListChecks, Copy, TrendingUp, Unplug, Flag,
  XCircle, Timer,
} from "lucide-react";

/**
 * /admin — the control room, not a trophy case. Exceptions that need an admin
 * decision at the top, money at a glance, then upgrade radar, bookkeeper
 * scoreboard, the tools list, and the audit trail. (Mike, 2026-07-21.)
 */
export default async function AdminOverviewPage() {
  const supabase = await createServerSupabase();
  const service = createServiceSupabase();
  const svc = service as any;
  const safe = async <T,>(p: PromiseLike<{ data: T }>, fallback: T): Promise<T> => {
    try {
      const { data } = await p;
      return (data as T) ?? fallback;
    } catch {
      return fallback;
    }
  };

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthStartIso = monthStart.toISOString();
  const now = new Date();

  const [
    { count: failedJobs },
    clients,
    staff,
    subs,
    failedPayments,
    upgradeActions,
    closesThisMonth,
    cleanupRows,
    failedReviewClients,
    failedReviewRuns,
    lastReconRun,
    { data: recentActivity },
  ] = await Promise.all([
    supabase.from("coa_jobs").select("*", { count: "exact", head: true }).eq("status", "failed"),
    safe<any[]>(svc.from("client_links").select("id, client_name").eq("is_active", true).order("client_name"), []),
    safe<any[]>(svc.from("users").select("id, full_name, role").eq("is_active", true).in("role", ["admin", "lead", "bookkeeper"]), []),
    safe<any[]>(svc.from("billing_subscriptions").select("*"), []),
    safe<any[]>(
      svc.from("billing_payments").select("amount_cents, currency, status")
        .eq("status", "failed").eq("period_year", now.getFullYear()).eq("period_month", now.getMonth() + 1),
      []
    ),
    safe<any[]>(svc.from("client_upgrade_actions").select("decision"), []),
    safe<any[]>(svc.from("monthly_rec_runs").select("completed_by").eq("status", "complete").gte("completed_at", monthStartIso), []),
    safe<any[]>(svc.from("client_links").select("cleanup_completed_by, cleanup_completed_at").not("cleanup_completed_at", "is", null), []),
    safe<any[]>(svc.from("client_links").select("id, client_name").eq("is_active", true).eq("cleanup_review_state", "failed_review"), []),
    safe<any[]>(svc.from("monthly_rec_runs").select("client_link_id").eq("status", "failed_review"), []),
    safe<any[]>(svc.from("daily_recon_runs").select("created_at").order("created_at", { ascending: false }).limit(1), []),
    supabase.from("recent_activity_feed").select("*").limit(15),
  ]);

  // ── Exceptions — fleet attention states, aggregated ──
  const disconnected: { id: string; name: string }[] = [];
  const stuckJobs: { id: string; name: string }[] = [];
  let escalations = 0;
  try {
    const attention = await getAttentionMap(service);
    const nameOf = new Map(clients.map((c) => [c.id, c.client_name]));
    for (const [id, a] of attention) {
      if (a.disconnected) disconnected.push({ id, name: nameOf.get(id) || "Client" });
      if (a.stuck_job) stuckJobs.push({ id, name: nameOf.get(id) || "Client" });
      escalations += a.escalations.length;
    }
  } catch { /* attention degrade — never break admin */ }

  const failedReviews = failedReviewClients.length + failedReviewRuns.length;
  const reconAgeHours = lastReconRun[0]?.created_at
    ? Math.floor((Date.now() - new Date(lastReconRun[0].created_at).getTime()) / 3600000)
    : null;
  const reconStale = reconAgeHours == null || reconAgeHours > 36;
  const exceptionCount =
    disconnected.length + stuckJobs.length + escalations + failedReviews +
    (failedJobs ?? 0) + (reconStale ? 1 : 0);

  // ── Money — expected collections (MRR) + failures ──
  const activeSub = (s: any) =>
    s?.is_active !== false &&
    (!s?.subscription_status || ["active", "past_due", "trialing"].includes(s.subscription_status));
  let mrrUsd = 0, mrrCad = 0;
  for (const s of subs) {
    if (!activeSub(s)) continue;
    const cents = Number(s.manual_mrr_cents ?? s.mrr_cents ?? 0);
    if (!cents) continue;
    if ((s.currency || "usd").toLowerCase() === "cad") mrrCad += cents;
    else mrrUsd += cents;
  }
  const failedPayCents = failedPayments.reduce((t, p) => t + Number(p.amount_cents || 0), 0);
  const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;

  // ── Upgrade radar ──
  const upgradePending = upgradeActions.filter((u) => u.decision === "pending").length;

  // ── Bookkeeper scoreboard ──
  const staffName = new Map(staff.map((s) => [s.id, s.full_name]));
  const board = new Map<string, { closes: number; cleanupsMonth: number; cleanupsAll: number }>();
  const bump = (id: string | null, key: "closes" | "cleanupsMonth" | "cleanupsAll") => {
    if (!id || !staffName.has(id)) return;
    const row = board.get(id) || { closes: 0, cleanupsMonth: 0, cleanupsAll: 0 };
    row[key]++;
    board.set(id, row);
  };
  for (const r of closesThisMonth) bump(r.completed_by, "closes");
  for (const r of cleanupRows) {
    bump(r.cleanup_completed_by, "cleanupsAll");
    if (r.cleanup_completed_at >= monthStartIso) bump(r.cleanup_completed_by, "cleanupsMonth");
  }
  const scoreboard = [...board.entries()]
    .map(([id, s]) => ({ id, name: staffName.get(id) || "—", ...s }))
    .sort((a, b) => b.closes + b.cleanupsMonth - (a.closes + a.cleanupsMonth));

  return (
    <AppShell>
      <TopBar
        title="Admin"
        subtitle="Exceptions, money, team, and the tools"
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/admin/invite-client"
              className="inline-flex items-center gap-2 bg-white border border-cardline text-ink-slate hover:border-teal hover:text-teal-dark text-sm font-semibold px-4 py-2 rounded-md transition-colors"
            >
              <Mail size={15} />
              Invite client
            </Link>
            <Link
              href="/admin/users"
              className="inline-flex items-center gap-2 bg-white border border-cardline text-ink-slate hover:border-teal hover:text-teal-dark text-sm font-semibold px-4 py-2 rounded-md transition-colors"
            >
              <Users size={15} />
              Employees
            </Link>
            <Link
              href="/admin/users?tab=clients"
              className="inline-flex items-center gap-2 bg-navy hover:bg-navy-deep text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors"
            >
              <Users size={15} />
              Clients
            </Link>
          </div>
        }
      />

      <div className="px-8 py-6 space-y-5">
        {/* Quick search — jump anywhere without walking lists. */}
        <AdminSearch
          clients={clients.map((c) => ({ id: c.id, name: c.client_name }))}
          employees={staff.map((s) => ({ id: s.id, name: s.full_name }))}
        />

        {/* Metric strip — one card, hairline-divided columns. */}
        <div className="bg-white border border-cardline rounded-lg shadow-card grid grid-cols-2 md:grid-cols-4 divide-x divide-hairline">
          <Metric label="Active clients" value={String(clients.length)} />
          <Metric
            label="Expected monthly"
            value={`${money(mrrCad)} CAD`}
            sub={mrrUsd > 0 ? `+ ${money(mrrUsd)} USD` : undefined}
          />
          <Metric
            label="Exceptions"
            value={String(exceptionCount)}
            tone={exceptionCount > 0 ? "rust" : "teal"}
          />
          <Metric
            label="Failed payments · this month"
            value={failedPayments.length ? `${failedPayments.length} · ${money(failedPayCents)}` : "0"}
            tone={failedPayments.length ? "rust" : undefined}
          />
        </div>

        {/* Exceptions — everything that needs an admin decision, or nothing. */}
        <div className="bg-white border border-cardline rounded-lg shadow-card p-5">
          <h2 className={`text-[15px] font-extrabold uppercase tracking-wide text-navy pb-2 border-b-2 ${exceptionCount > 0 ? "border-rust" : "border-navy"}`}>
            Exceptions
          </h2>
          {exceptionCount === 0 ? (
            <p className="text-[13.5px] text-ink-light text-center py-5">Nothing needs an admin right now.</p>
          ) : (
            <div className="divide-y divide-hairline">
              {disconnected.map((c) => (
                <ExceptionRow key={`d-${c.id}`} icon={Unplug} href={`/clients/${c.id}`}
                  label={c.name} detail="QuickBooks disconnected — nothing can run until it's reconnected" />
              ))}
              {stuckJobs.map((c) => (
                <ExceptionRow key={`s-${c.id}`} icon={Timer} href={`/clients/${c.id}`}
                  label={c.name} detail="Job stuck — open the client and restart or clear it" />
              ))}
              {failedReviewClients.map((c) => (
                <ExceptionRow key={`fr-${c.id}`} icon={XCircle} href={`/clients/${c.id}?tab=cleanup`}
                  label={c.name} detail="Cleanup failed manager review — rework pending" />
              ))}
              {failedReviewRuns.length > 0 && (
                <ExceptionRow icon={XCircle} href="/production"
                  label={`${failedReviewRuns.length} month-close${failedReviewRuns.length === 1 ? "" : "s"} failed review`}
                  detail="Bounced back to the bookkeeper — visible on Production" />
              )}
              {(failedJobs ?? 0) > 0 && (
                <ExceptionRow icon={AlertTriangle} href="/history"
                  label={`${failedJobs} failed cleanup job${failedJobs === 1 ? "" : "s"}`}
                  detail="Open History to inspect and re-run" />
              )}
              {escalations > 0 && (
                <ExceptionRow icon={Flag} href="/clients"
                  label={`${escalations} open escalation${escalations === 1 ? "" : "s"}`}
                  detail="Raised by the team — review on the Clients table" />
              )}
              {reconStale && (
                <ExceptionRow icon={Repeat} href="/admin/daily-recon"
                  label="Daily recon engine looks stale"
                  detail={reconAgeHours == null ? "No runs recorded — check the schedule" : `Last run ${reconAgeHours}h ago (expected nightly)`} />
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Upgrade radar */}
          <div className="bg-white border border-cardline rounded-lg shadow-card p-5">
            <div className="flex items-center justify-between pb-2 border-b-2 border-navy">
              <h2 className="text-[15px] font-extrabold uppercase tracking-wide text-navy">Upgrade radar</h2>
              <Link href="/admin/upgrades" className="text-xs font-semibold text-teal-dark hover:text-navy flex items-center gap-1">
                Open <ArrowRight size={12} className="text-gold" />
              </Link>
            </div>
            <div className="pt-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-md bg-teal-light flex items-center justify-center flex-shrink-0">
                <TrendingUp size={18} className="text-teal-dark" />
              </div>
              <div className="text-sm text-ink">
                {upgradePending > 0 ? (
                  <><span className="font-extrabold text-navy">{upgradePending}</span> upgrade candidate{upgradePending === 1 ? "" : "s"} pending review — clients running past their tier with healthy margin.</>
                ) : (
                  <>No pending upgrade reviews. The radar flags clients 3 straight months over their tier cap with ≥15% margin.</>
                )}
              </div>
            </div>
          </div>

          {/* Bookkeeper scoreboard */}
          <div className="bg-white border border-cardline rounded-lg shadow-card p-5">
            <div className="flex items-center justify-between pb-2 border-b-2 border-navy">
              <h2 className="text-[15px] font-extrabold uppercase tracking-wide text-navy">Bookkeeper scoreboard</h2>
              <span className="text-[11.5px] uppercase tracking-wider text-ink-light font-bold">This month</span>
            </div>
            {scoreboard.length === 0 ? (
              <p className="text-[13.5px] text-ink-light text-center py-5">No completions recorded yet this month.</p>
            ) : (
              <div className="divide-y divide-hairline">
                {scoreboard.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 py-2.5">
                    <div className="w-7 h-7 rounded-full bg-gold flex items-center justify-center text-[11px] font-extrabold text-navy flex-shrink-0">
                      {s.name.charAt(0)}
                    </div>
                    <div className="flex-1 text-sm font-semibold text-navy truncate">{s.name}</div>
                    <div className="text-right text-[12.5px] text-ink-slate whitespace-nowrap">
                      <span className="font-extrabold text-navy">{s.closes}</span> closes
                      <span className="mx-1.5 text-ink-light">·</span>
                      <span className="font-extrabold text-navy">{s.cleanupsMonth}</span> cleanups
                      <span className="mx-1.5 text-ink-light">·</span>
                      <span className="text-ink-light">{s.cleanupsAll} all-time</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Admin tools — everything that used to have its own sidebar row. */}
        <div className="space-y-2">
          {[
            { href: "/admin/billing", icon: CreditCard, title: "Billing", desc: "Subscription revenue — Stripe-synced + manual entries · MRR, dunning, reconciliation banner" },
            { href: "/admin/daily-recon", icon: Repeat, title: "Daily recon engine", desc: "Enroll / dry-run / pause clients · nightly run history · run all now" },
            { href: "/admin/bulk-email", icon: Mail, title: "Bulk email", desc: "Email some or all clients · rich text · unsubscribe-aware" },
            { href: "/admin/resync-logins", icon: RefreshCw, title: "Re-sync portal logins", desc: "Repoint client login emails that drifted from their contact email" },
            { href: "/admin/bank-rules", icon: ListChecks, title: "Bank rules — fleet", desc: "Which clients have / haven't had their rules applied · one-click .xls per client" },
            { href: "/admin/revenue-integrity", icon: Landmark, title: "Revenue integrity", desc: "Deposits posted straight into revenue — the invoice+deposit double-count · fleet report" },
            { href: "/admin/crm-invoice-revenue", icon: ReceiptText, title: "CRM invoice revenue", desc: "CRM-pushed invoices double-counting deposit revenue · review pairs + deposits-only per client" },
            { href: "/coa-audit", icon: ListChecks, title: "COA audit", desc: "Chart conformance vs the master COA · cleanup stage · stranded $ · open to all bookkeeping staff" },
            { href: "/admin/reapply-skipped", icon: CheckCheck, title: "Re-apply skipped", desc: "Re-push 'already in target account' skips to QBO · idempotent, closed-period safe" },
            { href: "/admin/payroll-double-scan", icon: AlertTriangle, title: "Payroll double-count scan", desc: "Same crew's pay booked to two labor lines · read-only triage · $ overstated per client" },
            { href: "/admin/duplicates", icon: Copy, title: "Duplicate transactions — fleet", desc: "Duplicate expenses across the fleet · open findings + $ exposure · void the extra copies" },
          ].map((t) => {
            const Icon = t.icon;
            return (
              <Link
                key={t.href}
                href={t.href}
                className="group flex items-center justify-between rounded-lg bg-white border border-cardline shadow-card px-5 py-3 hover:border-teal transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="rounded-md flex items-center justify-center w-9 h-9 bg-teal-light">
                    <Icon size={16} className="text-teal-dark" />
                  </div>
                  <div>
                    <h3 className="font-bold text-sm text-navy">{t.title}</h3>
                    <p className="text-xs text-ink-slate">{t.desc}</p>
                  </div>
                </div>
                <ArrowRight size={16} className="text-gold opacity-0 group-hover:opacity-100 transition-opacity" />
              </Link>
            );
          })}
        </div>

        {/* Recent activity — the audit trail, full width. */}
        <div className="bg-white border border-cardline rounded-lg shadow-card">
          <div className="flex items-center justify-between px-5 py-4 border-b border-rule">
            <h2 className="text-[15px] font-extrabold uppercase tracking-wide text-navy">Recent activity</h2>
            <Link href="/admin/audit" className="text-xs font-semibold text-teal-dark hover:text-navy flex items-center gap-1">
              Full audit log <ArrowRight size={12} className="text-gold" />
            </Link>
          </div>
          <div className="divide-y divide-hairline max-h-[400px] overflow-y-auto">
            {recentActivity?.map((event) => (
              <div key={event.id} className="px-5 py-3 text-xs hover:bg-[#FBFCFD]">
                <div className="flex items-start gap-2">
                  <Clock size={12} className="text-ink-light mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-navy">
                      <span className="font-semibold">{event.user_name || "System"}</span>
                      {" — "}
                      <span className="text-ink-slate">{formatEventType(event.event_type)}</span>
                      {event.client_name && (
                        <>
                          {" on "}
                          <span className="font-medium">{event.client_name}</span>
                        </>
                      )}
                    </div>
                    <div className="text-ink-light mt-0.5">{formatTimeAgo(event.occurred_at)}</div>
                  </div>
                </div>
              </div>
            ))}
            {(!recentActivity || recentActivity.length === 0) && (
              <p className="px-5 py-6 text-[13.5px] text-ink-light text-center">No activity yet.</p>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "rust" | "teal" }) {
  return (
    <div className="px-5 py-4">
      <div className="text-[11.5px] font-bold uppercase tracking-[0.12em] text-ink-light">{label}</div>
      <div className={`text-[26px] font-extrabold leading-tight mt-1 ${tone === "rust" ? "text-rust" : tone === "teal" ? "text-teal-dark" : "text-navy"}`}>
        {value}
      </div>
      {sub && <div className="text-[12px] text-ink-slate mt-0.5">{sub}</div>}
    </div>
  );
}

function ExceptionRow({
  icon: Icon,
  href,
  label,
  detail,
}: {
  icon: any;
  href: string;
  label: string;
  detail: string;
}) {
  return (
    <Link href={href} className="flex items-center gap-3 py-2.5 hover:bg-[#FBFCFD] transition-colors group">
      <div className="w-8 h-8 rounded-md bg-rust-tint border border-rust-border flex items-center justify-center flex-shrink-0">
        <Icon size={14} className="text-rust" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-navy truncate">{label}</div>
        <div className="text-[12.5px] text-ink-slate truncate">{detail}</div>
      </div>
      <ArrowRight size={14} className="text-gold flex-shrink-0" />
    </Link>
  );
}

function formatEventType(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/qbo /g, "QBO ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function formatTimeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
