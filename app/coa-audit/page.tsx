import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { deriveLifecycleStatus, ACTIVE_JOB_STATUSES, type LifecycleStatus } from "@/lib/client-lifecycle";
import { CoaAuditClient } from "./audit-client";

export const dynamic = "force-dynamic";

/**
 * /coa-audit — fleet COA drift dashboard: how conformant each client's live QBO
 * chart is to the master COA, and where each client sits in the cleanup flow.
 * The triage layer for standardization. Moved out of /admin so bookkeeping
 * staff (not just admins) can see + fix their clients; only the fleet
 * multi-select batch stays owner-only. Read-only scans; fixes go through the
 * bookkeeper-gated API routes.
 */
export default async function CoaAuditPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role, email").eq("id", user.id).single();
  const role = ((actor as any)?.role as string) || "bookkeeper";
  // Bookkeeping staff only. Clients live in the portal; billing-only admins
  // aren't bookkeeping staff.
  if (["client", "billing_admin"].includes(role)) redirect("/");
  // Who can actually run fixes/merges (viewers are read-only).
  const canFix = ["admin", "lead", "bookkeeper"].includes(role);

  // Owner-only (Mike): the multi-select batch Fix-all runner. Gated by email —
  // there's no dedicated owner role, and this is the one control that writes to
  // many clients' books at once, so it stays off for everyone else.
  const OWNER_EMAILS = new Set(["mike@paintergrowth.com"]);
  const isOwner =
    OWNER_EMAILS.has(String((actor as any)?.email || "").toLowerCase()) ||
    OWNER_EMAILS.has(String(user.email || "").toLowerCase());

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, status, qbo_realm_id, cleanup_completed_at, cleanup_review_state, daily_recon_enabled, bs_enabled")
    .eq("is_active", true)
    .not("qbo_realm_id", "is", null)
    .order("client_name");

  const clientList = (clients as any[]) || [];
  const clientIds = clientList.map((c) => c.id);

  // Cleanup stage per client. Bulk-load the two job tables once (instead of the
  // per-client deriveLifecycleForClient, which fires ~4 queries each) and feed
  // the pure deriveLifecycleStatus. We skip the month-close / ask-client
  // signals here — for COA triage the pipeline stage (needs cleanup → COA →
  // reclass → BS → review → done) is what matters.
  const initialStages: Record<string, LifecycleStatus> = {};
  try {
    const [{ data: coaJobs }, { data: reclassJobs }] = await Promise.all([
      (service as any).from("coa_jobs").select("client_link_id, status").in("client_link_id", clientIds),
      (service as any).from("reclass_jobs").select("client_link_id, status").in("client_link_id", clientIds),
    ]);
    const coaByClient = new Map<string, string[]>();
    const reclassByClient = new Map<string, string[]>();
    for (const j of (coaJobs as any[]) || []) {
      if (!coaByClient.has(j.client_link_id)) coaByClient.set(j.client_link_id, []);
      coaByClient.get(j.client_link_id)!.push(j.status);
    }
    for (const j of (reclassJobs as any[]) || []) {
      if (!reclassByClient.has(j.client_link_id)) reclassByClient.set(j.client_link_id, []);
      reclassByClient.get(j.client_link_id)!.push(j.status);
    }
    const anyActive = (s: string[]) => s.some((x) => ACTIVE_JOB_STATUSES.includes(x));
    const anyComplete = (s: string[]) => s.some((x) => x === "complete");
    for (const c of clientList) {
      const coa = coaByClient.get(c.id) || [];
      const reclass = reclassByClient.get(c.id) || [];
      initialStages[c.id] = deriveLifecycleStatus({
        status: c.status,
        qbo_connected: !!c.qbo_realm_id,
        cleanup_completed_at: c.cleanup_completed_at,
        cleanup_review_state: c.cleanup_review_state,
        daily_recon_enabled: c.daily_recon_enabled,
        bs_deferred: c.bs_enabled === false,
        has_active_coa: anyActive(coa),
        has_active_reclass: anyActive(reclass),
        has_complete_coa: anyComplete(coa),
        has_complete_reclass: anyComplete(reclass),
      });
    }
  } catch { /* job tables absent / pre-migration — stage column just shows "—" */ }

  // Hydrate from the last cached scan of each client (migration 135) so the
  // fleet view loads instantly instead of re-scanning QuickBooks. Degrades to
  // "unscanned" if the table isn't there yet.
  const initialScans: Record<string, { drift: any; scannedAt: string; scannedBy: string | null }> = {};
  try {
    const { data: scans } = await (service as any)
      .from("coa_audit_scans")
      .select("client_link_id, payload, scanned_at, scanned_by_name");
    for (const s of (scans as any[]) || []) {
      if (s?.payload) initialScans[s.client_link_id] = { drift: s.payload, scannedAt: s.scanned_at, scannedBy: s.scanned_by_name ?? null };
    }
  } catch { /* table absent pre-migration — start empty */ }

  return (
    <AppShell>
      <TopBar
        title="COA Audit"
        subtitle="Where each client's QuickBooks chart stands against the master COA — and where they sit in cleanup"
      />
      <div className="px-8 py-6">
        <CoaAuditClient
          clients={clientList.map((c) => ({ id: c.id, client_name: c.client_name, jurisdiction: c.jurisdiction ?? null }))}
          initialScans={initialScans}
          initialStages={initialStages}
          isOwner={isOwner}
          canFix={canFix}
        />
      </div>
    </AppShell>
  );
}
