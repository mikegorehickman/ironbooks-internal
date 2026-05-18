/**
 * COA Cleanup Execution Engine — v2 (with live progress)
 *
 * Writes detailed progress to audit_log as it works.
 * Frontend polls /api/jobs/[id]/status which reads from audit_log.
 */

import { createServiceSupabase } from "./supabase";
import * as qbo from "./qbo";
import * as double from "./double";
import * as validate from "./qbo-validation";
import { generateManualRepairPlan, type FailureContext } from "./claude-repair";
import {
  fetchTransactionsForAccount,
  reclassifyTransactionLines,
  getCompanyClosingDate,
  isInClosedPeriod,
  findDoubleClose,
  isDoubleCloseLocked,
} from "./qbo-reclass";
import { getClientEndCloses, type DoubleEndCloseSummary } from "./double";

type SupabaseClient = ReturnType<typeof createServiceSupabase>;

interface ExecutionContext {
  jobId: string;
  clientLinkId: string;
  realmId: string;
  accessToken: string;
  doubleClientId: string;
  bookkeeperId: string;
  supabase: SupabaseClient;
  /** Date range that scopes merges + inactivation checks. The bookkeeper
   *  picks this at the new-job step. Renames and creates aren't gated by
   *  it. Legacy jobs created before Migration 17 default to 2000-01-01 →
   *  today to preserve old behavior. */
  dateRangeStart: string;
  dateRangeEnd: string;
}

interface ExecutionStats {
  created: number;
  renamed: number;
  merged: number;
  reclassified: number;
  inactivated: number;
  duration_seconds: number;
}

/**
 * One entry in the Manual Cleanup Report.
 *
 * Generated when COA cleanup hits a QBO platform limitation that the user
 * must resolve manually in QBO's UI (typically: account has transactions or
 * non-zero balance, system-protected accounts, name conflicts, etc).
 *
 * Persisted to coa_jobs.manual_cleanup_items as a JSONB array so it shows up
 * in history and on the client view after the cleanup completes.
 */
export interface ManualCleanupItem {
  account_id: string | null;
  account_name: string;
  intended_action: "rename" | "inactivate" | "create";
  reason: string;
  suggestion: string;
  qbo_response?: string;
}

/**
 * QBO returns code 2010 ("Request has invalid or unsupported property") for
 * many platform-level rejections — most commonly when trying to inactivate
 * an account that has historical transactions or a non-zero balance.
 *
 * The QBO web UI lets users force these changes after a warning popup; the
 * REST API does not. We detect these and route them to the Manual Cleanup
 * Report instead of treating them as errors.
 */
function isQboLimitationError(err: any): boolean {
  const msg = String(err?.message || err || "");
  return (
    msg.includes("\"code\":\"2010\"") ||
    msg.includes("Request has invalid or unsupported property") ||
    msg.includes("\"code\":\"2170\"") ||      // "Invalid Enumeration" — often hit on parent type conflicts
    // Business Validation Error (code 6000) when QBO refuses to inactivate
    // an account that's referenced by another entity (product/service,
    // shipping default, payroll account, sales tax, etc.). These are QBO
    // system protections — UI lets users force-resolve via the warning
    // popup, but the REST API has no equivalent path. Send to Manual
    // Cleanup Report so the bookkeeper handles them in QBO directly.
    (msg.includes("\"code\":\"6000\"") &&
      (msg.includes("cannot be deleted because") ||
       msg.includes("can't be deleted because") ||
       msg.includes("used by a product or service") ||
       msg.includes("default account") ||
       msg.includes("used by") ||
       msg.includes("is the default")))
  );
}

async function logProgress(
  ctx: ExecutionContext,
  eventType: string,
  message: string,
  payload: Record<string, unknown> = {}
) {
  await ctx.supabase.from("audit_log").insert({
    job_id: ctx.jobId,
    user_id: ctx.bookkeeperId,
    event_type: eventType,
    request_payload: { message, ...payload } as any,
    occurred_at: new Date().toISOString(),
  });
}

async function logActionResult(
  ctx: ExecutionContext,
  actionId: string | null,
  eventType: string,
  payload: unknown
) {
  await ctx.supabase.from("audit_log").insert({
    job_id: ctx.jobId,
    action_id: actionId,
    user_id: ctx.bookkeeperId,
    event_type: eventType,
    response_payload: payload as any,
    status_code: 200,
    occurred_at: new Date().toISOString(),
  });
}

async function markActionComplete(
  ctx: ExecutionContext,
  actionId: string,
  newQboId: string,
  response: unknown
) {
  await ctx.supabase
    .from("coa_actions")
    .update({
      executed: true,
      executed_at: new Date().toISOString(),
      new_qbo_account_id: newQboId,
      qbo_response: response as any,
    })
    .eq("id", actionId);
}

async function markActionFailed(ctx: ExecutionContext, actionId: string, errorMessage: string) {
  await ctx.supabase
    .from("coa_actions")
    .update({ executed: false, error_message: errorMessage })
    .eq("id", actionId);
}

/**
 * Convert a queued action into a `flag` so it surfaces in Lisa's review queue
 * without being attempted against QBO. Called by pre-flight validation when
 * we know an action would fail (system account, invalid enum, etc).
 */
async function flagAction(ctx: ExecutionContext, action: any, reason: string) {
  await ctx.supabase
    .from("coa_actions")
    .update({
      action: "flag",
      flagged_reason: reason,
      executed: false,
    })
    .eq("id", action.id);
  await logActionResult(ctx, action.id, "preflight_flagged", {
    name: action.current_name || action.new_name,
    reason,
  });
}

/**
 * Cooperative cancellation point. Returns true if the bookkeeper has hit
 * the cancel endpoint (job.status === 'cancelled'). The executor's stage
 * loops call this between actions; when it returns true the caller should
 * `return` immediately so no further QBO writes happen.
 *
 * Cheap DB call — fine to invoke once per action. The cost is far less
 * than even a single QBO API call we'd otherwise make.
 */
async function shouldCancel(ctx: ExecutionContext): Promise<boolean> {
  const { data } = await ctx.supabase
    .from("coa_jobs")
    .select("status")
    .eq("id", ctx.jobId)
    .single();
  return data?.status === "cancelled";
}

