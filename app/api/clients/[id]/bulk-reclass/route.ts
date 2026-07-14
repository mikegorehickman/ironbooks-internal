import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { fetchAllAccounts, getValidToken, qboErrorResponse } from "@/lib/qbo";
import {
  reclassifyTransactionLines,
  refetchTransaction,
  getCompanyClosingDate,
  type SupportedTxType,
  SUPPORTED_TX_TYPES,
} from "@/lib/qbo-reclass";
import { bankRuleVendorPattern } from "@/lib/vendor-knowledge";

/**
 * POST /api/clients/[id]/bulk-reclass
 *
 * Move a multi-selected set of transactions OUT of one account and INTO a
 * target account (P&L or Balance Sheet), from the client financial-statement
 * drill-down. Optionally learns a per-client rule so the same vendors auto-
 * categorize to the new account on future runs.
 *
 * Body:
 *   {
 *     source_account_id: string,        // the drilled account the txns sit in
 *     source_account_name: string,      // for the stale-guard + rule display
 *     target_account_id: string,        // any active QBO account (P&L or BS)
 *     transactions: [{ id, type }],      // the selected rows (txn id + QBO type)
 *     create_rules?: boolean,            // default true — learn vendor→target rules
 *   }
 *
 * Semantics: for each unique transaction, EVERY expense line currently sitting
 * in the source account is moved to the target (the full amount in that
 * account). Guards mirror vendor remediation / daily-drain:
 *   - only SUPPORTED_TX_TYPES (expense family); others reported as skipped
 *   - closed-period transactions are never touched
 *   - stale guard: a line whose current account no longer matches the source
 *     (a human moved it since) is left alone
 * Budget-chunked: returns remaining[] when time runs out; the client re-invokes.
 *
 * Owner bookkeeper or admin/lead only.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const BUDGET_MS = 240_000;
// Keep each pass short enough that the drawer's progress bar moves; the client
// re-invokes with the returned remaining[] until nothing is left.
const MAX_TXNS_PER_PASS = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const startTime = Date.now();
  const { id: clientLinkId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, is_active, assigned_bookkeeper_id, industry")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!(client as any).qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json({ error: "Client is inactive or has no QBO connection" }, { status: 400 });
  }

  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const sourceAccountId = String(body.source_account_id || "").trim();
  const sourceAccountName = String(body.source_account_name || "").trim();
  const targetAccountId = String(body.target_account_id || "").trim();
  const createRules = body.create_rules !== false; // default on
  const rawTxns: Array<{ id: string; type: string }> = Array.isArray(body.transactions)
    ? body.transactions
    : [];

  if (!sourceAccountId || !targetAccountId || rawTxns.length === 0) {
    return NextResponse.json(
      { error: "source_account_id, target_account_id, and a non-empty transactions[] are required" },
      { status: 400 }
    );
  }
  if (sourceAccountId === targetAccountId) {
    return NextResponse.json({ error: "Target account is the same as the source" }, { status: 400 });
  }

  const realmId = (client as any).qbo_realm_id as string;

  let accessToken: string;
  let allAccounts: Awaited<ReturnType<typeof fetchAllAccounts>>;
  try {
    accessToken = await getValidToken(clientLinkId, service as any);
    allAccounts = await fetchAllAccounts(realmId, accessToken);
  } catch (err: any) {
    return qboErrorResponse(err);
  }

  const target = allAccounts.find((a) => a.Id === targetAccountId);
  if (!target) return NextResponse.json({ error: "Target account not found in QBO" }, { status: 404 });
  if (target.Active === false) {
    return NextResponse.json(
      { error: `Target account "${target.Name}" is inactive — reactivate it first` },
      { status: 400 }
    );
  }

  // Stale-guard name: reclassifyTransactionLines matches expected_current_account_name
  // against the line's live AccountRef.name (leaf-tolerant). Use the account's
  // REAL QBO name (resolved by id), not the drill-view display label — those can
  // differ (report label vs account name) and a mismatch would falsely skip
  // every line as "stale". Lines are still selected authoritatively by account
  // id below; this name only powers the "did a human move it since?" check.
  const sourceQboName =
    allAccounts.find((a) => a.Id === sourceAccountId)?.Name || sourceAccountName || undefined;

  // One closing-date read for the whole run.
  let closingDate: string | null = null;
  try {
    closingDate = await getCompanyClosingDate(realmId, accessToken);
  } catch {
    /* closing-date read is best-effort; a null means "no closed period" */
  }

  // Dedupe by transaction (a split line shows as multiple drill rows) and split
  // supported vs unsupported types up front.
  const seen = new Set<string>();
  const unique: Array<{ id: string; type: SupportedTxType }> = [];
  let skippedUnsupported = 0;
  for (const t of rawTxns) {
    const id = String(t?.id || "").trim();
    const type = String(t?.type || "").trim();
    if (!id || !type) continue;
    const key = `${type}::${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!SUPPORTED_TX_TYPES.includes(type as SupportedTxType)) {
      skippedUnsupported++;
      continue;
    }
    unique.push({ id, type: type as SupportedTxType });
  }

  const summary = {
    requested: rawTxns.length,
    unique_txns: unique.length,
    moved_txns: 0,
    moved_lines: 0,
    skipped_unsupported: skippedUnsupported,
    skipped_closed: 0,
    skipped_stale: 0,
    skipped_no_source_line: 0,
    failed: 0,
    remaining: [] as Array<{ id: string; type: string }>,
    rules_created: 0,
    rules_updated: 0,
    target: { id: target.Id, name: target.Name },
  };

  const bookkeeperName = (actor as any)?.full_name || "bookkeeper";
  const auditMemo = `Ironbooks bulk reclass by ${bookkeeperName} — "${sourceAccountName}" → "${target.Name}"`;

  // Vendors we actually moved this pass → learned rules at the end.
  const movedVendors = new Set<string>();

  for (let i = 0; i < unique.length; i++) {
    const t = unique[i];
    if (Date.now() - startTime > BUDGET_MS || i >= MAX_TXNS_PER_PASS) {
      for (const rem of unique.slice(i)) summary.remaining.push(rem);
      break;
    }

    let tx;
    try {
      tx = await refetchTransaction(realmId, accessToken, t.type, t.id);
    } catch (err: any) {
      summary.failed++;
      console.error(`[bulk-reclass] refetch ${t.type}/${t.id}: ${err.message}`);
      continue;
    }
    if (!tx) {
      summary.failed++;
      continue;
    }

    // Closed period — never touch published books.
    if (closingDate && tx.TxnDate && tx.TxnDate <= closingDate) {
      summary.skipped_closed++;
      continue;
    }

    // Every expense line currently in the source account.
    const lineUpdates = (tx.Line || [])
      .filter(
        (l) =>
          l.Id &&
          l.AccountBasedExpenseLineDetail?.AccountRef?.value === sourceAccountId
      )
      .map((l) => ({
        line_id: l.Id!,
        new_account_id: target.Id,
        new_account_name: target.Name,
        // Stale guard — skip a line a human has since moved off the source.
        expected_current_account_name: sourceQboName,
      }));

    if (lineUpdates.length === 0) {
      // The txn had no line in this account anymore (already moved, or the
      // drill row was a different split). Nothing to do — not a failure.
      summary.skipped_no_source_line++;
      continue;
    }

    try {
      const result = await reclassifyTransactionLines(realmId, accessToken, {
        txType: t.type,
        txId: t.id,
        lineUpdates,
        auditMemo,
      });
      if (result.lines_applied === 0) {
        summary.skipped_stale++;
        continue;
      }
      summary.moved_lines += result.lines_applied;
      summary.moved_txns++;
      const vendor = (tx.VendorRef?.name || tx.EntityRef?.name || "").trim();
      if (vendor) movedVendors.add(vendor);
    } catch (err: any) {
      summary.failed++;
      console.error(`[bulk-reclass] ${t.type}/${t.id}: ${err.message}`);
    }
  }

  // Learn per-client rules for the vendors we moved this pass. Idempotent
  // upsert on (client_link_id, vendor_pattern) — re-running just refreshes the
  // target. Stored in the exact normalized form both categorization engines
  // match on (see bankRuleVendorPattern).
  if (createRules && movedVendors.size > 0) {
    const patterns = new Map<string, string>(); // pattern → display vendor
    for (const v of movedVendors) {
      const p = bankRuleVendorPattern(v);
      if (p && !patterns.has(p)) patterns.set(p, v);
    }
    if (patterns.size > 0) {
      const patternList = [...patterns.keys()];
      const { data: existing } = await service
        .from("bank_rules")
        .select("vendor_pattern")
        .eq("client_link_id", clientLinkId)
        .in("vendor_pattern", patternList);
      const existedBefore = new Set(
        ((existing || []) as Array<{ vendor_pattern: string | null }>)
          .map((r) => r.vendor_pattern)
          .filter(Boolean) as string[]
      );

      const rows = [...patterns.entries()].map(([pattern, display]) => ({
        client_link_id: clientLinkId,
        vendor_pattern: pattern,
        match_type: "CONTAINS",
        target_account_name: target.Name,
        target_qbo_account_id: target.Id,
        status: "active",
        requires_approval: false,
        sample_descriptions: [display],
        created_by: user.id,
        ai_reasoning: `Learned from bulk reclass "${sourceAccountName}" → "${target.Name}" in the client financial view`,
      }));

      const { error: upErr } = await service
        .from("bank_rules")
        .upsert(rows as any, { onConflict: "client_link_id,vendor_pattern" });
      if (upErr) {
        console.warn(`[bulk-reclass] rule upsert failed: ${upErr.message}`);
      } else {
        for (const p of patternList) {
          if (existedBefore.has(p)) summary.rules_updated++;
          else summary.rules_created++;
        }
      }
    }
  }

  try {
    await service.from("audit_log").insert({
      event_type: "bulk_reclass",
      user_id: user.id,
      request_payload: {
        client_link_id: clientLinkId,
        source_account_id: sourceAccountId,
        source_account_name: sourceAccountName,
        target_account_id: target.Id,
        target_account_name: target.Name,
        create_rules: createRules,
        ...summary,
        remaining: summary.remaining.length,
        remaining_ids: undefined,
      } as any,
    } as any);
  } catch (e: any) {
    console.warn(`[bulk-reclass] audit insert failed: ${e?.message}`);
  }

  return NextResponse.json(summary);
}
