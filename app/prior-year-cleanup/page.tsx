import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { CalendarClock, AlertTriangle, DollarSign } from "lucide-react";
import { assessPriorYear } from "@/lib/prior-year-cleanup";
import { PriorYearRow } from "./py-row";

export const dynamic = "force-dynamic";

/**
 * /prior-year-cleanup — who needs their books cleaned back to the year after
 * their last filed return, how many catch-up years that is (extra years are
 * billable), and the tracking/comms workflow. Senior-only.
 *
 * "Needs it" is derived from py_taxes_filed_through_year vs the current year;
 * the per-client status/notes live in client_links.prior_year_cleanup.
 */
export default async function PriorYearCleanupPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/home");

  const currentYear = new Date().getFullYear();

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, assigned_bookkeeper_id, is_active, py_taxes_filed, py_taxes_filed_through_year, prior_year_cleanup")
    .eq("is_active", true)
    .order("client_name");

  const { data: staff } = await service
    .from("users").select("id, full_name").in("role", ["admin", "lead", "bookkeeper", "viewer"]);
  const nameById = new Map<string, string>(((staff as any[]) || []).map((u) => [u.id, u.full_name || "—"]));

  const rows = ((clients as any[]) || [])
    .map((c) => ({ client: c, a: assessPriorYear(c, currentYear) }))
    // Show clients who need catch-up, or that we can't assess yet (missing
    // last-filed year), or that already have a tracking status.
    .filter(({ a }) => a.needsPriorYear || a.unknown || !!a.tracking.status)
    .sort((x, y) => y.a.yearsNeeded.length - x.a.yearsNeeded.length);

  const needCount = rows.filter((r) => r.a.needsPriorYear).length;
  const billableCount = rows.filter((r) => r.a.billableExtraYears.length > 0).length;
  const unknownCount = rows.filter((r) => r.a.unknown).length;

  const stat = (label: string, value: number, Icon: any, tone: string) => (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 flex items-center gap-3">
      <div className={`p-2 rounded-lg ${tone}`}><Icon size={16} /></div>
      <div>
        <div className="text-xl font-bold text-navy leading-none">{value}</div>
        <div className="text-[11px] text-ink-slate mt-1">{label}</div>
      </div>
    </div>
  );

  return (
    <AppShell>
      <TopBar
        title="Prior-year cleanup"
        subtitle="Clients owed a catch-up back to the year after their last filed return"
      />
      <div className="px-8 py-6 max-w-6xl mx-auto space-y-5">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {stat("Need catch-up", needCount, CalendarClock, "bg-amber-50 text-amber-700")}
          {stat("Have extra billable years", billableCount, DollarSign, "bg-red-50 text-red-700")}
          {stat("Missing last-filed year", unknownCount, AlertTriangle, "bg-gray-100 text-ink-slate")}
        </div>

        {rows.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white py-14 text-center text-sm text-ink-slate">
            No clients need prior-year cleanup right now. 🎉
          </div>
        ) : (
          <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-[11px] font-bold uppercase tracking-wider text-ink-slate">
                    <th className="px-4 py-2.5">Client</th>
                    <th className="px-4 py-2.5">Last filed</th>
                    <th className="px-4 py-2.5">Catch-up years</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Note / actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ client, a }) => (
                    <PriorYearRow
                      key={client.id}
                      clientId={client.id}
                      clientName={client.client_name || "(unnamed)"}
                      assigneeName={client.assigned_bookkeeper_id ? nameById.get(client.assigned_bookkeeper_id) || null : null}
                      lastFiledYear={a.lastFiledYear}
                      yearsNeeded={a.yearsNeeded}
                      billableExtraYears={a.billableExtraYears}
                      unknown={a.unknown}
                      initialTracking={a.tracking}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p className="text-xs text-ink-light">
          Amber years are the current catch-up; red years are extra, billable years beyond the current
          filing period. Set a status and mark the client notified once they&apos;ve agreed to the catch-up scope.
        </p>
      </div>
    </AppShell>
  );
}
