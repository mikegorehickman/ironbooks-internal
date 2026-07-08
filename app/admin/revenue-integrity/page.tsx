import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Landmark, AlertTriangle } from "lucide-react";
import { RunSweepButton } from "./run-sweep-button";

export const dynamic = "force-dynamic";

/**
 * /admin/revenue-integrity — fleet report of deposits posted straight into
 * revenue accounts (invoice+deposit double-count). Read surface for the
 * revenue-integrity sweep; one row per client, newest finding wins.
 */
export default async function RevenueIntegrityPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") redirect("/today");

  const { data: rows } = await service
    .from("audit_log")
    .select("created_at, event_type, request_payload")
    .in("event_type", ["revenue_integrity_finding", "revenue_integrity_completed"])
    .order("created_at", { ascending: false })
    .limit(300);

  const all = ((rows as any[]) || []);
  const completed = all.find((r) => r.event_type === "revenue_integrity_completed");
  // Newest finding per client.
  const byClient = new Map<string, any>();
  for (const r of all) {
    if (r.event_type !== "revenue_integrity_finding") continue;
    const p = r.request_payload || {};
    if (p.client_link_id && !byClient.has(p.client_link_id)) {
      byClient.set(p.client_link_id, { ...p, found_at: r.created_at });
    }
  }
  const findings = [...byClient.values()].sort(
    (a, b) => (b.deposit_total || 0) - (a.deposit_total || 0)
  );
  const flagged = findings.filter((f) => f.flagged);
  const fmt = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n || 0)).toLocaleString();

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2.5">
          <Landmark size={20} className="text-teal" />
          <h1 className="text-xl font-bold text-navy">Revenue integrity</h1>
        </div>
        <RunSweepButton />
      </div>
      <p className="text-sm text-ink-slate mb-6">
        Deposits posted straight into revenue accounts. On invoice-driven books the invoice already
        recorded that income, so the deposit double-counts it. Read-only findings — fixes go through
        the client&apos;s reclass flow.
      </p>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Stat label="Clients with deposits in revenue" value={String(findings.length)} />
        <Stat label="Flagged (invoice-driven)" value={String(flagged.length)} accent={flagged.length > 0} />
        <Stat label="Total deposits in revenue" value={fmt(findings.reduce((s, f) => s + (f.deposit_total || 0), 0))} />
      </div>

      {completed && (
        <p className="text-[11px] text-ink-light mb-4">
          Last sweep completed {new Date(completed.created_at).toLocaleString()} ·{" "}
          {completed.request_payload?.window?.start} → {completed.request_payload?.window?.end}
        </p>
      )}

      {findings.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-ink-light">
          No findings yet. Run the sweep — results land here as each chunk finishes (a few minutes fleet-wide).
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-[10px] uppercase tracking-wider text-ink-light">
                <th className="px-4 py-2.5 font-semibold">Client</th>
                <th className="px-3 py-2.5 text-right font-semibold">Deposits → revenue</th>
                <th className="px-3 py-2.5 text-right font-semibold">No customer</th>
                <th className="px-3 py-2.5 text-right font-semibold">Invoices (context)</th>
                <th className="px-3 py-2.5 font-semibold">Read</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.client_link_id} className={`border-b border-gray-50 last:border-0 ${f.flagged ? "bg-red-50/40" : ""}`}>
                  <td className="px-4 py-2.5">
                    <Link href={`/clients/${f.client_link_id}`} className="font-semibold text-navy hover:text-teal hover:underline">
                      {f.client_name}
                    </Link>
                    {f.flagged && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                        <AlertTriangle size={10} /> likely double-count
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold text-navy">
                    {fmt(f.deposit_total)} <span className="text-[10px] font-normal text-ink-light">({f.deposit_count})</span>
                  </td>
                  <td className="px-3 py-2.5 text-right text-ink-slate">{fmt(f.deposit_no_name_total)}</td>
                  <td className="px-3 py-2.5 text-right text-ink-slate">
                    {f.invoice_count} · {fmt(f.invoice_total)}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-slate max-w-[260px]">{f.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-light">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${accent ? "text-red-600" : "text-navy"}`}>{value}</div>
    </div>
  );
}
