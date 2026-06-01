import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { after } from "next/server";
import {
  reclassifyTransactionLines,
  buildAuditMemo,
  getValidToken,
  type SupportedTxType,
} from "@/lib/qbo-reclass";
import { fetchAllAccounts } from "@/lib/qbo";
import { postReclassComplete } from "@/lib/double";

/**
 * POST /api/reclass/[id]/execute
 *
 * Validates attestation. Kicks off background execution.
 * Returns immediately.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("*")
    .eq("id", id)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // Pre-execution checks
  if (!job.attested) {
    return NextResponse.json(
      { error: "Bookkeeper attestation required before execution" },
      { status: 400 }
    );
  }
  if (job.status === "executing") {
    return NextResponse.json({ message: "Already executing", started: false });
  }
  if (job.status === "complete") {
    return NextResponse.json({ message: "Already complete", started: false });
  }

  // SAME-CLIENT CONCURRENCY GUARD. Defense in depth: refuse to start if
  // another reclass job for this client is already executing. Different
  // clients in parallel is fine; same-client parallel reclass causes
  // transaction-snapshot races (Job A moves a line, Job B can't find it).
  const { data: rivalReclassJobs } = await service
    .from("reclass_jobs")
    .select("id, status")
    .eq("client_link_id", job.client_link_id)
    .eq("status", "executing")
    .neq("id", id)
    .limit(1);
  if (rivalReclassJobs && rivalReclassJobs.length > 0) {
    return NextResponse.json(
      {
        error:
          `Another reclass job is already executing for this client ` +
          `(job ${rivalReclassJobs[0].id}). Wait for it to finish or cancel it before re-executing this one.`,
        rival_job_id: rivalReclassJobs[0].id,
      },
      { status: 409 }
    );
  }

  // Mark as executing
  await service
    .from("reclass_jobs")
    .update({
      status: "executing",
      execution_started_at: new Date().toISOString(),
    } as any)
    .eq("id", id);

  // Schedule background execution
  after(async () => {
    try {
      await executeReclass(id);
    } catch (err: any) {
      console.error(`Reclass execution failed for ${id}:`, err);
      const svc = createServiceSupabase();
      await svc
        .from("reclass_jobs")
        .update({
          status: "failed",
          error_message: err.message,
          execution_completed_at: new Date().toISOString(),
        } as any)
        .eq("id", id);

      await svc.from("audit_log").insert({
        event_type: "reclass_job_failed",
        user_id: user.id,
        request_payload: { reclass_job_id: id, error: err.message } as any,
      });
    }
  });

  return NextResponse.json({ started: true, job_id: id });
}

// ============== BACKGROUND EXECUTION ==============

async function executeReclass(jobId: string) {
  const service = createServiceSupabase();
  const startTime = Date.now();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("*, client_links(*), users:bookkeeper_id(full_name)")
    .eq("id", jobId)
    .single();
  if (!job) throw new Error("Job not found");
  const clientLink = (job as any).client_links;
  const bookkeeperName = (job as any).users?.full_name || "Ironbooks";

  // Audit start
  await service.from("audit_log").insert({
    event_type: "reclass_job_start",
    user_id: job.bookkeeper_id,
    request_payload: {
      reclass_job_id: jobId,
      workflow: job.workflow,
      source: job.source_account_name,
      target: job.target_account_name,
      reason: job.reason,
    } as any,
  });

  const accessToken = await getValidToken(clientLink.id, service as any);

  // Fetch live QBO accounts once to resolve name-only overrides.
  // When the bookkeeper picks from the master COA dropdown we store only the
  // account name (no QBO ID). This map lets us resolve the ID at execute time.
  const allQboAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
  const accountNameToId = new Map<string, string>(
    allQboAccounts
      .filter((a) => a.Active !== false)
      .map((a) => [a.Name.toLowerCase(), a.Id])
  );

  // Fetch rows to process: approved/auto_approve that haven't executed yet.
  // Filtering out already-executed rows means this route is safe to call again
  // after a partial run without re-touching QBO for completed lines.
  const { data: rows } = await service
    .from("reclassifications")
    .select("*")
    .eq("reclass_job_id", jobId)
    .in("decision", ["auto_approve", "approved"])
    .neq("status", "executed");

  if (!rows || rows.length === 0) {
    // Distinguish "discovery found nothing" from "everything is rejected/needs-review".
    // The former is almost always a "For Review" queue issue (bank-fed items haven't
    // been Added in QBO yet); the latter is a bookkeeper-driven outcome they understand.
    const txPulled = (job as any).transactions_pulled ?? 0;
    let message: string;
    if (txPulled === 0) {
      message =
        `QBO returned 0 reclass-eligible transactions for this date range. ` +
        `This usually means bank-fed items are sitting in QBO's "Banking → For Review" tab ` +
        `and haven't been Added yet — the QBO API can't see those. ` +
        `Fix: in QBO, go to Banking → For Review, select all, and bulk-categorize to ` +
        `"Ask My Accountant". Then come back and re-run reclass.`;
    } else {
      message =
        `${txPulled} transaction${txPulled === 1 ? "" : "s"} were pulled, but none are ` +
        `approved for execution. Either approve more on the review page or skip this step.`;
    }
    await service
      .from("reclass_jobs")
      .update({
        status: "complete",
        execution_completed_at: new Date().toISOString(),
        execution_duration_seconds: 0,
        transactions_moved: 0,
        error_message: message,
      } as any)
      .eq("id", jobId);
    return;
  }

  // Group rows by (transaction_id, transaction_type) so we update each tx once
  // even if multiple lines on it get reclassified
  const txMap = new Map<
    string,
    {
      tx_type: SupportedTxType;
      tx_id: string;
      lines: Array<{
        line_id: string;
        new_account_id: string;
        new_account_name: string;
        reclass_row_id: string;
      }>;
    }
  >();

  let failed = 0;
  let needsTarget = 0;
  const errors: string[] = [];

  for (const row of rows) {
    // Resolve target: prefer explicit ID, then try resolving the stored name
    // against live QBO accounts (bookkeeper picked from master COA by name).
    const overrideName = row.bookkeeper_override_target_name || null;
    const overrideId = row.bookkeeper_override_target_id || null;
    let targetId: string | null = overrideId || row.to_account_id || null;
    let targetNameResolved: string | null = overrideName || row.to_account_name || null;

    if (!targetId && targetNameResolved) {
      const resolvedId = accountNameToId.get(targetNameResolved.toLowerCase());
      if (resolvedId) targetId = resolvedId;
    }

    if (!targetId) {
      // Row was approved but has no destination account — no ID and name didn't
      // match any live QBO account. Demote back to needs_review so the bookkeeper
      // can assign a valid target before re-running.
      needsTarget++;
      await service
        .from("reclassifications")
        .update({
          decision: "needs_review",
          status: "pending",
          error_message: "Target account required — assign in the review screen and re-run.",
        } as any)
        .eq("id", row.id);
      continue;
    }

    const key = `${row.qbo_transaction_type}::${row.qbo_transaction_id}`;
    let entry = txMap.get(key);
    if (!entry) {
      entry = {
        tx_type: row.qbo_transaction_type as SupportedTxType,
        tx_id: row.qbo_transaction_id,
        lines: [],
      };
      txMap.set(key, entry);
    }
    entry.lines.push({
      line_id: row.line_id || "",
      new_account_id: targetId,
      new_account_name: targetNameResolved || "",
      reclass_row_id: row.id,
    });
  }

  const auditMemo = buildAuditMemo(bookkeeperName, job.reason);

  let moved = 0;

  // Execute each transaction update (sequential to respect QBO rate limits)
  const transactions = Array.from(txMap.values());
  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];

    // Progress event every 10 txs
    if (i % 10 === 0) {
      await service.from("audit_log").insert({
        event_type: "reclass_progress",
        user_id: job.bookkeeper_id,
        request_payload: {
          reclass_job_id: jobId,
          message: `Processing ${i + 1} of ${transactions.length} transactions`,
          stage: "execute",
          total: transactions.length,
          completed: i,
        } as any,
      });
    }

    try {
      const updated = await reclassifyTransactionLines(
        clientLink.qbo_realm_id,
        accessToken,
        {
          txType: t.tx_type,
          txId: t.tx_id,
          lineUpdates: t.lines,
          auditMemo,
        }
      );

      // Mark all reclass rows for this tx as executed
      for (const line of t.lines) {
        await service
          .from("reclassifications")
          .update({
            status: "executed",
            executed_at: new Date().toISOString(),
          } as any)
          .eq("id", line.reclass_row_id);
        moved++;
      }
    } catch (err: any) {
      failed += t.lines.length;
      errors.push(`${t.tx_type}/${t.tx_id}: ${err.message}`);

      for (const line of t.lines) {
        await service
          .from("reclassifications")
          .update({
            status: "failed",
            error_message: err.message,
          } as any)
          .eq("id", line.reclass_row_id);
      }
    }
  }

  const durationSec = Math.floor((Date.now() - startTime) / 1000);

  // Sync to Double (best-effort)
  let doubleTaskId: string | null = null;
  try {
    const task = await postReclassComplete(clientLink.double_client_id, {
      sourceAccount: job.source_account_name,
      targetAccount: job.target_account_name || undefined,
      transactionsMoved: moved,
      transactionsSkipped:
        (job.transactions_skipped_reconciled || 0) +
        (job.transactions_skipped_closed || 0),
      bookkeeperName,
      reason: job.reason,
      dateRangeStart: job.date_range_start,
      dateRangeEnd: job.date_range_end,
    });
    if (task) doubleTaskId = String(task.id);
  } catch (err: any) {
    console.warn(`Double sync failed (non-fatal):`, err.message);
    errors.push(`Double sync: ${err.message}`);
  }

  // Surface the needs-target count separately so the bookkeeper sees
  // "X rows still need a target account" instead of it looking like a failure.
  const summaryErrors = [...errors];
  if (needsTarget > 0) {
    summaryErrors.unshift(
      `${needsTarget} transaction${needsTarget === 1 ? "" : "s"} sent back to Needs Review — target account not selected before approval.`
    );
  }

  // Finalize
  await service
    .from("reclass_jobs")
    .update({
      status: failed === 0 ? "complete" : "complete", // even with some failures, mark complete - errors recorded per-row
      execution_completed_at: new Date().toISOString(),
      execution_duration_seconds: durationSec,
      transactions_moved: moved,
      transactions_failed: failed,
      double_task_id: doubleTaskId,
      error_message: summaryErrors.length > 0 ? summaryErrors.slice(0, 10).join("; ") : null,
    } as any)
    .eq("id", jobId);

  await service.from("audit_log").insert({
    event_type: "reclass_job_complete",
    user_id: job.bookkeeper_id,
    request_payload: {
      reclass_job_id: jobId,
      message: `Reclassification complete: ${moved} moved, ${failed} failed`,
      moved,
      failed,
      duration_seconds: durationSec,
    } as any,
  });
}

export const maxDuration = 300;
