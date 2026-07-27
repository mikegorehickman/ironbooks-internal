import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { GstExtractionClient } from "./extraction-client";

export const dynamic = "force-dynamic";

/**
 * /admin/gst-extraction — the Canadian GST/HST/PST retrofit tool.
 *
 * Pulls embedded sales tax out of 2026-YTD revenue (→ GST/HST Payable, a
 * liability on the balance sheet) and out of taxable expenses (→ GST/HST
 * Recoverable ITCs, an asset), per transaction, via line splits that never
 * change a transaction's total — so bank feeds and reconciliations are
 * untouched.
 *
 * Workflow per client: Preview (read-only) → review the per-vendor ITC list and
 * exclude unregistered suppliers → Apply income → Apply expenses. Apply is
 * chunked; the page loops passes until the run reports done. Every write is
 * snapshotted to audit_log first, and re-runs are idempotent (memo-stamped).
 */
export default async function GstExtractionPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/home");

  // Canadian clients only — the roster this tool operates on.
  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, state_province, gst_number, qbo_realm_id, cleanup_completed_at, daily_recon_enabled")
    .eq("is_active", true)
    .eq("jurisdiction", "CA")
    .order("client_name");

  const roster = ((clients as any[]) || [])
    .filter((c) => c.qbo_realm_id)
    .map((c) => ({
      id: c.id,
      client_name: c.client_name,
      province: c.state_province || null,
      gst_number: c.gst_number || null,
      live: !!(c.daily_recon_enabled && c.cleanup_completed_at),
    }));

  return (
    <AppShell>
      <TopBar
        title="GST/HST extraction — Canadian clients"
        subtitle="Pull sales tax out of 2026 revenue and expenses, per transaction, without changing any transaction total"
      />
      <div className="px-8 py-6 max-w-6xl mx-auto">
        <GstExtractionClient clients={roster} />
      </div>
    </AppShell>
  );
}
