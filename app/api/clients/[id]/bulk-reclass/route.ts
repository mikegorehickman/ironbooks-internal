import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { fetchAllAccounts, getValidToken, qboErrorResponse } from "@/lib/qbo";
import {
  reclassifyTransactionLines,
  refetchTransaction,
  getCompanyClosingDate,
  describeReclassError,
  type SupportedTxType,
} from "@/lib/qbo-reclass";
import { reclassifyDepositLines } from "@/lib/qbo-deposit-reclass";
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

/**
 * QBO's ProfitAndLossDetail report tags each row with a human txn_type label
 * ("Expense", "Check", "Credit Card Expense", "Deposit", "Bill"…) — NOT the API
 * entity name. The drill passes those labels through verbatim, so we translate
 * to the entity whose endpoint we can actually fetch/update, plus which write
 * path handles it.
 *
 * Critically, QBO has NO "Expense" entity: Expense / Check / Credit-Card / Cash
 * purchases are ALL `Purchase` records. Passing "Expense" straight to
 * /expense/{id} 404s — the pre-existing bug that made those rows fail silently
 * (they were in SUPPORTED_TX_TYPES, so they cleared the gate, then died at
 * refetch). Returns null for rows genuinely out of scope (Invoice / Sales
 * Receipt item income, Journal Entry, Transfer, Bill Payment, Payment…).
 */
function classifyReportTxn(
  rawType: string
): { entity: SupportedTxType; kind: "expense" } | { entity: "Deposit"; kind: "deposit" } | null {
  const t = rawType.trim().toLowerCase();
  if (t === "bill") return { entity: "Bill", kind: "expense" };
  if (t === "vendor credit" || t === "vendorcredit") return { entity: "VendorCredit", kind: "expense" };
  if (t === "deposit") return { entity: "Deposit", kind: "deposit" };
  // Everything QBO persists as a Purchase entity — all post via
  // AccountBasedExpenseLineDetail, so the reclass engine handles them identically.
  if ([
    "purchase", "expense", "check", "cheque", "cash expense", "cash purchase",
    "credit card expense", "credit card credit", "credit card charge", "cc expense",
    "debit", "charge", "expenditure",
  ].includes(t)) return { entity: "Purchase", kind: "expense" };
  return null;
}

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

  // Dedupe by transaction (a split line shows as multiple drill rows) and tag
  // each with the write path it needs. Two families move here:
  //   - expense: Bill/Purchase/Expense/VendorCredit via AccountBasedExpenseLineDetail
  //   - deposit: bank Deposits via DepositLineDetail.AccountRef (income booked
  //     straight to a revenue account — see lib/qbo-deposit-reclass.ts)
  // Everything else (Transfer, JournalEntry, Invoice/SalesReceipt item income…)
  // is genuinely out of scope and counted as skipped_unsupported.
  const seen = new Set<string>();
  const unique: Array<{ id: string; type: string; kind: "expense" | "deposit" }> = [];
  let skippedUnsupported = 0;
  for (const t of rawTxns) {
    const id = String(t?.id || "").trim();
    const rawType = String(t?.type || "").trim();
    if (!id || !rawType) continue;
    const key = `${rawType}::${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cls = classifyReportTxn(rawType);
    if (!cls) { skippedUnsupported++; continue; }
    // Store the API ENTITY name (not the report label) so refetch/update hit the
    // right endpoint — "Expense"/"Check"/"Credit Card Expense" all → Purchase.
    unique.push({ id, type: cls.entity, kind: cls.kind });
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
    // Deposit lines linked to a Payment/Sales Receipt — the account follows the
    // linked txn, so they can't be moved by editing the deposit.
    skipped_linked: 0,
    failed: 0,
    // Per-transaction failure reasons (capped) — classified so the drawer can
    // show a next step (e.g. "unmatch the bank-feed download") instead of a
    // bare "N failed". The server log still has the full raw QBO error.
    failures: [] as Array<{ id: string; type: string; blocked: string | null; message: string }>,
    remaining: [] as Array<{ id: string; type: string }>,
    rules_created: 0,
    rules_updated: 0,
    target: { id: target.Id, name: target.Name },
  };

  const recordFailure = (id: string, type: string, err: any) => {
    summary.failed++;
    const info = describeReclassError(err);
    if (summary.failures.length < 25) {
      summary.failures.push({ id, type, blocked: info.blocked, message: info.message });
    }
  };

  const bookkeeperName = (actor as any)?.full_name || "bookkeeper";
  const auditMemo = `Ironbooks bulk reclass by ${bookkeeperName} — "${sourceAccountName}" → "${target.Name}"`;

  // Vendors we actually moved this pass → learned rules at the end.
  const movedVendors = new Set<string>();

  for (let i = 0; i < unique.length; i++) {
    const t = unique[i];
    if (Date.now() - startTime > BUDGET_MS || i >= MAX_TXNS_PER_PASS) {
      for (const rem of unique.slice(i)) summary.remaining.push({ id: rem.id, type: rem.type });
      break;
    }

    // ── Deposit: move the income line via DepositLineDetail.AccountRef ──
    if (t.kind === "deposit") {
      try {
        const r = await reclassifyDepositLines(realmId, accessToken, {
          depositId: t.id,
          sourceAccountId,
          newAccountId: target.Id,
          newAccountName: target.Name,
          auditMemo,
          expectedCurrentAccountName: sourceQboName,
          closingDate,
        });
        summary.skipped_linked += r.linked;
        if (r.skipped_closed) summary.skipped_closed++;
        else if (r.applied > 0) { summary.moved_txns++; summary.moved_lines += r.applied; }
        else if (r.matched === 0) summary.skipped_no_source_line++;
        else if (r.stale > 0) summary.skipped_stale++;
        // matched but all linked → already tallied in skipped_linked (not a move, not a failure)
      } catch (err: any) {
        recordFailure(t.id, "Deposit", err);
        console.error(`[bulk-reclass] Deposit/${t.id}: ${err.message}`);
      }
      continue;
    }

    let tx;
    try {
      tx = await refetchTransaction(realmId, accessToken, t.type as SupportedTxType, t.id);
    } catch (err: any) {
      recordFailure(t.id, t.type, err);
      console.error(`[bulk-reclass] refetch ${t.type}/${t.id}: ${err.message}`);
      continue;
    }
    if (!tx) {
      recordFailure(t.id, t.type, new Error(`${t.type} ${t.id} not found in QBO (may have been deleted)`));
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
        txType: t.type as SupportedTxType,
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
      recordFailure(t.id, t.type, err);
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
