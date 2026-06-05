import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, fetchAllAccounts } from "@/lib/qbo";
import { fetchAccountTransactions } from "@/lib/qbo-balance-sheet";
import {
  detectPayrollDoubleEntries,
  PAYROLL_ACCOUNT_NAME_REGEX,
  type PayrollDoubleEntry,
} from "@/lib/payroll-double-entry";

/**
 * POST /api/clients/[id]/payroll-double-entry-scan
 *
 * Scans the client's QBO for the QBO Payroll DD double-entry pattern
 * and persists hits as a new hardcore_cleanup_runs row with item_type =
 * 'payroll_double_entry'.
 *
 * Mechanism:
 *   1. Pull every COA account whose name matches PAYROLL_ACCOUNT_NAME_REGEX
 *      (Wages, Salaries, Payroll Expense, Direct Labor, Officer Comp, etc.)
 *   2. For each, fetch TransactionList for the requested date range.
 *   3. Run detectPayrollDoubleEntries → pairs of (locked Paycheck/DD,
 *      categorizable Transfer/JE) at the same amount within ±3 days.
 *   4. Insert one item per pair. The Transfer side becomes the item we'd
 *      eventually recategorize; the locked Paycheck/DD info goes into the
 *      paired_locked_txn_* columns so the resolution UI can show both
 *      sides side-by-side.
 *
 * Body (optional):
 *   { start_date?: "YYYY-MM-DD", end_date?: "YYYY-MM-DD" }
 *   Defaults to last 24 months ending today.
 */

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, client_name, assigned_bookkeeper_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!(client as any).is_active) {
    return NextResponse.json({ error: "Client is inactive" }, { status: 400 });
  }
  const realmId = (client as any).qbo_realm_id as string | null;
  if (!realmId) {
    return NextResponse.json(
      { error: "Client has no QBO connection — connect QBO first." },
      { status: 400 }
    );
  }

  // Permission: bookkeeper-owner or admin/lead.
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Date range — 24 months default, body can override.
  const body = await request.json().catch(() => ({} as any));
  const today = new Date().toISOString().slice(0, 10);
  const startDate: string =
    typeof body.start_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.start_date)
      ? body.start_date
      : defaultStartDate();
  const endDate: string =
    typeof body.end_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.end_date)
      ? body.end_date
      : today;

  // Create the run row up front so we have somewhere to write status.
  const { data: runIns, error: runErr } = await (service as any)
    .from("hardcore_cleanup_runs")
    .insert({
      client_link_id: clientLinkId,
      created_by: user.id,
      status: "matching",
      crm_source: "payroll_scan",
      crm_filename: `payroll-double-entry scan ${startDate} → ${endDate}`,
      workflow_version: 2,
    })
    .select()
    .single();
  if (runErr || !runIns) {
    return NextResponse.json(
      { error: `Failed to create run: ${runErr?.message || "unknown"}` },
      { status: 500 }
    );
  }
  const runId = (runIns as any).id as string;

  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    const allAccounts = await fetchAllAccounts(realmId, accessToken);
    const payrollAccounts = allAccounts.filter((a) => {
      const name = a.Name || "";
      // Match payroll-expense accounts only — skip liability/payable variants
      // (PayrollLiabilities is a clearing account, not where the double-book
      // shows up). Detection runs on P&L accounts where the duplicate ends up.
      const t = String(a.AccountType || "").toLowerCase();
      const isExpenseSide =
        t.includes("expense") || t.includes("cost of goods") || t.includes("cogs");
      return isExpenseSide && PAYROLL_ACCOUNT_NAME_REGEX.test(name);
    });

    if (payrollAccounts.length === 0) {
      await (service as any)
        .from("hardcore_cleanup_runs")
        .update({
          status: "review",
          finalize_results: {
            payroll_accounts_scanned: 0,
            pairs_detected: 0,
            note: "No payroll-expense accounts matched the name regex — client may not use QBO Payroll.",
          },
        })
        .eq("id", runId);
      return NextResponse.json({
        ok: true,
        run_id: runId,
        accounts_scanned: 0,
        pairs_detected: 0,
        message: "No payroll-expense accounts found in this COA. Nothing to scan.",
      });
    }

    // Pull transactions per account sequentially — TransactionList is one
    // API call per account, and QBO rate-limits per-realm. With typical
    // counts of 1-6 payroll accounts this stays well under 60s.
    const accountsByPayroll: Array<{
      account_id: string;
      account_name: string;
      transactions: Awaited<ReturnType<typeof fetchAccountTransactions>>;
    }> = [];
    for (const a of payrollAccounts) {
      const txns = await fetchAccountTransactions(
        realmId,
        accessToken,
        a.Id,
        startDate,
        endDate
      );
      accountsByPayroll.push({
        account_id: a.Id,
        account_name: a.Name,
        transactions: txns,
      });
    }

    const pairs = detectPayrollDoubleEntries({ accountsByPayroll });

    // Persist pairs as hardcore_cleanup_items.
    if (pairs.length > 0) {
      const itemsToInsert = pairs.map((p) =>
        toHardcoreCleanupItem(p, clientLinkId, runId)
      );
      // Chunked insert in case a client has hundreds of pairs.
      const BATCH = 200;
      for (let i = 0; i < itemsToInsert.length; i += BATCH) {
        const { error: itemsErr } = await (service as any)
          .from("hardcore_cleanup_items")
          .insert(itemsToInsert.slice(i, i + BATCH));
        if (itemsErr) {
          throw new Error(`Item insert failed: ${itemsErr.message}`);
        }
      }
    }

    const totalDoubleBooked = pairs.reduce(
      (s, p) => s + Math.abs(p.duplicate_amount),
      0
    );

    await (service as any)
      .from("hardcore_cleanup_runs")
      .update({
        status: "review",
        duplicates_detected: pairs.length,
        finalize_results: {
          payroll_accounts_scanned: payrollAccounts.length,
          pairs_detected: pairs.length,
          total_double_booked_dollars: Math.round(totalDoubleBooked * 100) / 100,
          date_range: { start: startDate, end: endDate },
        },
      })
      .eq("id", runId);

    return NextResponse.json({
      ok: true,
      run_id: runId,
      accounts_scanned: payrollAccounts.length,
      pairs_detected: pairs.length,
      total_double_booked_dollars: Math.round(totalDoubleBooked * 100) / 100,
      review_url: `/balance-sheet/${clientLinkId}/hardcore-cleanup?run_id=${runId}`,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    await (service as any)
      .from("hardcore_cleanup_runs")
      .update({ status: "failed", finalize_results: { error: msg } })
      .eq("id", runId);
    return NextResponse.json(
      { error: `Scan failed: ${msg}`, run_id: runId },
      { status: 500 }
    );
  }
}

