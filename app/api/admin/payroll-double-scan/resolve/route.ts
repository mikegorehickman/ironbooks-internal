import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, createAccount, QBOReauthRequiredError, type QBOAccount } from "@/lib/qbo";
import { fetchTransactionsForAccount, reclassifyTransactionLines, type SupportedTxType } from "@/lib/qbo-reclass";
import { fetchPLDetailAll } from "@/lib/qbo-reports";
import { detectLaborDuplication, payrollEmployeeRoster, isPayrollEmployee, classifyPayrollPaymentKind } from "@/lib/payroll-double-entry";
import { normalizeAccountName } from "@/lib/account-name";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const MAX_LINES = 500;
const CLEARING_NAME = "Payroll Clearing";

/**
 * POST /api/admin/payroll-double-scan/resolve — resolve ONE flagged labor line
 * (Mike 2026-07-17: cash basis, cash leaving the bank is the source of truth;
 * keep the paycheque, move the duplicate CASH off the P&L).
 *
 * For the chosen suspect account, moves the employees' CASH net-pay postings
 * (bank-fed e-Transfers / direct-deposit debits) YTD onto a balance-sheet
 * "Payroll Clearing" account (created if missing). The gross paycheques stay
 * put as the wage record; the clearing account nets to ~0 against them. Only
 * the payroll employees' cash lines move — never unrelated postings, never the
 * paycheques themselves (which QBO locks anyway).
 *
 * Body: { client_link_id, source_account_name }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Staff only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const clientLinkId = String(body.client_link_id || "");
  const sourceName = String(body.source_account_name || "");
  if (!clientLinkId || !sourceName) {
    return NextResponse.json({ error: "client_link_id and source_account_name required" }, { status: 400 });
  }

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json({ error: "Client not found / inactive / not QBO-connected" }, { status: 400 });
  }

  // Never write while a COA cleanup job is actively rewriting this chart.
  const { data: activeJob } = await service
    .from("coa_jobs").select("id, status").eq("client_link_id", clientLinkId)
    .in("status", ["executing", "in_review"] as any).limit(1).maybeSingle();
  if (activeJob) {
    return NextResponse.json({ error: `A COA cleanup job (${(activeJob as any).status}) is active — finish it before resolving here.` }, { status: 409 });
  }

  const now = new Date();
  const ytdStart = `${now.getFullYear()}-01-01`;
  const ytdEnd = now.toISOString().slice(0, 10);

  try {
    const token = await getValidToken(clientLinkId, service as any, "ironbooks/api/admin/payroll-double-scan/resolve");
    const accounts = await fetchAllAccounts((client as any).qbo_realm_id, token);
    const source = accounts.find((a) => a.Active !== false && normalizeAccountName(a.Name) === normalizeAccountName(sourceName));
    if (!source) return NextResponse.json({ error: `Account "${sourceName}" not found` }, { status: 400 });
    const sourceId = source.Id;

    // Learn the roster + confirm this account is really a duplicate labor line.
    const rows = await fetchPLDetailAll((client as any).qbo_realm_id, token, ytdStart, ytdEnd, "Accrual");
    const roster = payrollEmployeeRoster(rows);
    if (roster.size === 0) {
      return NextResponse.json({ error: "No QBO Payroll paycheques found — nothing to reconcile against" }, { status: 400 });
    }
    const det = detectLaborDuplication(rows.map((r) => ({ account: r.account, txn_type: r.txn_type, name: r.name, amount: r.amount, memo: r.memo, date: r.date })));
    if (!det.suspects.some((s) => normalizeAccountName(s.account) === normalizeAccountName(source.Name))) {
      return NextResponse.json({ error: `"${source.Name}" is no longer flagged as a duplicate labor line — re-scan.` }, { status: 400 });
    }

    // Find or create the Payroll Clearing wash account (balance sheet).
    let clearing = accounts.find((a) => a.Active !== false && normalizeAccountName(a.Name) === normalizeAccountName(CLEARING_NAME));
    let createdClearing = false;
    if (!clearing) {
      clearing = await createAccount((client as any).qbo_realm_id, token, {
        name: CLEARING_NAME,
        accountType: "Other Current Liability",
        accountSubType: "OtherCurrentLiabilities",
        description: "Payroll wash account — net-pay bank payments land here to net against QBO Payroll paycheques (SNAP payroll-double resolve).",
      }) as QBOAccount;
      createdClearing = true;
    }

    // Pull the source account's YTD lines; keep only the payroll employees'
    // CASH postings (bank-fed money out). Paycheques never appear here (they're
    // on the wage account), but guard by kind anyway.
    const { lines, transactionsPulled } = await fetchTransactionsForAccount(
      (client as any).qbo_realm_id, token, sourceId, ytdStart, ytdEnd,
    );
    const movable = lines.filter(
      (l) => isPayrollEmployee(l.vendor_name, roster) &&
        classifyPayrollPaymentKind(l.transaction_type, l.private_note) === "cash",
    );

    if (movable.length === 0) {
      return NextResponse.json({ error: "No matching employee cash lines found on this account to move" }, { status: 400 });
    }
    if (movable.length > MAX_LINES) {
      return NextResponse.json({
        error: `${movable.length} lines to move — too many inline. Use QuickBooks' Reclassify tool to move ${source.Name}'s employee cash lines to "${CLEARING_NAME}".`,
        tooLarge: true,
      }, { status: 200 });
    }

    // Group by transaction; one QBO update per tx.
    const byTx = new Map<string, typeof movable>();
    for (const l of movable) {
      if (!byTx.has(l.transaction_id)) byTx.set(l.transaction_id, []);
      byTx.get(l.transaction_id)!.push(l);
    }

    const auditMemo = `SNAP payroll resolve: net-pay moved off "${source.Name}" → "${CLEARING_NAME}" (cash-basis dedupe)`;
    let linesMoved = 0;
    const failures: string[] = [];
    for (const [txId, txLines] of byTx) {
      try {
        const res = await reclassifyTransactionLines((client as any).qbo_realm_id, token, {
          txType: txLines[0].transaction_type as SupportedTxType,
          txId,
          lineUpdates: txLines.map((l) => ({
            line_id: l.line_id,
            new_account_id: clearing!.Id,
            new_account_name: clearing!.Name,
            // Stale guard: only move if the line still sits on the source account.
            expected_current_account_name: source.Name,
          })),
          auditMemo,
        });
        linesMoved += res.lines_applied;
        for (const na of res.lines_not_applied) failures.push(`${txId}: ${na.reason}`);
      } catch (e: any) {
        // Closed-period lock surfaces here — reported, never hidden.
        failures.push(`${txLines[0].transaction_type}/${txId}: ${e.message}`);
      }
    }

    // Fresh detection so the UI updates in place.
    const after = await fetchPLDetailAll((client as any).qbo_realm_id, token, ytdStart, ytdEnd, "Accrual");
    const fresh = detectLaborDuplication(after.map((r) => ({ account: r.account, txn_type: r.txn_type, name: r.name, amount: r.amount, memo: r.memo, date: r.date })));

    await service.from("audit_log").insert({
      event_type: "payroll_resolve",
      user_id: user.id,
      request_payload: {
        client_link_id: clientLinkId, client_name: (client as any).client_name,
        source_account: source.Name, clearing_account: CLEARING_NAME, created_clearing: createdClearing,
        ytd_start: ytdStart, ytd_end: ytdEnd,
        transactions_pulled: transactionsPulled, lines_moved: linesMoved, failures,
      } as any,
    } as any);

    return NextResponse.json({
      ok: true,
      source: source.Name,
      clearing: CLEARING_NAME,
      created_clearing: createdClearing,
      lines_moved: linesMoved,
      failures,
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      ...fresh,
    });
  } catch (err: any) {
    if (err instanceof QBOReauthRequiredError) return NextResponse.json({ reauth: true, error: "QBO reconnect required" }, { status: 200 });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
