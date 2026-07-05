import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { fetchAllAccounts, getValidToken, QBOReauthRequiredError } from "@/lib/qbo";
import { ArrowLeft, AlertTriangle, Sparkles } from "lucide-react";
import { DailyReviewTable } from "./daily-review-table";

export const dynamic = "force-dynamic";

/**
 * /today/[clientId] — Per-client drill-down for the daily recon queue.
 *
 * Reuses the same UX pattern as the reclass review screen but reads from
 * daily_review_queue instead of reclassifications. Each row has an
 * Approve / Reject / Ask Client action; bookkeeper can override the
 * suggested target via a dropdown of live QBO accounts.
 */
export default async function TodayClientPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();

  const { data: client } = await service
    .from("client_links")
    .select(
      "id, client_name, jurisdiction, state_province, qbo_realm_id, assigned_bookkeeper_id, last_synced_at, daily_recon_enabled, daily_recon_paused, daily_recon_paused_reason"
    )
    .eq("id", clientId)
    .single();
  if (!client) notFound();

  const c = client as any;

  // Auth — owner bookkeeper, or admin/lead
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = c.assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return (
      <AppShell>
        <TopBar title="Forbidden" />
        <div className="px-8 py-12">
          <div className="p-4 bg-red-50 text-red-800 rounded-lg max-w-xl">
            You don&apos;t have access to this client&apos;s daily review queue.
          </div>
        </div>
      </AppShell>
    );
  }

  // Pull every queue row (pending + recently decided) so the bookkeeper can
  // see what they did + what's left. Pending sorted by anomaly count then
  // amount; resolved at the bottom.
  const { data: queueRowsData } = await service
    .from("daily_review_queue" as any)
    .select("*")
    .eq("client_link_id", clientId)
    .order("created_at", { ascending: false })
    .limit(500);

  const allRows = (queueRowsData as any[]) || [];
  const pending = allRows.filter((r) => r.decision === "pending");
  const recentlyDecided = allRows
    .filter((r) => r.decision !== "pending")
    .slice(0, 50);

  // Fetch available accounts for the override dropdown — all active.
  let availableAccounts: Array<{ id: string; name: string; type: string }> = [];
  if (c.qbo_realm_id) {
    try {
      const accessToken = await getValidToken(clientId, service as any);
      const allAccounts = await fetchAllAccounts(c.qbo_realm_id, accessToken);
      availableAccounts = allAccounts
        .filter((a) => a.Active !== false)
        .map((a) => ({ id: a.Id, name: a.Name, type: a.AccountType || "" }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: any) {
      // Dead refresh token → send user to reconnect, not an empty dropdown.
      if (err instanceof QBOReauthRequiredError) redirect(err.reconnectUrl);
      console.warn(`[today/${clientId}] could not fetch accounts:`, err?.message);
    }
  }

  const totalAnomalies = pending.reduce((s, r) => {
    const flags = Array.isArray(r.anomaly_flags) ? r.anomaly_flags : [];
    return s + flags.length;
  }, 0);

  return (
    <AppShell>
      <TopBar title={c.client_name} subtitle="Daily review queue" />
      <div className="px-8 py-6 space-y-5">
        <Link
          href="/today"
          className="inline-flex items-center gap-1 text-sm text-ink-slate hover:text-navy"
        >
          <ArrowLeft size={14} />
          Back to Today
        </Link>

        {c.daily_recon_paused && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm">
            <div className="font-bold text-red-900 mb-1">⏸ Daily recon paused for this client</div>
            <div className="text-red-800">
              {c.daily_recon_paused_reason || "No reason recorded."}
            </div>
            <div className="text-xs text-red-700 mt-2">
              Admin can unpause from /admin/daily-recon after reviewing the day&apos;s batch.
            </div>
          </div>
        )}

        {/* Summary banner */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white rounded-2xl border border-gray-100 p-4">
            <div className="text-2xl font-bold text-navy">{pending.length}</div>
            <div className="text-xs text-ink-slate mt-1">Pending review</div>
          </div>
          <div className="bg-white rounded-2xl border border-gray-100 p-4">
            <div className="text-2xl font-bold text-navy flex items-center gap-2">
              {totalAnomalies}
              {totalAnomalies > 0 && <AlertTriangle size={18} className="text-amber-600" />}
            </div>
            <div className="text-xs text-ink-slate mt-1">Anomaly flags</div>
          </div>
          <div className="bg-white rounded-2xl border border-gray-100 p-4">
            <div className="text-2xl font-bold text-navy">{recentlyDecided.length}</div>
            <div className="text-xs text-ink-slate mt-1">Recently decided</div>
          </div>
        </div>

        {/* Pending queue */}
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-bold text-navy uppercase tracking-wider">
              Pending — {pending.length}
            </h2>
            <span className="text-xs text-ink-slate">
              Sorted: anomalies first, then by amount
            </span>
          </div>
          {pending.length === 0 ? (
            <div className="p-10 text-center space-y-2">
              <Sparkles className="inline text-emerald-500" size={28} />
              <div className="text-sm font-semibold text-navy">All caught up</div>
              <p className="text-xs text-ink-slate max-w-sm mx-auto">
                Nothing pending review for {c.client_name}. The next daily run will pick up any
                new transactions.
              </p>
            </div>
          ) : (
            <DailyReviewTable rows={pending} availableAccounts={availableAccounts} />
          )}
        </div>

        {/* Recently decided */}
        {recentlyDecided.length > 0 && (
          <details className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <summary className="px-5 py-3 cursor-pointer text-sm font-bold text-navy uppercase tracking-wider hover:bg-gray-50">
              Recently decided ({recentlyDecided.length}) — click to expand
            </summary>
            <DailyReviewTable rows={recentlyDecided} availableAccounts={availableAccounts} readOnly />
          </details>
        )}
      </div>
    </AppShell>
  );
}