function defaultStartDate(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 2);
  return d.toISOString().slice(0, 10);
}

function toHardcoreCleanupItem(
  p: PayrollDoubleEntry,
  clientLinkId: string,
  runId: string
) {
  // Map to the hardcore_cleanup_items shape. The Transfer (recategorizable
  // side) is the "primary" — that's what the bookkeeper will fix. The
  // locked Paycheck info goes into the paired_locked_txn_* columns.
  return {
    run_id: runId,
    client_link_id: clientLinkId,
    item_type: "payroll_double_entry",
    qbo_invoice_id: p.duplicate_txn_id, // re-purpose: the Transfer's txn id
    qbo_invoice_doc_number: p.duplicate_doc_number,
    qbo_invoice_date: normalizeDateForDb(p.duplicate_date),
    qbo_invoice_amount: Math.abs(p.duplicate_amount),
    qbo_invoice_balance: Math.abs(p.duplicate_amount),
    qbo_invoice_memo: p.duplicate_memo,
    paired_locked_txn_id: p.locked_txn_id,
    paired_locked_txn_type: p.locked_txn_type,
    paired_locked_txn_date: normalizeDateForDb(p.locked_date),
    confidence: p.confidence,
    reasoning: p.reasoning,
    resolution: "pending" as const,
    resolution_target_account_id: null,
    resolution_target_account_name: null,
  };
}

/** Accept MM/DD/YYYY or YYYY-MM-DD; return YYYY-MM-DD for the DATE column. */
function normalizeDateForDb(s: string | null): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const [, mm, dd, yy] = m;
    const yyyy = yy.length === 2 ? `20${yy}` : yy;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  return null;
}
