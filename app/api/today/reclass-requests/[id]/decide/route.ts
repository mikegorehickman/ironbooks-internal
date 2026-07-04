import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  fetchTransactionsForAccount,
  reclassifyTransactionLines,
  normalizeVendorName,
  buildAuditMemo,
  getValidToken,
  sourceFromRequest,
  type SupportedTxType,
  type ReclassLine,
} from "@/lib/qbo-reclass";

/**
 * POST /api/today/reclass-requests/[id]/decide
 *
 * Manager-side action on a client reclass request. Two decisions:
 *
 *   decline:
 *     - Sets status='declined', records decision_note. No QBO writes.
 *
 *   approve:
 *     - Runs the bulk reclass in QBO using the existing
 *       reclassifyTransactionLines helper (same engine used by /api/reclass/*).
 *     - Optionally creates/updates a bank_rule for future auto-categorization.
 *     - Updates request status to 'applied' (or 'failed' if every line errored).
 *
 * Body:
 *   {
 *     decision:      "approve" | "decline",
 *     also_bulk?:    boolean,   // approve: reclass ALL matching txns. Default true.
 *     create_rule?:  boolean,   // approve: upsert + activate bank_rule. Default true.
 *     decision_note?: string,   // optional. Surfaced back to client.
 *   }
 *
 * Match scope (Phase 3): vendor + source account, calendar YTD. Capped at
 * MAX_TXNS to keep request well under Vercel's serverless timeout. Anything
 * bigger should be handled via the full /api/reclass/* workflow.
 *
 * Bookkeepers only act on their own clients; admins + leads see all.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300; // 5 min — bulk reclass can be slow at the cap

const MAX_TXNS = 250;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: requestId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role, full_name").eq("id", user.id).single();
  const role = (actor as any)?.role;
  if (!["admin", "lead", "bookkeeper"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  if (body.decision !== "approve" && body.decision !== "decline") {
    return NextResponse.json({ error: "decision must be 'approve' or 'decline'" }, { status: 400 });
  }
  const decisionNote = body.decision_note ? String(body.decision_note).slice(0, 1500) : null;

  // ── Load the request ──
  const { data: reqRow } = await service
    .from("client_reclass_requests" as any)
    .select(
      "id, client_link_id, source_account_qbo_id, source_account_name, " +
      "target_account_qbo_id, target_account_name, vendor_name, " +
      "example_txn_id, status"
    )
    .eq("id", requestId)
    .single();
  if (!reqRow) return NextResponse.json({ error: "Request not found" }, { status: 404 });
  const r = reqRow as any;

  // Only applied (QBO was changed) and declined are terminal. A FAILED request
  // (scan error, or zero matching transactions — e.g. already recategorized)
  // stays actionable: decline clears it with a note to the client (no QBO
  // writes), and approve may be retried. Previously failed was a dead end —
  // unactionable AND hidden from the Today list, so the client never got an
  // answer (White Oak, 2026-07-04).
  if (r.status === "applied" || r.status === "declined") {
    return NextResponse.json(
      { error: `Request is already ${r.status} — can't act on it again.` },
      { status: 400 }
    );
  }

  // Ownership check — bookkeepers can only decide their own clients
  if (role === "bookkeeper") {
    const { data: client } = await service
      .from("client_links")
      .select("assigned_bookkeeper_id")
      .eq("id", r.client_link_id)
      .single();
    if ((client as any)?.assigned_bookkeeper_id !== user.id) {
      return NextResponse.json({ error: "Not your client" }, { status: 403 });
    }
  }

  // ── DECLINE path ──
  if (body.decision === "decline") {
    const { error: updErr } = await service
      .from("client_reclass_requests" as any)
      .update({
        status: "declined",
        decided_by: user.id,
        decided_at: new Date().toISOString(),
        decision_note: decisionNote,
      } as any)
      .eq("id", requestId);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    await service.from("audit_log").insert({
      event_type: "reclass_request_declined",
      user_id: user.id,
      request_payload: {
        request_id: requestId,
        client_link_id: r.client_link_id,
        decision_note: decisionNote,
      } as any,
    });
    return NextResponse.json({ ok: true, status: "declined" });
  }

  // ── APPROVE path ──
  const alsoBulk    = body.also_bulk !== false;     // default true
  const createRule  = body.create_rule !== false;   // default true

  // 1. Get QBO token + realm
  const { data: link } = await service
    .from("client_links")
    .select("qbo_realm_id")
    .eq("id", r.client_link_id)
    .single();
  const realmId = (link as any)?.qbo_realm_id;
  if (!realmId) {
    return NextResponse.json({ error: "Client has no QBO realm_id" }, { status: 400 });
  }
  let accessToken: string;
  try {
    accessToken = await getValidToken(r.client_link_id, service as any, sourceFromRequest(request));
  } catch (e: any) {
    return NextResponse.json(
      { error: `QBO token unavailable: ${e?.message || "unknown"}` },
      { status: 502 }
    );
  }

  // 2. Determine which lines to reclass
  const now = new Date();
  const yearStart = `${now.getFullYear()}-01-01`;
  const today = now.toISOString().slice(0, 10);

  let linesToReclass: ReclassLine[] = [];
  let scanError: string | null = null;
  try {
    const result = await fetchTransactionsForAccount(
      realmId,
      accessToken,
      r.source_account_qbo_id,
      yearStart,
      today
    );

    if (alsoBulk) {
      // Bulk: filter by vendor if request has one, else everything in the
      // source account (account-level reclass — the client's "Postage is
      // mostly Marketing" case where individual vendor doesn't matter).
      if (r.vendor_name) {
        const norm = normalizeVendorName(r.vendor_name);
        linesToReclass = result.lines.filter(
          (l) => normalizeVendorName(l.vendor_name) === norm
        );
      } else {
        linesToReclass = result.lines;
      }
    } else if (r.example_txn_id) {
      // Just the one line: match by transaction id (and source account is
      // implicit because we only scanned that account).
      linesToReclass = result.lines.filter(
        (l) => l.transaction_id === r.example_txn_id
      );
    }
  } catch (e: any) {
    scanError = `QBO scan failed: ${e?.message || "unknown"}`;
  }

  if (scanError) {
    await markFailed(service, requestId, user.id, scanError);
    return NextResponse.json({ error: scanError }, { status: 502 });
  }

  if (linesToReclass.length === 0) {
    const msg = "No transactions matched the request in the current fiscal year. The matching transactions may have already been moved.";
    await markFailed(service, requestId, user.id, msg);
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  if (linesToReclass.length > MAX_TXNS) {
    const msg = `Bulk scope is too large for this flow (${linesToReclass.length} lines, cap ${MAX_TXNS}). Use /reclass for full-fleet cleanup, or narrow the request and try again.`;
    return NextResponse.json({ error: msg }, { status: 413 });
  }

  // 3. Group by (txType, txId) and execute reclass per transaction
  const byTx = new Map<string, { txType: SupportedTxType; txId: string; lineIds: string[] }>();
  for (const l of linesToReclass) {
    const key = `${l.transaction_type}::${l.transaction_id}`;
    let g = byTx.get(key);
    if (!g) {
      g = {
        txType: l.transaction_type as SupportedTxType,
        txId: l.transaction_id,
        lineIds: [],
      };
      byTx.set(key, g);
    }
    g.lineIds.push(l.line_id);
  }

  const auditMemo = buildAuditMemo(
    (actor as any)?.full_name || "Bookkeeper",
    `Approved client reclass request ${requestId.slice(0, 8)}: ` +
    `${r.source_account_name || r.source_account_qbo_id} → ${r.target_account_name || r.target_account_qbo_id}`
  );

  let applied = 0;
  let lineFailures = 0;
  const failures: Array<{ tx: string; reason: string }> = [];

  for (const [, g] of byTx) {
    try {
      const result = await reclassifyTransactionLines(realmId, accessToken, {
        txType:   g.txType,
        txId:     g.txId,
        lineUpdates: g.lineIds.map((id) => ({
          line_id: id,
          new_account_id:   r.target_account_qbo_id,
          new_account_name: r.target_account_name || undefined,
        })),
        auditMemo,
      });
      applied += result.lines_applied;
      lineFailures += result.lines_not_applied.length;
    } catch (e: any) {
      failures.push({ tx: g.txId, reason: e?.message || "unknown" });
    }
  }

  const allFailed = applied === 0 && failures.length > 0;
  const finalStatus = allFailed ? "failed" : "applied";
  const applyError = allFailed
    ? `All ${failures.length} transactions failed. First: ${failures[0]?.reason}`
    : failures.length > 0
      ? `${failures.length} of ${byTx.size} transactions failed — see audit_log.`
      : null;

  // 4. Optionally create/activate a bank_rule for future imports
  let bankRuleCreated = false;
  if (createRule && r.vendor_name && !allFailed) {
    try {
      const { data: upserted, error: ruleErr } = await service
        .from("bank_rules")
        .upsert(
          [{
            client_link_id:        r.client_link_id,
            vendor_pattern:        r.vendor_name,
            match_type:            "CONTAINS",
            target_account_name:   r.target_account_name || "",
            status:                "approved",
            ai_confidence:         null,
            ai_reasoning:          null,
            requires_approval:     false,
            sample_descriptions:   [`Client reclass request: ${requestId}`],
            transaction_count:     applied,
            total_amount:          linesToReclass.reduce((s, l) => s + (l.transaction_amount || 0), 0),
            created_by:            user.id,
          }],
          { onConflict: "client_link_id,vendor_pattern" }
        )
        .select("id");
      if (!ruleErr && upserted && upserted.length > 0) {
        await service
          .from("bank_rules")
          .update({ status: "active" } as any)
          .in("id", (upserted as any[]).map((x) => x.id));
        bankRuleCreated = true;
      }
    } catch {
      // Don't fail the whole decision if rule creation breaks — the QBO
      // reclass already succeeded. Log it and move on.
      bankRuleCreated = false;
    }
  }

  // 5. Persist final state on the request row
  await service
    .from("client_reclass_requests" as any)
    .update({
      status:              finalStatus,
      decided_by:          user.id,
      decided_at:          new Date().toISOString(),
      decision_note:       decisionNote,
      apply_scope:         "vendor_plus_account",
      apply_period_start:  yearStart,
      apply_period_end:    today,
      applied_txn_count:   applied,
      applied_at:          new Date().toISOString(),
      bank_rule_created:   bankRuleCreated,
      apply_error:         applyError,
    } as any)
    .eq("id", requestId);

  await service.from("audit_log").insert({
    event_type: `reclass_request_${finalStatus}`,
    user_id: user.id,
    request_payload: {
      request_id: requestId,
      client_link_id: r.client_link_id,
      source_account_qbo_id: r.source_account_qbo_id,
      target_account_qbo_id: r.target_account_qbo_id,
      vendor_name: r.vendor_name,
      lines_applied: applied,
      line_failures: lineFailures,
      tx_failures: failures.length,
      first_failure_reason: failures[0]?.reason || null,
      bank_rule_created: bankRuleCreated,
    } as any,
  });

  return NextResponse.json({
    ok: !allFailed,
    status: finalStatus,
    lines_applied: applied,
    transactions_touched: byTx.size,
    transactions_failed: failures.length,
    bank_rule_created: bankRuleCreated,
    apply_error: applyError,
  });
}

async function markFailed(service: any, requestId: string, userId: string, msg: string) {
  await service
    .from("client_reclass_requests" as any)
    .update({
      status: "failed",
      decided_by: userId,
      decided_at: new Date().toISOString(),
      apply_error: msg,
    } as any)
    .eq("id", requestId);
}