async function getBookkeeperName(ctx: ExecutionContext): Promise<string> {
  const { data } = await ctx.supabase
    .from("users")
    .select("full_name")
    .eq("id", ctx.bookkeeperId)
    .single();
  return data?.full_name || "Ironbooks";
}

export async function executeJob(jobId: string): Promise<{
  success: boolean;
  errors: string[];
  stats: ExecutionStats;
}> {
  const supabase = createServiceSupabase();
  const startTime = Date.now();
  const errors: string[] = [];
  // Manual cleanup report — items the user must handle in QBO UI manually.
  // Typically QBO platform limitations (account has transactions, system-protected, etc).
  // Different from `errors` which should ONLY contain unexpected failures.
  const manualCleanupItems: ManualCleanupItem[] = [];
  // Failures collected during execution that we'll send to Claude at the END
  // of the job to produce smart, plain-English manual cleanup line items.
  // Each entry has the exact request body + QBO error + account snapshot.
  const pendingFailures: FailureContext[] = [];
  const stats: ExecutionStats = {
    created: 0, renamed: 0, merged: 0, reclassified: 0, inactivated: 0, duration_seconds: 0,
  };

  const { data: job, error: jobErr } = await supabase
    .from("coa_jobs")
    .select("*, client_links(*)")
    .eq("id", jobId)
    .single();
  if (jobErr || !job) throw new Error(`Job ${jobId} not found`);

  const clientLink = (job as any).client_links;
  if (!clientLink) throw new Error("Client link not found");

  await supabase.from("coa_jobs").update({
    status: "executing",
    execution_started_at: new Date().toISOString(),
  }).eq("id", jobId);

  const accessToken = await qbo.getValidToken(clientLink.id, supabase as any);

  // STRICT date-range validation. The executor REFUSES to run if the job
  // doesn't have a bookkeeper-chosen scope. No silent fallback to all-time
  // — that's exactly the bug that caused Renaissance to rewrite years of
  // closed-period transactions. Allowed presets are the four from the
  // new-job form: cy, fy, cy_plus_1, fy_plus_1. Legacy backfilled jobs
  // (preset='legacy_all_time') must be re-scoped before they can run.
  const todayIso = new Date().toISOString().slice(0, 10);
  const ALLOWED_PRESETS = new Set(["cy", "fy", "cy_plus_1", "fy_plus_1"]);
  const rawStart: string | null = (job as any).date_range_start || null;
  const rawEnd: string | null = (job as any).date_range_end || null;
  const rawPreset: string | null = (job as any).date_range_preset || null;

  if (!rawStart || !rawEnd) {
    const reason =
      "Cleanup refused: this job has no date range. Open the job in the app, " +
      "pick a scope from the Cleanup Scope card (This Calendar Year, etc.), " +
      "and re-run.";
    await supabase
      .from("coa_jobs")
      .update({
        status: "failed",
        execution_completed_at: new Date().toISOString(),
        error_message: reason,
      } as any)
      .eq("id", jobId);
    throw new Error(reason);
  }

  if (rawPreset && !ALLOWED_PRESETS.has(rawPreset)) {
    const reason =
      `Cleanup refused: date_range_preset is "${rawPreset}" which isn't an ` +
      `allowed scope. Allowed: ${Array.from(ALLOWED_PRESETS).join(", ")}. ` +
      `Update the job's date range to one of the supported presets and re-run.`;
    await supabase
      .from("coa_jobs")
      .update({
        status: "failed",
        execution_completed_at: new Date().toISOString(),
        error_message: reason,
      } as any)
      .eq("id", jobId);
    throw new Error(reason);
  }

  // Defense in depth: even if preset slipped through somehow, refuse any
  // start date older than 3 years. A cleanup never legitimately needs more.
  const startMs = new Date(rawStart).getTime();
  const threeYearsAgo = Date.now() - 3 * 365 * 86_400_000;
  if (Number.isNaN(startMs) || startMs < threeYearsAgo) {
    const reason =
      `Cleanup refused: date_range_start is ${rawStart}, more than 3 years ` +
      `back. Touching that far into the past risks rewriting closed-period ` +
      `transactions. Pick a current scope (This Calendar Year, This Fiscal ` +
      `Year, or either + last) and re-run.`;
    await supabase
      .from("coa_jobs")
      .update({
        status: "failed",
        execution_completed_at: new Date().toISOString(),
        error_message: reason,
      } as any)
      .eq("id", jobId);
    throw new Error(reason);
  }

  const dateRangeStart = rawStart;
  const dateRangeEnd = rawEnd;
  void todayIso;

  const ctx: ExecutionContext = {
    jobId,
    clientLinkId: clientLink.id,
    realmId: clientLink.qbo_realm_id,
    accessToken,
    doubleClientId: clientLink.double_client_id,
    bookkeeperId: job.bookkeeper_id,
    supabase,
    dateRangeStart,
    dateRangeEnd,
  };

  await logProgress(
    ctx,
    "job_start",
    `Starting cleanup for ${clientLink.client_name} · scope: ${dateRangeStart} → ${dateRangeEnd}`,
    { date_range_start: dateRangeStart, date_range_end: dateRangeEnd }
  );

  const { data: actions } = await supabase
    .from("coa_actions").select("*").eq("job_id", jobId).order("sort_order");
  if (!actions) throw new Error("No actions found for job");

  try {
    // ============================================================
    // STAGE 0: Pre-flight validation
    // ============================================================
    // Before touching QBO, validate every action against known QBO rules.
    // Actions that are guaranteed to fail (system accounts, invalid enums,
    // rename-to-parent-name) get re-marked as `flag` with a reason, so they
    // surface in Lisa's review queue instead of polluting the error log.
    // Recoverable issues (wrong AccountType for known subtype) get auto-corrected.
    await logProgress(ctx, "stage_start", `Pre-flight validation of ${actions.length} actions`,
      { stage: "preflight", total: actions.length });

    // Fetch live QBO state once for name-collision checks.
    const liveAccounts = await qbo.fetchAllAccounts(ctx.realmId, ctx.accessToken);
    const liveById = new Map(liveAccounts.map((a) => [a.Id, a]));

    // Fetch transaction counts per account. Critical for Rule 5: QBO blocks
    // inactivation of accounts with any historical transactions, even if the
    // current balance is zero. CurrentBalance alone is not enough.
    const txCounts = await qbo.fetchTransactionCountsForAllAccounts(
      ctx.realmId, ctx.accessToken
    );

    let flaggedCount = 0;
    let correctedCount = 0;

    for (const a of actions as any[]) {
      // -- Rule 1: System accounts cannot be modified via API.
      // If the action targets a known QBO system account (Uncategorized, etc),
      // flag it. Never attempt to rename/inactivate these.
      if (a.action !== "create" && a.current_name && validate.isSystemAccount(a.current_name)) {
        await flagAction(ctx, a, `System-protected QBO account "${a.current_name}" cannot be modified via API. Skipping.`);
        flaggedCount++;
        continue;
      }

      // -- Rule 2: Type/Subtype enum validity (creates only — renames don't change type)
      if (a.action === "create") {
        const v = validate.validateTypeSubtype(a.new_type, a.new_subtype);
        if (!v.ok) {
          const reason = v.suggestion
            ? `${v.reason}. Did you mean "${v.suggestion}"? Set new_subtype manually and retry.`
            : `${v.reason}. Account cannot be created.`;
          await flagAction(ctx, a, reason);
          flaggedCount++;
          continue;
        }
        if (v.correctedType && v.correctedType !== a.new_type) {
          // Auto-correct the AccountType to match the subtype's required type
          await ctx.supabase.from("coa_actions")
            .update({ new_type: v.correctedType })
            .eq("id", a.id);
          a.new_type = v.correctedType;
          correctedCount++;
          await logActionResult(ctx, a.id, "preflight_corrected", {
            field: "new_type",
            value: v.correctedType,
            reason: `Auto-corrected to match subtype "${a.new_subtype}"`,
          });
        }
      }

      // -- Rule 3: Rename target equals current parent's name (merge, not rename)
      if (a.action === "rename" && a.qbo_account_id && a.new_name) {
        const current = liveById.get(a.qbo_account_id);
        if (current?.SubAccount && current.ParentRef?.value) {
          const parent = liveById.get(current.ParentRef.value);
          if (parent && parent.Name.trim().toLowerCase() === a.new_name.trim().toLowerCase()) {
            await flagAction(ctx, a,
              `Rename target "${a.new_name}" equals the parent account's name. This looks like a merge, not a rename. Review manually.`
            );
            flaggedCount++;
            continue;
          }
        }
      }

      // -- Rule 4: Rename would cause a name collision
      // Merge actions intentionally target an existing name (or one about to be created
      // by the preceding rename), so we skip collision checks for them.
      if (a.action === "rename" && a.qbo_account_id && a.new_name) {
        const current = liveById.get(a.qbo_account_id);
        const parentId = current?.ParentRef?.value || null;
        if (validate.wouldCollide(a.new_name, liveAccounts, a.qbo_account_id, parentId)) {
          await flagAction(ctx, a,
            `Rename target "${a.new_name}" already exists in QBO at the same parent level. Pick a different name or use merge.`
          );
          flaggedCount++;
          continue;
        }
      }

      // -- Rule 5: Inactivate of an account with transaction history or non-zero balance.
      // QBO blocks API inactivation of accounts that:
      //   (a) have a non-zero current balance, OR
      //   (b) have any historical transactions (even if balance now nets to zero), OR
      //   (c) have active sub-accounts
      // The web UI lets users force-deactivate these with a warning popup; the API
      // does not. Detect proactively and flag — Lisa handles these manually in QBO.
      if (a.action === "delete" && a.qbo_account_id) {
        const current: any = liveById.get(a.qbo_account_id);
        if (current) {
          const balance = Number(current.CurrentBalance ?? 0);
          const balanceWithSubs = Number(current.CurrentBalanceWithSubAccounts ?? 0);
          let txCount = txCounts.get(a.qbo_account_id) ?? 0;

          // FALLBACK: If bulk tx count is 0 but the account might still have
          // transactions (TransactionList report has known reliability issues
          // on some sandbox/edge accounts), verify with a direct per-account
          // query before letting the delete through.
          // This is slower (1 extra API call per delete candidate) but is the
          // only 100% reliable way to catch the "has transactions" case.
          let hasTxFromDirectCheck = false;
          if (txCount === 0 && balance === 0 && balanceWithSubs === 0) {
            try {
              hasTxFromDirectCheck = await qbo.accountHasTransactions(
                ctx.realmId, ctx.accessToken, a.qbo_account_id
              );
            } catch {
              // ignore — proceed with txCount we already have
            }
          }

          // Active sub-accounts check
          const hasActiveChildren = liveAccounts.some(
            (other: any) =>
              other.ParentRef?.value === a.qbo_account_id &&
              other.Active !== false
          );

          if (
            balance !== 0 ||
            balanceWithSubs !== 0 ||
            txCount > 0 ||
            hasTxFromDirectCheck ||
            hasActiveChildren
          ) {
            const reasons: string[] = [];
            if (balance !== 0) reasons.push(`current balance ${balance.toFixed(2)}`);
            if (balanceWithSubs !== 0 && balanceWithSubs !== balance) {
              reasons.push(`balance-with-subs ${balanceWithSubs.toFixed(2)}`);
            }
            if (txCount > 0) reasons.push(`${txCount} historical transactions`);
            else if (hasTxFromDirectCheck) reasons.push(`has historical transactions (verified directly)`);
            if (hasActiveChildren) reasons.push(`active sub-accounts`);

            await flagAction(ctx, a,
              `Cannot inactivate "${current.Name}" via API: ${reasons.join(", ")}. QBO requires manual handling for accounts with activity — please reclassify transactions and zero the balance, then inactivate via QBO UI.`
            );
            flaggedCount++;
            continue;
          }
        }
      }
    }

    await logProgress(ctx, "stage_complete",
      `Pre-flight done. ${flaggedCount} flagged, ${correctedCount} auto-corrected.`,
      { stage: "preflight", flagged: flaggedCount, corrected: correctedCount });

    // Re-fetch actions so subsequent stages skip the just-flagged ones
    const { data: validatedActions } = await ctx.supabase
      .from("coa_actions").select("*").eq("job_id", jobId).order("sort_order");
    const liveActions = (validatedActions || actions) as any[];

    // STAGE 1: Create parents
    const parentCreations = liveActions.filter((a) => a.action === "create" && !a.new_parent_name);
    const parentIdMap = new Map<string, string>();

    if (parentCreations.length > 0) {
      await logProgress(ctx, "stage_start", `Creating ${parentCreations.length} parent accounts`,
        { stage: "create_parents", total: parentCreations.length });

      for (const action of parentCreations) {
        if (await shouldCancel(ctx)) {
          await logProgress(ctx, "cancellation_acknowledged", "Cancelled mid-run — exiting create-parents stage cleanly");
          return { success: false, errors, stats };
        }
        try {
          const created = await qbo.createAccount(ctx.realmId, ctx.accessToken, {
            name: action.new_name!,
            accountType: action.new_type!,
            accountSubType: action.new_subtype!,
          });
          parentIdMap.set(action.new_name!, created.Id);
          await markActionComplete(ctx, action.id, created.Id, created);
          await logActionResult(ctx, action.id, "qbo_create_parent",
            { name: created.Name, id: created.Id });
          stats.created++;
        } catch (e: any) {
          errors.push(`Create parent "${action.new_name}" failed: ${e.message}`);
          await markActionFailed(ctx, action.id, e.message);
          await logProgress(ctx, "error", `Failed: ${action.new_name}`, { error: e.message });
        }
      }
      await logProgress(ctx, "stage_complete", `Parents created: ${stats.created}`, { stage: "create_parents" });
    }

    // STAGE 1.5: Auto-create any missing parent accounts referenced by child creations.
    // Claude's analysis sometimes assumes parents like "Vehicle Expenses" exist when they don't.
    // We look up the parent's QBO type from the master COA and create it on the fly.
    const childCreations = liveActions.filter((a) => a.action === "create" && a.new_parent_name);
    if (childCreations.length > 0) {
      const allAccountsCache = await qbo.fetchAllAccounts(ctx.realmId, ctx.accessToken);
      const existingNames = new Set(allAccountsCache.map((a) => a.Name));

      // Distinct parent names referenced by children that aren't already known
      const neededParents = Array.from(
        new Set(
          childCreations
            .map((a) => a.new_parent_name!)
            .filter((p) => !parentIdMap.has(p) && !existingNames.has(p))
        )
      );

      if (neededParents.length > 0) {
        await logProgress(ctx, "stage_start", `Auto-creating ${neededParents.length} missing parent accounts`,
          { stage: "create_missing_parents", total: neededParents.length });

        // Fetch master COA rows for these parent names to get correct types/subtypes
        const { data: masterMatches } = await ctx.supabase
          .from("master_coa")
          .select("account_name, qbo_account_type, qbo_account_subtype, is_parent")
          .in("account_name", neededParents);

        const masterByName = new Map<string, any>(
          (masterMatches || []).map((m) => [m.account_name, m])
        );

        for (const parentName of neededParents) {
          try {
            const master = masterByName.get(parentName);
            // Fall back to "Expense / OtherMiscellaneousExpense" if not found in master
            // (rare — usually means Claude invented a parent name not in master COA)
            const accountType = master?.qbo_account_type || "Expense";
            const accountSubType = master?.qbo_account_subtype || "OtherMiscellaneousExpense";

            const created = await qbo.createAccount(ctx.realmId, ctx.accessToken, {
              name: parentName,
              accountType,
              accountSubType,
            });
            parentIdMap.set(parentName, created.Id);
            await logActionResult(ctx, null, "qbo_create_missing_parent",
              { name: parentName, id: created.Id, type: accountType, subtype: accountSubType });
            stats.created++;
          } catch (e: any) {
            // Don't push to `errors`. Send to Claude at end-of-job for a manual repair plan.
            pendingFailures.push({
              intended_action: "create",
              account_id: null,
              account_name: parentName,
              request_body: { Name: parentName, AccountType: accountType, AccountSubType: accountSubType },
              qbo_error: String(e?.message || e),
              account_snapshot: null,
            });
            await logProgress(ctx, "warning",
              `Parent "${parentName}" routed to manual cleanup`,
              { reason: "QBO rejected parent create; sending to AI for repair plan" });
          }
        }
        await logProgress(ctx, "stage_complete", `Missing parents created`, { stage: "create_missing_parents" });
      }
    }

    // STAGE 2: Create children
    if (childCreations.length > 0) {
      await logProgress(ctx, "stage_start", `Creating ${childCreations.length} sub-accounts`,
        { stage: "create_children", total: childCreations.length });

      for (const action of childCreations) {
        if (await shouldCancel(ctx)) {
          await logProgress(ctx, "cancellation_acknowledged", "Cancelled mid-run — exiting create-children stage cleanly");
          return { success: false, errors, stats };
        }
        try {
          let parentId = parentIdMap.get(action.new_parent_name!);
          if (!parentId) {
            const allAccounts = await qbo.fetchAllAccounts(ctx.realmId, ctx.accessToken);
            const existingParent = allAccounts.find((a) => a.Name === action.new_parent_name);
            if (!existingParent) throw new Error(`Parent "${action.new_parent_name}" not found`);
            parentId = existingParent.Id;
            parentIdMap.set(action.new_parent_name!, parentId);
          }

          // Defensive: QBO requires BOTH AccountType and AccountSubType.
          // If Claude's analysis didn't fill in subtype, fall back to master_coa.
          let accountType = action.new_type;
          let accountSubType = action.new_subtype;
          if (!accountType || !accountSubType) {
            const { data: master } = await ctx.supabase
              .from("master_coa")
              .select("qbo_account_type, qbo_account_subtype")
              .eq("account_name", action.new_name!)
              .maybeSingle();
            if (master) {
              accountType = accountType || master.qbo_account_type;
              accountSubType = accountSubType || master.qbo_account_subtype;
            }
          }
          if (!accountType || !accountSubType) {
            throw new Error(
              `Missing AccountType/AccountSubType for "${action.new_name}" and not found in master COA — skipping.`
            );
          }

          const created = await qbo.createAccount(ctx.realmId, ctx.accessToken, {
            name: action.new_name!,
            accountType,
            accountSubType,
            parentRefId: parentId,
            taxCodeRef: action.tax_code_ref || undefined,
          });

          await markActionComplete(ctx, action.id, created.Id, created);
          await logActionResult(ctx, action.id, "qbo_create_child",
            { name: created.Name, parent: action.new_parent_name, id: created.Id });
          stats.created++;
        } catch (e: any) {
          // Don't push to `errors`. Collect for Claude to write a manual cleanup item.
          pendingFailures.push({
            intended_action: "create",
            account_id: null,
            account_name: action.new_name || "Unknown",
            request_body: {
              Name: action.new_name,
              AccountType: action.new_type,
              AccountSubType: action.new_subtype,
              ParentRef: action.new_parent_name ? { value: "?", name: action.new_parent_name } : undefined,
            },
            qbo_error: String(e?.message || e),
            account_snapshot: null,
          });
          await ctx.supabase
            .from("coa_actions")
            .update({
              executed: false,
              error_message: null,
              flagged_reason: "Manual cleanup required: see Manual Cleanup Report.",
            })
            .eq("id", action.id);
          await logActionResult(ctx, action.id, "manual_cleanup_required",
            { name: action.new_name, reason: "QBO rejected create — sent to AI for repair plan" });
        }
      }
      await logProgress(ctx, "stage_complete", `Children created`, { stage: "create_children" });
    }

    // STAGE 3: Rename
    const renames = liveActions.filter((a) => a.action === "rename");

    if (renames.length > 0) {
      await logProgress(ctx, "stage_start", `Renaming ${renames.length} accounts`,
        { stage: "rename", total: renames.length });

      const allAccounts = await qbo.fetchAllAccounts(ctx.realmId, ctx.accessToken);
      const accountMap = new Map(allAccounts.map((a) => [a.Id, a]));

      for (const action of renames) {
        if (await shouldCancel(ctx)) {
          await logProgress(ctx, "cancellation_acknowledged", "Cancelled mid-run — exiting rename stage cleanly");
          return { success: false, errors, stats };
        }
        try {
          const current = accountMap.get(action.qbo_account_id!);
          if (!current) throw new Error("Account no longer exists in QBO");

          // Only send AccountSubType if it actually matches the existing AccountType
          // (otherwise QBO returns 2010 "invalid property"). The rename action should
          // primarily change the Name. Subtype changes are risky and we skip them.
          const renamed = await qbo.renameAccount(
            ctx.realmId, ctx.accessToken,
            action.qbo_account_id!, (current as any).SyncToken,
            action.new_name!,
            {
              // Pass the current account so renameAccount preserves SubAccount/ParentRef/AccountType.
              // Without this, QBO 2010s on sub-account renames.
              currentAccount: current as any,
              taxCodeRef: action.tax_code_ref || undefined,
            }
          );

          await markActionComplete(ctx, action.id, renamed.Id, renamed);
          await logActionResult(ctx, action.id, "qbo_rename",
            { from: action.current_name, to: renamed.Name });
          stats.renamed++;
        } catch (e: any) {
          if (isQboLimitationError(e)) {
            // Collect for Claude to write a manual cleanup item with rich context
            const currentSnapshot = accountMap.get(action.qbo_account_id!) as any;
            pendingFailures.push({
              intended_action: "rename",
              account_id: action.qbo_account_id ?? null,
              account_name: action.current_name || "Unknown account",
              request_body: {
                Id: action.qbo_account_id,
                Name: action.new_name,
                AccountType: currentSnapshot?.AccountType,
                AccountSubType: currentSnapshot?.AccountSubType,
                SubAccount: currentSnapshot?.SubAccount,
                ParentRef: currentSnapshot?.ParentRef,
              },
              qbo_error: String(e?.message || e),
              account_snapshot: currentSnapshot ? {
                Name: currentSnapshot.Name,
                AccountType: currentSnapshot.AccountType,
                AccountSubType: currentSnapshot.AccountSubType,
                SubAccount: currentSnapshot.SubAccount,
                ParentRef: currentSnapshot.ParentRef,
                CurrentBalance: currentSnapshot.CurrentBalance,
                Active: currentSnapshot.Active,
              } : null,
            });
            await ctx.supabase
              .from("coa_actions")
              .update({
                executed: false,
                error_message: null,
                flagged_reason: "Manual cleanup required: see Manual Cleanup Report.",
              })
              .eq("id", action.id);
            await logActionResult(ctx, action.id, "manual_cleanup_required", {
              name: action.current_name,
              reason: "QBO rejected rename — sent to AI for repair plan",
            });
          } else {
            errors.push(`Rename "${action.current_name}" failed: ${e.message}`);
            await markActionFailed(ctx, action.id, e.message);
            await logProgress(ctx, "error", `Failed: ${action.current_name}`, { error: e.message });
          }
        }
      }
      await logProgress(ctx, "stage_complete", `Renames complete`, { stage: "rename" });
    }

    // STAGE 3.5: Merge
    // For each merge action: move all transactions from the source account to the
    // target account (which was just renamed into existence in Stage 3), then
    // inactivate the source. Uses the same line-level reclassification engine as
    // the Reclass module.
    const merges = liveActions.filter((a) => a.action === "merge");

    if (merges.length > 0) {
      await logProgress(ctx, "stage_start", `Merging ${merges.length} accounts`,
        { stage: "merge", total: merges.length });

      // Pull the closed-period markers ONCE for the whole merge stage. Any
      // merge whose source has even a single line inside a closed period
      // gets routed to manual cleanup — never auto-rewrite closed-period
      // transactions. Bookkeeper handles those in QBO with the closing-date
      // password if they really want to override.
      const bookCloseDate = await getCompanyClosingDate(ctx.realmId, ctx.accessToken);
      let doubleCloses: DoubleEndCloseSummary[] = [];
      if (clientLink.double_client_id && !String(clientLink.double_client_id).startsWith("pending_")) {
        try {
          const dcId = parseInt(clientLink.double_client_id, 10);
          if (!Number.isNaN(dcId)) {
            doubleCloses = await getClientEndCloses(dcId);
          }
        } catch (err: any) {
          console.warn("[executor] Could not fetch Double end-closes:", err.message);
        }
      }
      if (bookCloseDate || doubleCloses.length > 0) {
        await logProgress(
          ctx,
          "merge_period_guard",
          `Closed-period guard active · QBO closes on ${bookCloseDate || "(none)"} · Double tracks ${doubleCloses.length} closed months`,
          { qbo_close_date: bookCloseDate, double_closed_months: doubleCloses.length }
        );
      }

      // Re-fetch live accounts after Stage 3 so we have fresh QBO IDs for renamed targets.
      const postRenameAccounts = await qbo.fetchAllAccounts(ctx.realmId, ctx.accessToken);
      const postRenameByName = new Map(
        postRenameAccounts.map((a) => [a.Name.trim().toLowerCase(), a])
      );
      const postRenameById = new Map(postRenameAccounts.map((a) => [a.Id, a]));

      for (const action of merges) {
        if (await shouldCancel(ctx)) {
          await logProgress(ctx, "cancellation_acknowledged", "Cancelled mid-run — exiting merge stage cleanly");
          return { success: false, errors, stats };
        }
        if (!action.new_name || !action.qbo_account_id) {
          await flagAction(ctx, action, "Merge has no target account name — skipping.");
          continue;
        }

        // Resolve the target account's QBO ID by name (case-insensitive)
        const targetAccount = postRenameByName.get(action.new_name.trim().toLowerCase());
        if (!targetAccount) {
          pendingFailures.push({
            intended_action: "rename",
            account_id: action.qbo_account_id,
            account_name: action.current_name || "Unknown",
            request_body: { merge_target: action.new_name },
            qbo_error: `Target account "${action.new_name}" not found in QBO after rename stage`,
            account_snapshot: null,
          });
          await logActionResult(ctx, action.id, "manual_cleanup_required", {
            name: action.current_name,
            reason: `Merge target "${action.new_name}" not found — may need to be created manually`,
          });
          continue;
        }

        const sourceAccount = postRenameById.get(action.qbo_account_id) as any;
        if (!sourceAccount) {
          await flagAction(ctx, action, "Source account no longer exists in QBO.");
          continue;
        }

        try {
          // Fetch transactions that reference the source account, scoped to
          // the job's date range. Older transactions stay put — the source
          // account remains active until the bookkeeper does an "all-time"
          // pass on closed years separately. This prevents auto-rewriting
          // closed-period transactions, which is an audit risk.
          const { lines, transactionsPulled } = await fetchTransactionsForAccount(
            ctx.realmId, ctx.accessToken, action.qbo_account_id,
            ctx.dateRangeStart, ctx.dateRangeEnd
          );

          // SEGREGATE OPEN vs CLOSED-PERIOD LINES.
          //
          // When the source has lines in a closed period (QBO BookCloseDate or
          // a Double month marked complete/closed/delivered), we don't block
          // the merge — we do a PARTIAL merge:
          //   - Move only the open-period lines to the target.
          //   - Rename the source with a "(Pre-YYYY)" suffix so it's visibly
          //     historical in the COA.
          //   - DON'T inactivate the source — it still holds closed-period data.
          // That way the cleanup actually consolidates current activity while
          // preserving audit-safe history. Bookkeeper gets value, no manual
          // intervention required.
          const closedLines = lines.filter((l) => {
            if (isInClosedPeriod(l.transaction_date, bookCloseDate)) return true;
            const dc = findDoubleClose(l.transaction_date, doubleCloses);
            if (dc && isDoubleCloseLocked(dc.status)) return true;
            return false;
          });
          const openLines = lines.filter((l) => !closedLines.includes(l));
          const isPartialMerge = closedLines.length > 0;

          // SIZE GUARD — applies to the lines we'll actually move
          // (openLines for partial, all lines for full). Anything > 500
          // would blow past the function budget; route to manual.
          const MERGE_MAX_LINES = 500;
          const linesToMove = isPartialMerge ? openLines : lines;
          if (linesToMove.length > MERGE_MAX_LINES) {
            const reason =
              `Merge of "${action.current_name}" → "${action.new_name}" would move ` +
              `${linesToMove.length} lines${isPartialMerge ? ` (${openLines.length} open + ${closedLines.length} closed-period preserved)` : ""} — ` +
              `too many for automated reclassification within the function timeout. ` +
              `Use QBO's Reclassify Transactions tool to move them in bulk, then ` +
              `${isPartialMerge ? "rename the source with a historical marker." : "inactivate the source account manually."}`;
            pendingFailures.push({
              intended_action: "rename",
              account_id: action.qbo_account_id,
              account_name: action.current_name || "Unknown",
              request_body: {
                merge_source: action.current_name,
                merge_target: action.new_name,
                lines_to_move: linesToMove.length,
                lines_in_closed_period: closedLines.length,
                transactions: transactionsPulled,
              },
              qbo_error: reason,
              account_snapshot: sourceAccount
                ? {
                    Name: sourceAccount.Name,
                    AccountType: sourceAccount.AccountType,
                    AccountSubType: sourceAccount.AccountSubType,
                    CurrentBalance: sourceAccount.CurrentBalance,
                    Active: sourceAccount.Active,
                  }
                : null,
            });
            await ctx.supabase
              .from("coa_actions")
              .update({
                executed: false,
                error_message: null,
                flagged_reason: reason,
              })
              .eq("id", action.id);
            await logActionResult(ctx, action.id, "manual_cleanup_required", {
              name: action.current_name,
              reason: `Too large for auto-merge (${linesToMove.length} lines)`,
            });
            continue;
          }

          await logProgress(
            ctx,
            "merge_progress",
            isPartialMerge
              ? `Partial merge "${action.current_name}" → "${action.new_name}" (${openLines.length} open lines moving, ${closedLines.length} closed-period lines staying on source)`
              : `Merging "${action.current_name}" → "${action.new_name}" (${lines.length} lines across ${transactionsPulled} txns)`,
            {
              source: action.current_name,
              target: action.new_name,
              lines_to_move: linesToMove.length,
              lines_preserved: closedLines.length,
              partial: isPartialMerge,
            }
          );

          // Group lines-to-move by transaction so we can batch updates per tx
          const linesByTx = new Map<string, typeof linesToMove>();
          for (const line of linesToMove) {
            if (!linesByTx.has(line.transaction_id)) linesByTx.set(line.transaction_id, []);
            linesByTx.get(line.transaction_id)!.push(line);
          }

          const auditMemo = isPartialMerge
            ? `Ironbooks partial merge (open period): "${action.current_name}" → "${action.new_name}"`
            : `Ironbooks merge: "${action.current_name}" → "${action.new_name}"`;

          let linesReclassed = 0;
          let lastHeartbeat = 0;
          for (const [txId, txLines] of linesByTx) {
            const txType = txLines[0].transaction_type;
            await reclassifyTransactionLines(ctx.realmId, ctx.accessToken, {
              txType,
              txId,
              lineUpdates: txLines.map((l) => ({
                line_id: l.line_id,
                new_account_id: targetAccount.Id,
                new_account_name: targetAccount.Name,
              })),
              auditMemo,
            });
            linesReclassed += txLines.length;

            // Heartbeat every 50 lines so:
            //   - the bookkeeper sees live progress for big merges
            //   - the stuck-job detector doesn't false-fire (it watches
            //     for 5+ minutes of total audit-log silence)
            if (linesReclassed - lastHeartbeat >= 50) {
              lastHeartbeat = linesReclassed;
              await logProgress(ctx, "merge_progress",
                `${isPartialMerge ? "Partial merging" : "Merging"} "${action.current_name}" → "${action.new_name}" · ${linesReclassed}/${linesToMove.length} lines reclassified`,
                {
                  source: action.current_name,
                  target: action.new_name,
                  lines_done: linesReclassed,
                  lines_total: linesToMove.length,
                }
              );
              // Mid-merge cancel check — piggybacks on the heartbeat so a
              // user cancel during a big merge stops within ~50 lines
              // instead of waiting for the whole merge to finish.
              if (await shouldCancel(ctx)) {
                await logProgress(ctx, "cancellation_acknowledged",
                  `Cancelled mid-merge — ${linesReclassed} lines already moved, exiting cleanly`);
                return { success: false, errors, stats };
              }
            }
          }

          if (isPartialMerge) {
            // PARTIAL MERGE — rename source to flag it as historical,
            // skip inactivation. Source keeps its closed-period data.
            //
            // Suffix uses the year of the date range start so re-runs that
            // expand the window (e.g. last year + this year) produce a
            // consistent label. We don't double-suffix if the source name
            // already looks historical.
            const yearForSuffix = (() => {
              const y = new Date(ctx.dateRangeStart).getUTCFullYear();
              return Number.isFinite(y) ? y : new Date().getUTCFullYear();
            })();
            const suffix = `(Pre-${yearForSuffix})`;
            const currentSourceName = String(sourceAccount.Name || action.current_name || "");
            const alreadyHistorical = /\((pre|historical|archive)[\s\-]?\d{0,4}\)|\bhistorical\b|\barchive\b|\bpre[\s\-]?\d{4}\b/i.test(
              currentSourceName
            );

            let renamedTo: string | null = null;
            if (!alreadyHistorical) {
              // QBO Account.Name has a length cap (~100 chars). Truncate
              // the base name to fit the suffix.
              const maxLen = 100;
              const reserve = suffix.length + 1; // +1 for the space
              const base = currentSourceName.length + reserve > maxLen
                ? currentSourceName.slice(0, maxLen - reserve - 1).trimEnd() + "…"
                : currentSourceName;
              const proposed = `${base} ${suffix}`;
              try {
                await qbo.renameAccount(
                  ctx.realmId,
                  ctx.accessToken,
                  action.qbo_account_id,
                  sourceAccount.SyncToken,
                  proposed,
                  sourceAccount
                );
                renamedTo = proposed;
              } catch (renameErr: any) {
                // Don't fail the merge if rename fails. The reclass already
                // succeeded; the source just keeps its original name (still
                // active, still has closed history). Log and continue.
                console.warn(
                  `[executor] Partial-merge rename failed for "${currentSourceName}":`,
                  renameErr?.message || renameErr
                );
                await logActionResult(ctx, action.id, "partial_merge_rename_failed", {
                  name: currentSourceName,
                  attempted: proposed,
                  error: String(renameErr?.message || renameErr).slice(0, 300),
                });
              }
            }

            await markActionComplete(ctx, action.id, targetAccount.Id, {
              merged_into: action.new_name,
              lines_moved: linesReclassed,
              lines_preserved_on_source: closedLines.length,
              source_renamed_to: renamedTo,
              partial_merge: true,
            });
            await logActionResult(ctx, action.id, "qbo_partial_merge", {
              from: action.current_name,
              into: action.new_name,
              lines_moved: linesReclassed,
              lines_preserved: closedLines.length,
              source_now_named: renamedTo || currentSourceName,
            });
          } else {
            // FULL MERGE — source is fully drained, safe to inactivate.
            await qbo.inactivateAccount(
              ctx.realmId,
              ctx.accessToken,
              action.qbo_account_id,
              sourceAccount.SyncToken,
              sourceAccount
            );
            await markActionComplete(ctx, action.id, targetAccount.Id, {
              merged_into: action.new_name,
              lines_moved: linesReclassed,
            });
            await logActionResult(ctx, action.id, "qbo_merge", {
              from: action.current_name,
              into: action.new_name,
              lines_moved: linesReclassed,
            });
          }

          stats.merged++;
          stats.reclassified += linesReclassed;

        } catch (e: any) {
          pendingFailures.push({
            intended_action: "rename",
            account_id: action.qbo_account_id,
            account_name: action.current_name || "Unknown",
            request_body: {
              merge_source: action.current_name,
              merge_target: action.new_name,
              target_qbo_id: targetAccount.Id,
            },
            qbo_error: String(e?.message || e),
            account_snapshot: sourceAccount ? {
              Name: sourceAccount.Name,
              AccountType: sourceAccount.AccountType,
              AccountSubType: sourceAccount.AccountSubType,
              CurrentBalance: sourceAccount.CurrentBalance,
              Active: sourceAccount.Active,
            } : null,
          });
          await ctx.supabase
            .from("coa_actions")
            .update({
              executed: false,
              error_message: null,
              flagged_reason: "Manual cleanup required: see Manual Cleanup Report.",
            })
            .eq("id", action.id);
          await logActionResult(ctx, action.id, "manual_cleanup_required", {
            name: action.current_name,
            reason: `Merge failed — sent to AI for repair plan: ${e.message}`,
          });
        }
      }

      await logProgress(ctx, "stage_complete",
        `Merges complete: ${stats.merged} merged`,
        { stage: "merge", merged: stats.merged });
    }

    // STAGE 4: Inactivate
    const deletions = liveActions.filter((a) => a.action === "delete");

    if (deletions.length > 0) {
      await logProgress(ctx, "stage_start", `Inactivating ${deletions.length} accounts`,
        { stage: "inactivate", total: deletions.length });

      const allAccounts = await qbo.fetchAllAccounts(ctx.realmId, ctx.accessToken);
      const accountMap = new Map(allAccounts.map((a) => [a.Id, a]));

      for (const action of deletions) {
        if (await shouldCancel(ctx)) {
          await logProgress(ctx, "cancellation_acknowledged", "Cancelled mid-run — exiting inactivate stage cleanly");
          return { success: false, errors, stats };
        }
        try {
          const current = accountMap.get(action.qbo_account_id!);
          if (!current) continue;

          const inactive = await qbo.inactivateAccount(
            ctx.realmId, ctx.accessToken,
            action.qbo_account_id!, (current as any).SyncToken,
            current as any
          );

          await markActionComplete(ctx, action.id, inactive.Id, inactive);
          await logActionResult(ctx, action.id, "qbo_inactivate", { name: current.Name });
          stats.inactivated++;
        } catch (e: any) {
          if (isQboLimitationError(e)) {
            // QBO platform limit (most often: account has historical transactions
            // or non-zero balance). NOT an error — collect for Claude repair plan.
            const snap = current as any;
            pendingFailures.push({
              intended_action: "inactivate",
              account_id: action.qbo_account_id ?? null,
              account_name: action.current_name || "Unknown account",
              request_body: {
                Id: action.qbo_account_id,
                Active: false,
                AccountType: snap?.AccountType,
                AccountSubType: snap?.AccountSubType,
                SubAccount: snap?.SubAccount,
                ParentRef: snap?.ParentRef,
              },
              qbo_error: String(e?.message || e),
              account_snapshot: snap ? {
                Name: snap.Name,
                AccountType: snap.AccountType,
                AccountSubType: snap.AccountSubType,
                SubAccount: snap.SubAccount,
                ParentRef: snap.ParentRef,
                CurrentBalance: snap.CurrentBalance,
                CurrentBalanceWithSubAccounts: snap.CurrentBalanceWithSubAccounts,
                Active: snap.Active,
              } : null,
            });
            await ctx.supabase
              .from("coa_actions")
              .update({
                executed: false,
                error_message: null,
                flagged_reason: "Manual cleanup required: see Manual Cleanup Report.",
              })
              .eq("id", action.id);
            await logActionResult(ctx, action.id, "manual_cleanup_required", {
              name: action.current_name,
              reason: "QBO blocks API inactivation — sent to AI for repair plan",
            });
          } else {
            errors.push(`Inactivate "${action.current_name}" failed: ${e.message}`);
            await markActionFailed(ctx, action.id, e.message);
          }
        }
      }
      await logProgress(ctx, "stage_complete", `Inactivations complete`, { stage: "inactivate" });
    }

    // STAGE 5: Sync to Double
    await logProgress(ctx, "stage_start", "Syncing status to Double HQ", { stage: "double_sync" });
    try {
      const bookkeeperName = await getBookkeeperName(ctx);
      await double.postCleanupComplete(ctx.doubleClientId, {
        accountsRenamed: stats.renamed + stats.merged,
        accountsCreated: stats.created,
        accountsDeleted: stats.inactivated + stats.merged,
        transactionsReclassified: stats.reclassified,
        bookkeeperName,
        durationSeconds: Math.floor((Date.now() - startTime) / 1000),
      });
      await logProgress(ctx, "stage_complete", "Synced to Double", { stage: "double_sync" });
    } catch (e: any) {
      errors.push(`Double sync failed: ${e.message}`);
      await logProgress(ctx, "warning", `Double sync failed (non-fatal): ${e.message}`);
    }

    stats.duration_seconds = Math.floor((Date.now() - startTime) / 1000);

    // STAGE 6: Generate AI-powered manual cleanup line items for any failures.
    // Sends the full batch of failures to Claude in one call. Claude returns
    // structured plain-English repair items appended to manualCleanupItems.
    // On failure (rate limit, network, etc), the function returns a pass-through
    // fallback so the job still completes cleanly.
    if (pendingFailures.length > 0) {
      await logProgress(ctx, "stage_start",
        `Asking AI to generate ${pendingFailures.length} manual repair instructions`,
        { stage: "ai_repair_plan", total: pendingFailures.length });
      const aiItems = await generateManualRepairPlan(pendingFailures);
      for (const it of aiItems) manualCleanupItems.push(it);
      await logProgress(ctx, "stage_complete",
        `AI generated ${aiItems.length} manual cleanup items`,
        { stage: "ai_repair_plan", produced: aiItems.length });
    }

    await supabase.from("coa_jobs").update({
      status: "complete",
      execution_completed_at: new Date().toISOString(),
      execution_duration_seconds: stats.duration_seconds,
      error_message: errors.length > 0 ? errors.join("; ") : null,
      manual_cleanup_items: manualCleanupItems as any,
    }).eq("id", jobId);

    await logProgress(ctx, "job_complete",
      `Job complete in ${stats.duration_seconds}s` +
      (manualCleanupItems.length > 0 ? ` (${manualCleanupItems.length} items need manual cleanup)` : ""),
      { stats, error_count: errors.length, manual_cleanup_count: manualCleanupItems.length });

    return { success: errors.length === 0, errors, stats };
  } catch (fatalError: any) {
    await supabase.from("coa_jobs").update({
      status: "failed",
      execution_completed_at: new Date().toISOString(),
      execution_duration_seconds: Math.floor((Date.now() - startTime) / 1000),
      error_message: fatalError.message,
    }).eq("id", jobId);

    await logProgress(ctx, "job_failed", fatalError.message);
    throw fatalError;
  }
}
