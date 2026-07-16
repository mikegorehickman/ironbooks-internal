import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, inactivateAccount, QBOReauthRequiredError } from "@/lib/qbo";
import { fetchTransactionsForAccount, reclassifyTransactionLines, type SupportedTxType, SUPPORTED_TX_TYPES } from "@/lib/qbo-reclass";
import { computeCoaDrift, type DriftMasterRow } from "@/lib/coa-drift";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Same budget guard the executor uses — reclassifying a huge account inline
// would blow the function timeout. Above this, hand off to QBO's bulk tool.
const MAX_LINES = 500;

/**
 * POST /api/admin/coa-audit/merge — merge ONE non-master account into a
 * master account, from the audit view, after the bookkeeper approved it
 * (Mike, 2026-07-16: approve one at a time, then it updates all YTD
 * transactions). Reuses the executor's merge mechanics (move lines via
 * reclassifyTransactionLines, then inactivate the drained source).
 *
 * Scope = CURRENT CALENDAR YEAR TO DATE, including already-closed months
 * (Mike's call). We attempt every line; any QBO rejects (e.g. a closing-date
 * lock on a filed period) are reported as failures rather than hidden.
 *
 * Body: { client_link_id, source_account_id, target_account_id }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role)) {
    return NextResponse.json({ error: "Admin/lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "");
  const sourceId = String(body.source_account_id || "");
  const targetId = String(body.target_account_id || "");
  if (!clientLinkId || !sourceId || !targetId) {
    return NextResponse.json({ error: "client_link_id, source_account_id, target_account_id required" }, { status: 400 });
  }
  if (sourceId === targetId) {
    return NextResponse.json({ error: "Source and target can't be the same account" }, { status: 400 });
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, jurisdiction, industry, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!clientLink?.qbo_realm_id || !clientLink.is_active) {
    return NextResponse.json({ error: "Client not found / inactive / not QBO-connected" }, { status: 404 });
  }

  // Concurrency guard: never merge while a COA cleanup job is actively
  // rewriting this client's chart (same class of race the executor locks on).
  const { data: activeJob } = await service
    .from("coa_jobs")
    .select("id, status")
    .eq("client_link_id", clientLinkId)
    .in("status", ["executing", "in_review"] as any)
    .limit(1)
    .maybeSingle();
  if (activeJob) {
    return NextResponse.json({ error: `A COA cleanup job (${(activeJob as any).status}) is active for this client — finish it before merging here.` }, { status: 409 });
  }

  const now = new Date();
  const ytdStart = `${now.getFullYear()}-01-01`;
  const ytdEnd = now.toISOString().slice(0, 10);

  try {
    const accessToken = await getValidToken(clientLink.id, service as any, "ironbooks/api/admin/coa-audit/merge");
    const accounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
    const byId = new Map(accounts.map((a) => [a.Id, a]));
    const source: any = byId.get(sourceId);
    const target: any = byId.get(targetId);
    if (!source) return NextResponse.json({ error: "Source account no longer exists" }, { status: 400 });
    if (!target) return NextResponse.json({ error: "Target account no longer exists" }, { status: 400 });

    // Type-safety guard (defense in depth — the UI only offers compatible
    // targets): never merge a balance-sheet account (bank/card/AR/AP/asset/
    // loan) and never cross income↔expense↔equity families.
    const family = (t: string) => {
      const x = (t || "").toLowerCase();
      if (x === "income" || x === "other income") return "income";
      if (x === "expense" || x === "other expense" || x === "cost of goods sold") return "expense";
      if (x === "equity") return "equity";
      return "other";
    };
    const srcFam = family(source.AccountType);
    if (srcFam === "other") {
      return NextResponse.json({ error: `"${source.Name}" is a ${source.AccountType} account — this tool only merges P&L/equity accounts, not banks, receivables, assets, or loans.` }, { status: 400 });
    }
    if (srcFam !== family(target.AccountType)) {
      return NextResponse.json({ error: `Can't merge a ${source.AccountType} account into a ${target.AccountType} account — types must be compatible.` }, { status: 400 });
    }

    const { lines, transactionsPulled } = await fetchTransactionsForAccount(
      clientLink.qbo_realm_id, accessToken, sourceId, ytdStart, ytdEnd
    );
    // Only the transaction types SNAP can safely rewrite line-by-line.
    const movable = lines.filter((l) => SUPPORTED_TX_TYPES.includes(l.transaction_type as SupportedTxType));
    const unsupported = lines.length - movable.length;

    if (movable.length > MAX_LINES) {
      return NextResponse.json({
        error: `"${source.Name}" has ${movable.length} lines YTD — too many to move inline. Use QuickBooks' Reclassify Transactions tool to move them to "${target.Name}", then inactivate the source.`,
        tooLarge: true,
      }, { status: 200 });
    }

    // Group by transaction; one QBO update per tx.
    const byTx = new Map<string, typeof movable>();
    for (const l of movable) {
      if (!byTx.has(l.transaction_id)) byTx.set(l.transaction_id, []);
      byTx.get(l.transaction_id)!.push(l);
    }

    const auditMemo = `SNAP COA merge (audit): "${source.Name}" → "${target.Name}"`;
    let linesMoved = 0;
    const failures: string[] = [];
    for (const [txId, txLines] of byTx) {
      try {
        const res = await reclassifyTransactionLines(clientLink.qbo_realm_id, accessToken, {
          txType: txLines[0].transaction_type as SupportedTxType,
          txId,
          lineUpdates: txLines.map((l) => ({ line_id: l.line_id, new_account_id: target.Id, new_account_name: target.Name })),
          auditMemo,
        });
        linesMoved += res.lines_applied;
        for (const na of res.lines_not_applied) failures.push(`${txId}: ${na.reason}`);
      } catch (e: any) {
        // Closed-period lock (closing-date password) surfaces here — reported,
        // never hidden.
        failures.push(`${txLines[0].transaction_type}/${txId}: ${e.message}`);
      }
    }

    // Inactivate the source only if it's fully drained (nothing left that
    // failed to move). A partial move keeps the source alive so no data is
    // stranded on an inactive account.
    let inactivated = false;
    if (linesMoved > 0 && failures.length === 0) {
      try {
        const fresh = (await fetchAllAccounts(clientLink.qbo_realm_id, accessToken)).find((a) => a.Id === sourceId) as any;
        if (fresh) {
          await inactivateAccount(clientLink.qbo_realm_id, accessToken, sourceId, fresh.SyncToken, fresh);
          inactivated = true;
        }
      } catch (e: any) {
        failures.push(`inactivate source: ${e.message}`);
      }
    }

    // Master rows → fresh drift for the in-place re-score.
    const industryRaw = ((clientLink as any).industry as string) || "painters";
    const jurisdiction = clientLink.jurisdiction || "US";
    let { data: masterRows } = await service
      .from("master_coa")
      .select("account_name, qbo_account_type, qbo_account_subtype, parent_account_name, is_parent, is_required")
      .eq("industry", industryRaw).eq("jurisdiction", jurisdiction);
    if ((!masterRows || masterRows.length === 0) && industryRaw !== "painters") {
      ({ data: masterRows } = await service
        .from("master_coa")
        .select("account_name, qbo_account_type, qbo_account_subtype, parent_account_name, is_parent, is_required")
        .eq("industry", "painters").eq("jurisdiction", jurisdiction));
    }
    const after = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
    const drift = masterRows ? computeCoaDrift(after as any, masterRows as DriftMasterRow[]) : null;

    await service.from("audit_log").insert({
      event_type: "coa_audit_merge",
      user_id: user.id,
      request_payload: {
        client_link_id: clientLink.id,
        client_name: clientLink.client_name,
        source: source.Name, target: target.Name,
        ytd_start: ytdStart, ytd_end: ytdEnd,
        transactions_pulled: transactionsPulled,
        lines_moved: linesMoved, unsupported_lines: unsupported,
        failures, inactivated,
      } as any,
    } as any);

    return NextResponse.json({
      ok: true,
      source: source.Name, target: target.Name,
      linesMoved, unsupported, failures, inactivated,
      drift,
    });
  } catch (err: any) {
    if (err instanceof QBOReauthRequiredError) return NextResponse.json({ error: "QBO reconnect required", reauth: true }, { status: 200 });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
