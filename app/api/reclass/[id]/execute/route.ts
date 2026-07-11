import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { after } from "next/server";
import {
  reclassifyTransactionLines,
  buildAuditMemo,
  describeReclassError,
  getValidToken,
  type SupportedTxType,
} from "@/lib/qbo-reclass";
import { fetchAllAccounts, createAccount } from "@/lib/qbo";
import { normalizeAccountName } from "@/lib/account-name";
import { postReclassComplete } from "@/lib/double";
import { sendAskClientQuestions } from "@/lib/reclass-ask-client";

/**
 * POST /api/reclass/[id]/execute
 *
 * Validates attestation. Kicks off background execution.
 * Returns immediately.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  // Captured now so the background job can build portal links after the
  // request object is gone.
  const portalOrigin = new URL(request.url).origin;
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
  // A job paused between batches sits in status='executing' with
  // execution_resumable=true, waiting for the open job page to kick the next
  // pass. Distinguish that from a genuinely-mid-batch run (resumable=false).
  const isResumableContinue =
    job.status === "executing" && (job as any).execution_resumable === true;
  if (job.status === "executing" && !isResumableContinue) {
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

  if (isResumableContinue) {
    // Atomically claim the next pass — guards against two overlapping poll
    // triggers both kicking a batch. Only the update that flips resumable
    // false→started wins; a loser sees 0 rows and no-ops.
    const { data: claimed } = await (service as any)
      .from("reclass_jobs")
      .update({ execution_resumable: false, execution_started_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "executing")
      .eq("execution_resumable", true)
      .select("id");
    if (!claimed || claimed.length === 0) {
      return NextResponse.json({ message: "Continuation already running", started: false });
    }
  } else {
    // Fresh run.
    await service
      .from("reclass_jobs")
      .update({
        status: "executing",
        execution_started_at: new Date().toISOString(),
        execution_resumable: false,
      } as any)
      .eq("id", id);
  }

  // Schedule background execution
  after(async () => {
    try {
      await executeReclass(id, portalOrigin, isResumableContinue);
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

async function executeReclass(jobId: string, portalOrigin: string, isContinuation = false) {
  const service = createServiceSupabase();
  const startTime = Date.now();
  // Leave headroom under maxDuration (300s): pause cleanly before the platform
  // kills the background task, so a big job resumes instead of dying mid-loop.
  const BUDGET_MS = 230_000;

  const { data: job } = await service
    .from("reclass_jobs")
    .select("*, client_links(*), users:bookkeeper_id(full_name)")
    .eq("id", jobId)
    .single();
  if (!job) throw new Error("Job not found");
  const clientLink = (job as any).client_links;
  const bookkeeperName = (job as any).users?.full_name || "Ironbooks";

  // Counts accumulate across resumable passes — start from what's persisted.
  const priorMoved = (job as any).transactions_moved || 0;
  const priorFailed = (job as any).transactions_failed || 0;

  // One-time work (start audit + ask-client) runs only on the first pass.
  let askClientWarning: string | null = null;
  if (!isContinuation) {
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

    // Ask-client batch: every row the bookkeeper routed to "Ask Client"
    // becomes ONE portal message + ONE email to the client (never one per
    // transaction). Best-effort and idempotent — a re-execute won't resend.
    try {
      const ask = await sendAskClientQuestions(service, {
        reclassJobId: jobId,
        portalOrigin,
      });
      if (ask.sent && ask.emailDelivery && !ask.emailDelivery.sent) {
        askClientWarning =
          `Asked the client about ${ask.count} transaction${ask.count === 1 ? "" : "s"} in their portal, ` +
          `but the email could NOT be delivered (${ask.emailDelivery.reason.replace(/_/g, " ")}) — ` +
          `they won't see the questions until they log in. Follow up directly.`;
      }
    } catch (err: any) {
      console.error(`[reclass] ask-client send failed (non-fatal):`, err?.message);
      askClientWarning = `Ask-client questions could not be sent automatically: ${err?.message}`;
    }
  }

  const accessToken = await getValidToken(clientLink.id, service as any);

  // Fetch live QBO accounts once to resolve name-only overrides.
  // When the bookkeeper picks from the master COA dropdown we store only the
  // account name (no QBO ID). This map lets us resolve the ID at execute time.
  const allQboAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
  const accountNameToId = new Map<string, string>(
    allQboAccounts
      .filter((a) => a.Active !== false)
      .map((a) => [normalizeAccountName(a.Name), a.Id])
  );
  // Active-account allow-list. We NEVER post a categorization to an inactive
  // ("(deleted)") account — that's exactly what leaves "… (deleted)" rows with
  // balances on the P&L. Any row whose target resolves to an inactive account
  // is demoted to needs_review instead of being written to QBO.
  const activeAccountIds = new Set(
    allQboAccounts.filter((a) => a.Active !== false).map((a) => a.Id)
  );

  // Master COA rows for create-on-demand: when a bookkeeper picked a master
  // account by name (e.g. "Owner's Draw" — Equity, a balance-sheet target)
  // and the client's QBO doesn't have it yet, we create it with the master's
  // type/subtype instead of demoting the row. This is what makes non-P&L
  // targets (draws/contributions) actually executable everywhere.
  const { data: masterRows } = await service
    .from("master_coa")
    .select("account_name, qbo_account_type, qbo_account_subtype, is_parent")
    .eq("industry", ((clientLink as any).industry as string) || "painters")
    .eq("jurisdiction", clientLink.jurisdiction || "US");
  const masterByName = new Map(
    (masterRows || [])
      .filter((m: any) => !m.is_parent)
      .map((m: any) => [normalizeAccountName(m.account_name), m])
  );

  // Fetch rows to process: approved/auto_approve that haven't executed yet.
  // Filtering out already-executed rows means this route is safe to call again
  // after a partial run without re-touching QBO for completed lines.
  const { data: rows } = await service
    .from("reclassifications")
    .select("*")
    .eq("reclass_job_id", jobId)
    .in("decision", ["auto_approve", "approved"])
    .not("status", "in", "(executed,failed)");

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
    // On a continuation pass the queue is simply drained — finalize cleanly
    // and keep the counts accumulated across passes (don't reset to 0 or
    // re-show the "nothing approved" message).
    const carried = isContinuation ? ((job as any).warnings || []) : (askClientWarning ? [askClientWarning] : []);
    await service
      .from("reclass_jobs")
      .update({
        status: "complete",
        execution_completed_at: new Date().toISOString(),
        execution_duration_seconds: 0,
        transactions_moved: priorMoved,
        execution_resumable: false,
        error_message: isContinuation
          ? (carried.length ? carried.join("; ") : null)
          : (askClientWarning ? `${askClientWarning}; ${message}` : message),
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
      const resolvedId = accountNameToId.get(normalizeAccountName(targetNameResolved));
      if (resolvedId) targetId = resolvedId;
    }

    // Name didn't resolve but it IS a master account → create it in the
    // client's QBO with the master's type/subtype (works for Equity and
    // other balance-sheet targets, e.g. Owner's Draw / Owner Contributions).
    if (!targetId && targetNameResolved) {
      const master = masterByName.get(normalizeAccountName(targetNameResolved));
      if (master) {
        try {
          const created = await createAccount(clientLink.qbo_realm_id, accessToken, {
            name: master.account_name,
            accountType: master.qbo_account_type,
            accountSubType: master.qbo_account_subtype || undefined,
          });
          targetId = created.Id;
          targetNameResolved = created.Name;
          accountNameToId.set(normalizeAccountName(created.Name), created.Id);
          activeAccountIds.add(created.Id);
          console.log(
            `[reclass execute] created missing master account "${created.Name}" (${master.qbo_account_type}) as ${created.Id}`
          );
        } catch (createErr: any) {
          console.warn(
            `[reclass execute] could not create master account "${targetNameResolved}": ${createErr.message}`
          );
        }
      }
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

    // GUARD: never post to an inactive/deleted account. If the resolved target
    // isn't on the active allow-list, demote to needs_review so the bookkeeper
    // picks a live account — instead of silently re-animating a deleted one.
    if (!activeAccountIds.has(targetId)) {
      needsTarget++;
      await service
        .from("reclassifications")
        .update({
          decision: "needs_review",
          status: "pending",
          error_message: `Target account "${targetNameResolved || targetId}" is inactive/deleted in QBO — pick an active account and re-run.`,
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
  let brokeEarly = false;
  for (let i = 0; i < transactions.length; i++) {
    // Time budget: pause before the platform kills the background task, so a
    // big job resumes on the next pass instead of dying mid-loop at 0 progress.
    if (i > 0 && Date.now() - startTime > BUDGET_MS) {
      brokeEarly = true;
      break;
    }
    const t = transactions[i];

    // Heartbeat every 10 txs: bump persisted counts + updated_at so the UI
    // shows live progress and the stale-job watchdog (which keys on a fresh
    // updated_at) never false-fails a run that's actively moving.
    if (i % 10 === 0 && i > 0) {
      await service
        .from("reclass_jobs")
        .update({
          transactions_moved: priorMoved + moved,
          transactions_failed: priorFailed + failed,
          updated_at: new Date().toISOString(),
        } as any)
        .eq("id", jobId);
    }

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
      const { blocked, message } = describeReclassError(err);
      errors.push(`${t.tx_type}/${t.tx_id}: ${blocked === "matched_download" ? "matched to a bank-feed download — unmatch in QBO first" : message}`);

      for (const line of t.lines) {
        await service
          .from("reclassifications")
          .update({
            status: "failed",
            error_message: blocked ? message : err.message,
          } as any)
          .eq("id", line.reclass_row_id);
      }
    }
  }

  const durationSec = Math.floor((Date.now() - startTime) / 1000);

  // Paused mid-queue (hit the time budget with rows still pending). Persist
  // progress, stay resumable, and let the open job page kick the next pass.
  // Skip Double sync + completion audit until the queue is actually drained.
  if (brokeEarly) {
    const carryWarnings = isContinuation
      ? ((job as any).warnings || [])
      : (askClientWarning ? [askClientWarning] : []);
    await service
      .from("reclass_jobs")
      .update({
        status: "executing",
        execution_resumable: true,
        transactions_moved: priorMoved + moved,
        transactions_failed: priorFailed + failed,
        warnings: carryWarnings,
        execution_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", jobId);
    await service.from("audit_log").insert({
      event_type: "reclass_progress",
      user_id: job.bookkeeper_id,
      request_payload: {
        reclass_job_id: jobId,
        message: `Posted ${priorMoved + moved} so far — continuing the next batch…`,
        stage: "execute",
      } as any,
    });
    return;
  }

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
  const totalMoved = priorMoved + moved;
  const totalFailed = priorFailed + failed;
  // Carry the ask-client warning forward from the first pass (persisted in
  // `warnings`) so a multi-pass job still surfaces it at completion.
  const summaryErrors = [...errors];
  if (askClientWarning) summaryErrors.unshift(askClientWarning);
  else if (isContinuation) summaryErrors.unshift(...((job as any).warnings || []));
  if (needsTarget > 0) {
    summaryErrors.unshift(
      `${needsTarget} transaction${needsTarget === 1 ? "" : "s"} sent back to Needs Review — target account not selected before approval.`
    );
  }

  // Finalize
  await service
    .from("reclass_jobs")
    .update({
      status: "complete", // even with some failures, mark complete - errors recorded per-row
      execution_completed_at: new Date().toISOString(),
      execution_duration_seconds: durationSec,
      transactions_moved: totalMoved,
      transactions_failed: totalFailed,
      execution_resumable: false,
      double_task_id: doubleTaskId,
      error_message: summaryErrors.length > 0 ? summaryErrors.slice(0, 10).join("; ") : null,
    } as any)
    .eq("id", jobId);

  await service.from("audit_log").insert({
    event_type: "reclass_job_complete",
    user_id: job.bookkeeper_id,
    request_payload: {
      reclass_job_id: jobId,
      message: `Reclassification complete: ${totalMoved} moved, ${totalFailed} failed`,
      moved: totalMoved,
      failed: totalFailed,
      duration_seconds: durationSec,
    } as any,
  });
}

export const maxDuration = 300;
