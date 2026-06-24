import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { QboHealthClient, type ClientHealthRow } from "./qbo-health-client";

export const dynamic = "force-dynamic";

/**
 * /fleet/qbo-health
 *
 * Single page showing every client's QBO connection health, with
 * inline re-auth buttons + a bulk-reconnect mode.
 *
 * Data source: qbo_connection_health (populated by /api/fleet/qbo-health-check).
 * If the table is empty (probe never run), prompts the bookkeeper to
 * run it from the page.
 *
 * Admin/lead only — the probe + re-auth flows shouldn't be initiated
 * by bookkeepers casually.
 */
export async function QboHealthContent() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    redirect("/dashboard");
  }

  // Pull every active client + their health row + bookkeeper.
  // Use star-select on the health table — Supabase JS sometimes silently
  // drops untyped tables' explicit column lists when the table isn't in
  // the generated Database type. `select("*")` bypasses that. We cast the
  // service handle through `any` for the same reason.
  const svcAny: any = service;
  const [clientsRes, healthRes, bookkeepersRes] = await Promise.all([
    service
      .from("client_links")
      .select(
        "id, client_name, qbo_realm_id, assigned_bookkeeper_id, jurisdiction, state_province, created_at"
      )
      .eq("is_active", true)
      .order("client_name"),
    svcAny.from("qbo_connection_health").select("*"),
    service
      .from("users")
      .select("id, full_name")
      .eq("is_active", true),
  ]);

  // Server-side trace — surfaces in Vercel logs the first time someone
  // opens the page after a deploy. Helps catch silent column-projection
  // failures on untyped tables.
  console.log(
    `[fleet/qbo-health] client_links=${(clientsRes.data as any[])?.length ?? "null"} ` +
    `health_rows=${(healthRes?.data as any[])?.length ?? "null"} ` +
    `health_error=${(healthRes as any)?.error?.message || "none"}`
  );
  if (Array.isArray(healthRes?.data) && healthRes.data.length > 0) {
    const sample = healthRes.data[0];
    console.log(
      `[fleet/qbo-health] sample health row keys=${Object.keys(sample).join(",")} ` +
      `client_link_id=${sample.client_link_id} status=${sample.status}`
    );
  }

  const healthByClient = new Map<string, any>();
  for (const h of (healthRes?.data as any[]) || []) {
    if (h?.client_link_id) {
      healthByClient.set(String(h.client_link_id), h);
    }
  }
  const bookkeepersById = new Map<string, string>();
  for (const u of (bookkeepersRes.data as any[]) || []) {
    bookkeepersById.set(u.id, u.full_name);
  }

  const rows: ClientHealthRow[] = ((clientsRes.data as any[]) || []).map((c) => {
    const h = healthByClient.get(String(c.id));
    let status: ClientHealthRow["status"];
    if (!c.qbo_realm_id) status = "never_connected";
    else if (!h) status = "unknown";
    else status = h.status;
    return {
      client_link_id: c.id,
      client_name: c.client_name,
      qbo_realm_id: c.qbo_realm_id,
      jurisdiction: c.jurisdiction || null,
      state_province: c.state_province || null,
      bookkeeper_id: c.assigned_bookkeeper_id,
      bookkeeper_name: c.assigned_bookkeeper_id
        ? bookkeepersById.get(c.assigned_bookkeeper_id) || null
        : null,
      client_created_at: c.created_at,
      status,
      last_checked_at: h?.last_checked_at || null,
      error_message: h?.error_message || null,
      last_ok_at: h?.last_ok_at || null,
      first_failed_at: h?.first_failed_at || null,
      reconnect_initiated_at: h?.reconnect_initiated_at || null,
      reconnect_initiated_by_name: h?.reconnect_initiated_by
        ? bookkeepersById.get(h.reconnect_initiated_by) || null
        : null,
    };
  });

  const probeNeverRun = ((healthRes?.data as any[]) || []).length === 0;
  // Diagnostic — surface when we fetched health rows but the join
  // produced zero matches. If this fires, either the IDs disagree
  // (UUID format mismatch) or the column projection dropped data.
  const healthRowCount = ((healthRes?.data as any[]) || []).length;
  const joinedCount = rows.filter(
    (r) => r.status === "ok" || r.status === "invalid_grant" || r.status === "other_error"
  ).length;
  const joinSuspect = healthRowCount > 0 && joinedCount === 0;

  return (
    <div className="px-6 py-5 max-w-[1400px] mx-auto space-y-3">
        {joinSuspect && (
          <div className="rounded-lg bg-red-50 border border-red-300 p-3 text-xs text-red-800">
            <strong className="block mb-1">Join diagnostic — page is broken:</strong>
            Fetched {healthRowCount} health rows from qbo_connection_health, but
            zero matched any of the {(clientsRes.data as any[])?.length ?? "?"}{" "}
            active clients. Check the Vercel logs for `[fleet/qbo-health]` lines
            — they'll show the sample row keys + first client_link_id.
          </div>
        )}
        <QboHealthClient rows={rows} probeNeverRun={probeNeverRun} />
    </div>
  );
}

/** Standalone /fleet/qbo-health — wraps QboHealthContent in the shell (V1). */
export default async function QboHealthPage() {
  return (
    <AppShell>
      <TopBar
        title="QBO Connection Health"
        subtitle="Every client's QuickBooks refresh-token state — re-auth dead connections in bulk"
      />
      <QboHealthContent />
    </AppShell>
  );
}
