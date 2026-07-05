import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import Link from "next/link";
import { Users, FileCheck, Shield, Activity, AlertTriangle, ArrowRight, Clock, Mail, CreditCard, RefreshCw, Phone, Repeat, Video } from "lucide-react";

export default async function AdminOverviewPage() {
  const supabase = await createServerSupabase();

  const [
    { count: totalUsers },
    { count: activeUsers },
    { data: users },
    { data: recentActivity },
    { count: totalCleanups },
    { count: completedCleanups },
    { count: failedJobs },
  ] = await Promise.all([
    supabase.from("users").select("*", { count: "exact", head: true }),
    supabase.from("users").select("*", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("user_activity_stats").select("*").limit(20),
    supabase.from("recent_activity_feed").select("*").limit(15),
    supabase.from("coa_jobs").select("*", { count: "exact", head: true }),
    supabase.from("coa_jobs").select("*", { count: "exact", head: true }).eq("status", "complete"),
    supabase.from("coa_jobs").select("*", { count: "exact", head: true }).eq("status", "failed"),
  ]);

  return (
    <AppShell>
      <TopBar
        title="Admin"
        subtitle="Team management, accountability, and compliance"
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/admin/invite-client"
              className="inline-flex items-center gap-2 bg-white border-2 border-teal text-teal hover:bg-teal/5 text-sm font-semibold px-4 py-2 rounded-lg"
            >
              <Mail size={16} />
              Invite client
            </Link>
            <Link
              href="/admin/billing"
              className="inline-flex items-center gap-2 bg-white border-2 border-slate-200 text-ink-slate hover:border-teal hover:text-teal text-sm font-semibold px-4 py-2 rounded-lg"
            >
              <CreditCard size={16} />
              Billing
            </Link>
            <Link
              href="/admin/billing-backfill"
              className="inline-flex items-center gap-2 bg-white border-2 border-slate-200 text-ink-slate hover:border-teal hover:text-teal text-sm font-semibold px-4 py-2 rounded-lg"
            >
              <CreditCard size={16} />
              Link Stripe
            </Link>
            <Link
              href="/admin/coaching-calls"
              className="inline-flex items-center gap-2 bg-white border-2 border-slate-200 text-ink-slate hover:border-teal hover:text-teal text-sm font-semibold px-4 py-2 rounded-lg"
            >
              <Phone size={16} />
              Coaching calls
            </Link>
            <Link
              href="/admin/users"
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg"
            >
              <Users size={16} />
              Manage Users
            </Link>
          </div>
        }
      />

      <div className="px-8 py-6">
        {/* Top stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          <StatCard
            label="Active Users"
            value={`${activeUsers ?? 0} / ${totalUsers ?? 0}`}
            icon={Users}
            color="#2D7A75"
          />
          <StatCard
            label="Total Cleanups"
            value={String(totalCleanups ?? 0)}
            icon={FileCheck}
            color="#0F1F2E"
          />
          <StatCard
            label="Completed"
            value={String(completedCleanups ?? 0)}
            icon={Activity}
            color="#10B981"
          />
          <StatCard
            label="Failed Jobs"
            value={String(failedJobs ?? 0)}
            icon={AlertTriangle}
            color={(failedJobs ?? 0) > 0 ? "#DC2626" : "#94A3B8"}
          />
        </div>

        {/* Compliance status */}
        <div className="rounded-xl bg-white border border-gray-200 mb-6">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center gap-3">
            <div className="rounded-lg flex items-center justify-center w-9 h-9 bg-green-100">
              <Shield size={18} className="text-green-600" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-navy">Compliance Status</h3>
              <p className="text-xs text-ink-slate">Financial controls active</p>
            </div>
          </div>
          <div className="p-5 grid grid-cols-3 gap-4 text-sm">
            <ComplianceItem label="Audit log immutable" ok />
            <ComplianceItem label="RLS enforced on all tables" ok />
            <ComplianceItem label="Role changes auto-audited" ok />
            <ComplianceItem label="QBO tokens encrypted" ok />
            <ComplianceItem label="Magic-link auth" ok />
            <ComplianceItem label="Service role isolated" ok />
          </div>
        </div>

        {/* Admin tools — everything that used to have its own sidebar row.
            One hub, one click deeper; these are enter-rarely surfaces. */}
        <div className="space-y-2 mb-6">
          {[
            {
              href: "/admin/daily-recon",
              icon: Repeat,
              title: "Daily recon engine",
              desc: "Enroll / dry-run / pause clients · nightly run history · run all now",
            },
            {
              href: "/admin/bulk-email",
              icon: Mail,
              title: "Bulk email",
              desc: "Email some or all clients · rich text · unsubscribe-aware",
            },
            {
              href: "/admin/call-matching",
              icon: Video,
              title: "Call matching",
              desc: "Match Grain call recordings to clients · manual matches teach auto-matching",
            },
            {
              href: "/admin/resync-logins",
              icon: RefreshCw,
              title: "Re-sync portal logins",
              desc: "Repoint client login emails that drifted from their contact email",
            },
          ].map((t) => {
            const Icon = t.icon;
            return (
              <Link
                key={t.href}
                href={t.href}
                className="group flex items-center justify-between rounded-xl bg-white border border-gray-200 px-5 py-3 hover:border-teal hover:bg-teal-lighter/40 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="rounded-lg flex items-center justify-center w-9 h-9 bg-teal-light">
                    <Icon size={16} className="text-teal" />
                  </div>
                  <div>
                    <h3 className="font-bold text-sm text-navy">{t.title}</h3>
                    <p className="text-xs text-ink-slate">{t.desc}</p>
                  </div>
                </div>
                <ArrowRight size={16} className="text-ink-light group-hover:text-teal" />
              </Link>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-6">
          {/* Team leaderboard */}
          <div className="rounded-xl bg-white border border-gray-200">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h3 className="font-bold text-sm text-navy">Team Productivity</h3>
              <Link
                href="/admin/users"
                className="text-xs font-semibold text-teal flex items-center gap-1"
              >
                All users <ArrowRight size={12} />
              </Link>
            </div>
            <div className="divide-y divide-gray-100">
              {users?.slice(0, 6).map((u) => (
                <Link
                  key={u.id}
                  href={`/admin/users/${u.id}`}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-teal-lighter transition-colors"
                >
                  <div className="rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0 w-8 h-8 bg-teal-light text-teal">
                    {u.full_name?.charAt(0) || "?"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-navy truncate">{u.full_name}</div>
                    <div className="text-xs text-ink-slate capitalize">{u.role}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-navy">
                      {u.completed_cleanups || 0}
                    </div>
                    <div className="text-xs text-ink-slate">cleanups</div>
                  </div>
                </Link>
              ))}
              {(!users || users.length === 0) && (
                <p className="px-5 py-6 text-sm text-ink-slate text-center">
                  No team members yet.
                </p>
              )}
            </div>
          </div>

          {/* Recent activity */}
          <div className="rounded-xl bg-white border border-gray-200">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h3 className="font-bold text-sm text-navy">Recent Activity</h3>
              <Link
                href="/admin/audit"
                className="text-xs font-semibold text-teal flex items-center gap-1"
              >
                Full audit log <ArrowRight size={12} />
              </Link>
            </div>
            <div className="divide-y divide-gray-100 max-h-[400px] overflow-y-auto">
              {recentActivity?.map((event) => (
                <div key={event.id} className="px-5 py-3 text-xs">
                  <div className="flex items-start gap-2">
                    <Clock size={12} className="text-ink-light mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-navy">
                        <span className="font-semibold">{event.user_name || "System"}</span>
                        {" — "}
                        <span className="text-ink-slate">
                          {formatEventType(event.event_type)}
                        </span>
                        {event.client_name && (
                          <>
                            {" on "}
                            <span className="font-medium">{event.client_name}</span>
                          </>
                        )}
                      </div>
                      <div className="text-ink-light mt-0.5">
                        {formatTimeAgo(event.occurred_at)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {(!recentActivity || recentActivity.length === 0) && (
                <p className="px-5 py-6 text-sm text-ink-slate text-center">
                  No activity yet.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: string;
  icon: any;
  color: string;
}) {
  return (
    <div className="p-5 rounded-xl bg-white border border-gray-200">
      <div className="flex items-start justify-between mb-3">
        <div className="p-2 rounded-lg" style={{ backgroundColor: `${color}15` }}>
          <Icon size={18} style={{ color }} />
        </div>
      </div>
      <div className="text-2xl font-bold tracking-tight text-navy">{value}</div>
      <div className="text-sm mt-1 text-ink-slate">{label}</div>
    </div>
  );
}

function ComplianceItem({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className="rounded-full w-2 h-2"
        style={{ backgroundColor: ok ? "#10B981" : "#DC2626" }}
      />
      <span className="text-navy">{label}</span>
    </div>
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
