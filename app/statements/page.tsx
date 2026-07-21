import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { FileText, AlertTriangle, CheckCircle2, MailWarning, ArrowRight } from "lucide-react";
import { getStatementsFleet } from "@/lib/statements-fleet";

export const dynamic = "force-dynamic";

/**
 * /statements — the one home for client statements across the fleet. Answers
 * "who's had statements sent, who's a gap, who bounced" from the durable send
 * log (client_email_log · bs_statements), and links each row to the client and
 * to the senior approval queue. Consolidates the scattered statement surfaces
 * (per-client card, approvals widget, backfill tool) into one place.
 */
const STATUS_TONE: Record<string, { label: string; cls: string }> = {
  opened: { label: "Opened", cls: "bg-emerald-50 text-emerald-700" },
  delivered: { label: "Delivered", cls: "bg-teal-light/60 text-teal" },
  sent: { label: "Sent", cls: "bg-blue-50 text-blue-700" },
  bounced: { label: "Bounced", cls: "bg-red-50 text-red-700" },
  failed: { label: "Failed", cls: "bg-red-50 text-red-700" },
};

export default async function StatementsPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper", "viewer"].includes(role)) redirect("/portal");

  const { rows, summary } = await getStatementsFleet(service);

  const stat = (label: string, value: number, Icon: any, tone: string) => (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 flex items-center gap-3">
      <div className={`p-2 rounded-lg ${tone}`}>
        <Icon size={16} />
      </div>
      <div>
        <div className="text-xl font-bold text-navy leading-none">{value}</div>
        <div className="text-[11px] text-ink-slate mt-1">{label}</div>
      </div>
    </div>
  );

  return (
    <AppShell>
      <TopBar
        title="Statements"
        subtitle="Every client's statements in one place — sent, delivered, gaps, bounces"
        actions={
          <Link
            href="/admin/backfill-statements"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy border border-gray-200 rounded-lg px-3 py-2"
          >
            Backfill tool <ArrowRight size={12} />
          </Link>
        }
      />
      <div className="px-8 py-6 max-w-6xl mx-auto space-y-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {stat("Active clients", summary.total, FileText, "bg-gray-100 text-ink-slate")}
          {stat("Statements sent", summary.sent, CheckCircle2, "bg-emerald-50 text-emerald-700")}
          {stat("Production gaps", summary.neverSent, AlertTriangle, "bg-amber-50 text-amber-700")}
          {stat("Bounced / failed", summary.bounced, MailWarning, "bg-red-50 text-red-700")}
        </div>

        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-[11px] font-bold uppercase tracking-wider text-ink-slate">
                  <th className="px-4 py-2.5">Client</th>
                  <th className="px-4 py-2.5">Last statement</th>
                  <th className="px-4 py-2.5">Sent</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const gap = r.isProduction && !r.everSent;
                  const tone = r.lastStatus ? STATUS_TONE[r.lastStatus] : null;
                  return (
                    <tr key={r.clientId} className="border-t border-gray-100 hover:bg-gray-50/60">
                      <td className="px-4 py-2.5">
                        <Link href={`/clients/${r.clientId}`} className="font-semibold text-navy hover:text-teal">
                          {r.clientName}
                        </Link>
                        {r.isProduction && (
                          <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-teal">Production</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-ink-slate max-w-[280px] truncate" title={r.lastSubject || ""}>
                        {r.lastSubject || <span className="text-ink-light italic">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-ink-slate whitespace-nowrap">
                        {r.lastSentAt ? new Date(r.lastSentAt).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        {gap ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold bg-amber-50 text-amber-700">
                            <AlertTriangle size={11} /> Never sent
                          </span>
                        ) : tone ? (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold ${tone.cls}`}>
                            {tone.label}
                          </span>
                        ) : (
                          <span className="text-ink-light">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          href={`/clients/${r.clientId}`}
                          className="text-xs font-semibold text-teal hover:underline inline-flex items-center gap-1"
                        >
                          Open <ArrowRight size={12} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-xs text-ink-light">
          Statements awaiting senior sign-off live on{" "}
          <Link href="/oversight?tab=approvals" className="text-teal hover:underline font-semibold">
            Oversight → Approvals
          </Link>
          . Delivery status updates automatically from Resend.
        </p>
      </div>
    </AppShell>
  );
}
