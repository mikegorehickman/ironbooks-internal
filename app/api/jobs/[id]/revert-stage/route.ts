import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse, after } from "next/server";
import {
  getValidToken,
  fetchAllAccounts,
  reactivateAccount,
  renameAccount,
  inactivateAccount,
} from "@/lib/qbo";
import {
  fetchTransactionsForAccount,
  reclassifyTransactionLines,
} from "@/lib/qbo-reclass";

/**
 * POST /api/jobs/[id]/revert-stage
 *
 * Reverts a single stage of a COA cleanup. Used from the Revert button on
 * an errored job — instead of undoing the whole cleanup, the bookkeeper
 * targets just the stage that failed (typically 'merge' for the
 * Renaissance-style mid-merge errors).
 *
 * Body: { stage: 'rename' | 'merge' | 'create' | 'delete' }
 *
 * Per-stage undo logic:
 *   - rename : rename each renamed account back to its current_name
 *   - merge  : reactivate source if inactivated + move transactions back
 *              from target → source using the Ironbooks merge audit memo
 *   - create : inactivate the newly-created account
 *   - delete : reactivate the (previously) inactivated account
 *
 * Renames and creates are cheap (one QBO update each). Merges are the
 * expensive case — we use the same per-50-line heartbeat pattern as the
 * executor so the stuck-job detector doesn't false-fire.
 */

export const maxDuration = 800;

