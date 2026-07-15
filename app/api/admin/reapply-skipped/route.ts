import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import {
  reclassifyTransactionLines,
  getCompanyClosingDate,
  type SupportedTxType,
} from "@/lib/qbo-reclass";
import { fetchAllAccounts, getValidToken } from "@/lib/qbo";
import { normalizeAccountName } from "@/lib/account-name";
import { groupReapplyRows, type ReapplyRow } from "@/lib/reapply-skipped";

/**
 * POST /api/admin/reapply-skipped
 * Body: { client_link_id: string, dry_run?: boolean }
 *
 * Re-pushes to QBO every reclassification the discovery step marked
 * "skipped — already_correct" for ONE client, to guarantee the
 * categorization actually landed (Mike, 2026-07-15: skips that "say already
 * in target account" don't always get applied, leaving the txn
 * uncategorized). The /admin/reapply-skipped page loops clients in the
 * browser, so each call stays small and a failure is isolated to one client.
 *
 * Guards:
 *  1. Admin-only.
 *  2. Closed periods: rows on/before the QBO closing date are never touched
 *     (published statements stay immutable).
 *  3. Target account must still exist + be active in the client's QBO.
 *  4. NO stale guard — unlike vendor-remediation we push the target
 *     UNCONDITIONALLY. The stale guard would silently skip exactly the
 *     drifted rows we're trying to correct; the re-push is idempotent, so a
 *     genuinely-already-correct line just gets a harmless no-op update.
 *
 * Time-budgeted: returns remaining>0 when the budget expires; the UI
 * re-invokes until done. dry_run returns candidate counts with zero writes.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const BUDGET_MS = 240_000;
const MAX_GROUPS_PER_PASS = 40;

export async function POST(request: Request) {
  const startTime = Date.now();
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId: string = body.client_link_id;
  const dryRun: boolean = body.dry_run !== false; // default TRUE — writes are opt-in
  if (!clientLinkId) {
    return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!clientLink?.qbo_realm_id || !clientLink.is_active) {
    return NextResponse.json({ error: "Client not found / inactive / not QBO-connected" }, { status: 404 });
  }

  // reclassifications carry reclass_job_id, not client_link_id — resolve the
  // client's jobs first, then the "already_correct" skips under them.
  const { data: jobs } = await service
    .from("reclass_jobs")
    .select("id")
    .eq("client_link_id", clientLinkId);
  const jobIds = (jobs || []).map((j: any) => j.id);
  if (jobIds.length === 0) {
    return NextResponse.json({ scanned: 0, reapplied: 0, confirmed: 0, corrected: 0, skipped_closed: 0, skipped_no_account: 0, failed: 0, remaining: 0 });
  }

  const { data: rawRows } = await service
    .from("reclassifications")
    .select(
      "id, qbo_transaction_id, qbo_transaction_type, line_id, to_account_id, to_account_name, from_account_name, transaction_date, status, skip_reason, decision"
    )
    .in("reclass_job_id", jobIds)
    .eq("status", "skipped")
    // "already_correct" is a real stored value (54k+ rows fleet-wide) but the
    // generated enum type is stale and omits it — cast past the type only.
    .eq("skip_reason", "already_correct" as any);

  const groups = groupReapplyRows((rawRows || []) as ReapplyRow[]);
  const scanned = groups.reduce((s, g) => s + g.rows.length, 0);

  const summary = {
    scanned,
    reapplied: 0,        // lines successfully pushed to QBO this pass
    confirmed: 0,        // lines that were genuinely already in target (no-op)
    corrected: 0,        // lines that were NOT in target and got fixed
    skipped_closed: 0,
    skipped_no_account: 0,
    failed: 0,
    remaining: 0,
  };

  if (dryRun || groups.length === 0) {
    return NextResponse.json(summary);
  }

  const accessToken = await getValidToken(clientLinkId, service as any, "ironbooks/api/admin/reapply-skipped");
  const closingDate = await getCompanyClosingDate(clientLink.qbo_realm_id, accessToken);

  const qboAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
  const activeById = new Map(
    qboAccounts.filter((a) => a.Active !== false).map((a) => [a.Id, a])
  );
  const activeByName = new Map(
    qboAccounts.filter((a) => a.Active !== false).map((a) => [normalizeAccountName(a.Name), a])
  );
  const resolveTarget = (row: ReapplyRow) => {
    if (row.to_account_id && activeById.has(row.to_account_id)) return activeById.get(row.to_account_id)!;
    if (row.to_account_name) return activeByName.get(normalizeAccountName(row.to_account_name)) || null;
    return null;
  };
  // The transaction's live account at re-fetch time, per line, so we can tell
  // "was already correct" (confirmed) from "was wrong, now fixed" (corrected).
  const lineCurrentName = (tx: any, lineId: string): string | null => {
    const line = ((tx?.Line ?? []) as any[]).find((l) => String(l.Id) === String(lineId));
    return line?.AccountBasedExpenseLineDetail?.AccountRef?.name ?? null;
  };

  const auditMemo = `SNAP re-apply skipped (already-correct confirm) ${new Date().toISOString().slice(0, 10)}`;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (Date.now() - startTime > BUDGET_MS || i >= MAX_GROUPS_PER_PASS) {
      for (const g of groups.slice(i)) summary.remaining += g.rows.length;
      break;
    }

    // Guard 2: closed-period rows are untouchable.
    const open = group.rows.filter((r) => {
      if (closingDate && r.transaction_date && r.transaction_date <= closingDate) {
        summary.skipped_closed++;
        return false;
      }
      return true;
    });
    if (open.length === 0) continue;

    // Guard 3: target must still exist + be active.
    const resolvable = open.filter((r) => {
      if (resolveTarget(r)) return true;
      summary.skipped_no_account++;
      return false;
    });
    if (resolvable.length === 0) continue;

    try {
      const result = await reclassifyTransactionLines(clientLink.qbo_realm_id, accessToken, {
        txType: group.txType,
        txId: group.txId,
        lineUpdates: resolvable.map((r) => {
          const target = resolveTarget(r)!;
          return {
            line_id: r.line_id as string,
            new_account_id: target.Id,
            new_account_name: target.Name,
            // NO expected_current_account_name — force the target regardless
            // of the line's current account. That is the whole point: fix the
            // ones that silently never got applied.
          };
        }),
        auditMemo,
      });

      const notAppliedLineIds = new Set(result.lines_not_applied.map((l) => l.line_id));
      for (const r of resolvable) {
        if (notAppliedLineIds.has(r.line_id as string)) {
          summary.failed++;
          continue;
        }
        const target = resolveTarget(r)!;
        // result.tx is the PRE-mutation refetch — its line still shows the
        // account the txn actually had before we wrote, so we can report how
        // many were genuinely not-yet-applied vs already-correct no-ops.
        const wasName = lineCurrentName(result.tx, r.line_id as string);
        const wasCorrect =
          !!wasName && normalizeAccountName(wasName) === normalizeAccountName(target.Name);
        summary.reapplied++;
        if (wasCorrect) summary.confirmed++;
        else summary.corrected++;
        await service
          .from("reclassifications")
          .update({
            status: "executed",
            executed_at: new Date().toISOString(),
            to_account_id: target.Id,
            to_account_name: target.Name,
            ai_reasoning:
              `re-apply (already-correct confirm): pushed "${target.Name}" to QBO` +
              (wasCorrect ? " — was already correct" : `, was "${wasName ?? "(uncategorized)"}"`),
          } as any)
          .eq("id", r.id);
      }
    } catch (err: any) {
      summary.failed += resolvable.length;
      console.error(
        `[reapply-skipped] ${clientLink.client_name} ${group.txType}/${group.txId}: ${err.message}`
      );
    }
  }

  // audit_log has NO client_link_id column — it lives in the payload.
  const { error: auditErr } = await service.from("audit_log").insert({
    event_type: "reapply_skipped_already_correct",
    user_id: user.id,
    request_payload: { client_link_id: clientLinkId, ...summary } as any,
  } as any);
  if (auditErr) console.warn(`[reapply-skipped] audit insert failed: ${auditErr.message}`);

  return NextResponse.json(summary);
}
