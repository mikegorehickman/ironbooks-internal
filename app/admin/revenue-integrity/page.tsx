import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Landmark, AlertTriangle } from "lucide-react";
import { RunSweepButton } from "./run-sweep-button";

export const dynamic = "force-dynamic";

/**
 * /admin/revenue-integrity — fleet report for BOTH sides of the
 * invoice/deposit mismatch, because they're the same root cause and
 * substantially the same clients:
 *
 *  - Revenue side: deposits posted straight into revenue accounts, so the
 *    invoice AND the deposit both book income (double-count).
 *  - A/R side: the flip of the same coin — that deposit was never APPLIED to
 *    its invoice, so the invoice never closed and receivables pile up for
 *    years (All Inspired Painting: $1.55M open, oldest 1,638 days). Those are
 *    unmatched invoices, NOT bad debt.
 *
 * One row per client, union of both finding types, newest finding per client.
 * Read-only — fixes go through the client's cleanup flow.
 */
export default async function RevenueIntegrityPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") redirect("/today");

  // audit_log's timestamp column is `occurred_at`, not created_at — the old
  // created_at select/order errored the query and this page silently showed no
  // findings (same latent bug as the CRM-invoice page).
  const { data: rows } = await service
    .from("audit_log")
    .select("occurred_at, event_type, request_payload")
    .in("event_type", [
      "revenue_integrity_finding",
      "revenue_integrity_completed",
      "ar_integrity_finding",
      "ar_integrity_completed",
    ])
    .order("occurred_at", { ascending: false })
    .limit(1000);

  const all = ((rows as any[]) || []);
  const revCompleted = all.find((r) => r.event_type === "revenue_integrity_completed");
  const arCompleted = all.find((r) => r.event_type === "ar_integrity_completed");

  // Newest finding per client, per kind.
  const revByClient = new Map<string, any>();
  const arByClient = new Map<string, any>();
  for (const r of all) {
    const p = r.request_payload || {};
    if (!p.client_link_id) continue;
    if (r.event_type === "revenue_integrity_finding" && !revByClient.has(p.client_link_id)) {
      revByClient.set(p.client_link_id, { ...p, found_at: r.occurred_at });
    } else if (r.event_type === "ar_integrity_finding" && !arByClient.has(p.client_link_id)) {
      arByClient.set(p.client_link_id, { ...p, found_at: r.occurred_at });
    }
  }

  const clientIds = new Set<string>([...revByClient.keys(), ...arByClient.keys()]);
  const merged = [...clientIds].map((id) => {
    const rev = revByClient.get(id) || null;
    const ar = arByClient.get(id) || null;
    return {
      id,
      name: rev?.client_name || ar?.client_name || "(unknown client)",
      rev,
      ar,
      // Sort: untrustworthy A/R first, then anything flagged, then by dollars.
      severity: ar?.verdict === "unreliable" ? 2 : ar?.flagged || rev?.flagged ? 1 : 0,
      exposure: (ar?.total_open || 0) + (rev?.deposit_total || 0),
    };
  });
  merged.sort((a, b) => b.severity - a.severity || b.exposure - a.exposure);

  const revFlagged = merged.filter((m) => m.rev?.flagged);
  const arUnreliable = merged.filter((m) => m.ar?.verdict === "unreliable");
  const arFlagged = merged.filter((m) => m.ar?.flagged);
  const phantomAr = arFlagged.reduce((s, m) => s + (m.ar?.total_open || 0), 0);
  const priorYearAr = arFlagged.reduce((s, m) => s + (m.ar?.prior_year_total || 0), 0);

  const fmt = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n || 0)).toLocaleString();

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <Landmark size={20} className="text-teal" />
          <h1 className="text-xl font-bold text-navy">Revenue &amp; A/R integrity</h1>
        </div>
        <div className="flex items-center gap-2">
          <RunSweepButton variant="secondary" />
          <RunSweepButton
            endpoint="/api/admin/ar-integrity-sweep"
            label="Run A/R sweep"
            confirmText={
              "Scan every production client for phantom A/R (invoices collected but never matched to their deposits)?\n\n" +
              "Read-only against QBO. Runs in chunks in the background — results appear on this page as they land."
            }
          />
        </div>
      </div>
      <p className="text-sm text-ink-slate mb-6 max-w-4xl">
        Two sides of one problem. <strong>Deposits → revenue</strong>: the deposit was booked as
        income when the invoice already recorded it (double-count). <strong>Phantom A/R</strong>: the
        same deposit was never <em>applied</em> to its invoice, so the invoice never closed and
        receivables pile up for years. Invoices that old are almost always already collected —
        they are <strong>unmatched invoices, not bad debt</strong>. Fix by matching the deposit
        (current year) or a prior-period adjustment with CPA sign-off (closed years) — never a write-off.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Stat label="A/R not trustworthy" value={String(arUnreliable.length)} accent={arUnreliable.length > 0} />
        <Stat label="Phantom A/R (flagged clients)" value={fmt(phantomAr)} accent={phantomAr > 0} />
        <Stat label="…of which closed years" value={fmt(priorYearAr)} />
        <Stat label="Flagged for deposits → revenue" value={String(revFlagged.length)} accent={revFlagged.length > 0} />
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-ink-light mb-4">
        {revCompleted && (
          <span>
            Revenue sweep completed {new Date(revCompleted.occurred_at).toLocaleString()} ·{" "}
            {revCompleted.request_payload?.window?.start} → {revCompleted.request_payload?.window?.end}
          </span>
        )}
        {arCompleted ? (
          <span>
            A/R sweep completed {new Date(arCompleted.occurred_at).toLocaleString()} ·{" "}
            {arCompleted.request_payload?.scanned ?? "?"} clients scanned
          </span>
        ) : (
          <span className="text-gold-deep font-semibold">
            A/R sweep hasn&apos;t run yet — click &ldquo;Run A/R sweep&rdquo; to size the fleet.
          </span>
        )}
      </div>

      {merged.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-ink-light">
          No findings yet. Run the sweeps — results land here as each chunk finishes (a few minutes fleet-wide).
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-[10px] uppercase tracking-wider text-ink-light">
                <th className="px-4 py-2.5 font-semibold">Client</th>
                <th className="px-3 py-2.5 text-right font-semibold">Open A/R</th>
                <th className="px-3 py-2.5 text-right font-semibold">&gt;90d</th>
                <th className="px-3 py-2.5 text-right font-semibold">Oldest</th>
                <th className="px-3 py-2.5 text-right font-semibold">Closed yrs</th>
                <th className="px-3 py-2.5 text-right font-semibold">A/R × rev</th>
                <th className="px-3 py-2.5 text-right font-semibold">Deposits → rev</th>
              </tr>
            </thead>
            <tbody>
              {merged.map((m) => {
                const ar = m.ar;
                const rev = m.rev;
                const bad = ar?.verdict === "unreliable";
                return (
                  <tr
                    key={m.id}
                    className={`border-b border-gray-50 last:border-0 ${
                      bad ? "bg-red-50/40" : ar?.flagged ? "bg-amber-50/30" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5 align-top">
                      <Link href={`/clients/${m.id}`} className="font-semibold text-navy hover:text-teal hover:underline">
                        {m.name}
                      </Link>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {ar && <ArBadge verdict={ar.verdict} />}
                        {ar?.deposits_only && (
                          <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-semibold text-ink-slate">
                            deposits-only
                          </span>
                        )}
                        {rev?.flagged && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                            <AlertTriangle size={10} /> double-count
                          </span>
                        )}
                      </div>
                      {ar?.reason && (
                        <div className="text-[11px] text-ink-slate mt-1 max-w-[440px]">{ar.reason}</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right align-top font-semibold text-navy tabular-nums">
                      {ar ? (
                        <>
                          {fmt(ar.total_open)}{" "}
                          <span className="text-[10px] font-normal text-ink-light">({ar.total_count})</span>
                        </>
                      ) : (
                        <span className="text-ink-light">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right align-top tabular-nums">
                      {ar ? (
                        <span className={ar.pct_over_90 >= 70 ? "font-semibold text-red-700" : "text-ink-slate"}>
                          {Math.round(ar.pct_over_90)}%
                        </span>
                      ) : (
                        <span className="text-ink-light">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right align-top text-ink-slate tabular-nums">
                      {ar?.oldest_days != null ? `${Number(ar.oldest_days).toLocaleString()}d` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right align-top text-ink-slate tabular-nums">
                      {ar?.prior_year_total ? (
                        <>
                          {fmt(ar.prior_year_total)}{" "}
                          <span className="text-[10px] text-ink-light">({ar.prior_year_count})</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right align-top tabular-nums">
                      {ar?.ar_to_monthly_revenue != null ? (
                        <span className={ar.ar_to_monthly_revenue > 6 ? "font-semibold text-red-700" : "text-ink-slate"}>
                          {ar.ar_to_monthly_revenue}×
                        </span>
                      ) : (
                        <span className="text-ink-light">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right align-top text-ink-slate tabular-nums">
                      {rev ? (
                        <>
                          {fmt(rev.deposit_total)}{" "}
                          <span className="text-[10px] text-ink-light">({rev.deposit_count})</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ArBadge({ verdict }: { verdict: string }) {
  if (verdict === "unreliable") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
        <AlertTriangle size={10} /> A/R not trustworthy
      </span>
    );
  }
  if (verdict === "suspect") {
    return (
      <span className="inline-flex items-center rounded-full border border-gold-border bg-gold-tint px-1.5 py-0.5 text-[10px] font-semibold text-gold-deep">
        A/R questionable
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
      A/R clean
    </span>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-light">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${accent ? "text-red-600" : "text-navy"}`}>{value}</div>
    </div>
  );
}