type Stage = "rename" | "merge" | "create" | "delete";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const stage: Stage | undefined = body?.stage;
  if (!stage || !["rename", "merge", "create", "delete"].includes(stage)) {
    return NextResponse.json(
      { error: "stage must be one of: rename, merge, create, delete" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("coa_jobs")
    .select("*, client_links(*)")
    .eq("id", jobId)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const clientLink = (job as any).client_links;
  if (!clientLink) return NextResponse.json({ error: "Client missing" }, { status: 400 });

  // Don't revert while the executor is still running — would race on the
  // same QBO accounts. Tell the bookkeeper to Stop first.
  if (job.status === "executing") {
    return NextResponse.json(
      {
        error:
          "This job is currently executing. Click Stop first (wait for the executor to acknowledge the cancel), then run Revert.",
      },
      { status: 409 }
    );
  }

  const { data: stageActions } = await service
    .from("coa_actions")
    .select("*")
    .eq("job_id", jobId)
    .eq("action", stage)
    .eq("executed", true);

  if (!stageActions || stageActions.length === 0) {
    return NextResponse.json({
      ok: true,
      stage,
      reverted: 0,
      message: `No executed ${stage} actions to revert.`,
    });
  }

  // Background work
  after(async () => {
    const svc = createServiceSupabase();
    try {
      await runStageRevert(jobId, stage, user.id, stageActions, clientLink, svc);
    } catch (err: any) {
      console.error(`[revert-stage] Job ${jobId} stage ${stage} failed:`, err);
      await svc.from("audit_log").insert({
        job_id: jobId,
        user_id: user.id,
        event_type: "revert_stage_failed",
        request_payload: { stage, error: err.message } as any,
      });
    }
  });

  return NextResponse.json({
    started: true,
    job_id: jobId,
    stage,
    actions_to_revert: stageActions.length,
  });
}

async function runStageRevert(
  jobId: string,
  stage: Stage,
  bookkeeperId: string,
  actions: any[],
  clientLink: any,
  service: ReturnType<typeof createServiceSupabase>
) {
  const accessToken = await getValidToken(clientLink.id, service as any);
  const realmId = clientLink.qbo_realm_id;

  await service.from("audit_log").insert({
    job_id: jobId,
    user_id: bookkeeperId,
    event_type: "revert_stage_start",
    request_payload: {
      message: `Reverting stage "${stage}" — ${actions.length} executed action${actions.length === 1 ? "" : "s"}`,
      stage,
    } as any,
  });

  // Fresh QBO snapshot — names may have changed since execute. Use this
  // to look up current SyncTokens and to find renamed accounts by new name.
  const allAccounts = await fetchAllAccounts(realmId, accessToken);
  const byId = new Map(allAccounts.map((a) => [a.Id, a]));
  const byNameInsensitive = new Map<string, typeof allAccounts[number]>();
  for (const a of allAccounts) {
    if (a.Active !== false && a.Name) {
      byNameInsensitive.set(a.Name.trim().toLowerCase(), a);
    }
  }

  let reverted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const action of actions) {
    try {
      switch (stage) {
        case "rename": {
          // Undo rename: rename action.qbo_account_id from new_name back to current_name
          const acct = byId.get(action.qbo_account_id);
          if (!acct) {
            skipped++;
            errors.push(`${action.current_name}: account no longer exists`);
            continue;
          }
          await renameAccount(
            realmId,
            accessToken,
            action.qbo_account_id,
            acct.SyncToken,
            action.current_name,
            { currentAccount: acct as any }
          );
          reverted++;
          break;
        }

        case "create": {
          // Undo create: inactivate the newly-created account
          const acct = byId.get(action.qbo_account_id);
          if (!acct) {
            skipped++;
            continue;
          }
          await inactivateAccount(
            realmId,
            accessToken,
            action.qbo_account_id,
            acct.SyncToken,
            acct as any
          );
          reverted++;
          break;
        }

        case "delete": {
          // Undo inactivate: reactivate the account
          const acct = byId.get(action.qbo_account_id);
          if (!acct) {
            skipped++;
            continue;
          }
          if (acct.Active !== false) {
            // Already active — no-op
            skipped++;
            continue;
          }
          await reactivateAccount(
            realmId,
            accessToken,
            action.qbo_account_id,
            acct.SyncToken,
            acct as any
          );
          reverted++;
          break;
        }

        case "merge": {
          // Undo merge:
          //   - Reactivate source if it was inactivated (full merge path)
          //   - Rename source back to its original name if it was renamed
          //     with a "(Pre-YYYY)" suffix (partial merge path)
          //   - Move transactions back from target to source using the
          //     Ironbooks merge audit memo
          const sourceId = action.qbo_account_id;
          const targetName = String(action.new_name || "");
          const target = byNameInsensitive.get(targetName.trim().toLowerCase());
          if (!target) {
            skipped++;
            errors.push(`${action.current_name}: target "${targetName}" not found`);
            continue;
          }

          let source: any = byId.get(sourceId);
          if (source && source.Active === false) {
            try {
              source = await reactivateAccount(realmId, accessToken, sourceId, source.SyncToken, source);
              await service.from("audit_log").insert({
                job_id: jobId,
                user_id: bookkeeperId,
                event_type: "revert_stage_reactivated_source",
                request_payload: { source: action.current_name } as any,
              });
            } catch (e: any) {
              skipped++;
              errors.push(`${action.current_name}: could not reactivate: ${e.message}`);
              continue;
            }
          }

          // Partial-merge rename undo. If the original merge renamed the
          // source to "(Pre-YYYY)" (result_data.partial_merge=true), and
          // the source's current name still has that suffix, rename it
          // back to the original.
          const resultData: any = action.result_data || {};
          const originalName: string = String(action.current_name || "");
          if (
            resultData.partial_merge &&
            source &&
            originalName &&
            source.Name !== originalName &&
            /\(Pre[\s\-]?\d{4}\)/i.test(source.Name || "")
          ) {
            try {
              source = await renameAccount(
                realmId,
                accessToken,
                sourceId,
                source.SyncToken,
                originalName,
                { currentAccount: source }
              );
              await service.from("audit_log").insert({
                job_id: jobId,
                user_id: bookkeeperId,
                event_type: "revert_stage_renamed_source_back",
                request_payload: {
                  source_was: resultData.source_renamed_to,
                  source_now: originalName,
                } as any,
              });
            } catch (e: any) {
              // Don't fail the whole revert if the rename-back fails; the
              // transactions still need to move. Log and continue.
              await service.from("audit_log").insert({
                job_id: jobId,
                user_id: bookkeeperId,
                event_type: "revert_stage_rename_back_failed",
                request_payload: {
                  source: action.current_name,
                  error: String(e?.message || e).slice(0, 300),
                } as any,
              });
            }
          }

          // Find lines moved by this merge — pull every line on target
          // (all-time) and filter to those carrying our audit memo.
          const fullMarker = `Ironbooks merge: "${action.current_name}" → "${action.new_name}"`;
          const partialMarker = `Ironbooks partial merge (open period): "${action.current_name}" → "${action.new_name}"`;

          const todayIso = new Date().toISOString().slice(0, 10);
          const { lines } = await fetchTransactionsForAccount(
            realmId,
            accessToken,
            target.Id,
            "2000-01-01",
            todayIso
          );
          const linesToRevert = lines.filter((l) => {
            const memo = String(l.private_note || "");
            return memo.includes(fullMarker) || memo.includes(partialMarker);
          });

          if (linesToRevert.length === 0) {
            // Nothing to move back, but the source was still reactivated if
            // needed. Count as reverted.
            reverted++;
            await service.from("audit_log").insert({
              job_id: jobId,
              user_id: bookkeeperId,
              event_type: "revert_stage_merge_no_lines",
              request_payload: {
                source: action.current_name,
                target: targetName,
                message: "Source reactivated; no merged lines found on target.",
              } as any,
            });
            continue;
          }

          // Group by transaction so we update each tx once.
          const linesByTx = new Map<string, typeof linesToRevert>();
          for (const l of linesToRevert) {
            if (!linesByTx.has(l.transaction_id)) linesByTx.set(l.transaction_id, []);
            linesByTx.get(l.transaction_id)!.push(l);
          }

          let movedBack = 0;
          let lastHeartbeat = 0;
          for (const [, txLines] of linesByTx) {
            await reclassifyTransactionLines(realmId, accessToken, {
              txType: txLines[0].transaction_type,
              txId: txLines[0].transaction_id,
              lineUpdates: txLines.map((l) => ({
                line_id: l.line_id,
                new_account_id: sourceId,
                new_account_name: action.current_name,
              })),
              auditMemo: `Ironbooks revert (stage=merge): "${action.new_name}" → "${action.current_name}"`,
            });
            movedBack += txLines.length;

            if (movedBack - lastHeartbeat >= 50) {
              lastHeartbeat = movedBack;
              await service.from("audit_log").insert({
                job_id: jobId,
                user_id: bookkeeperId,
                event_type: "revert_stage_progress",
                request_payload: {
                  source: action.current_name,
                  target: targetName,
                  lines_done: movedBack,
                  lines_total: linesToRevert.length,
                } as any,
              });
            }
          }

          reverted++;
          await service.from("audit_log").insert({
            job_id: jobId,
            user_id: bookkeeperId,
            event_type: "revert_stage_merge_complete",
            request_payload: {
              source: action.current_name,
              target: targetName,
              lines_moved_back: movedBack,
            } as any,
          });
          break;
        }
      }

      // Mark the action as no-longer-executed so the executor would
      // re-attempt it on a future run if the bookkeeper wants. Also clear
      // any partial_merge flags / result_data so the next analyze sees a
      // clean slate.
      await service
        .from("coa_actions")
        .update({
          executed: false,
          executed_at: null,
          result_data: null,
          error_message: null,
        } as any)
        .eq("id", action.id);
    } catch (e: any) {
      skipped++;
      errors.push(`${action.current_name || action.new_name}: ${e.message}`);
      await service.from("audit_log").insert({
        job_id: jobId,
        user_id: bookkeeperId,
        event_type: "revert_stage_error",
        request_payload: {
          stage,
          action_name: action.current_name || action.new_name,
          error: e.message,
        } as any,
      });
    }
  }

  await service.from("audit_log").insert({
    job_id: jobId,
    user_id: bookkeeperId,
    event_type: "revert_stage_complete",
    request_payload: {
      message: `Stage "${stage}" revert complete: ${reverted} reverted, ${skipped} skipped`,
      stage,
      reverted,
      skipped,
      errors: errors.slice(0, 10),
    } as any,
  });
}
