import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /admin/close-coverage
 *
 * Month-end DELIVERY audit: one row per active client, one column per month,
 * each cell showing whether the client actually received their completed books
 * and when.
 *
 * The authoritative "did the client get it" signal is on the close itself
 * (monthly_rec_runs), because completing a month ALWAYS sends — by one of two
 * paths (see app/api/clients/[id]/monthly-rec/route.ts "send"):
 *   1. Full month-end package — branded email + statements published to the
 *      portal → also writes month_end_packages.email_sent_at.
 *   2. Fallback plain email — used for P&L-only clients (BS toggle off) and
 *      whenever the package pipeline errors. Emails a summary but writes NO
 *      month_end_packages row and publishes nothing to the portal.
 * Both stamp monthly_rec_runs.sent_to_client_at + email_delivery{sent}. So we
 * judge delivery from the run (+ email_delivery.sent), and use month_end_packages
 * only to tell a full portal package apart from an email-only "lite" close.
 */

type CellState = "full" | "email_only" | "send_failed" | "closed_not_sent" | "none";
type Cell = { state: CellState; date: string | null };

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

  // The closes themselves — the authoritative delivery signal.
  const { data: runs } = clientIds.length
    ? await (service as any)
        .from("monthly_rec_runs")
        .select("client_link_id, period, status, completed_at, sent_to_client_at, email_delivery, month_end_package_id")
        .in("client_link_id", clientIds)
        .eq("status", "complete")
    : { data: [] };

  // Full portal packages (to distinguish a full package from an email-only close).
  const { data: packages } = clientIds.length
    ? await (service as any)
        .from("month_end_packages")
        .select("client_link_id, period_year, period_month, email_sent_at, portal_published_at")
        .in("client_link_id", clientIds)
    : { data: [] };

  const cells = new Map<string, Cell>(); // key: `${clientId}|${ym}`
  const monthsPresent = new Set<string>();
  const yearOf = new Map<string, number>();

  // Packages first: a delivered package = a full portal close.
  for (const p of (packages as any[]) || []) {
    const ym = ymKey(p.period_year, p.period_month);
    monthsPresent.add(ym);
    yearOf.set(ym, p.period_year);
    const delivered = p.email_sent_at || p.portal_published_at || null;
    if (delivered) cells.set(`${p.client_link_id}|${ym}`, { state: "full", date: delivered });
  }

  // Runs: fill in / correct the delivery state from the authoritative signal.
  for (const r of (runs as any[]) || []) {
    const ym = String(r.period || "").trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    monthsPresent.add(ym);
    if (!yearOf.has(ym)) yearOf.set(ym, Number(ym.slice(0, 4)));
    const key = `${r.client_link_id}|${ym}`;
    if (cells.get(key)?.state === "full") continue; // package already proves full delivery

    const ed = r.email_delivery as any;
    const sent = ed?.sent;
    const viaPackage = ed?.via === "month_end_package" || !!r.month_end_package_id;
    const when = r.sent_to_client_at || r.completed_at || null;

    let state: CellState;
    if (sent === true) state = viaPackage ? "full" : "email_only";
    else if (sent === false) state = "send_failed";
    else if (r.sent_to_client_at) state = "email_only"; // older rows w/o email_delivery — assume the summary email went
    else state = "closed_not_sent"; // completed but no send recorded (the real gap the backfill tool was for)

    cells.set(key, { state, date: when });
  }

  // Column range: always the full 2026 year, plus any earlier/later data.
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

  const tally = (s: CellState) => [...cells.values()].filter((c) => c.state === s).length;
  const totals = { full: tally("full"), email: tally("email_only"), failed: tally("send_failed"), notSent: tally("closed_not_sent") };

  const STATE_STYLE: Record<Exclude<CellState, "none">, { cls: string; title: string }> = {
    full: { cls: "bg-emerald-50 text-emerald-800", title: "Delivered — full package (email + statements in portal)" },
    email_only: { cls: "bg-sky-50 text-sky-800", title: "Delivered — summary email only (no statement package published to portal)" },
    send_failed: { cls: "bg-red-100 text-red-800 font-semibold", title: "Close completed but the send FAILED — client did not receive it" },
    closed_not_sent: { cls: "bg-amber-50 text-amber-800", title: "Marked complete but no send was ever recorded" },
  };

  const Swatch = ({ cls, label, n }: { cls: string; label: string; n: number }) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block w-3 h-3 rounded border ${cls}`} />
      {label} ({n})
    </span>
  );

  return (
    <div className="px-4 py-8">
      <h1 className="text-2xl font-bold text-navy">Month-end delivery</h1>
      <p className="text-sm text-ink-slate mt-1 leading-relaxed max-w-3xl">
        Every active client and whether they actually received their completed books each month.
        Completing a month always sends — either the full package (email + statements in the portal)
        or a summary email only. This reads the delivery stamped on the close itself, so it reflects
        what really went out.
      </p>

      <div className="flex flex-wrap items-center gap-4 mt-3 text-xs">
        <span className="text-ink-slate">{clients.length} clients · {months.length} months</span>
        <Swatch cls="bg-emerald-100 border-emerald-300" label="Full package" n={totals.full} />
        <Swatch cls="bg-sky-100 border-sky-300" label="Email only" n={totals.email} />
        <Swatch cls="bg-red-200 border-red-400" label="Send failed" n={totals.failed} />
        <Swatch cls="bg-amber-100 border-amber-300" label="Closed, never sent" n={totals.notSent} />
        <Swatch cls="bg-white border-gray-200" label="Not closed" n={0} />
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
                  const s = STATE_STYLE[cell.state];
                  return (
                    <td key={ym} title={s.title} className={`px-2 py-1.5 text-center whitespace-nowrap ${s.cls}`}>
                      {cell.state === "send_failed" ? "⚠ failed" : shortDate(cell.date, py)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {clients.length === 0 && <div className="mt-4 text-sm text-ink-light italic">No active clients found.</div>}
    </div>
  );
}
