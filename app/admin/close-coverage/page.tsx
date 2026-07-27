import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /admin/close-coverage
 *
 * Month-end close coverage matrix: one row per active client, one column per
 * month, each cell showing the DATE the client received their completed books.
 *
 * "Received" = the month-end package was delivered to the client — we use the
 * delivery timestamp COALESCE(email_sent_at, portal_published_at) from
 * month_end_packages. A close that was marked complete (monthly_rec_runs) but
 * never actually delivered is shown separately (amber, "closed · not sent") so
 * the gap is visible rather than looking done. No delivery + no close = blank.
 */

type CellState = "received" | "closed_not_sent" | "none";
type Cell = { state: CellState; date: string | null };

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 'YYYY-MM' → "Mon 'YY" (column header). */
function monthHeader(key: string): { mon: string; yr: string } {
  const [y, m] = key.split("-").map(Number);
  return { mon: MONTH_LABELS[(m || 1) - 1], yr: `'${String(y).slice(2)}` };
}

/** ISO timestamp → "Mon D" (+ year only when it differs from the period year). */
function shortDate(iso: string | null, periodYear: number): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.getUTCDate();
  const mon = MONTH_LABELS[d.getUTCMonth()];
  const yr = d.getUTCFullYear();
  return yr === periodYear ? `${mon} ${day}` : `${mon} ${day}, '${String(yr).slice(2)}`;
}

function ymKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export default async function CloseCoveragePage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/dashboard");

  // Rows: every active client.
  const { data: clientsRaw } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("is_active", true)
    .order("client_name");
  const clients = ((clientsRaw as any[]) || []).map((c) => ({ id: c.id as string, name: (c.client_name as string) || "(unnamed)" }));
  const clientIds = clients.map((c) => c.id);

  // Delivery timestamps per (client, month).
  const { data: packages } = clientIds.length
    ? await (service as any)
        .from("month_end_packages")
        .select("client_link_id, period_year, period_month, status, email_sent_at, portal_published_at")
        .in("client_link_id", clientIds)
    : { data: [] };

  // Completed closes (to flag "closed but never delivered").
  const { data: recRuns } = clientIds.length
    ? await (service as any)
        .from("monthly_rec_runs")
        .select("client_link_id, period, status, completed_at")
        .in("client_link_id", clientIds)
        .eq("status", "complete")
    : { data: [] };

  // Build the cell map + discover the month range.
  const cells = new Map<string, Cell>(); // key: `${clientId}|${ym}`
  const monthsPresent = new Set<string>();
  const yearOf = new Map<string, number>(); // ym -> period year (for date formatting)

  for (const p of (packages as any[]) || []) {
    const ym = ymKey(p.period_year, p.period_month);
    monthsPresent.add(ym);
    yearOf.set(ym, p.period_year);
    const delivered = p.email_sent_at || p.portal_published_at || null;
    if (delivered) {
      cells.set(`${p.client_link_id}|${ym}`, { state: "received", date: delivered });
    }
  }
  for (const r of (recRuns as any[]) || []) {
    const ym = String(r.period || "").trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    monthsPresent.add(ym);
    if (!yearOf.has(ym)) yearOf.set(ym, Number(ym.slice(0, 4)));
    const key = `${r.client_link_id}|${ym}`;
    if (!cells.has(key) && r.completed_at) {
      // Closed but no delivery timestamp found — surface the gap.
      cells.set(key, { state: "closed_not_sent", date: r.completed_at });
    }
  }

  // Column range: always span the full 2026 calendar year (Jan–Dec), plus any
  // earlier history that exists and anything past 2026 (future-proof). Later
  // months in the year show as empty columns until those closes are delivered.
  const now = new Date();
  const currentYm = ymKey(now.getUTCFullYear(), now.getUTCMonth() + 1);
  monthsPresent.add("2026-01");
  monthsPresent.add("2026-12");
  monthsPresent.add(currentYm);
  const sorted = [...monthsPresent].sort();
  const startYm = sorted[0];
  const endYm = sorted[sorted.length - 1];
  const months: string[] = [];
  {
    let [y, m] = startYm.split("-").map(Number);
    const [ey, em] = endYm.split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
      months.push(ymKey(y, m));
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
  }

  const totalReceived = [...cells.values()].filter((c) => c.state === "received").length;
  const totalGaps = [...cells.values()].filter((c) => c.state === "closed_not_sent").length;

  return (
    <div className="px-4 py-8">
      <div className="max-w-none">
        <h1 className="text-2xl font-bold text-navy">Month-end close coverage</h1>
        <p className="text-sm text-ink-slate mt-1 leading-relaxed max-w-3xl">
          Every active client and the date they received their completed books each month.
          A date = the month-end package was delivered (emailed or published to the portal).
          <span className="text-amber-700 font-semibold"> Amber</span> = the month was marked
          complete but no delivery was recorded. Blank = not closed.
        </p>

        <div className="flex flex-wrap items-center gap-4 mt-3 text-xs">
          <span className="text-ink-slate">{clients.length} clients · {months.length} months</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded bg-emerald-100 border border-emerald-300" />
            Received ({totalReceived})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded bg-amber-100 border border-amber-300" />
            Closed · not sent ({totalGaps})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded bg-white border border-gray-200" />
            Not closed
          </span>
        </div>

        <div className="mt-4 overflow-x-auto border border-gray-100 rounded-xl bg-white">
          <table className="text-xs border-collapse min-w-max">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="sticky left-0 z-10 bg-white text-left font-bold text-navy px-3 py-2 border-r border-gray-200 min-w-[200px]">
                  Client
                </th>
                {months.map((ym) => {
                  const h = monthHeader(ym);
                  return (
                    <th key={ym} className="px-2 py-2 text-center font-semibold text-ink-slate whitespace-nowrap min-w-[64px]">
                      <div>{h.mon}</div>
                      <div className="text-[10px] text-ink-light font-normal">{h.yr}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {clients.map((c, i) => (
                <tr key={c.id} className={i % 2 ? "bg-gray-50/40" : "bg-white"}>
                  <td className={`sticky left-0 z-10 px-3 py-1.5 border-r border-gray-200 text-navy font-medium whitespace-nowrap ${i % 2 ? "bg-gray-50" : "bg-white"}`}>
                    {c.name}
                  </td>
                  {months.map((ym) => {
                    const cell = cells.get(`${c.id}|${ym}`);
                    const py = yearOf.get(ym) ?? Number(ym.slice(0, 4));
                    if (!cell || cell.state === "none") {
                      return <td key={ym} className="px-2 py-1.5 text-center text-ink-light">·</td>;
                    }
                    const isGap = cell.state === "closed_not_sent";
                    return (
                      <td
                        key={ym}
                        title={isGap ? "Marked complete but no delivery recorded" : "Delivered to client"}
                        className={`px-2 py-1.5 text-center whitespace-nowrap ${
                          isGap ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"
                        }`}
                      >
                        {shortDate(cell.date, py)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {clients.length === 0 && (
          <div className="mt-4 text-sm text-ink-light italic">No active clients found.</div>
        )}
      </div>
    </div>
  );
}
