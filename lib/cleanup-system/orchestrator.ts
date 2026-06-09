/**
 * Cleanup run orchestrator — lifecycle, module gating, concurrency guard.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ACTIVE_CLEANUP_STATUSES,
  MODULE_ORDER,
  type CleanupModule,
  type CleanupModuleStatus,
  type CleanupWorkflowMode,
} from "./types";
import { pullQboSnapshot } from "./snapshot";
import { saveHealthScore } from "./health-score";
import { getCompanyClosingDate, isInClosedPeriod } from "@/lib/qbo-reclass";
import { getValidToken } from "@/lib/qbo";
import { getClientEndCloses } from "@/lib/double";

export async function checkActiveRun(
  service: SupabaseClient,
  clientLinkId: string
): Promise<{ id: string; status: string } | null> {
  const { data } = await service
    .from("cleanup_runs")
    .select("id, status")
    .eq("client_link_id", clientLinkId)
    .in("status", ACTIVE_CLEANUP_STATUSES)
    .limit(1)
    .maybeSingle();
  return data as any;
}

export async function startCleanupRun(
  service: SupabaseClient,
  clientLinkId: string,
  bookkeeperId: string,
  opts: {
    periodLockDate: string;
    workflowMode?: CleanupWorkflowMode;
    asOfDate?: string;
  }
): Promise<{ runId: string; healthScoreId: string }> {
  const existing = await checkActiveRun(service, clientLinkId);
  if (existing) {
    throw new Error(
      `Active cleanup run ${existing.id} (status=${existing.status}) already exists for this client`
    );
  }

  const asOfDate = opts.asOfDate || opts.periodLockDate;

  // Resolve QBO + Double close dates for period lock
  let qboCloseDate: string | null = null;
  let doubleCloseDate: string | null = null;
  try {
    const token = await getValidToken(clientLinkId, service);
    const { data: client } = await service
      .from("client_links")
      .select("qbo_realm_id, double_client_id")
      .eq("id", clientLinkId)
      .single();
    if (client) {
      qboCloseDate = await getCompanyClosingDate((client as any).qbo_realm_id, token);
      if ((client as any).double_client_id) {
        const closes = await getClientEndCloses(Number((client as any).double_client_id));
        if (closes.length > 0) {
          const ym = closes[0].yearMonth;
          if (ym && ym.length === 6) {
            const y = ym.slice(0, 4);
            const m = ym.slice(4, 6);
            const lastDay = new Date(Number(y), Number(m), 0).getDate();
            doubleCloseDate = `${y}-${m}-${String(lastDay).padStart(2, "0")}`;
          }
        }
      }
    }
  } catch {
    // Non-fatal — bookkeeper can set lock date manually
  }

  const { data: periodLock, error: plErr } = await service
    .from("period_locks")
    .upsert(
      {
        client_link_id: clientLinkId,
        lock_date: opts.periodLockDate,
        qbo_books_close_date: qboCloseDate,
        double_close_date: doubleCloseDate,
        set_by: bookkeeperId,
        updated_at: new Date().toISOString(),
      } as any,
      { onConflict: "client_link_id" }
    )
    .select("id")
    .single();
  if (plErr) throw new Error(`Period lock failed: ${plErr.message}`);

  const { data: run, error: runErr } = await service
    .from("cleanup_runs")
    .insert({
      client_link_id: clientLinkId,
      bookkeeper_id: bookkeeperId,
      status: "discovering",
      workflow_mode: opts.workflowMode || "onboarding",
      period_lock_id: periodLock.id,
      period_lock_date: opts.periodLockDate,
    } as any)
    .select("id")
    .single();
  if (runErr) throw new Error(`Failed to create run: ${runErr.message}`);

  try {
    const snapshot = await pullQboSnapshot(service, clientLinkId, asOfDate, bookkeeperId);

    const healthScoreId = await saveHealthScore(
      service,
      clientLinkId,
      run.id,
      snapshot.snapshotId,
      { trialBalance: snapshot.trialBalance, balanceSheet: snapshot.balanceSheet }
    );

    await service
      .from("cleanup_runs")
      .update({
        snapshot_id: snapshot.snapshotId,
        health_score_id: healthScoreId,
        status: "reviewing",
        current_module: MODULE_ORDER[0],
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", run.id);

    // Initialize module rows. Modules are ungated — every one starts "ready"
    // so the bookkeeper can run them individually in any order, rather than
    // unlocking one at a time.
    const moduleRows = MODULE_ORDER.map((module) => ({
      run_id: run.id,
      module,
      status: "ready" as CleanupModuleStatus,
    }));
    await service.from("cleanup_run_modules").insert(moduleRows as any);

    await service.from("audit_log").insert({
      event_type: "cleanup_run_started",
      user_id: bookkeeperId,
      occurred_at: new Date().toISOString(),
      request_payload: {
        client_link_id: clientLinkId,
        run_id: run.id,
        period_lock_date: opts.periodLockDate,
        health_score_id: healthScoreId,
      },
    } as any);

    return { runId: run.id, healthScoreId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await service
      .from("cleanup_runs")
      .update({
        status: "failed",
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", run.id);
    throw err instanceof Error ? err : new Error(message);
  }
}

export function getNextModule(current: CleanupModule): CleanupModule | null {
  const idx = MODULE_ORDER.indexOf(current);
  if (idx < 0 || idx >= MODULE_ORDER.length - 1) return null;
  return MODULE_ORDER[idx + 1];
}

export async function advanceModule(
  service: SupabaseClient,
  runId: string,
  completedModule: CleanupModule
): Promise<CleanupModule | null> {
  await service
    .from("cleanup_run_modules")
    .update({ status: "complete", completed_at: new Date().toISOString() } as any)
    .eq("run_id", runId)
    .eq("module", completedModule);

  const next = getNextModule(completedModule);
  if (next) {
    await service
      .from("cleanup_run_modules")
      .update({ status: "ready" } as any)
      .eq("run_id", runId)
      .eq("module", next);
    await service
      .from("cleanup_runs")
      .update({ current_module: next, updated_at: new Date().toISOString() } as any)
      .eq("id", runId);
  } else {
    await service
      .from("cleanup_runs")
      .update({ current_module: null, updated_at: new Date().toISOString() } as any)
      .eq("id", runId);
  }
  return next;
}

export function isDateInLockedPeriod(
  txnDate: string,
  periodLockDate: string,
  qboCloseDate: string | null
): boolean {
  if (qboCloseDate && isInClosedPeriod(txnDate, qboCloseDate)) return true;
  if (periodLockDate && txnDate <= periodLockDate) return true;
  return false;
}
