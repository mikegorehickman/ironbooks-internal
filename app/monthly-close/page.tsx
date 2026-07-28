import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { MonthBoard } from "./month-board";
import { formatMonth, type ClientMonth } from "@/lib/client-months";

export const dynamic = "force-dynamic";

/**
 * /monthly-close — the monthly reclass board.
 *
 * One row per client for the selected month, showing every stage of the close
 * and what to do next. This replaces holding the month in your head: previously
 * a reclass job carried a free-typed date range and nothing could answer "is
 * June done for this client?".
 *
 * Buckets come from `client_months` (migration 142) and are opened per month, so
 * June and July are worked independently — finish June while July fills up.
 */
export default async function MonthlyClosePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const sp = await searchParams;

  // Which months have buckets at all — drives the selector. Newest first, and we
  // default to the OLDEST open month rather than the newest: the work you owe is
  // the month you haven't finished, not the one that just started.
  const { data: monthRows } = await (service as any)
    .from("client_months")
    .select("period_month, status")
    .order("period_month", { ascending: false });

  const allMonths: string[] = [...new Set(((monthRows as any[]) || []).map((r) => r.period_month))];
  const oldestIncomplete = [...allMonths]
    .reverse()
    .find((m) =>
      ((monthRows as any[]) || []).some((r) => r.period_month === m && r.status !== "complete")
    );
  const selectedMonth = sp.month || oldestIncomplete || allMonths[0] || null;

  if (!selectedMonth) {
    return (
      <AppShell>
        <TopBar title="Monthly close" subtitle="No months opened yet" />
        <div className="px-8 py-6 max-w-3xl">
          <div className="rounded-xl border border-gold-border bg-gold-tint px-4 py-4 text-sm text-gold-deep">
            <p className="font-semibold mb-1">No monthly buckets exist yet.</p>
            <p>
              Months are opened on the 1st, or manually for a catch-up month. Once a month is
              opened, every eligible client appears here with their close checklist.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  const { data: buckets } = await (service as any)
    .from("client_months")
    .select("*")
    .eq("period_month", selectedMonth);

  const bucketList = ((buckets as any[]) || []) as ClientMonth[];
  const clientIds = bucketList.map((b) => b.client_link_id);

  const { data: clients } = clientIds.length
    ? await (service as any)
        .from("client_links")
        .select("id, client_name, assigned_bookkeeper_id, qbo_realm_id, jurisdiction")
        .in("id", clientIds)
    : { data: [] };

  const clientById = new Map(((clients as any[]) || []).map((c) => [c.id, c]));

  const rows = bucketList
    .map((b) => ({
      bucket: b,
      clientName: clientById.get(b.client_link_id)?.client_name || "(unknown client)",
      qboConnected: !!clientById.get(b.client_link_id)?.qbo_realm_id,
    }))
    .sort((a, b) => a.clientName.localeCompare(b.clientName));

  return (
    <AppShell>
      <TopBar
        title="Monthly close"
        subtitle={`${formatMonth(selectedMonth)} · ${rows.length} client${rows.length === 1 ? "" : "s"}`}
      />
      <div className="px-8 py-6 max-w-[1600px]">
        <MonthBoard
          rows={rows}
          months={allMonths}
          selectedMonth={selectedMonth}
        />
      </div>
    </AppShell>
  );
}
