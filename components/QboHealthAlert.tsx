import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { createServiceSupabase } from "@/lib/supabase";

/**
 * Fleet-wide QBO connection alert for the bookkeeper's daily surfaces.
 *
 * Renders a red banner when any active client's QuickBooks connection is
 * dead — and calls out, separately, reconnects that were STARTED but never
 * completed (consent link opened 24h+ ago, client still dead). That state
 * looked "handled" for three days in June 2026 while 25 clients had no
 * working books connection; this banner exists so it can never hide again.
 *
 * Server component. Renders nothing when everything is healthy, so it's
 * safe to mount unconditionally on senior-role pages.
 */
export async function QboHealthAlert() {
  const service = createServiceSupabase();

  const { data, error } = await (service as any)
    .from("qbo_connection_health")
    .select("client_link_id, status, reconnect_initiated_at")
    .in("status", ["invalid_grant", "other_error"]);
  if (error || !data || data.length === 0) return null;

  const staleCutoff = Date.now() - 24 * 3_600_000;
  const dead = data.length;
  const incomplete = data.filter(
    (r: { reconnect_initiated_at: string | null }) =>
      r.reconnect_initiated_at && Date.parse(r.reconnect_initiated_at) < staleCutoff
  ).length;

  return (
    <Link
      href="/fleet/qbo-health"
      className="group flex items-center gap-3 rounded-xl border-2 border-red-300 bg-red-50 hover:bg-red-100 transition-colors p-3.5"
    >
      <AlertTriangle size={18} className="shrink-0 text-red-600" />
      <div className="flex-1 text-sm text-red-800">
        <strong>
          {dead} client{dead === 1 ? "" : "s"} ha{dead === 1 ? "s" : "ve"} a dead QuickBooks
          connection
        </strong>
        {incomplete > 0 && (
          <>
            {" "}
            — including <strong>{incomplete}</strong> where a reconnect was started but{" "}
            <strong>never finished</strong>
          </>
        )}
        . No statements or recon can run for them until re-auth is completed.
      </div>
      <span className="shrink-0 inline-flex items-center gap-1 text-xs font-bold text-red-700 group-hover:text-red-800">
        Fix now <ArrowRight size={12} />
      </span>
    </Link>
  );
}
