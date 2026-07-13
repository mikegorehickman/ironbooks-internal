import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { scanForCandidates, sameAccount } from "@/lib/vendor-remediation";
import { reclassifyTransactionLines, getCompanyClosingDate, type SupportedTxType, SUPPORTED_TX_TYPES } from "@/lib/qbo-reclass";
import { fetchAllAccounts, getValidToken } from "@/lib/qbo";

/**
 * POST /api/admin/vendor-remediation/apply
 * Body: { client_link_id: string, reclassification_ids: string[] }
 *
 * Applies APPROVED remediation candidates for ONE client. Layered guards —
 * every one must pass before a line is touched:
 *   1. Admin-only, per-client, explicit row ids from the review screen.
 *   2. Re-scan: each id must STILL be a candidate against the current KB
 *      (revalidated server-side; the client payload is never trusted).
 *   3. Closed periods: rows dated on/before the client's QBO closing date are
 *      skipped — published statements are never silently changed.
 *   4. Target account must already exist in the client's QBO (Apply Standard
 *      COA created these fleet-wide; anything missing is skipped, not created).
 *   5. Stale guard (in reclassifyTransactionLines): the txn is refetched and a
 *      line is skipped if its CURRENT account differs from what we posted —
 *      i.e. a human moved it after us, and their decision wins.
 *
 * Time-budgeted: returns remaining_ids when the budget expires; the UI
 * re-invokes until done. Every applied line is audit-logged.
 */
export const maxDuration = 300;
const BUDGET_MS = 240_000;

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
  const ids: string[] = Array.isArray(body.reclassification_ids) ? body.reclassification_ids : [];
  if (!clientLinkId || ids.length === 0) {
    return NextResponse.json({ error: "client_link_id and reclassification_ids are required" }, { status: 400 });
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!clientLink?.qbo_realm_id || !clientLink.is_active) {
    return NextResponse.json({ error: "Client not found / not active / no QBO connection" }, { status: 404 });
  }

  // Guard 2: revalidate — recompute candidacy server-side for exactly these ids.
  const candidates = (await scanForCandidates({ clientLinkIds: [clientLinkId], reclassificationIds: ids }))
    .filter((c) => SUPPORTED_TX_TYPES.includes(c.qbo_transaction_type as SupportedTxType));
  const droppedByRevalidation = ids.length - candidates.length;

  const accessToken = await getValidToken(clientLinkId, service as any);

  // Guard 3: closing date — one fetch per run.
  const closingDate = await getCompanyClosingDate(clientLink.qbo_realm_id, accessToken);

  // Guard 4: target accounts must exist (leaf-tolerant name match).
  const qboAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
  const findAccount = (name: string) =>
    qboAccounts.find((a) => a.Active !== false && sameAccount(a.FullyQualifiedName || a.Name, name)) ||
    qboAccounts.find((a) => a.Active !== false && sameAccount(a.Name, name));

  const summary = {
    requested: ids.length,
    dropped_by_revalidation: droppedByRevalidation,
    moved_lines: 0,
    skipped_stale: 0,
    skipped_closed: 0,
    skipped_no_account: 0,
    failed: 0,
    remaining_ids: [] as string[],
  };

  // Group candidate lines by transaction (one QBO write per txn).
  const byTxn = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const key = `${c.qbo_transaction_type}::${c.qbo_transaction_id}`;
    (byTxn.get(key) ?? byTxn.set(key, []).get(key)!).push(c);
  }

  const auditMemo = `SNAP vendor remediation ${new Date().toISOString().slice(0, 10)} (reviewed vendor rules)`;
  const txnGroups = [...byTxn.values()];

  for (let i = 0; i < txnGroups.length; i++) {
    const group = txnGroups[i];

    if (Date.now() - startTime > BUDGET_MS) {
      for (const g of txnGroups.slice(i)) for (const c of g) summary.remaining_ids.push(c.reclassification_id);
      break;
    }

    // Guard 3 per row: closed-period rows are untouchable.
    const open = group.filter((c) => {
      if (closingDate && c.transaction_date && c.transaction_date <= closingDate) {
        summary.skipped_closed++;
        return false;
      }
      return true;
    });
    if (open.length === 0) continue;

    // Guard 4 per row: resolve target accounts.
    const resolvable = open.filter((c) => {
      if (findAccount(c.target_account)) return true;
      summary.skipped_no_account++;
      return false;
    });
    if (resolvable.length === 0) continue;

    const first = resolvable[0];
    try {
      const result = await reclassifyTransactionLines(clientLink.qbo_realm_id, accessToken, {
        txType: first.qbo_transaction_type as SupportedTxType,
        txId: first.qbo_transaction_id,
        lineUpdates: resolvable.map((c) => ({
          line_id: c.line_id,
          new_account_id: findAccount(c.target_account)!.Id,
          new_account_name: findAccount(c.target_account)!.Name,
          // Guard 5: only move the line if it's still where WE put it.
          expected_current_account_name: c.current_account,
        })),
        auditMemo,
        vendorName: first.target_vendor,
      });

      const staleLineIds = new Set(
        result.lines_not_applied.filter((l) => l.reason.startsWith("stale:")).map((l) => l.line_id)
      );
      for (const c of resolvable) {
        if (staleLineIds.has(c.line_id)) {
          summary.skipped_stale++;
          continue;
        }
        summary.moved_lines++;
        const target = findAccount(c.target_account)!;
        await service
          .from("reclassifications")
          .update({
            to_account_id: target.Id,
            to_account_name: target.Name,
            // Skipped rows become executed — remediation is the write that
            // finally moved them; executed rows just refresh the stamp.
            status: "executed",
            executed_at: new Date().toISOString(),
            ai_reasoning: `${c.kb_reasoning} — vendor remediation (reviewed rules), was "${c.current_account}"`,
          } as any)
          .eq("id", c.reclassification_id);
      }
    } catch (err: any) {
      summary.failed += resolvable.length;
      console.error(
        `[vendor-remediation] ${clientLink.client_name} ${first.qbo_transaction_type}/${first.qbo_transaction_id}: ${err.message}`
      );
    }
  }

  await service.from("audit_log").insert({
    event_type: "vendor_remediation_apply",
    user_id: user.id,
    client_link_id: clientLinkId,
    request_payload: { ...summary, remaining: summary.remaining_ids.length, remaining_ids: undefined } as any,
  } as any);

  return NextResponse.json(summary);
}
